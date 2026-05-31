/**
 * Session Manager
 *
 * Manages Playwright Browser lifecycle as a singleton.
 * Handles:
 * - Single browser instance (persistent context)
 * - Session state tracking (logged in / needs re-auth / crashed)
 * - Automatic recovery on crash
 * - Memory management (DOM pruning)
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { SELECTORS } from "../utils/selectors.js";

export type SessionState = "new" | "logged_in" | "needs_reauth" | "crashed";

export interface SessionManagerOptions {
  userDataDir?: string;
  headless?: boolean;
  stealth?: boolean;
}

export class SessionManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private state: SessionState = "new";
  private options: SessionManagerOptions;
  private lastProcessedMessages: any[] = [];
  private _targetMode: "flash-lite" | "flash" | "pro" | null = null;
  private _lastError: string | null = null;
  private _lastErrorTime: number | null = null;

  getLastProcessedMessages(): any[] {
    return this.lastProcessedMessages;
  }

  setLastProcessedMessages(msgs: any[]) {
    this.lastProcessedMessages = msgs;
  }

  getLastError(): { message: string; time: number } | null {
    if (!this._lastError) return null;
    return { message: this._lastError, time: this._lastErrorTime ?? 0 };
  }

  setLastError(message: string): void {
    this._lastError = message;
    this._lastErrorTime = Date.now();
    console.warn(`[SessionManager] Last error updated: ${message}`);
  }

  /**
   * Remove Angular CDK overlay backdrops that intercept pointer events.
   */
  private async dismissOverlays(): Promise<void> {
    try {
      await this.page?.evaluate(() => {
        // @ts-expect-error — window is a browser global inside page.evaluate
        const win = (window as any);
        const selectors = [
          '.cdk-overlay-backdrop',
          '.cdk-overlay-transparent-backdrop',
          '.cdk-overlay-container',
          '[class*="modal-backdrop"]',
          '[class*="backdrop"][class*="show"]',
          '[role="dialog"][aria-modal="true"]'
        ];
        const combinedSelector = selectors.join(',');
        win.document.querySelectorAll(combinedSelector).forEach((el: any) => {
          if (el.parentNode) el.parentNode.removeChild(el);
        });
      });
    } catch { /* best-effort */ }
  }

  /**
   * Set the target Gemini model.
   * Simplified: just pick one of the 3 models. Thinking is always "延長".
   */
  setTargetMode(mode: "flash-lite" | "flash" | "pro" | null) {
    this._targetMode = mode;
    console.log(`[SessionManager] Target mode set to: ${mode}`);
  }

  /**
   * Apply the target mode by clicking the correct model if needed.
   */
  public async applyTargetMode(): Promise<boolean> {
    if (!this._targetMode) {
      console.log(`[SessionManager] No target mode set, skipping apply`);
      return true;
    }

    const page = await this.getPage();
    if (!page) return false;

    const currentMode = await this.detectGeminiMode();
    if (currentMode === this._targetMode) {
      console.log(`[SessionManager] Mode already correct: ${currentMode}`);
      return true;
    }

    console.log(`[SessionManager] Applying target mode: ${this._targetMode} (current: ${currentMode})`);
    
    // Limit attempts to avoid infinite "Context Shift" loop
    let attempts = 0;
    const maxAttempts = 2;
    while (attempts < maxAttempts) {
      attempts++;
      const success = await this.setGeminiMode(this._targetMode);
      if (success) return true;
      
      console.warn(`[SessionManager] Model switch attempt ${attempts}/${maxAttempts} failed`);
      await page.waitForTimeout(1000);
    }

    console.error(`[SessionManager] Failed to switch to ${this._targetMode} after ${maxAttempts} attempts. Giving up to prevent loop.`);
    this.setLastError(`Model switch to "${this._targetMode}" failed after ${maxAttempts} attempts`);
    return false; // Return false so the caller knows it failed, but we stop trying here
  }

  constructor(options: SessionManagerOptions = {}) {
    const headlessEnv = process.env.GOLLM_BROWSER_HEADLESS === "true";
    this.options = {
      userDataDir: options.userDataDir || process.env.GOLLM_USER_DATA_DIR || "~/.openclaw/gollm-playwright-profile",
      headless: options.headless ?? headlessEnv,
      stealth: options.stealth ?? true,
    };
  }

  async getPage(): Promise<Page> {
    if (!this.context || !this.page) {
      await this.launch();
    }
    return this.page!;
  }

  async launch(): Promise<void> {
    if (this.browser) {
      console.log("[SessionManager] Browser already launched");
      return;
    }

    console.log(`[SessionManager] Launching Chromium (headless=${this.options.headless})...`);
    this.state = "new";

    const stealthArgs = [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--no-default-browser-check",
      "--use-mock-keychain",
      "--disable-web-security",
    ];

    this.context = await chromium.launchPersistentContext(this.options.userDataDir!, {
      headless: this.options.headless,
      viewport: null,
      args: stealthArgs,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    });

    // Remove automation indicators from the browser context
    await this.context.addInitScript(() => {
      Object.defineProperty(globalThis, "webdriver", { get: () => false });
      // @ts-ignore
      Object.defineProperty(globalThis, "navigator", { value: { chrome: { runtime: {} }, plugins: { length: 5 }, languages: ["zh-TW", "en-US"] }, configurable: true, get: function(){ return this._navigator; } });
      Object.defineProperty(globalThis, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(globalThis, 'languages', { get: () => ['zh-TW', 'en-US'] });
    });

    this.page = this.context.pages()[0] || (await this.context.newPage());

    this.context.on("close", () => {
      console.log("[SessionManager] Browser context closed/crashed.");
      this.context = null;
      this.page = null;
      this.browser = null;
      this.state = "new";
    });

    // Detect session state
    await this.detectSessionState();

    console.log(`[SessionManager] Launched. State: ${this.state}`);
  }

  async detectSessionState(): Promise<void> {
    if (!this.page) return;

    const url = this.page.url();
    console.log(`[SessionManager] Detecting session state, URL: ${url}`);

    if (url.includes("accounts.google.com/signin")) {
      this.state = "needs_reauth";
    } else if (url.includes("gemini.google.com")) {
      // Wait a bit for page to load after navigation
      await this.page.waitForTimeout(1000);

      // Try multiple selectors for the input area
      try {
        const selectorsToTry = SELECTORS.input.join(", ");
        const inputArea = await this.page.waitForSelector(selectorsToTry, {
          state: "attached",
          timeout: 5000
        }).catch(() => null);

        if (inputArea) {
          this.state = "logged_in";
          console.log("[SessionManager] Session detected as logged in");
        } else {
          this.state = "needs_reauth";
          console.log("[SessionManager] Input area not found, setting needs_reauth");
        }
      } catch (e) {
        this.state = "needs_reauth";
        console.log(`[SessionManager] Session detection error: ${e}`);
      }
    } else {
      this.state = "new";
    }
  }

  // ─── Mode Detection & Switching ────────────────────────────────────────────
  //
  // Simplified model: 3 models, thinking always fixed to "延長".
  //   "flash-lite" → 3.1 Flash-Lite
  //   "flash"      → 3 Flash
  //   "pro"        → 3.1 Pro
  //
  // Thinking level ("延長") is set once at first launch and never touched again.

  async detectGeminiMode(): Promise<"flash-lite" | "flash" | "pro" | "unknown"> {
    const page = await this.getPage();
    if (!page) return "unknown";

    try {
      const mode = await page.evaluate(() => {
        // @ts-expect-error — window/document are browser globals inside page.evaluate
        const win = (window as any);
        const allButtons = win.document.querySelectorAll('button');
        for (let i = 0; i < allButtons.length; i++) {
          const btn = allButtons[i];
          const txt = (btn.textContent || '').trim();
          if (txt.length > 25) continue;
          if (/Flash-Lite/i.test(txt)) return 'flash-lite';
          if (/Flash(?!-Lite)/i.test(txt)) return 'flash';
          if (/Pro/i.test(txt)) return 'pro';
        }
        const modeBtn = win.document.querySelector('[aria-label*="模型"], [aria-label*="Model"]');
        if (modeBtn) {
          const t = (modeBtn.textContent || '').trim().toLowerCase();
          if (t.includes('lite')) return 'flash-lite';
          if (t.includes('pro')) return 'pro';
          if (t.includes('flash')) return 'flash';
        }
        return 'unknown';
      });
      console.log(`[SessionManager] Detected model: ${mode}`);
      return mode as "flash-lite" | "flash" | "pro" | "unknown";
    } catch (e) {
      console.log(`[SessionManager] Mode detection error: ${e}`);
      return "unknown";
    }
  }

  /**
   * Switch to the specified Gemini model.
   * Thinking level is NOT changed — it stays on "延長" (set once manually).
   */
  async setGeminiMode(targetMode: "flash-lite" | "flash" | "pro"): Promise<boolean> {
    const page = await this.getPage();
    if (!page) return false;

    const modelPatterns: Record<string, RegExp> = {
      'flash-lite': /Flash-Lite/i,
      'flash':      /Flash(?!-Lite)/i,
      'pro':        /Pro|Advanced/i, // Support "Advanced" which is often used for Pro
    };
    const pattern = modelPatterns[targetMode];
    if (!pattern) return false;

    await this.dismissOverlays();

    await this.dismissOverlays();

    // Open the model dropdown - prioritize the actual button showing the model name
    let clicked = false;
    
    // First, try to find the button by its text (e.g., "Flash-Lite ▾", "3 Flash")
    for (const modelName of ['Flash-Lite', 'Flash', 'Pro']) {
      try {
        const btn = page.getByRole('button', { name: new RegExp(modelName, 'i') }).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          console.log(`[SessionManager] Opening dropdown via text match: ${modelName}`);
          await btn.click();
          clicked = true;
          break;
        }
      } catch { /* ignore */ }
    }

    // Fallback ARIA selectors (removed the old trap '[aria-label="開啟模式挑選器"]')
    if (!clicked) {
      for (const sel of ['[aria-label*="模型"]', '[aria-label*="Model"]', '[aria-haspopup="menu"]', '[aria-haspopup="listbox"]']) {
        try {
          const el = page.locator(sel).first();
          if (await el.count() > 0 && await el.isVisible().catch(() => false)) {
            console.log(`[SessionManager] Opening dropdown fallback: ${sel}`);
            await el.click(); clicked = true; break;
          }
        } catch { /* next */ }
      }
    }

    if (!clicked) { console.log("[SessionManager] Could not find dropdown button"); return false; }

    await page.waitForTimeout(500);

    // Click the target model
    let modelClicked = false;
    for (const role of ['menuitemradio', 'menuitem', 'option', 'radio'] as const) {
      try {
        const loc = page.getByRole(role, { name: pattern });
        const count = await loc.count();
        for (let i = 0; i < count; i++) {
          if (await loc.nth(i).isVisible().catch(() => false)) {
            console.log(`[SessionManager] ✅ Selecting model: ${targetMode}`);
            await loc.nth(i).click(); modelClicked = true; break;
          }
        }
      } catch { /* next */ }
      if (modelClicked) break;
    }

    // Fallback: text scan inside menu
    if (!modelClicked) {
      try {
        const containers = page.locator('[role="menu"], [role="listbox"], [role="dialog"]');
        const cCount = await containers.count();
        for (let c = 0; c < cCount; c++) {
          const container = containers.nth(c);
          if (!await container.isVisible().catch(() => false)) continue;
          const items = container.locator('button, [role="menuitem"], [role="menuitemradio"], [role="option"], li, div[tabindex]');
          const iCount = await items.count();
          for (let j = 0; j < iCount; j++) {
            const itemText = await items.nth(j).textContent().catch(() => '') || '';
            if (pattern.test(itemText.trim())) {
              console.log(`[SessionManager] ✅ Selecting model via text: "${itemText.trim()}"`);
              await items.nth(j).click(); modelClicked = true; break;
            }
          }
          if (modelClicked) break;
        }
      } catch { /* ignore */ }
    }

    if (!modelClicked) {
      console.log(`[SessionManager] Model "${targetMode}" not found in dropdown`);
      await page.keyboard.press('Escape');
      return false;
    }

    await page.waitForTimeout(500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    console.log(`[SessionManager] ✅ Model switched to: ${targetMode}`);
    return true;
  }

  async navigateToGemini(): Promise<void> {
    const page = await this.getPage();
    const currentUrl = page.url();

    // ─── Save mode before navigation ───
    const prevMode = await this.detectGeminiMode();
    console.log(`[SessionManager] Current mode before nav: ${prevMode}, URL: ${currentUrl}`);

    // Check if we have a visible input area
    const pageCheck = await page.evaluate(() => {
      // @ts-expect-error — window/document are browser globals inside page.evaluate
      const win = (window as any);
      return { hasInput: !!win.document.querySelector(".ql-editor,.ProseMirror,[contenteditable],textarea") };
    });

    console.log(`[SessionManager] Page check: hasInput=${pageCheck.hasInput}`);

    if (!currentUrl.includes("gemini.google.com")) {
      console.log("[SessionManager] Navigating to Gemini...");
      await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
      await (this.page!)?.waitForTimeout(2000);
    }

    // Re-check after navigation
    const pageCheck2 = await page.evaluate(() => {
      // @ts-expect-error — window/document are browser globals inside page.evaluate
      const win = (window as any);
      return { hasInput: !!win.document.querySelector(".ql-editor,.ProseMirror,[contenteditable],textarea") };
    });

    if (!pageCheck2.hasInput) {
      console.log("[SessionManager] No input found, looking for New Chat...");
      try {
        // Dismiss overlays and press Escape to close any blocking dialogs
        await this.dismissOverlays();
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);

        // Try clicking any "New Chat" or "新對話" button
        const newChatBtn = await page.$('button[aria-label*="New"],button[aria-label*="新對話"],button[aria-label*="新建"]');
        if (newChatBtn) {
          await this.dismissOverlays();
          await newChatBtn.click({ force: true, timeout: 3000 });
          await page.waitForTimeout(2000);
          console.log("[SessionManager] Clicked New Chat button");
        } else {
          // Try navigating directly to gemini with a hash to force new chat
          console.log("[SessionManager] No New Chat button, trying direct navigation...");
          await page.goto("https://gemini.google.com/app#new", { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(2000);
        }
      } catch (e) {
        console.log("[SessionManager] Error clicking New Chat: " + e + " - falling back to direct navigation...");
        this.setLastError(`startNewChat click failed: ${e}`);
        await page.goto("https://gemini.google.com/app#new", { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);
      }
    }

    // ─── Apply target mode after navigation ───
    await this.page?.waitForTimeout(2000); // Wait for page to fully settle including mode buttons
    await this.applyTargetMode();

    // Always re-detect session state after potential navigation or even if already on Gemini
    await this.detectSessionState();
  }

  async startNewChat(): Promise<void> {
    const page = await this.getPage();

    // Dismiss any overlay/backdrop that may block navigation
    await this.dismissOverlays();

    // Direct navigation to /app creates a fresh new chat page.
    // This is more reliable than clicking the "New chat" button,
    // and ensures Gemini has no knowledge of previous conversation history.
    await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    // Apply target mode (e.g., pro/flash) after fresh page load
    await this.applyTargetMode();

    console.log("[SessionManager] Done starting new chat");
  }

  async pruneDOM(): Promise<void> {
    const page = await this.page;
    if (!page) return;

    try {
      // Prune old conversation turns to keep the page responsive
      await page.evaluate(() => {
        // @ts-expect-error — window/document are browser globals inside page.evaluate
        const win = (window as any);
        const nodes = win.document.querySelectorAll(
          "message-content, model-response, user-message, .message-row, .conversation-turn"
        );
        if (nodes.length <= 6) return;
        for (let i = 0; i < nodes.length - 6; i++) {
          const wrapper =
            nodes[i].closest(".message-row") ||
            nodes[i].closest(".conversation-turn") ||
            nodes[i].closest(".chat-message-group") ||
            nodes[i];
          if (wrapper && wrapper.parentNode) {
            wrapper.parentNode.removeChild(wrapper);
          }
        }
      });
      console.log("[SessionManager] DOM pruned successfully");
    } catch (e) {
      console.warn("[SessionManager] DOM prune failed:", e);
      this.setLastError(`DOM prune failed: ${e}`);
    }
  }

  /**
   * Apply new options on top of existing ones (used by getSessionManager to re-configure
   * the singleton after initial creation).
   */
  mergeOptions(updates: Partial<SessionManagerOptions>): void {
    this.options = { ...this.options, ...updates };
  }

  getState(): SessionState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === "logged_in" && this.page !== null;
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.state = "new";
  }
}

// Singleton export for the service
let globalSessionManager: SessionManager | null = null;

export function getSessionManager(options?: SessionManagerOptions): SessionManager {
  if (!globalSessionManager) {
    globalSessionManager = new SessionManager(options);
  } else if (options) {
    // Merge new options into the existing singleton so that config loaded after
    // the first call (e.g., from gollmrc.json) is applied without restarting.
    globalSessionManager.mergeOptions(options);
  }
  return globalSessionManager;
}