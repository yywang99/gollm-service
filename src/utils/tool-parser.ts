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
import { jsonrepair } from "jsonrepair";
import JSON5 from "json5";

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
 * 並還原被轉義的 HTML 實體字元（防止網頁端把 < 改成 <）
 */
function sanitizeWebRpaOutput(rawText: string): string {
  if (!rawText) return "";

  // 1. 移除可能包裹在最外層的代碼塊標籤，只保留內部核心
  let cleaned = rawText.replace(
    /```(?:xml|json|html|javascript|ts|js|bash|sh|text)?\s*([\s\S]*?)\s*```/gi,
    "$1"
  );

  // 移除剩餘的懸空反引號
  cleaned = cleaned.replace(/```/g, "");

  // 2. 拔除可能被轉義的 HTML 實體字元
  cleaned = cleaned
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/&/g, "&");

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
        name: fullMethod.replace(/:/g, "__"), // Convert to OpenAI safe name if needed
        arguments: argsStr,
      },
    });
  }

  // Pattern 2: Standard Hermes <tool_call> JSON block format
  // Use layered recovery because Gemini's web UI often produces malformed JSON:
  // 1. JSON.parse       — fastest, handles well-formed JSON
  // 2. jsonrepair       — fixes embedded unescaped quotes, missing commas
  // 3. JSON5.parse      — handles single quotes, trailing commas, comments
  // 4. targeted extract — handles edge cases where all above fail
  const toolCallPattern = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  while ((match = toolCallPattern.exec(text)) !== null) {
    const jsonStr = match[1].trim();
    let parsed: Record<string, unknown> | null = null;

    for (const parseAttempt of [
      () => JSON.parse(jsonStr),
      () => JSON.parse(jsonrepair(jsonStr)),
      () => JSON5.parse(jsonStr) as unknown,
      () => extractMalformedToolCall(jsonStr),
    ]) {
      try {
        const result = parseAttempt() as Record<string, unknown>;
        if (result && typeof result === "object" && "name" in result) {
          parsed = result;
          break;
        }
      } catch {
        // try next method
      }
    }

    if (parsed) {
      toolCalls.push({
        id: `call_${Math.random().toString(36).substring(2, 11)}`,
        type: "function",
        function: {
          name: String(parsed.name).replace(/:/g, "__"),
          arguments:
            typeof parsed.arguments === "object"
              ? JSON.stringify(parsed.arguments)
              : String(parsed.arguments || "{}"),
        },
      });
    }
    // else: couldn't extract — silently skip; gollm-service will fall back to text response
  }

  return toolCalls;
}

/**
 * Last-resort extractor for severely malformed <tool_call> JSON where
 * all standard parsers (JSON.parse, jsonrepair, JSON5) fail.
 * Handles the worst cases: deeply embedded unescaped quotes in command strings.
 *
 * Strategy: extract `name` and `arguments` separately via targeted regex/brute-force,
 * then parse each piece individually.
 */
function extractMalformedToolCall(jsonStr: string): Record<string, unknown> | null {
  // Extract "name" — simple scalar, never has embedded quotes in practice
  const nameMatch = /"name"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/.exec(jsonStr);
  if (!nameMatch) return null;

  const argsStartIdx = jsonStr.indexOf('"arguments"');
  if (argsStartIdx < 0) return null;

  // Walk from "arguments" to find the opening brace of the value
  let braceStart = -1;
  let depth = 0;
  let i = argsStartIdx + '"arguments"'.length;
  while (i < jsonStr.length) {
    const ch = jsonStr[i];
    if (ch === ":") {
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "{") {
      braceStart = i;
      depth = 1;
      i++;
      break;
    }
    i++;
  }
  if (braceStart < 0) return null;

  // Walk forward counting braces to find the matching close
  let j = braceStart + 1;
  while (j < jsonStr.length && depth > 0) {
    const ch = jsonStr[j];
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    j++;
  }
  const argsJson = jsonStr.slice(braceStart, j);

  // Try jsonrepair → JSON5 → JSON.parse on the arguments object
  let argsObj: unknown = {};
  for (const parser of [
    (s: string) => JSON.parse(jsonrepair(s)),
    JSON5.parse,
    JSON.parse,
  ]) {
    try {
      argsObj = parser(argsJson);
      break;
    } catch {
      // try next
    }
  }

  return { name: nameMatch[1], arguments: argsObj };
}

/**
 * Checks if the text should be treated as a pure tool call response.
 * If true, the 'content' field in OpenAI response should be null.
 */
export function isPureToolCall(
  text: string,
  toolCalls: ParsedToolCall[]
): boolean {
  if (toolCalls.length === 0) return false;

  // Clean markdown and HTML escaping first
  const sanitized = sanitizeWebRpaOutput(text);

  // Remove ALL tool call tags to see if any actual conversational text remains
  const cleaned = sanitized
    .replace(/<call:[\s\S]*?<\/call>/g, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<invoke>[\s\S]*?<\/invoke>/g, "")
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
  const noReplyIdx = sanitized.indexOf("NO_REPLY");
  if (noReplyIdx !== -1) {
    const after = sanitized.slice(noReplyIdx + "NO_REPLY".length).trim();
    return after.length === 0;
  }

  return false;
}

/**
 * Detects common LLM refusal patterns to help filter out hallucinated tool calls.
 * Returns HallucinationResult with details about why it was flagged.
 */
export function detectHallucination(
  text: string,
  toolCalls: ParsedToolCall[]
): HallucinationResult {
  const sanitized = sanitizeWebRpaOutput(text);

  for (const pattern of Object.values(DEFAULT_PATTERNS).flat()) {
    if (pattern.test(sanitized)) {
      return {
        isHallucination: true,
        reason: pattern.message,
        matchedPattern: pattern.name,
      };
    }
  }

  // Legacy fallback check: "I've attached" + file path without actual tool call
  const hasAttachedMention = /\b(attached|appended|added|written|created)\b.*\.(json|yaml|yml|sh|bash|py|ts|js|md|txt)/i.test(text);
  const hasToolCall =
    toolCalls.length > 0 ||
    /<call:|<\/call>|<tool_call>|<\/tool_call>/.test(text);
  if (hasAttachedMention && !hasToolCall) {
    return {
      isHallucination: true,
      reason: "Text mentions file modification but contains no valid tool call",
      matchedPattern: "file_modification_intent_no_tool",
    };
  }

  return { isHallucination: false };
}

export { hasCompletionClaim, hasFileModificationIntent, hasRefusalClaim };