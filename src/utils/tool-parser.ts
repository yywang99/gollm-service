/**
 * Tool Parser Utility
 * 
 * Extracts tool calls from Gemini's Markdown response and converts them
 * to OpenAI-compatible tool_calls objects.
 */

export interface ParsedToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
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
