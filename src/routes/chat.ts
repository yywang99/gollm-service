import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { executeGollmRPA, buildChatCompletionResponse } from "../agents/gollm-transport-stream.js";
import { parseToolCalls, isPureToolCall } from "../utils/tool-parser.js";

interface ChatBody {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  stream?: boolean;
}

export async function chatRoute(fastify: FastifyInstance, opts: { config: any }) {
  fastify.post("/v1/chat/completions", async (request: FastifyRequest<{ Body: ChatBody }>, reply: FastifyReply) => {
    const { messages = [] } = request.body || {};

    // 1. Universal Message Filtering & Deduplication
    // For Stateful Web UI, we only want the LAST user message if it's a stateless replay
    const filteredMessages = messages.map((msg: any) => {
      if (msg.role !== 'user') return msg;
      const content = msg.content;
      if (typeof content !== 'string') return msg;
      
      // Generic Metadata Filtering (Cleaner than before)
      const metadataPattern = /(?:Conversation info \(untrusted metadata\):|Sender \(untrusted metadata\):|\[Metadata\])[\s\S]*$/gi;
      const stripped = content.replace(metadataPattern, '').trim();
      
      // If the message is JUST metadata after stripping, skip it
      if (stripped.length === 0 && content.length > 0) return null;
      
      return { ...msg, content: stripped };
    }).filter((msg: any) => msg !== null);

    if (!filteredMessages || filteredMessages.length === 0) {
      return reply.status(400).send({
        error: { message: "messages is required", type: "invalid_request_error" },
      });
    }

    const modelId = request.body?.model || "gollm-v9";
    const thinkingLog = opts.config?.gemini?.thinkingLog !== false;
    const playwrightConfig = opts.config?.playwright || {};

    // 2. Dynamic Mode Selection (Harness Feature)
    const modeMatch = modelId.match(/-(thinking|think|pro|fast)$/i);
    if (modeMatch) {
      const modeMap: Record<string, "think" | "pro" | "fast"> = {
        think: "think", thinking: "think",
        pro: "pro",
        fast: "fast",
      };
      const detectedMode = modeMap[modeMatch[1].toLowerCase()];
      if (detectedMode) {
        const session = (await import("../services/session-manager.js")).getSessionManager();
        session.setTargetMode(detectedMode);
      }
    }

    try {
      // 3. RPA Execution
      const result = await executeGollmRPA(
        { messages: filteredMessages as any, thinkingLog },
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

      // If it's a pure tool call, content should be null (OpenAI spec)
      const finalContent = isPureTool ? null : result.text;
      const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";

      // ── [Phase 4] Hallucination Warning Metadata ───────────────────
      // If hallucination was detected and not resolved, add warning to response
      const hasUnconfirmedAction = result.isHallucination === true;

      // 5. Handling Streaming (Simplified Chunking)
      if (request.body?.stream) {
        reply.raw.setHeader("Content-Type", "text/event-stream");
        reply.raw.setHeader("Cache-Control", "no-cache");
        reply.raw.setHeader("Connection", "keep-alive");

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
                ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
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
