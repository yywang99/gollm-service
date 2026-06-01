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
}

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULTS: PromptLimits = {
  maxTranscriptLength:    60_000,  // 60 KB — generous but safe (avoids Web UI lag)
  maxToolsSectionLength:  64_000,  // 64 KB — fits most tool lists from OpenClaw
  maxToolOutputLength:     3_000,  // 3 KB per tool — prevents cat/ls from flooding context
  enableMediaSendReminder:  true,  // always on; opt-out via config
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
    maxToolOutputLength:    Number(cfg.maxToolOutputLength)    || DEFAULTS.maxToolOutputLength,
    enableMediaSendReminder: cfg.enableMediaSendReminder !== undefined
      ? Boolean(cfg.enableMediaSendReminder)
      : DEFAULTS.enableMediaSendReminder,
  };

  _initialized = true;
  console.log(`[PromptConfig] limits loaded: transcript≤${_limits.maxTranscriptLength}, `
    + `tools≤${_limits.maxToolsSectionLength}, toolOutput≤${_limits.maxToolOutputLength}, `
    + `mediaReminder=${_limits.enableMediaSendReminder}`);
}

/** Returns true after init() has been called at least once. */
export function isPromptConfigInitialized(): boolean {
  return _initialized;
}