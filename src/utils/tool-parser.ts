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
 * Parses text for Hermes-style tool calls: <call:plugin:method>{...}</call>
 * Also supports basic JSON code blocks as a fallback if instructed.
 */
export function parseToolCalls(text: string): ParsedToolCall[] {
  const toolCalls: ParsedToolCall[] = [];
  
  // Pattern 1: Hermes/OpenClaw XML-like format <call:domain:method>{args}</call>
  const hermesPattern = /<call:([\w:]+)>([\s\S]*?)<\/call>/g;
  let match;
  
  while ((match = hermesPattern.exec(text)) !== null) {
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

  // Pattern 2: Generic Markdown JSON blocks if the text contains nothing else or is clearly a tool call
  // This is a fallback and can be risky if the model is just showing code.
  // Use with caution or only when text matches a specific "Action" pattern.
  
  return toolCalls;
}

/**
 * Checks if the text should be treated as a pure tool call response.
 * If true, the 'content' field in OpenAI response should be null.
 */
export function isPureToolCall(text: string, toolCalls: ParsedToolCall[]): boolean {
  if (toolCalls.length === 0) return false;
  
  // If the remaining text (after removing tags) is just whitespace/boilerplate, it's pure
  const cleaned = text.replace(/<call:[\s\S]*?<\/call>/g, '').trim();
  return cleaned.length < 20; // Allow for some small boilerplate like "OK." or "Sure."
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
