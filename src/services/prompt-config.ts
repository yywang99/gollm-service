/**
 * Prompt Config Loader
 *
 * Centralizes all PromptEngine limits and behaviour flags.
 * Values are driven by service.gollmrc.json -> config.prompt and config.polling, with safe
 * defaults so the service still works if the config keys are absent.
 */

export interface PromptLimits {
  maxTranscriptLength: number;    // chars — oldest messages are trimmed before this
  maxToolsSectionLength: number; // chars — tool list is truncated before this
  maxToolOutputLength: number;   // chars — per-tool output is capped before this
  enableMediaSendReminder: boolean; // inject a MEDIA:/path reminder into tool instructions
  // ── CacheAligner: extract dynamic content for stable KV-cache prefix ──────
  enableCacheAligner: boolean;       // default true
  // ── ContentRouter: type-aware tool-output compression ─────────────────────
  enableContentRouter: boolean;      // default true
  // ── OutputHint: steering block to reduce output tokens ────────────────────
  enableOutputHint: number;          // 0=off, 1=L1, 2=L2 (default), 3=L3, 4=L4
  // ── Polling: response extraction timing settings ─────────────────────────
  pollIntervalMs: number;            // DOM polling interval (ms)
  stableThreshold: number;           // consecutive stable polls to consider done
  postGenerationBufferMs: number;    // extra wait after generation stops (ms)
}

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULTS: PromptLimits = {
  maxTranscriptLength:    60_000,  // 60 KB — generous but safe (avoids Web UI lag)
  maxToolsSectionLength:  64_000,  // 64 KB — fits most tool lists from OpenClaw
  maxToolOutputLength:     5_000,  // 5 KB per tool — generous for GitHub fetch, etc.
  enableMediaSendReminder:  true,  // always on; opt-out via config
  enableCacheAligner:       true,  // extract dynamic vars → stable KV-cache prefix
  enableContentRouter:      true,  // type-aware tool-output compression
  enableOutputHint:            2,  // L2: concise + no echo (safe default)
  // Polling defaults (can be overridden via service.gollmrc.json -> polling)
  pollIntervalMs:         300,   // 0.3s between DOM checks
  stableThreshold:          8,   // need 8 consecutive stable reads
  postGenerationBufferMs: 2000,  // 2s extra wait after stop button disappears
};

// ── Module-level store (lazily populated, can be overridden) ─────────────────
let _limits: PromptLimits = { ...DEFAULTS };
let _initialized = false;

/**
 * Get current limits. Always returns a valid PromptLimits object.
 * Call init() or merge() first if you need non-default values.
 */
export function getPromptLimits(): PromptLimits {
  return _limits;
}

/**
 * Initialise with values from service.gollmrc.json (or any equivalent object).
 * Idempotent — safe to call multiple times; later calls win.
 */
export function initPromptConfig(rcConfig?: Record<string, unknown> | null): void {
  const promptConfig = rcConfig?.prompt ?? {};
  const pollingConfig = rcConfig?.polling ?? {};

  _limits = {
    ...DEFAULTS,
    ...promptConfig,
    ...pollingConfig,
  } as PromptLimits;

  _initialized = true;
  console.log(`[PollConfig] polling: interval=${_limits.pollIntervalMs}ms, stable=${_limits.stableThreshold}, postGenBuf=${_limits.postGenerationBufferMs}ms`);
  console.log(`[PromptConfig] limits loaded: transcript≤${_limits.maxTranscriptLength}, ` +
    `tools≤${_limits.maxToolsSectionLength}, toolOutput≤${_limits.maxToolOutputLength}, ` +
    `mediaReminder=${_limits.enableMediaSendReminder}, ` +
    `cacheAligner=${_limits.enableCacheAligner}, contentRouter=${_limits.enableContentRouter}, ` +
    `outputHint=L${_limits.enableOutputHint}`);
}

/** Returns true after init() has been called at least once. */
export function isPromptConfigInitialized(): boolean {
  return _initialized;
}