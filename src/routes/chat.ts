import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { executeGollmRPA, buildChatCompletionResponse } from "../agents/gollm-transport-stream.js";
import { parseToolCalls, isPureToolCall, isNoReply } from "../utils/tool-parser.js";

interface ChatBody {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  tools?: any[];
  stream?: boolean;
}

// Track in-flight prompt size for health reporting
let currentPromptSize = 0;

export function getCurrentPromptSize(): number {
  return currentPromptSize;
}

export async function chatRoute(fastify: FastifyInstance, opts: { config: any }) {
  fastify.post("/v1/chat/completions", async (request: FastifyRequest<{ Body: ChatBody }>, reply: FastifyReply) => {
    const { messages = [], tools = [] } = request.body || {};

    // ── DEBUG: Log raw incoming messages ──────────────────────────────────
    console.log(`[GoLLM Chat] Incoming ${messages.length} messages, ${tools.length} tools`);
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const contentPreview = typeof m.content === 'string'
        ? m.content.slice(0, 200).replace(/\n/g, '\\n')
        : Array.isArray(m.content)
          ? `[Array(${(m.content as any[]).length})]`
          : String(m.content).slice(0, 100);
      console.log(`[GoLLM Chat]   [${i}] role=${m.role} content(${typeof m.content === 'string' ? m.content.length : '?'}): ${contentPreview}`);
    }

    // 1. Message passthrough — NO content stripping.
    // OpenClaw metadata (untrusted metadata blocks) is passed through
    // because stripping it here risks destroying the actual user message.
    // The downstream cleanContent() in gollm-transport-stream.ts handles
    // surgical metadata removal when building the transcript for Gemini.
    const filteredMessages = messages.filter((msg: any) => {
      // Only filter out completely empty messages
      if (!msg.content && msg.role !== 'system') return false;
      const text = typeof msg.content === 'string' ? msg.content.trim() : '';
      // Keep everything, including metadata — let cleanContent handle it
      return text.length > 0 || msg.role === 'system' || typeof msg.content !== 'string';
    });

    if (!filteredMessages || filteredMessages.length === 0) {
      return reply.status(400).send({
        error: { message: "messages is required", type: "invalid_request_error" },
      });
    }

    const modelId = request.body?.model || "gollm-v9";
    const thinkingLog = opts.config?.gemini?.thinkingLog !== false;
    const playwrightConfig = opts.config?.playwright || {};

    // 2. Dynamic Model Selection
    // Supports: golem/gemini-pro, golem/gemini-flash, golem/gemini-flash-lite, gemini-think, etc.
    const modeMatch = modelId.match(/-(flash-lite|flash|pro|thinking|think|fast)$/i);
    if (modeMatch) {
      const modeMap: Record<string, "flash-lite" | "flash" | "pro"> = {
        'flash-lite': 'flash-lite',
        'fast': 'flash',
        'flash': 'flash',
        'pro': 'pro',
        'think': 'pro',      // backward compat: think → use Pro model
        'thinking': 'pro',
      };
      const detectedMode = modeMap[modeMatch[1].toLowerCase()];
      if (detectedMode) {
        const session = (await import("../services/session-manager.js")).getSessionManager();
        session.setTargetMode(detectedMode);
        // Apply immediately: click the model dropdown + set thinking to "延長"
        await session.applyTargetMode().catch((e: any) =>
          console.warn(`[GoLLM Chat] applyTargetMode warning: ${e?.message || e}`)
        );
      }
    }

    try {
      // Track prompt size for health endpoint
      currentPromptSize = (filteredMessages as any[]).reduce(
        (sum: number, m: any) => sum + (typeof m.content === "string" ? m.content.length : 0),
        0
      );

      // 3. RPA Execution
      const result = await executeGollmRPA(
        { messages: filteredMessages as any, tools, thinkingLog },
        { thinkingLog, playwrightConfig }
      );

      if (result.finishReason === "error") {
        return reply.status(500).send({
          error: { message: "GoLLM RPA execution failed", type: "internal_error" },
        });
      }

      // 4. Tool Use Detection & Response Mapping (Universal Adapter)
      const toolCalls = parseToolCalls(result.text);
      const isPureTool = isPureToolCall(result.text, toolCalls);
      const noReply = isNoReply(result.text);

      // If it's a pure tool call, content should be null (OpenAI spec)
      // If it's a NO_REPLY response, strip any "Thinking" logs and strictly return "NO_REPLY"
      let finalContent: string | null = result.text;
      if (isPureTool) {
        finalContent = null;
      } else if (noReply) {
        finalContent = "NO_REPLY";
      }

      const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";

      // ── [Phase 4] Hallucination Warning Metadata ───────────────────
      // If hallucination was detected and not resolved, add warning to response
      const hasUnconfirmedAction = result.isHallucination === true;

      // 5. Handling Streaming (Simplified Chunking)
      if (request.body?.stream) {
        reply.raw.setHeader("Content-Type", "text/event-stream");
        reply.raw.setHeader("Cache-Control", "no-cache");
        reply.raw.setHeader("Connection", "keep-alive");

        // Format tool calls for streaming (must include 'index' for each tool call delta)
        const streamToolCalls = toolCalls.map((tc, index) => ({
          index,
          id: tc.id,
          type: "function",
          function: tc.function,
        }));

        const chunk = {
          id: `gollm-${Date.now()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: finalContent,
                ...(streamToolCalls.length > 0 ? { tool_calls: streamToolCalls } : {}),
                // Attach hallucination warning as a special content block
                ...(hasUnconfirmedAction ? { _gollm_hallucination_warn: true } : {}),
              },
              finish_reason: finishReason,
            },
          ],
        };

        reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
        reply.raw.write(`data: [DONE]\n\n`);
        reply.raw.end();
        return reply;
      }

      // 6. Final Non-Streaming Response
      // We manually construct the response to support tool_calls and hallucination warnings
      const response = {
        id: `gollm-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: finalContent,
              ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
              // Attach hallucination warning as a custom field
              ...(hasUnconfirmedAction ? { _gollm_hallucination_warn: true } : {}),
            },
            finish_reason: finishReason,
          },
        ],
        usage: {
          prompt_tokens: 0, // RPA can't accurately count
          completion_tokens: 0,
          total_tokens: 0,
        },
        // Top-level flag for easier detection by Hermes/OpenClaw
        ...(hasUnconfirmedAction ? { _gollm_unconfirmed_action: true } : {}),
      };

      return response;
    } catch (error: any) {
      fastify.log.error(error);

      if (error.message?.includes("session expired") || error.message?.includes("needs_reauth")) {
        return reply.status(401).send({
          error: {
            message: "Google session expired. Please sign in through the browser at the dashboard or health endpoint.",
            type: "authentication_error",
          },
        });
      }

      return reply.status(500).send({
        error: { message: error.message || "Internal error", type: "internal_error" },
      });
    }
  });
}
