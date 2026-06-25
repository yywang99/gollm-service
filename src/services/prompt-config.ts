/**
 * Prompt Config Loader
 *
 * Centralizes all PromptEngine limits and behaviour flags.
 * Values are driven by service.gollmrc.json → config.prompt, with safe
 * defaults so the service still works if the config key is absent.
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
  const cfg = (rcConfig?.prompt ?? {}) as Partial<PromptLimits>;

  _limits = {
    maxTranscriptLength:    Number(cfg.maxTranscriptLength)    || DEFAULTS.maxTranscriptLength,
    maxToolsSectionLength:  Number(cfg.maxToolsSectionLength)  || DEFAULTS.maxToolsSectionLength,
    maxToolOutputLength:     Number(cfg.maxToolOutputLength)    || DEFAULTS.maxToolOutputLength,
    enableMediaSendReminder: cfg.enableMediaSendReminder !== undefined
      ? Boolean(cfg.enableMediaSendReminder)
      : DEFAULTS.enableMediaSendReminder,
    enableCacheAligner: cfg.enableCacheAligner !== undefined
      ? Boolean(cfg.enableCacheAligner)
      : DEFAULTS.enableCacheAligner,
    enableContentRouter: cfg.enableContentRouter !== undefined
      ? Boolean(cfg.enableContentRouter)
      : DEFAULTS.enableContentRouter,
    enableOutputHint: cfg.enableOutputHint !== undefined
      ? Number(cfg.enableOutputHint)
      : DEFAULTS.enableOutputHint,
  };

  _initialized = true;
  console.log(`[PromptConfig] limits loaded: transcript≤${_limits.maxTranscriptLength}, `
    + `tools≤${_limits.maxToolsSectionLength}, toolOutput≤${_limits.maxToolOutputLength}, `
    + `mediaReminder=${_limits.enableMediaSendReminder}, `
    + `cacheAligner=${_limits.enableCacheAligner}, contentRouter=${_limits.enableContentRouter}, `
    + `outputHint=L${_limits.enableOutputHint}`);
}

/** Returns true after init() has been called at least once. */
export function isPromptConfigInitialized(): boolean {
  return _initialized;
}