/**
 * Request Mutex
 *
 * Ensures only one RPA request runs at a time per session.
 * Without this, concurrent requests corrupt shared browser state (window.__pollState).
 *
 * Safety net: forceReset() allows external callers (e.g. timeout handlers) to
 * forcibly unlock even if the original function never returned.
 */

let busy = false;

export async function withMutex<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (busy) {
    console.log(`[Mutex] ${label} skipped — another request in progress`);
    throw new Error("GoLLM RPA busy with another request. Please retry in a moment.");
  }
  busy = true;
  try {
    console.log(`[Mutex] ${label} acquired`);
    return await fn();
  } finally {
    busy = false;
    console.log(`[Mutex] ${label} released`);
  }
}

/**
 * Force-reset the mutex lock.
 * Call this from a timeout handler or health-check when the normal release path
 * is suspected to be stuck (e.g. CDP/browser hang).
 *
 * Safety: also imports SessionManager to force-refresh the browser state so the
 * next request starts from a known-clean environment.
 */
export async function forceResetMutex(): Promise<void> {
  if (!busy) {
    console.log("[Mutex] forceReset: already free, no-op");
    return;
  }

  console.warn("[Mutex] ⚠️ forceReset: was busy, forcibly releasing");
  busy = false;

  // Force a clean browser state so the next request starts fresh
  try {
    const { getSessionManager } = await import("./session-manager.js");
    const sm = getSessionManager();
    if (sm) {
      console.log("[Mutex] forceReset: reloading Gemini page to clean state");
      const page = (sm as any).page;
      if (page) {
        await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000).catch(() => {});
      }
    }
  } catch (e) {
    console.error("[Mutex] forceReset: cleanup error", e);
  }
}

/**
 * Wrapper that adds a hard timeout to the mutex-protected function.
 * If the timeout fires, the mutex is force-reset AND the browser is reloaded.
 *
 * @param label        Identifier for logging
 * @param fn           The async function to run
 * @param timeoutMs    Max milliseconds to wait (default: 5 minutes)
 */
export async function withMutexAndTimeout<T>(
  label: string,
  fn: () => Promise<T>,
  timeoutMs = 300_000
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(async () => {
      console.warn(`[Mutex] ⏱️ Timeout ${timeoutMs}ms reached for "${label}" — force resetting`);
      await forceResetMutex();
      reject(new Error(`GoLLM RPA timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const result = await withMutex(label, fn);
      clearTimeout(timer);
      resolve(result);
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}