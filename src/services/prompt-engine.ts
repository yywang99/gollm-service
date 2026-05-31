/**
 * Prompt Engine
 * 
 * Responsible for all text manipulation, prompt assembly, and tool truncation.
 * Decoupled from RPA execution to ensure that prompt logic can be tested and 
 * evolved independently of the Playwright driver.
 */

export class PromptEngine {
  private readonly MAX_TRANSCRIPT_LENGTH = 30000;  // Reduced from 80000 — Gemini hangs on >50KB context
  private readonly MAX_TOOLS_SECTION_LENGTH = 8000;
  private readonly MAX_TOOL_OUTPUT_LENGTH = 3000;   // Per-message cap: prevents a single cat/ls from eating 35KB

  /**
   * Strips metadata from both OpenClaw and Hermes style messages.
   */
  cleanContent(content: string | any[]): string {
    if (!content) return "";
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      // Strip metadata from each part BEFORE joining, so the resulting text
      // doesn't start with a metadata header even when user text follows it.
      const strippedParts = content
        .filter((p: any) => p.type === "text")
        .map((p: any) => {
          let partText = p.text || "";
          // Remove the multi-line metadata block from this part
          const blockPat = /[^\\n]*\\(untrusted(?:\\s+metadata|\\s*,\\s*for\\s+context)\\):?\\s*\\n```(?:json)?\\n[\\s\\S]*?\\n```/gi;
          partText = partText.replace(blockPat, '');
          return partText;
        });
      text = strippedParts.join("\\n");
    }

    // 1. Strip remaining OpenClaw multi-line metadata blocks (covers string path + edge cases)
    const metadataBlockPattern = /[^\\n]*\\(untrusted(?:\\s+metadata|\\s*,\\s*for\\s+context)\\):?\\s*\\n```(?:json)?\\n[\\s\\S]*?\\n```/gi;
    text = text.replace(metadataBlockPattern, '');

    // 2. Strip remaining single-line metadata headers
    text = text.replace(/^[^\\n]*\\(untrusted(?:\\s+metadata|\\s*,\\s*for\\s+context)\\):[^\\n]*$/gim, '');
    text = text.replace(/^\\[Metadata\\][^\\n]*$/gim, '');
    text = text.replace(/\\n{3,}/g, '\\n\\n').trim();

    return text;
  }

  private isMetadataContent(text: string): boolean {
    if (!text) return false;
    const t = text.trim();
    const isMetaStart = t.startsWith('Conversation info (untrusted') ||
      t.startsWith('[Metadata]') ||
      t.startsWith('Conversation context (untrusted');
    if (!isMetaStart) return false;
    // It's metadata-starting. Strip the block and check if anything real remains.
    // This handles cases where cleanContent's regex missed the block format,
    // but real user content follows the metadata block.
    const blockPat = /[^\\n]*\\(untrusted(?:\\s+metadata|\\s*,\\s*for\\s+context)\\):?\\s*\\n```(?:json)?\\n[\\s\\S]*?\\n```/gi;
    const stripped = t.replace(blockPat, '').replace(/^\\s+/, '').trim();
    return stripped.length === 0;
  }

  private extractLatestUserMessage(messages: any[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        const text = this.cleanContent(messages[i].content);
        // If the extracted text is just metadata (no real user content), ignore it.
        // This handles the case where OpenClaw sends a metadata block as a user message
        // after RPA restart — we want to fall through to full injection instead.
        if (!text || this.isMetadataContent(text)) continue;
        return text;
      }
    }
    return "";
  }

  private extractChatId(systemContent: string): string | null {
    // OpenClaw metadata block: Conversation info (untrusted metadata):\n```json\n{...}\n```
    // Extract the first JSON block and read its "chat_id" field.
    const match = systemContent.match(/```json\s*(\{[\s\S]*?\})\s*```/i);
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

    // Stable conversation identity via chat_id from OpenClaw metadata JSON.
    // Fallback to role-sequence comparison if no chat_id found.
    const oldChatId = oldMsgs[0]?.role === 'system' ? this.extractChatId(oldMsgs[0].content) : null;
    const newChatId = newMsgs[0]?.role === 'system' ? this.extractChatId(newMsgs[0].content) : null;

    if (oldChatId && newChatId) {
      return oldChatId === newChatId;
    }

    // Fallback: role sequence comparison (stable for same conversation)
    for (let i = 0; i < oldMsgs.length; i++) {
      if (oldMsgs[i].role !== newMsgs[i].role) return false;
    }
    return true;
  }

  private getNewMessages(oldMsgs: any[], newMsgs: any[]): any[] {
    if (!oldMsgs || oldMsgs.length === 0) return newMsgs;
    return newMsgs.slice(oldMsgs.length);
  }

  private formatIncrementalPrompt(newMsgs: any[]): string {
    let prompt = "";
    for (const msg of newMsgs) {
      if (msg.role === "assistant") continue;
      const text = this.cleanContent(msg.content);
      if (!text) continue;

      // Skip system messages in incremental mode — the full transcript on first turn
      // already established the system context. Re-injecting it every turn causes
      // Gemini to re-process it and can interfere with conversation continuity.
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
      if (lastMsg.role === "tool" || lastMsg.role === "function") {
        prompt += `\\n[System Instruction]: Analyze the tool output above. If you need to perform more actions, output the next <tool_call>. Otherwise, provide your final response to the user.`;
      }
    }
    return prompt.trim();
  }

  formatTranscript(messages: any[], tools?: any[]): string {
    // DEBUG: log message count and size going into formatTranscript
    console.log(`[formatTranscript] IN: ${messages.length} msgs, tools=${tools?.length ?? 0}`);
    const systemMsg = messages.find((m: any) => m.role === 'system');
    const systemText = systemMsg ? this.cleanContent(systemMsg.content) : '';
    console.log(`[formatTranscript] system msg found=${!!systemMsg}, cleanedLen=${systemText.length}`);
    let transcript = "";
    
    if (tools && tools.length > 0) {
      // ── [URL Handling] General guidance to prevent timeout ────────────────────
      transcript += `[Important: URL Handling]\n`;
      transcript += `When you encounter a URL in the user's message (especially GitHub URLs), do NOT attempt to process it yourself.\n`;
      transcript += `You MUST use the web_fetch tool to retrieve the content first, then analyze the fetched content.\n`;
      transcript += `IMPORTANT: Output ONLY the tool_call block without any explanatory text or preamble.\n`;
      transcript += `Example correct response: <tool_call>\n{"name": "web_fetch", "arguments": {"url": "https://github.com/..."}}\n</tool_call>\n`;
      transcript += `Example WRONG response: "Let me fetch that URL for you..." <tool_call>...\n</tool_call>\n\n`;

      transcript += `[System Instructions - Available Tools]\\n`;
      transcript += `You have access to the following tools. To use a tool, you MUST output a <tool_call> JSON block EXACTLY like this:\\n`;
      transcript += `<tool_call>\\n{\"name\": \"tool_name\", \"arguments\": {\"arg1\": \"value1\"}}\\n</tool_call>\\n\\n`;
      
      const includedTools = [];
      let currentToolsLen = 0;
      for (const t of tools) {
        const tStr = JSON.stringify(t, null, 2);
        if (currentToolsLen + tStr.length > this.MAX_TOOLS_SECTION_LENGTH && includedTools.length > 0) {
          break;
        }
        includedTools.push(t);
        currentToolsLen += tStr.length;
      }
      
      let toolsJson = JSON.stringify(includedTools, null, 2);
      const remaining = tools.length - includedTools.length;
      if (remaining > 0) {
        toolsJson += `\\n// ... ${remaining} more tools available (not shown for context limit)`;
      }
      
      transcript += `Available Tools:\\n${toolsJson}\\n\\n`;
    }

    const selectedMessages: any[] = [];
    let currentLength = transcript.length;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const text = this.cleanContent(msg.content);
      const hasToolCalls = !!(msg.tool_calls && msg.tool_calls.length > 0);
      const addedLen = (text ? text.length : 0) + 50;
      if (currentLength + addedLen > this.MAX_TRANSCRIPT_LENGTH && selectedMessages.length > 0) break;
      selectedMessages.unshift(msg);
      currentLength += addedLen;
    }

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
            const args = typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
            transcript += `<tool_call>\\n{"name": "${origName}", "arguments": ${args}}\\n</tool_call>\\n`;
          }
          transcript += `\\n`;
        } else {
          transcript += `--- Assistant ---\\n${text}\\n\\n`;
        }
      } else if (msg.role === "tool" || msg.role === "function") {
        const toolName = (msg.name || msg.tool_call_id || "tool").replace(/__/g, ':');
        // Truncate very large tool outputs (e.g. cat <large_file>) to prevent context overflow
        const truncatedText = text.length > this.MAX_TOOL_OUTPUT_LENGTH
          ? text.slice(0, this.MAX_TOOL_OUTPUT_LENGTH) + `\n... [truncated ${text.length - this.MAX_TOOL_OUTPUT_LENGTH} chars]`
          : text;
        transcript += `--- Tool Output (${toolName}) ---\\n${truncatedText}\\n\\n`;
      }
    }

    

const lastRole = messages.length > 0 ? messages[messages.length - 1].role : "";
    if (lastRole === "user" || lastRole === "tool" || lastRole === "function") {
      transcript += `[Assistant]:\n`;
    }

    const result = transcript.trim();
    console.log(`[formatTranscript] OUT: ${result.length} chars, systemPrefix=${result.includes('[Instructions]:') ? 'YES' : 'NO'}`);
    return result;
  }

  determinePromptStrategy(session: any, messages: any[], tools?: any[]): { text: string; requireNewChat: boolean } {
    if (!messages || messages.length === 0) return { text: "", requireNewChat: false };
    const oldMsgs = session.getLastProcessedMessages() || [];
    console.log(`[PromptEngine] determinePromptStrategy: ${messages.length} msgs, oldMsgs=${oldMsgs.length}, tools=${tools?.length ?? 0}`);

// CRITICAL: Check if the system prompt has changed.
    // Even if the same chat_id, a change in the system prompt (e.g. after RPA restart or config update)
    // must trigger a new chat to ensure the new instructions are applied.
    // EXCEPTION: Hermes injects transient model-switch notes like:
    //   "[Note: model was just switched from X to Y via Z. Adjust...]"
    // These are NOT real system changes — strip them before comparing.
    const stripModelSwitchNotes = (content: any): string => {
      const raw = typeof content === 'string' ? content : JSON.stringify(content ?? '');
      return raw.replace(/\[Note: model was just switched[^\]]*\]\s*/gi, '').trim();
    };
    const oldSystem = oldMsgs.find((m: any) => m.role === 'system')?.content;
    const newSystem = messages.find((m: any) => m.role === 'system')?.content;
    const oldSystemNorm = stripModelSwitchNotes(oldSystem ?? '');
    const newSystemNorm = stripModelSwitchNotes(newSystem ?? '');
    const systemChanged = oldSystemNorm !== newSystemNorm;
    console.log(`[PromptEngine] system check: oldLen=${oldSystem?.length ?? 0}, newLen=${newSystem?.length ?? 0}, changed=${systemChanged}`);
    if (systemChanged) {
      // Check if it's the same conversation despite system change (chat_id match).
      // If same conversation, use incremental mode — avoid 78KB full re-injection.
      const sameChatId = this.isSameConversation(oldMsgs, messages);
      if (sameChatId) {
        console.log(`[PromptEngine] SYSTEM CHANGED but same chat_id → incremental (avoid full re-injection)`);
        const newMsgsList = this.getNewMessages(oldMsgs, messages);
        const newText = this.formatIncrementalPrompt(newMsgsList);
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
      console.log(`[PromptEngine] getNewMessages: ${newMsgsList.length} new msgs`);
      const newText = this.formatIncrementalPrompt(newMsgsList);
      console.log(`[PromptEngine] formatIncrementalPrompt: "${newText.substring(0, 100)}..." (${newText.length} chars)`);
      // Only use incremental output if it contains actual user text, not just metadata.
      if (newText && !this.isMetadataContent(newText)) return { text: newText, requireNewChat: false };
      // If all new messages are metadata (no real user input since last turn),
      // force full injection to avoid using stale ancient content.
      const hasNewUserContent = newMsgsList.some((m: any) =>
        m.role === 'user' && !this.isMetadataContent(this.cleanContent(m.content))
      );
      console.log(`[PromptEngine] hasNewUserContent=${hasNewUserContent}`);
      if (!hasNewUserContent) {
        console.log(`[PromptEngine] NO real user content in new msgs → full injection (same conv, no new chat)`);
        return { text: this.formatTranscript(messages, tools), requireNewChat: false };
      }
      const lastUser = this.extractLatestUserMessage(messages);
      console.log(`[PromptEngine] extractLatestUserMessage: "${lastUser.substring(0, 100)}..." (${lastUser.length} chars)`);
      if (lastUser) return { text: lastUser, requireNewChat: false };
    }
    console.log(`[PromptEngine] FALLBACK → full injection`);
    return { text: this.formatTranscript(messages, tools), requireNewChat: true };
  }
}
