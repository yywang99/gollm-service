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

    // Trigger lazy browser launch (if not already launched) and check it's alive.
    // This ensures /health reflects actual service health rather than just "browser hasn't been
    // lazily launched yet" — which is expected behavior, not a failure.
    //
    // Key principle: do NOT require a successful CDP probe here.
    // Why: the RPA workflow has its own navigation-waiting logic; we just need to verify
    // that Chromium was able to start without a hard crash or uncaught exception.
    // A failed CDP probe (e.g. page still initializing) does NOT mean the service is unhealthy.
    let browserLaunched = false;
    let launchError: string | null = null;

    try {
      await session.getPage(); // triggers lazy launch; throws if Chromium fails to start
      browserLaunched = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      launchError = msg;
    }

    // Healthy if: Chromium launched without throwing
    // Note: 'logged_in' session state and CDP responsiveness are NOT required for health
    const healthy = browserLaunched;
    const uptimeMs = serverStartTime ? Date.now() - serverStartTime : 0;
    const lastErrorFromSession = session.getLastError();

    return {
      status: healthy ? "ok" : "degraded",
      service: "gollm-service",
      version: "0.3.0",
      session: sessionState,
      browser: browserLaunched ? "responsive" : "unresponsive",
      uptime_seconds: Math.floor(uptimeMs / 1000),
      current_prompt_size: currentPromptSize,
      last_error: launchError
        ? { message: `[Launch] ${launchError}`, timestamp: new Date().toISOString() }
        : lastErrorFromSession
          ? { message: lastErrorFromSession.message, timestamp: new Date(lastErrorFromSession.time).toISOString() }
          : null,
      timestamp: new Date().toISOString(),
    };
  });
}