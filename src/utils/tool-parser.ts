/**
 * Tool Parser Utility
 * 
 * Extracts tool calls from Gemini's Markdown response and converts them
 * to OpenAI-compatible tool_calls objects.
 */

import {
  hasCompletionClaim,
  hasFileModificationIntent,
  hasRefusalClaim,
  DEFAULT_PATTERNS,
} from "./hallucination-patterns.js";

export interface ParsedToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface HallucinationResult {
  isHallucination: boolean;
  reason?: string;
  matchedPattern?: string;
}

/**
 * 核心解決方案：清洗 Gemini Web UI 強制渲染的 Markdown 代碼塊
 * 並還原被轉義的 HTML 實體字元（防止網頁端把 < 改成 &lt;）
 */
function sanitizeWebRpaOutput(rawText: string): string {
  if (!rawText) return '';

  // 1. 移除可能包裹在最外層的代碼塊標籤，只保留內部核心
  let cleaned = rawText.replace(/```(?:xml|json|html|javascript|ts|js|bash|sh|text)?\s*([\s\S]*?)\s*```/gi, '$1');
  
  // 移除剩餘的懸空反引號
  cleaned = cleaned.replace(/```/g, '');

  // 2. 拔除可能被轉義的 HTML 實體字元
  cleaned = cleaned
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');

  return cleaned.trim();
}

/**
 * Parses text for Hermes-style tool calls: <call:plugin:method>{...}</call>
 * Also supports standard <tool_call> JSON blocks.
 */
export function parseToolCalls(rawText: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];
  
  // 進入解析前，先脫掉 Markdown 的糖衣外殼與 HTML 轉義
  const text = sanitizeWebRpaOutput(rawText);
  
  // Pattern 1: Legacy OpenClaw/Hermes XML format <call:domain:method>{args}</call>
  const callPattern = /<call:([\w:-]+)>([\s\S]*?)<\/call>/g;
  let match;
  while ((match = callPattern.exec(text)) !== null) {
    const fullMethod = match[1]; // e.g. "default_api:run_shell_command"
    const argsStr = match[2].trim();
    toolCalls.push({
      id: `call_${Math.random().toString(36).substring(2, 11)}`,
      type: "function",
      function: {
        name: fullMethod.replace(/:/g, '__'), // Convert to OpenAI safe name if needed
        arguments: argsStr
      }
    });
  }

  // Pattern 2: Standard Hermes <tool_call> JSON block format
  const toolCallPattern = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  while ((match = toolCallPattern.exec(text)) !== null) {
    try {
      // The content inside <tool_call> should be a JSON object: {"name": "...", "arguments": {...}}
      const jsonStr = match[1].trim();
      const parsed = JSON.parse(jsonStr);
      if (parsed.name) {
        toolCalls.push({
          id: `call_${Math.random().toString(36).substring(2, 11)}`,
          type: "function",
          function: {
            name: parsed.name.replace(/:/g, '__'),
            // if arguments is an object, stringify it (OpenAI expects stringified JSON)
            arguments: typeof parsed.arguments === 'object' ? JSON.stringify(parsed.arguments) : (parsed.arguments || "{}")
          }
        });
      }
    } catch (e) {
      console.warn("[GoLLM Parser] Failed to parse <tool_call> JSON:", e);
    }
  }
  
  return toolCalls;
}

/**
 * Checks if the text should be treated as a pure tool call response.
 * If true, the 'content' field in OpenAI response should be null.
 */
export function isPureToolCall(text: string, toolCalls: ParsedToolCall[]): boolean {
  if (toolCalls.length === 0) return false;
  
  // Clean markdown and HTML escaping first
  const sanitized = sanitizeWebRpaOutput(text);

  // Remove ALL tool call tags to see if any actual conversational text remains
  const cleaned = sanitized
    .replace(/<call:[\s\S]*?<\/call>/g, '')
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/<invoke>[\s\S]*?<\/invoke>/g, '')
    .trim();
    
  return cleaned.length < 20; // Allow for some small boilerplate like "OK." or "Sure."
}

/**
 * Checks if the response is essentially just a NO_REPLY signal,
 * ignoring any "Thinking" logs or boilerplate.
 */
export function isNoReply(text: string): boolean {
  // If the text ends with NO_REPLY (ignoring trailing whitespace)
  if (/NO_REPLY\s*$/.test(text)) return true;
  
  // If the text contains NO_REPLY and everything after it is just whitespace
  const sanitized = sanitizeWebRpaOutput(text);
  if (/NO_REPLY\s*$/.test(sanitized)) return true;

  return false;
}

/**
 * Detects if a response is a hallucination or refusal.
 * 
 * A hallucination/refusal occurs when:
 * 1. The response claims completion (e.g. "I already modified the file")
 *    but did NOT include any tool call tags
 * 2. The response has file modification intent (user asked to modify a file)
 *    AND the model claims completion without an action
 * 3. The response refuses to execute the task (e.g. "I am an AI and cannot run commands")
 * 
 * @param text - The raw response text from Gemini
 * @param toolCalls - Parsed tool calls from the same response
 * @returns HallucinationResult with isHallucination flag and reason
 */
export function detectHallucination(
  text: string,
  toolCalls: ParsedToolCall[]
): HallucinationResult {
  // No hallucination if we have valid tool calls
  if (toolCalls.length > 0) {
    return { isHallucination: false };
  }

  const completionClaim = hasCompletionClaim(text, DEFAULT_PATTERNS.completionClaims);
  const fileIntent = hasFileModificationIntent(text, DEFAULT_PATTERNS.fileModificationIntent);
  const refusalClaim = hasRefusalClaim(text, DEFAULT_PATTERNS.refusalClaims);

  // Case 1: Refusal
  if (refusalClaim) {
    return {
      isHallucination: true,
      reason: "Model refused to execute command due to RLHF constraints. Forcing retry to break refusal.",
      matchedPattern: "refusal_claim",
    };
  }

  // Case 2: Completion claim without any tool call = hallucination
  if (completionClaim) {
    return {
      isHallucination: true,
      reason: "Response claims completion without outputting action tags. Gemini does not have direct filesystem access.",
      matchedPattern: "completion_claim",
    };
  }

  // Case 3: Strong file modification intent + very short response
  // (model said "Sure, done!" without action tags)
  if (fileIntent && text.trim().length < 200) {
    return {
      isHallucination: true,
      reason: "Short response with file modification intent but no action tags detected. Gemini cannot modify files directly.",
      matchedPattern: "file_intent_short",
    };
  }

  return { isHallucination: false };
}
