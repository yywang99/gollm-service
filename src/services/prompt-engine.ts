/**
 * Prompt Engine
 *
 * Responsible for all text manipulation, prompt assembly, and tool truncation.
 * Decoupled from RPA execution to ensure that prompt logic can be tested and
 * evolved independently of the Playwright driver.
 *
 * All numeric limits are driven by service.gollmrc.json → config.prompt
 * (loaded via prompt-config.ts). Safe defaults are used when the config is absent.
 */

import { getPromptLimits, type PromptLimits } from "./prompt-config.js";

export class PromptEngine {
  private readonly _limits: PromptLimits;

  constructor() {
    this._limits = getPromptLimits();
  }

  /**
   * Strips metadata from both OpenClaw and Hermes style messages.
   * IMPORTANT: Context files (MEMORY.md, USER.md, AGENT.md, etc.) embedded
   * inside the JSON metadata block are extracted and preserved, since they
   * contain real agent context that should not be discarded.
   */
  cleanContent(content: string | any[]): string {
    if (!content) return "";
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      const strippedParts = content
        .filter((p: any) => p.type === "text")
        .map((p: any) => {
          let partText = p.text || "";
          // Only strip JSON metadata blocks, not plain text system content
          if (partText.includes('"untrusted') || partText.includes('(untrusted')) {
            partText = this._stripMetadataPreservingContext(partText);
          }
          return partText;
        });
      text = strippedParts.join("\n");
    }

    // Only strip metadata from content that looks like JSON metadata
    if (text.includes('"untrusted') || text.includes('(untrusted')) {
      text = this._stripMetadataPreservingContext(text);
    }
    text = text.replace(/^\[Metadata\][^\n]*$/gim, '');
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    return text;
  }

  /**
   * Strips the JSON metadata block but extracts and preserves context file
   * contents (MEMORY.md, USER.md, AGENT.md, WORKSPACE.md, RULES.md, etc.)
   * that are embedded inside it.
   */
  private _stripMetadataPreservingContext(text: string): string {
    // Pattern captures: prefix line + code fence + JSON body + closing fence
    // Modified to support CRLF (\r\n) line endings
    const jsonBlockPat = /([^\n]*\(untrusted(?:\s+metadata|\s*,\s*for\s+context)\):?\s*\r?\n)(```(?:json)?\r?\n)([\s\S]*?\r?\n)(```)/gi;
    let preservedContext = "";
    const contextFileNames = [
      "MEMORY.md", "USER.md", "AGENT.md", "CLAUDE.md", "WORKSPACE.md",
      "RULES.md", "SYSTEM.md", "PROFILE.md", "SOUL.md", "IDENTITY.md",
      "IDENTIFY.md",
      "memory.md", "user.md", "agent.md", "soul.md", "identity.md",
      "identify.md",
      "claude.md", "workspace.md", "rules.md", "agent", "soul", "identity",
      "identify",
      // OpenClaw specific
      "AGENTS.md", "TOOLS.md",
    ];

    text = text.replace(jsonBlockPat, (match, _prefix, _codeOpen, jsonBody, _codeClose) => {
      try {
        const jsonContent = jsonBody.trim();
        const parsed = JSON.parse(jsonContent);
        const extractedParts: string[] = [];
        const allKeys = Object.keys(parsed);

        for (const key of allKeys) {
          // Extract base name of the path (handles both forward slash and backslash in keys)
          const baseKey = key.split(/[/\\]/).pop() || "";
          const baseKeyLower = baseKey.toLowerCase();
          
          // Match:
          // 1. In contextFileNames whitelist (e.g. memory, USER.md, agent)
          // 2. Contains path separators (e.g. ~/.openclaw/workspace/custom_prompt)
          // 3. Ends with a file extension (e.g. custom_prompt.txt, package.json)
          const isContextFile = contextFileNames.some(
            (name) => {
              const n = name.toLowerCase();
              return baseKeyLower === n
                || baseKeyLower === n.replace(/\.md$/, '')
                || n.replace(/\.md$/, '') === baseKeyLower;
            }
          ) ||
          key.includes('/') ||
          key.includes('\\') ||
          /\.[a-zA-Z0-9]{1,10}$/.test(baseKey);

          if (isContextFile && typeof parsed[key] === "string" && parsed[key].trim()) {
            extractedParts.push(`[${baseKey}]\n${parsed[key].trim()}`);
          }
        }

        if (extractedParts.length > 0) {
          console.log(`[_stripMetadataPreservingContext] keys found: ${allKeys.join(', ')}`);
          console.log(`[_stripMetadataPreservingContext] extracted ${extractedParts.length} context files: ${extractedParts.map(p => p.split('\n')[0]).join(', ')}`);
          preservedContext += extractedParts.join("\n\n") + "\n\n";
        }
      } catch {
        // JSON parse failed — block will be stripped below
      }
      return ""; // remove the JSON block
    });

    // Fallback: strip any remaining JSON blocks the regex didn't catch (with CRLF support)
    const metadataBlockPattern =
      /[^\n]*\(untrusted(?:\s+metadata|\s*,\s*for\s+context)\):?\s*\r?\n```(?:json)?\r?\n[\s\S]*?\r?\n```/gi;
    text = text.replace(metadataBlockPattern, "");
    text = text.replace(
      /^[^\n]*\(untrusted(?:\s+metadata|\s*,\s*for\s+context)\):[^\n]*$/gim,
      ""
    );

    return (text + (preservedContext ? "\n" + preservedContext.trim() : "")).trim();
  }

  private isMetadataContent(text: string): boolean {
    if (!text) return false;
    const t = text.trim();
    const isMetaStart = t.startsWith('Conversation info (untrusted') ||
      t.startsWith('[Metadata]') ||
      t.startsWith('Conversation context (untrusted');
    if (!isMetaStart) return false;
    // Fixed literal regex blockPat to use single backslashes and support CRLF
    const blockPat = /[^\n]*\(untrusted(?:\s+metadata|\s*,\s*for\s+context)\):?\s*\r?\n```(?:json)?\r?\n[\s\S]*?\r?\n```/gi;
    const stripped = t.replace(blockPat, '').replace(/^\s+/, '').trim();
    return stripped.length === 0;
  }

  private extractLatestUserMessage(messages: any[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        const text = this.cleanContent(messages[i].content);
        if (!text || this.isMetadataContent(text)) continue;
        return text;
      }
    }
    return "";
  }

  private extractChatId(systemContent: string): string | null {
    // Try JSON code block first
    const match = systemContent.match(/```json\s*(\{[\s\S]*?\})\s*```/i);
    if (match) {
      try {
        const parsed = JSON.parse(match[1]);
        if (parsed.chat_id) return parsed.chat_id;
      } catch { /* fall through */ }
    }
    // Fallback: extract "chat_id": "value" directly (OpenClaw embeds chat_id in text)
    const directMatch = systemContent.match(/"chat_id"\s*:\s*"([^"]+)"/);
    if (directMatch) return directMatch[1];
    return null;
  }

  private isSameConversation(oldMsgs: any[], newMsgs: any[]): boolean {
    if (!oldMsgs || oldMsgs.length === 0) return false;
    if (!newMsgs || newMsgs.length === 0) return false;
    if (newMsgs.length <= oldMsgs.length) return false;

    // Guard: If there's a significant jump in message count (e.g., > 5),
    // it's likely a strong indicator of a new session/web window being opened,
    // even if chat_id matches. Force full injection to be safe.
    if (newMsgs.length - oldMsgs.length > 5) return false;

    const oldChatId = oldMsgs[0]?.role === 'system' ? this.extractChatId(oldMsgs[0].content) : null;
    const newChatId = newMsgs[0]?.role === 'system' ? this.extractChatId(newMsgs[0].content) : null;

    if (oldChatId && newChatId) {
      return oldChatId === newChatId;
    }

    for (let i = 0; i < oldMsgs.length; i++) {
      if (oldMsgs[i].role !== newMsgs[i].role) return false;
    }
    return true;
  }

  private getNewMessages(oldMsgs: any[], newMsgs: any[]): any[] {
    if (!oldMsgs || oldMsgs.length === 0) return newMsgs;
    return newMsgs.slice(oldMsgs.length);
  }

  private formatIncrementalPrompt(newMsgs: any[], tools?: any[]): string {
    let prompt = "";
    for (const msg of newMsgs) {
      if (msg.role === "assistant") continue;
      const text = this.cleanContent(msg.content);
      if (!text) continue;
      if (msg.role === "system") continue;

      if (msg.role === "user") {
        prompt += `${text}\n\n`;
      } else if (msg.role === "tool" || msg.role === "function") {
        const toolName = (msg.name || msg.tool_call_id || "tool").replace(/__/g, ':');
        prompt += `[Tool Output (${toolName})]:\n${text}\n\n`;
      }
    }
    if (prompt.trim() && newMsgs.length > 0) {
      const lastMsg = newMsgs[newMsgs.length - 1];
      if (tools && tools.length > 0) {
        // Lightweight tool reminder — names only, not full schemas
        const toolNames = tools.map((t: any) => t.name).join(", ");
        prompt += `\n\n[Tools available: ${toolNames}]`;

        if (lastMsg.role === "tool" || lastMsg.role === "function") {
          prompt += `\n[System Instruction]: Analyze the tool output above. If you need to perform more actions, output the next <tool_call>. Otherwise, provide your final response to the user.`;
        } else {
          prompt += `\n[System Instruction]: If you need to perform an action, you MUST output the next <tool_call>. Otherwise, provide your final response to the user.`;
        }
      } else if (lastMsg.role === "tool" || lastMsg.role === "function") {
        prompt += `\n[System Instruction]: Analyze the tool output above. If you need to perform more actions, output the next <tool_call>. Otherwise, provide your final response to the user.`;
      }
    }
    return prompt.trim();
  }

  formatTranscript(messages: any[], tools?: any[]): string {
    const log = (msg: string) => console.log(`[formatTranscript] ${msg}`);
    log(`IN: ${messages.length} msgs, tools=${tools?.length ?? 0}`);

    // Collect ALL system messages, not just the first one
    const systemMsgs = messages.filter((m: any) => m.role === 'system');
    const rawContent = systemMsgs.length > 0
      ? systemMsgs.map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n\n')
      : '';

    // Combine all system messages into one
    const systemText = systemMsgs.map((m: any) => this.cleanContent(m.content)).filter(Boolean).join('\n\n');
    log(`system msgs found=${systemMsgs.length}, cleanedLen=${systemText.length}`);

    // ── [CacheAligner] Extract dynamic content → stable prefix + dynamic tail
    let dynamicTail = '';
    if (this._limits.enableCacheAligner && systemText) {
      const aligned = this._extractDynamicContext(systemText);
      dynamicTail = aligned.dynamicTail;
    }

    let transcript = "";

    if (tools && tools.length > 0) {
      // ── [URL Handling] Prevent Gemini from timing out on GitHub URLs ─────────
      transcript += `[Important: URL Handling]\n`;
      transcript += `When you encounter a URL in the user's message (especially GitHub URLs), do NOT attempt to process it yourself.\n`;
      transcript += `You MUST use the web_fetch tool to retrieve the content first, then analyze the fetched content.\n`;
      transcript += `IMPORTANT: Output ONLY the tool_call block without any explanatory text or preamble.\n`;
      transcript += `Example correct response: <tool_call>\n{"name": "web_fetch", "arguments": {"url": "https://github.com/..."}}\n</tool_call>\n\n`;

      // ── [Tools] ───────────────────────────────────────────────────────────────
      transcript += `[System Instructions - Available Tools]\n`;
      transcript += `You have access to the following tools. To use a tool, you MUST output a <tool_call> JSON block EXACTLY like this:\n`;
      transcript += `<tool_call>\n{"name": "tool_name", "arguments": {"arg1": "value1"}}\n</tool_call>\n\n`;

      const includedTools = [];
      let currentToolsLen = 0;
      const maxToolsLen = this._limits.maxToolsSectionLength;

      for (const t of tools) {
        const tStr = JSON.stringify(t, null, 2);
        if (currentToolsLen + tStr.length > maxToolsLen && includedTools.length > 0) {
          break;
        }
        includedTools.push(t);
        currentToolsLen += tStr.length;
      }

      let toolsJson = JSON.stringify(includedTools, null, 2);
      const remaining = tools.length - includedTools.length;
      if (remaining > 0) {
        toolsJson += `\n// ... ${remaining} more tools available (not shown for context limit)`;
      }

      transcript += `Available Tools:\n${toolsJson}\n\n`;

      // ── [Media Sending Reminder] Prevent hallucinated "photo sent" claims ─────
      if (this._limits.enableMediaSendReminder) {
        transcript += `[Critical: How to Send Images/Media]\n`;
        transcript += `When sending images or files, you MUST use the MEDIA: prefix with a LOCAL ABSOLUTE PATH.\n`;
        transcript += `Example correct: In a send_message tool call, use "MEDIA:/path/to/your/image_cache/photo.jpg"\n`;
        transcript += `NEVER claim "photo sent" or "image delivered" without actually outputting a valid tool_call.\n`;
        transcript += `NEVER use an external HTTP URL (e.g. Bing URL) as the media path — Telegram cannot fetch it.\n`;
        transcript += `If no local file exists, you MUST first use a tool to download/save the image, then send it.\n\n`;
      }

      // ── [Identity Verification Reminder] Prevent hallucinated identity ─────
      transcript += `[Identity Verification]\n`;
      transcript += `If you catch yourself about to say you are "Gemini", "Claude", or any other AI model, or if you are unsure of your identity, you MUST call a tool to look up your identity definition.\n`;
      transcript += `Use memory_search or similar tools to find: "Who am I? What is my name and persona?"\n`;
      transcript += `Read the results and introduce yourself based on what you find.\n\n`;
    }

    // Prepend the combined system instructions at the top
    if (systemText) {
      const aligned = this._limits.enableCacheAligner
        ? this._extractDynamicContext(systemText)
        : { stable: systemText, dynamicTail: '' };
      transcript += `========== SYSTEM INSTRUCTIONS ==========\n${aligned.stable}${aligned.dynamicTail}\n\n`;
    }

    // ── [Message Selection] Trim oldest messages to fit within context limit ───
    const selectedMessages: any[] = [];
    let currentLength = transcript.length;
    const maxLen = this._limits.maxTranscriptLength;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "system") continue; // Skip system messages here since they are already merged at the top!
      const text = this.cleanContent(msg.content);
      const hasToolCalls = !!(msg.tool_calls && msg.tool_calls.length > 0);
      const addedLen = (text ? text.length : 0) + 50;
      if (currentLength + addedLen > maxLen && selectedMessages.length > 0) break;
      selectedMessages.unshift(msg);
      currentLength += addedLen;
    }

    // ── [Transcript Assembly] ─────────────────────────────────────────────────
    const maxToolOutput = this._limits.maxToolOutputLength;

    for (const msg of selectedMessages) {
      const text = this.cleanContent(msg.content);
      const hasToolCalls = !!(msg.tool_calls && msg.tool_calls.length > 0);
      if (!text && !hasToolCalls) continue;

      if (msg.role === "system") {
        continue; // Skip system messages since they are already merged at the top
      } else if (msg.role === "user") {
        transcript += `--- User ---\n${text}\n\n`;
      } else if (msg.role === "assistant") {
        if (hasToolCalls) {
          transcript += `--- Assistant ---\n`;
          if (text) transcript += `${text}\n`;
          for (const tc of msg.tool_calls!) {
            const origName = tc.function.name.replace(/__/g, ':');
            const args = typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments);
            transcript += `<tool_call>\n{"name": "${origName}", "arguments": ${args}}\n</tool_call>\n`;
          }
          transcript += `\n`;
        } else {
          transcript += `--- Assistant ---\n${text}\n\n`;
        }
      } else if (msg.role === "tool" || msg.role === "function") {
        const toolName = (msg.name || msg.tool_call_id || "tool").replace(/__/g, ':');
        // ContentRouter compression — type-aware truncation
        const rawText = text;
        const compressedText = this._limits.enableContentRouter
          ? this._compressToolOutput(rawText, toolName, maxToolOutput)
          : (rawText.length > maxToolOutput ? rawText.slice(0, maxToolOutput) + `\n... [truncated ${rawText.length - maxToolOutput} chars]` : rawText);
        transcript += `--- Tool Output (${toolName}) ---\n${compressedText}\n\n`;
      }
    }

    const lastRole = messages.length > 0 ? messages[messages.length - 1].role : "";
    if (lastRole === "user" || lastRole === "tool" || lastRole === "function") {
      if (tools && tools.length > 0) {
        transcript += `\n[System Instruction]: Remember, you must use the <tool_call> format for all tool calls. Do not describe your tool call or output any preamble before the tool call.\n`;
      }
      transcript += `[Assistant]:\n`;
    }

    const result = transcript.trim();
    log(`OUT: ${result.length} chars`);
    return result;
  }

  /**
 * CacheAligner: extract dynamic content from the system prompt so the
 * KV-cache-friendly prefix stays stable across requests.
 *
 * Headroom calls this "CacheAligner" — the idea is that providers like
 * Anthropic / OpenAI cache the stable prefix; only the dynamic tail
 * varies between requests.
 *
 * Examples of content we extract as "dynamic":
 *   - [Note: model was just switched ...]
 *   - Current Date: 2024-12-15
 *   - Session: abc-123
 *   - chat_id, timestamps embedded in text
 *
 * The stable part goes FIRST (what the LLM sees on every request).
 * The dynamic tail goes LAST (unchanged unless something actually changed).
 */
private _extractDynamicContext(text: string): { stable: string; dynamicTail: string } {
  const dynamicItems: string[] = [];

  // Pattern 1: [Note: model was just switched ...] — transient, not meaningful to LLM
  text = text.replace(/\[Note:.*?model was just switched.*?\]/gi, (match) => {
    dynamicItems.push(match);
    return '';
  });

  // Pattern 2: Timestamps and dates (loose matching)
  // Matches: "Date: 2024-12-15", "下午5點10分", "17:30", "2024年12月15日", unix timestamps
  text = text.replace(
    /(?:Date|日期|時間|Time|Timestamp)[\s:：]*[\d\w\u4e00-\u9fff:：\-/\s年月日點分秒上午下午UTC]+/gi,
    (match) => {
      const trimmed = match.trim();
      if (trimmed.length > 3) dynamicItems.push(trimmed);
      return '';
    }
  );

  // Pattern 3: Explicit [Dynamic: ...] blocks (if user/admin annotated them)
  text = text.replace(/\[Dynamic[\s:：]*([^\]]+)\]/gi, (_match, content) => {
    dynamicItems.push(content.trim());
    return '';
  });

  // Pattern 4: Standalone chat_id / session_token lines
  text = text.replace(/^\s*(?:chat_id|session|session_id|conversation_id)[\s:：]+[^\n]+/gim, (match) => {
    dynamicItems.push(match.trim());
    return '';
  });

  // Clean up any triple+ newlines left by removals
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  const dynamicTail = dynamicItems.length > 0
    ? `\n\n[Dynamic Context: ${dynamicItems.join(' | ')}]`
    : '';

  return { stable: text, dynamicTail };
}

/**
 * ContentRouter: detect the type of a tool's raw output and pick the
 * right compression strategy.
 *
 * Returns one of:
 *   'json-array'  — JSON array (search results, file listings, etc.)
 *   'error-log'   — log output with repeated patterns (build logs, test output)
 *   'web-fetch'   — HTML / Markdown fetched from a URL
 *   'plain'       — everything else (plain text, mixed content)
 */
private _detectContentType(text: string): 'json-array' | 'error-log' | 'web-fetch' | 'plain' {
  const trimmed = text.trim();

  // Heuristic: starts with [ or { followed by JSON-like content → JSON array
  if (/^\[/.test(trimmed) && trimmed.includes('}')) {
    try {
      const parsed = JSON.parse(trimmed.startsWith('[') ? trimmed : `[${trimmed}]`);
      if (Array.isArray(parsed)) return 'json-array';
    } catch { /* fall through */ }
  }

  // Heuristic: HTML tags present → web fetch
  if (/<html|<body|<div|<p>|<a href|<head>/i.test(trimmed) ||
      trimmed.includes('<!DOCTYPE') || trimmed.includes('</html>')) {
    return 'web-fetch';
  }

  // Heuristic: Markdown links and headings → web fetch (extracted markdown)
  if (/^#{1,6}\s+\S/m.test(trimmed) && trimmed.includes('[') && trimmed.includes('](http')) {
    return 'web-fetch';
  }

  // Heuristic: error log — has multiple lines with ERROR, WARN, FATAL, FAIL, or
  // line-number prefixes like [INFO] / [ERROR] / [2024-01-01 12:00:00]
  const errorLines = (trimmed.match(/^\[?(?:ERROR|WARN(?:ING)?|FATAL|FAIL|CRITICAL)\]?/im) || []).length;
  const timestampLines = (trimmed.match(/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}/m) || []).length;
  if (errorLines >= 2 || (timestampLines >= 3 && errorLines >= 1)) {
    return 'error-log';
  }

  return 'plain';
}

/**
 * ContentRouter compression strategies.
 *
 * json-array:
 *   Keep 30% head (schema), 15% tail (recency), 55% by statistical importance
 *   (items with highest uniqueness / variance scores).
 *
 * error-log:
 *   Cluster by error pattern prefix, keep one representative per cluster,
 *   always preserve lines containing ERROR / FATAL / uncaught.
 *
 * web-fetch:
 *   Try to keep only meaningful text (strip HTML noise). Head + tail preserved.
 *
 * plain:
 *   Simple head + tail split: keep first 60% and last 20% of content,
 *   ensuring no single line is split in the middle.
 */
private _compressToolOutput(text: string, _toolName: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  const type = this._detectContentType(text);

  if (type === 'json-array') {
    return this._compressJsonArray(text, maxLen);
  } else if (type === 'error-log') {
    return this._compressErrorLog(text, maxLen);
  } else {
    return this._compressPlainText(text, maxLen);
  }
}

/** Pick a representative subset from a JSON array using Kneedle-like heuristics. */
private _compressJsonArray(text: string, maxLen: number): string {
  let parsed: any[];
  try {
    parsed = JSON.parse(text);
  } catch {
    return this._compressPlainText(text, maxLen);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    return this._compressPlainText(text, maxLen);
  }

  const total = parsed.length;
  // Split: 30% head, 15% tail, 55% body (importance-sampled)
  const headCount = Math.max(1, Math.floor(total * 0.30));
  const tailCount = Math.max(1, Math.floor(total * 0.15));
  const bodyCount = total - headCount - tailCount;

  if (total <= 10) {
    // Small arrays — just head+tail, cheap and safe
    const kept = [...parsed.slice(0, headCount), ...parsed.slice(-tailCount)];
    const result = JSON.stringify(kept, null, 2);
    return result.length <= maxLen ? result : this._compressPlainText(text, maxLen);
  }

  // Body sampling: score each item by "uniqueness" — number of unique keys
  // and string-length variance compared to the array average
  const bodyItems = parsed.slice(headCount, total - tailCount);
  const scored = bodyItems.map((item, idx) => {
    const keys = typeof item === 'object' && item !== null ? Object.keys(item) : [];
    const uniqueKeyRatio = keys.length / Math.max(1, Object.values(parsed[headCount] || {}).length);
    const stringLens = typeof item === 'object' && item !== null
      ? Object.values(item).filter(v => typeof v === 'string').map((v: string) => v.length)
      : [String(item).length];
    const avgLen = stringLens.reduce((a, b) => a + b, 0) / Math.max(1, stringLens.length);
    const variance = stringLens.reduce((s, l) => s + Math.abs(l - avgLen), 0) / Math.max(1, stringLens.length);
    // Error-like items score higher (they are preserved unconditionally later)
    const hasError = typeof item === 'object' && item !== null
      ? JSON.stringify(item).toLowerCase().includes('error')
      : String(item).toLowerCase().includes('error');
    return { item, idx, score: uniqueKeyRatio * 0.5 + variance * 0.3 + (hasError ? 2 : 0) };
  });

  // Sort body by score descending, pick top bodyCount
  scored.sort((a, b) => b.score - a.score);
  const sampledBody = scored.slice(0, bodyCount).map(s => s.item).sort((a, b) => {
    // Restore approximate original order within body
    return bodyItems.indexOf(a) - bodyItems.indexOf(b);
  });

  const kept = [
    ...parsed.slice(0, headCount),
    ...sampledBody,
    ...parsed.slice(-tailCount),
  ];

  let result = JSON.stringify(kept, null, 2);

  // If still over budget, fall back to simple head+tail
  if (result.length > maxLen) {
    const simpleKept = [...parsed.slice(0, headCount), ...parsed.slice(-tailCount)];
    result = JSON.stringify(simpleKept, null, 2);
    if (result.length > maxLen) {
      return this._compressPlainText(result, maxLen);
    }
  }

  // Append how many were omitted
  const omitted = total - kept.length;
  if (omitted > 0) {
    const suffix = `\n// ... ${omitted} items omitted (total: ${total})`;
    if (result.length + suffix.length <= maxLen) {
      result += suffix;
    }
  }

  return result;
}

/** Cluster error lines by their error prefix, keep one per cluster. */
private _compressErrorLog(text: string, maxLen: number): string {
  const lines = text.split('\n');

  // Always-keep patterns (critical errors)
  const alwaysKeep = (line: string) =>
    /\[?(?:FATAL|ERROR|uncaught|exception|crashed|failed)\]?/i.test(line) &&
    !/^info.*\(not an error\)/i.test(line);

  if (lines.length <= 20) return text; // short logs: no compression needed

  // Group by "error family" — first significant word after [ or at start
  const groups = new Map<string, { lines: string[]; kept: string | null }>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Extract error family key
    const keyMatch = trimmed.match(/^\[([A-Z]+)\]|\<([A-Z_]+)\>|^([A-Z]{3,}):/);
    const key = keyMatch
      ? (keyMatch[1] || keyMatch[2] || keyMatch[3] || 'OTHER').toUpperCase()
      : 'OTHER';

    if (!groups.has(key)) groups.set(key, { lines: [], kept: null });
    const grp = groups.get(key)!;
    grp.lines.push(trimmed);

    // Always keep critical errors
    if (!grp.kept && alwaysKeep(trimmed)) {
      grp.kept = trimmed;
    } else if (!grp.kept) {
      // Keep first occurrence as representative
      grp.kept = trimmed;
    }
  }

  // Build output: always-kept lines first, then one representative per cluster
  const outLines: string[] = [];
  for (const [, grp] of groups) {
    if (grp.kept) outLines.push(grp.kept);
  }

  // Add "X similar errors omitted" note
  const totalInputLines = lines.filter(l => l.trim()).length;
  const omitted = totalInputLines - outLines.length;
  let result = outLines.join('\n');
  if (omitted > 0) {
    const suffix = `\n// ... ${omitted} similar log lines omitted (total: ${totalInputLines})`;
    if (result.length + suffix.length <= maxLen) result += suffix;
  }

  return result.length <= maxLen ? result : this._compressPlainText(text, maxLen);
}

/**
 * Plain-text / fallback compression:
 * Preserve meaningful structure by keeping:
 *   - First 60% of content (head)
 *   - Last 20% of content (tail)
 * Ensure we don't split a line in the middle.
 */
private _compressPlainText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;

  const headRatio = 0.65;
  const tailRatio = 0.25;
  const headTarget = Math.floor(text.length * headRatio);
  const tailTarget = Math.floor(text.length * tailRatio);

  // Find the best split point near headTarget (end of a line)
  let headEnd = text.indexOf('\n', headTarget);
  if (headEnd === -1 || headEnd > text.length * 0.85) headEnd = headTarget;

  // Find tail start (last \n before reaching tailTarget from end)
  let tailStart = text.lastIndexOf('\n', text.length - tailTarget);
  if (tailStart === -1) tailStart = text.length - tailTarget;

  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);

  const separator = `\n// ... [${text.length - head.length - tail.length} chars omitted] ...\n`;
  let result = head + (headEnd < text.length - tail.length ? separator : '') + tail;

  // If still over budget, linear truncation from the middle of the separator
  if (result.length > maxLen) {
    const overBy = result.length - maxLen;
    const truncatedSep = `\n// ... [${text.length - head.length - tail.length} chars omitted] ...\n`;
    result = head.slice(0, head.length - overBy) + truncatedSep + tail;
  }

  return result;
  }

  determinePromptStrategy(session: any, messages: any[], tools?: any[]): { text: string; requireNewChat: boolean } {
    if (!messages || messages.length === 0) return { text: "", requireNewChat: false };

    // ── Step 1: Extract chat_id ──────────────────────────────────────────────
    // Primary: from system message (Hermes style)
    let newChatId: string | null = null;
    const systemMsg = messages.find((m: any) => m.role === 'system');
    if (systemMsg) {
      newChatId = this.extractChatId(systemMsg.content) ?? null;
    }
    // Fallback: from user messages (OpenClaw style — JSON block in user content)
    if (!newChatId) {
      for (const m of messages) {
        if (m.role === 'user' && typeof m.content === 'string') {
          const fromUser = this.extractChatId(m.content);
          if (fromUser) { newChatId = fromUser; break; }
        }
      }
    }

    if (!newChatId) {
      newChatId = "default-session";
    }
    const oldChatId = session.getLastChatId();

    // ── Step 2: Detect explicit NEW CHAT signals ─────────────────────────────
    const lastMsg = messages[messages.length - 1];
    const lastUserText = (lastMsg?.role === 'user' && typeof lastMsg.content === 'string')
      ? lastMsg.content
      : "";

    // Signal A: /new command in the latest user message
    const hasNewCommand = /\b\/new\b/i.test(lastUserText);
    // Signal B: No prior chat_id stored → first request ever or session was reset
    const isFirstRequest = oldChatId === null;
    
    // Signal C: chat_id changed → different conversation thread
    const chatIdChanged = !isFirstRequest && newChatId !== null && newChatId !== oldChatId;

    // Signal D: system prompt changed → reload required (e.g. MEMORY.md, AGENTS.md modified)
    const oldMsgs = session.getLastProcessedMessages() || [];
    const oldSystemMsgs = oldMsgs.filter((m: any) => m.role === 'system');
    const newSystemMsgs = messages.filter((m: any) => m.role === 'system');
    const oldSystemText = oldSystemMsgs.map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n\n');
    const newSystemText = newSystemMsgs.map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n\n');
    const systemPromptChanged = !isFirstRequest && oldSystemText !== newSystemText;

    console.log(`[DEBUG determinePromptStrategy] newChatId=${newChatId}, oldChatId=${oldChatId}, isFirstRequest=${isFirstRequest}, chatIdChanged=${chatIdChanged}, systemPromptChanged=${systemPromptChanged}`);

    const needFullInjection = hasNewCommand || isFirstRequest || chatIdChanged || systemPromptChanged;

    if (needFullInjection) {
      console.log(`[PromptEngine] Full injection (newCmd=${hasNewCommand}, first=${isFirstRequest}, chatIdChanged=${chatIdChanged}, sysPromptChanged=${systemPromptChanged})`);
      session.setLastChatId(newChatId);
      return { text: this.formatTranscript(messages, tools), requireNewChat: true };
    }

    // ── Step 3: Incremental — diff messages to find new updates ──────────────
    if (this.isSameConversation(oldMsgs, messages)) {
      const newMsgs = this.getNewMessages(oldMsgs, messages);
      const newText = this.formatIncrementalPrompt(newMsgs, tools);
      if (newText) {
        console.log(`[PromptEngine] Incremental (chatId=${newChatId ?? 'none'}), newText length=${newText.length}`);
        session.setLastChatId(newChatId);
        return { text: newText, requireNewChat: false };
      }
      
      // Fallback: if no new text (e.g. metadata only), check for last user message
      const lastUser = this.extractLatestUserMessage(messages);
      if (lastUser) {
        console.log(`[PromptEngine] Incremental Fallback (chatId=${newChatId ?? 'none'}), userMsg=${lastUser.substring(0, 50)}...`);
        session.setLastChatId(newChatId);
        return { text: lastUser, requireNewChat: false };
      }
    }

    // Fall back to full injection if not same conversation or no messages found
    console.log(`[PromptEngine] Diverged or empty continuation → full injection`);
    session.setLastChatId(newChatId);
    return { text: this.formatTranscript(messages, tools), requireNewChat: true };
  }
}