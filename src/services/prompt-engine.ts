/**
 * Prompt Engine
 * 
 * Responsible for all text manipulation, prompt assembly, and tool truncation.
 * Decoupled from RPA execution to ensure that prompt logic can be tested and 
 * evolved independently of the Playwright driver.
 */

export class PromptEngine {
  private readonly MAX_TRANSCRIPT_LENGTH = 80000;
  private readonly MAX_TOOLS_SECTION_LENGTH = 8000;

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
      transcript += `[System Instructions - Available Tools]\\n`;
      transcript += `You have access to the following tools. To use a tool, you MUST output a <tool_call> JSON block EXACTLY like this:\\n`;
      transcript += `<tool_call>\\n{\"name\": \"tool_name\", \"arguments\": {\"arg1\": \"value1\"}}\\n</tool_call>\\n\\n`;
      
      let toolsJson = JSON.stringify(tools, null, 2);
      if (toolsJson.length > this.MAX_TOOLS_SECTION_LENGTH) {
        const budgetPerTool = 300;
        const maxTools = Math.max(3, Math.floor(this.MAX_TOOLS_SECTION_LENGTH / budgetPerTool));
        const truncatedTools = tools.slice(0, maxTools);
        toolsJson = JSON.stringify(truncatedTools, null, 2);
        const remaining = tools.length - maxTools;
        if (remaining > 0) {
          toolsJson += `\\n// ... ${remaining} more tools available (not shown for context limit)`;
        }
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
        transcript += `--- Tool Output (${toolName}) ---\\n${text}\\n\\n`;
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
    const oldSystem = oldMsgs.find((m: any) => m.role === 'system')?.content;
    const newSystem = messages.find((m: any) => m.role === 'system')?.content;
    const systemChanged = JSON.stringify(oldSystem) !== JSON.stringify(newSystem);
    console.log(`[PromptEngine] system check: oldLen=${oldSystem?.length ?? 0}, newLen=${newSystem?.length ?? 0}, changed=${systemChanged}`);
    if (systemChanged) {
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
