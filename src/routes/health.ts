import { FastifyInstance } from "fastify";
import { getSessionManager } from "../services/session-manager.js";
import { getServerStartTime } from "../server/http-server.js";
import { getCurrentPromptSize } from "../routes/chat.js";

export async function healthRoute(fastify: FastifyInstance) {
  fastify.get("/health", async () => {
    const session = getSessionManager();
    const sessionState = session.getState();
    const isReady = session.isReady();
    const lastError = session.getLastError();
    const serverStartTime = getServerStartTime();
    const currentPromptSize = getCurrentPromptSize();

    // Check if the browser page is actually responsive
    let pageResponsive = false;
    try {
      const page = await session.getPage();
      if (page) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await page.evaluate("return document.readyState" as any);
        pageResponsive = true;
      }
    } catch { /* page not available yet */ }

    const healthy = isReady && pageResponsive;
    const uptimeMs = serverStartTime ? Date.now() - serverStartTime : 0;

    return {
      status: healthy ? "ok" : "degraded",
      service: "gollm-service",
      version: "0.2.0",
      session: sessionState,
      browser: pageResponsive ? "responsive" : "unresponsive",
      uptime_seconds: Math.floor(uptimeMs / 1000),
      current_prompt_size: currentPromptSize,
      last_error: lastError
        ? { message: lastError.message, timestamp: new Date(lastError.time).toISOString() }
        : null,
      timestamp: new Date().toISOString(),
    };
  });
}