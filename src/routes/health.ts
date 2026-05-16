import { FastifyInstance } from "fastify";
import { getSessionManager } from "../services/session-manager.js";

export async function healthRoute(fastify: FastifyInstance) {
  fastify.get("/health", async () => {
    const session = getSessionManager();
    const sessionState = session.getState();
    const isReady = session.isReady();

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

    return {
      status: healthy ? "ok" : "degraded",
      service: "gollm-service",
      version: "0.2.0",
      session: sessionState,
      browser: pageResponsive ? "responsive" : "unresponsive",
      timestamp: new Date().toISOString(),
    };
  });
}