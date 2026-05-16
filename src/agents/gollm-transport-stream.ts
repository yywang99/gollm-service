/**
 * GoLLM Transport Stream
 *
 * Core RPA logic: takes a prompt → types into Gemini Web → waits for response.
 * Universal version for OpenClaw and Hermes.
 */

import { type Page } from "playwright";
import { getSessionManager } from "../services/session-manager.js";
import { waitForStableResponse, captureBaseline } from "../services/response-extractor.js";
import { SELECTORS, type SelectorType } from "../utils/selectors.js";
import { TIMINGS } from "../utils/timings.js";
import { withMutex } from "../services/request-mutex.js";
import { DOMDoctor } from "../services/dom-doctor.js";

const domDoctor = new DOMDoctor();

export interface GollmMessage {
  role: "user" | "assistant" | "system";
  content: string | any[];
}

export interface GollmInput {
  messages: GollmMessage[];
  thinkingLog?: boolean;
}

export interface GollmOutput {
  text: string;
  thinking?: string;
  finishReason: "stop" | "timeout" | "error";
}

/**
 * Universal Content Extractor
 * Strips metadata from both OpenClaw and Hermes style messages.
 */
function cleanContent(content: string | any[]): string {
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  }

  // 1. Strip OpenClaw Metadata
  const openclawPattern = /(?:Conversation info \(untrusted metadata\):|Sender \(untrusted metadata\):)[\s\S]*$/gi;
  text = text.replace(openclawPattern, '').trim();

  // 2. Strip generic [Metadata] markers if present
  text = text.replace(/\[Metadata\][\s\S]*$/gi, '').trim();

  return text;
}

function extractLatestUserMessage(messages: GollmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return cleanContent(messages[i].content);
    }
  }
  return "";
}

function isSameConversation(oldMsgs: GollmMessage[], newMsgs: GollmMessage[]): boolean {
  if (!oldMsgs || oldMsgs.length === 0) return false;
  if (!newMsgs || newMsgs.length === 0) return false;
  
  const oldFirstUser = oldMsgs.find(m => m.role === "user");
  const newFirstUser = newMsgs.find(m => m.role === "user");
  
  if (!oldFirstUser || !newFirstUser) return false;
  
  const oldText = cleanContent(oldFirstUser.content);
  const newText = cleanContent(newFirstUser.content);
  
  if (!oldText || !newText) return false;
  return oldText.slice(0, 100) === newText.slice(0, 100);
}

/**
 * Formats a stateless message array into a stateful transcript for Web UI.
 * This is used when we detect a context shift (e.g. from Hermes).
 */
function formatTranscript(messages: GollmMessage[]): string {
  let transcript = "";
  for (const msg of messages) {
    const text = cleanContent(msg.content);
    if (!text) continue;
    
    if (msg.role === "system") {
      transcript += `[Instructions]:\n${text}\n\n`;
    } else if (msg.role === "user") {
      transcript += `[User]:\n${text}\n\n`;
    } else if (msg.role === "assistant") {
      transcript += `[Assistant]:\n${text}\n\n`;
    }
  }
  
  if (messages.length > 0 && messages[messages.length - 1].role === "user") {
    transcript += `[Assistant]:\n`;
  }
  
  return transcript.trim();
}

function determinePromptStrategy(session: any, messages: GollmMessage[]): { text: string; requireNewChat: boolean } {
  if (!messages || messages.length === 0) return { text: "", requireNewChat: false };
  
  const oldMsgs = session.getLastProcessedMessages() || [];
  
  // If the conversation history matches, just send the latest message (Incremental)
  if (isSameConversation(oldMsgs, messages)) {
    const newText = extractLatestUserMessage(messages);
    if (newText) return { text: newText, requireNewChat: false };
  }
  
  // Otherwise, re-send the whole context (Stateless to Stateful translation)
  return { text: formatTranscript(messages), requireNewChat: true };
}

// ─── Input injection ───────────────────────────────────────────────────────

// ─── Selector pool — try all candidates before giving up ───────────────

/**
 * Try every selector in the pool for a given type.
 * Returns the first working one, or null if none are found.
 */
async function trySelectorPool(page: Page, type: SelectorType): Promise<string | null> {
  const pool = SELECTORS[type];
  if (!pool || pool.length < 1) return null;

  for (const sel of pool) {
    try {
      const el = await page.waitForSelector(sel, { state: 'attached', timeout: 2000 });
      if (el && await el.isVisible()) {
        console.log(`[GoLLM] Pool found usable selector for ${type}: ${sel}`);
        return sel;
      }
    } catch {
      // try next
    }
  }
  return null;
}

// ─── Input injection ───────────────────────────────────────────────────────

async function typeInput(page: Page, text: string): Promise<void> {
  // Step 1: Try the DOMDoctor-cached selector first
  let currentSelector = domDoctor.getSelector("input") || SELECTORS.input[0];

  let workingSelector: string | null = null;

  // Step 2: Try the cached selector, then the whole pool before escalating to AI
  const candidates = [
    currentSelector,
    ...SELECTORS.input.filter(s => s !== currentSelector),
  ];

  for (const sel of candidates) {
    try {
      const el = await page.waitForSelector(sel, { state: 'attached', timeout: 3000 });
      if (el && await el.isVisible()) {
        workingSelector = sel;
        break;
      }
    } catch {
      // selector didn't work, try next
    }
  }

  // Step 3: Pool exhausted → let DOMDoctor try AI repair (max once per type)
  if (!workingSelector) {
    console.log("[GoLLM] All pool selectors exhausted for 'input', trying AI repair...");
    const healed = await domDoctor.healIfNeeded(page, "input", currentSelector);
    if (healed) {
      workingSelector = domDoctor.getSelector("input");
      if (workingSelector) {
        console.log(`[GoLLM] AI repair succeeded: ${workingSelector}`);
      }
    }
  }

  // Step 4: Everything failed
  if (!workingSelector) {
    throw new Error(
      `Cannot find input element. Pool exhausted. ` +
      `Try restarting GoLLM Service to refresh selectors.`
    );
  }

  const inputEl = await page.$(workingSelector);
  if (!inputEl) throw new Error(`Cannot find input element: ${workingSelector}`);

  await inputEl.scrollIntoViewIfNeeded();
  await inputEl.click();
  await inputEl.focus();

  // Clear existing text
  const isMac = process.platform === "darwin";
  await page.keyboard.down(isMac ? "Meta" : "Control");
  await page.keyboard.press("a");
  await page.keyboard.up(isMac ? "Meta" : "Control");
  await page.keyboard.press("Backspace");

  // Inject text via page.evaluate for speed and stability with long prompts
  const injectFn = new Function("args",
    "var el=document.querySelector(args.s); if(!el)return;" +
    "if(el.tagName==='TEXTAREA'||el.tagName==='INPUT'){el.value=args.t;}else{el.innerText=args.t;}" +
    "['input','change','keyup'].forEach(function(n){el.dispatchEvent(new Event(n,{bubbles:true}));});"
  );
  await page.evaluate(injectFn as any, { s: workingSelector, t: text } as any);

  // Trigger UI update
  await page.keyboard.type(" ");
  await page.keyboard.press("Backspace");
}

async function clickSend(page: Page): Promise<void> {
  // Try cached selector, then full pool, then AI repair
  const currentSelector = domDoctor.getSelector("send") || SELECTORS.send[0];
  const candidates = [currentSelector, ...SELECTORS.send.filter(s => s !== currentSelector)];

  let workingSendBtn: import("playwright").ElementHandle | null = null;

  for (const sel of candidates) {
    try {
      const btn = await page.waitForSelector(sel, { state: 'attached', timeout: 2000 });
      if (btn && await btn.isVisible()) {
        workingSendBtn = btn;
        break;
      }
    } catch { /* try next */ }
  }

  // Pool exhausted → AI repair (once)
  if (!workingSendBtn) {
    console.log("[GoLLM] All send selectors exhausted, trying AI repair...");
    const healed = await domDoctor.healIfNeeded(page, "send", currentSelector);
    if (healed) {
      const newSel = domDoctor.getSelector("send");
      if (newSel) {
        workingSendBtn = await page.$(newSel);
      }
    }
  }

  if (workingSendBtn && await workingSendBtn.isVisible()) {
    await workingSendBtn.click();
  } else {
    await page.keyboard.press("Enter");
  }
}

// ─── Main RPA function ─────────────────────────────────────────────────────

export async function executeGollmRPA(
  input: GollmInput,
  options: { thinkingLog?: boolean; playwrightConfig?: any } = {}
): Promise<GollmOutput> {
  return await withMutex("gollm-rpa", async () => {
    const { messages } = input;
    const { thinkingLog = true, playwrightConfig = {} } = options;
    const log = (msg: string) => { if (thinkingLog) console.log(`[GoLLM RPA] ${msg}`); };

    const session = getSessionManager({
      headless: playwrightConfig?.headless ?? process.env.GOLLM_HEADLESS === "true",
      userDataDir: playwrightConfig?.userDataDir,
    });

    const promptData = determinePromptStrategy(session, messages);
    if (!promptData.text) throw new Error("No prompt extracted.");

    const page = await session.getPage();
    await session.navigateToGemini();

    if (promptData.requireNewChat) {
      log("Context shift detected, starting new chat...");
      await session.startNewChat();
    }

    const baseline = await captureBaseline(page);
    log(`Baseline captured: ${baseline.length} chars`);

    await typeInput(page, promptData.text);
    log(`Prompt typed (${promptData.text.length} chars)`);

    await clickSend(page);
    log("Message sent.");

    await page.waitForTimeout(2000); // Give UI time to start generating

    const result = await waitForStableResponse(page, baseline);

    if (result.status === "timeout" || !result.text) {
      log("Response timeout.");
      return { text: result.text || "", finishReason: "timeout" };
    }

    log(`Response received: ${result.text.length} chars`);
    
    await session.pruneDOM();
    session.setLastProcessedMessages(messages);
    
    return { text: result.text, finishReason: "stop" };
  });
}

// Legacy builder for backward compatibility
export function buildChatCompletionResponse(text: string, modelId: string = "gollm-v9") {
  return {
    id: `gollm-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { total_tokens: 0 },
  };
}
