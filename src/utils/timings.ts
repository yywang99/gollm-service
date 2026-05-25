// Timings and limits configuration
// Based on values proven to work in Project GoLLM

export const TIMINGS = {
  // Input delay before sending
  INPUT_DELAY: 200,

  // System message short delay
  SYSTEM_DELAY: 500,

  // Waiting time before re-focusing input
  SEND_RETRY_DELAY: 500,

  // Delay for workspace auto-click check
  WORKSPACE_SCAN_DELAY: 1500,
};

export const LIMITS = {
  // Maximum DOM Doctor repair attempts
  MAX_INTERACT_RETRY: 2,

  // Page busy wait timeout
  PAGE_BUSY_TIMEOUT_MS: 30_000,

  // Response wait timeout (5 minutes for Gemini thinking)
  RESPONSE_TIMEOUT_MS: 300_000,

  // Max HTML snippet size for DOM Doctor analysis (bytes)
  HTMLSnippet_MAX_CHARS: 60_000,
};

export const POLLING = {
  // Response polling interval
  POLL_INTERVAL_MS: 500,

  // Number of consecutive stable polls before considering response done
  STABLE_THRESHOLD: 10,

  // That's 5 seconds of stable response = done
  // Minimum wait after generation completes (stop button disappears).
  // This gives streaming content (e.g. tool_call JSON blocks) time to fully render
  // before the stability check kicks in. Prevents premature capture of partial JSON.
  POST_GENERATION_BUFFER_MS: 5000,
};