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
          partText = this._stripMetadataPreservingContext(partText);
          return partText;
        });
      text = strippedParts.join("\\n");
    }

    text = this._stripMetadataPreservingContext(text);
    text = text.replace(/^\[Metadata\][^\n]*$/gim, '');
    text = text.replace(/\n{3,}/g, '\\n\\n').trim();

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
      "memory.md", "user.md", "agent.md", "soul.md", "identity.md",
      "claude.md", "workspace.md", "rules.md", "agent", "soul", "identity"
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
    const match = systemContent.match(/```json\\s*(\\{[\\s\\S]*?\\})\\s*```/i);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[1]);
      return parsed.chat_id ?? null;
    } catch {
      return null;
    }
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
        prompt += `${text}\\n\\n`;
      } else if (msg.role === "tool" || msg.role === "function") {
        const toolName = (msg.name || msg.tool_call_id || "tool").replace(/__/g, ':');
        prompt += `[Tool Output (${toolName})]:\\n${text}\\n\\n`;
      }
    }
    if (prompt.trim() && newMsgs.length > 0) {
      const lastMsg = newMsgs[newMsgs.length - 1];
      if (tools && tools.length > 0) {
        const toolsJson = JSON.stringify(tools, null, 2);
        prompt += `\\n[System Instructions - Available Tools]\\n`;
        prompt += `You have access to the following tools. To use a tool, you MUST output a <tool_call> JSON block EXACTLY like this:\\n`;
        prompt += `<tool_call>\\n{"name": "tool_name", "arguments": {"arg1": "value1"}}\\n</tool_call>\\n\\n`;
        prompt += `Available Tools:\\n${toolsJson}\\n\\n`;

        if (lastMsg.role === "tool" || lastMsg.role === "function") {
          prompt += `[System Instruction]: Analyze the tool output above. If you need to perform more actions, output the next <tool_call>. Otherwise, provide your final response to the user.`;
        } else {
          prompt += `[System Instruction]: If you need to perform an action, you MUST output the next <tool_call>. Otherwise, provide your final response to the user.`;
        }
      } else if (lastMsg.role === "tool" || lastMsg.role === "function") {
        prompt += `\\n[System Instruction]: Analyze the tool output above. If you need to perform more actions, output the next <tool_call>. Otherwise, provide your final response to the user.`;
      }
    }
    return prompt.trim();
  }

  formatTranscript(messages: any[], tools?: any[]): string {
    const log = (msg: string) => console.log(`[formatTranscript] ${msg}`);
    log(`IN: ${messages.length} msgs, tools=${tools?.length ?? 0}`);

    const systemMsg = messages.find((m: any) => m.role === 'system');
    const rawContent = systemMsg ? (typeof systemMsg.content === 'string' ? systemMsg.content : JSON.stringify(systemMsg.content)) : '';
    if (rawContent.includes('memory') || rawContent.includes('user') || rawContent.includes('MEMORY') || rawContent.includes('SOUL')) {
      console.log('[DEBUG raw system content PREVIEW]:', rawContent.substring(0, 800));
    }
    const systemText = systemMsg ? this.cleanContent(systemMsg.content) : '';
    log(`system msg found=${!!systemMsg}, cleanedLen=${systemText.length}`);

    let transcript = "";

    if (tools && tools.length > 0) {
      // ── [URL Handling] Prevent Gemini from timing out on GitHub URLs ─────────
      transcript += `[Important: URL Handling]\\n`;
      transcript += `When you encounter a URL in the user's message (especially GitHub URLs), do NOT attempt to process it yourself.\\n`;
      transcript += `You MUST use the web_fetch tool to retrieve the content first, then analyze the fetched content.\\n`;
      transcript += `IMPORTANT: Output ONLY the tool_call block without any explanatory text or preamble.\\n`;
      transcript += `Example correct response: <tool_call>\\n{"name": "web_fetch", "arguments": {"url": "https://github.com/..."}}\\n</tool_call>\\n`;
      transcript += `Example WRONG response: "Let me fetch that URL for you..." <tool_call>...\\n</tool_call>\\n\\n`;

      // ── [Tools] ───────────────────────────────────────────────────────────────
      transcript += `[System Instructions - Available Tools]\\n`;
      transcript += `You have access to the following tools. To use a tool, you MUST output a <tool_call> JSON block EXACTLY like this:\\n`;
      transcript += `<tool_call>\\n{"name": "tool_name", "arguments": {"arg1": "value1"}}\\n</tool_call>\\n\\n`;

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

      transcript += `Available Tools:\\n${toolsJson}\\n\\n`;

      // ── [Media Sending Reminder] Prevent hallucinated "photo sent" claims ─────
      if (this._limits.enableMediaSendReminder) {
        transcript += `[Critical: How to Send Images/Media]\\n`;
        transcript += `When sending images or files, you MUST use the MEDIA: prefix with a LOCAL ABSOLUTE PATH.\\n`;
        transcript += `Example correct: In a send_message tool call, use "MEDIA:/home/yywang/.hermes/image_cache/photo.jpg"\\n`;
        transcript += `NEVER claim "photo sent" or "image delivered" without actually outputting a valid tool_call.\\n`;
        transcript += `NEVER use an external HTTP URL (e.g. Bing URL) as the media path — Telegram cannot fetch it.\\n`;
        transcript += `If no local file exists, you MUST first use a tool to download/save the image, then send it.\\n\\n`;
      }
    }

    // ── [Message Selection] Trim oldest messages to fit within context limit ───
    const selectedMessages: any[] = [];
    let currentLength = transcript.length;
    const maxLen = this._limits.maxTranscriptLength;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
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
        transcript += `========== SYSTEM INSTRUCTIONS ==========\\n${text}\\n\\n`;
      } else if (msg.role === "user") {
        transcript += `--- User ---\\n${text}\\n\\n`;
      } else if (msg.role === "assistant") {
        if (hasToolCalls) {
          transcript += `--- Assistant ---\\n`;
          if (text) transcript += `${text}\\n`;
          for (const tc of msg.tool_calls!) {
            const origName = tc.function.name.replace(/__/g, ':');
            const args = typeof tc.function.arguments === 'string'
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments);
            transcript += `<tool_call>\\n{"name": "${origName}", "arguments": ${args}}\\n</tool_call>\\n`;
          }
          transcript += `\\n`;
        } else {
          transcript += `--- Assistant ---\\n${text}\\n\\n`;
        }
      } else if (msg.role === "tool" || msg.role === "function") {
        const toolName = (msg.name || msg.tool_call_id || "tool").replace(/__/g, ':');
        const truncatedText = text.length > maxToolOutput
          ? text.slice(0, maxToolOutput) + `\\n... [truncated ${text.length - maxToolOutput} chars]`
          : text;
        transcript += `--- Tool Output (${toolName}) ---\\n${truncatedText}\\n\\n`;
      }
    }

    const lastRole = messages.length > 0 ? messages[messages.length - 1].role : "";
    if (lastRole === "user" || lastRole === "tool" || lastRole === "function") {
      if (tools && tools.length > 0) {
        transcript += `\\n[System Instruction]: Remember, you must use the <tool_call> format for all tool calls. Do not describe your tool call or output any preamble before the tool call.\\n`;
      }
      transcript += `[Assistant]:\\n`;
    }

    const result = transcript.trim();
    log(`OUT: ${result.length} chars`);
    return result;
  }

  determinePromptStrategy(session: any, messages: any[], tools?: any[]): { text: string; requireNewChat: boolean } {
    if (!messages || messages.length === 0) return { text: "", requireNewChat: false };
    const oldMsgs = session.getLastProcessedMessages() || [];
    console.log(`[PromptEngine] determinePromptStrategy: ${messages.length} msgs, oldMsgs=${oldMsgs.length}`);

    const stripModelSwitchNotes = (content: any): string => {
      const raw = typeof content === 'string' ? content : JSON.stringify(content ?? '');
      return raw.replace(/\\[Note: model was just switched[^\\]]*\\]\\s*/gi, '').trim();
    };
    const oldSystem = oldMsgs.find((m: any) => m.role === 'system')?.content;
    const newSystem = messages.find((m: any) => m.role === 'system')?.content;
    const oldSystemNorm = stripModelSwitchNotes(oldSystem ?? '');
    const newSystemNorm = stripModelSwitchNotes(newSystem ?? '');
    const systemChanged = oldSystemNorm !== newSystemNorm;

    if (systemChanged) {
      const sameChatId = this.isSameConversation(oldMsgs, messages);
      if (sameChatId) {
        console.log(`[PromptEngine] SYSTEM CHANGED but same chat_id → incremental`);
        const newMsgsList = this.getNewMessages(oldMsgs, messages);
        const newText = this.formatIncrementalPrompt(newMsgsList, tools);
        if (newText && !this.isMetadataContent(newText)) {
          return { text: newText, requireNewChat: false };
        }
      }
      console.log(`[PromptEngine] SYSTEM CHANGED → full injection`);
      return { text: this.formatTranscript(messages, tools), requireNewChat: true };
    }

    const same = this.isSameConversation(oldMsgs, messages);
    console.log(`[PromptEngine] isSameConversation=${same}`);

    if (same) {
      const newMsgsList = this.getNewMessages(oldMsgs, messages);
      const newText = this.formatIncrementalPrompt(newMsgsList, tools);
      if (newText && !this.isMetadataContent(newText)) return { text: newText, requireNewChat: false };

      const hasNewUserContent = newMsgsList.some((m: any) =>
        m.role === 'user' && !this.isMetadataContent(this.cleanContent(m.content))
      );
      if (!hasNewUserContent) {
        console.log(`[PromptEngine] NO real user content → full injection (same conv)`);
        return { text: this.formatTranscript(messages, tools), requireNewChat: false };
      }
      const lastUser = this.extractLatestUserMessage(messages);
      if (lastUser) {
        let text = lastUser;
        if (tools && tools.length > 0) {
          const toolsJson = JSON.stringify(tools, null, 2);
          text += `\\n\\n[System Instructions - Available Tools]\\n`;
          text += `You have access to the following tools. To use a tool, you MUST output a <tool_call> JSON block EXACTLY like this:\\n`;
          text += `<tool_call>\\n{"name": "tool_name", "arguments": {"arg1": "value1"}}\\n</tool_call>\\n\\n`;
          text += `Available Tools:\\n${toolsJson}\\n\\n`;
          text += `[System Instruction]: If you need to perform an action, you MUST output the next <tool_call>. Otherwise, provide your final response to the user.`;
        }
        return { text, requireNewChat: false };
      }
    }

    console.log(`[PromptEngine] FALLBACK → full injection`);
    return { text: this.formatTranscript(messages, tools), requireNewChat: true };
  }
}