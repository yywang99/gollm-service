/**
 * Request Mutex
 *
 * Ensures only one RPA request runs at a time per session.
 * Without this, concurrent requests corrupt shared browser state (window.__pollState).
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