# gollm-service v0.3.0 Project Summary

**Date**: 2026-05-25
**Version**: v0.3.0 (Type Safety + DX Standardization)
**Status**: ✅ Released & Merged to main

---

## 📌 Project Overview

**gollm-service** bridges the Gemini Web UI to an OpenAI-compatible API endpoint (port 3001), enabling the Hermes/OpenClaw ecosystem to use Gemini as an LLM provider via Playwright RPA — bypassing API quota limits and unlocking "Thinking" model capabilities directly from the web interface.

---

## 🛤️ Three-Step Refactoring Journey

### Step 1 ✅ — PromptEngine Decoupling (2026-05-25)

**Problem**: `gollm-transport-stream.ts` was a "God Object" handling Prompt engineering + RPA + Hallucination Guard simultaneously.

**Solution**:
- Extracted all prompt formatting logic into `src/services/prompt-engine.ts`
- Unified all call sites to use `PromptEngine.formatTranscript()`, `PromptEngine.cleanContent()`, `PromptEngine.truncateTools()`
- Removed idle constants `MAX_TRANSCRIPT_LENGTH` / `MAX_TOOLS_SECTION_LENGTH`
- Result: 176 lines extracted, single source of truth established

**Files changed**: `src/agents/gollm-transport-stream.ts`, `src/services/prompt-engine.ts` (new)

---

### Step 2 ✅ — Type Safety (2026-05-25)

**Problem**: `new Function(...) as any` was used throughout for browser-side DOM manipulation. This bypassed TypeScript entirely — typo in property names would only be caught at runtime. Also, `fill()` on Gemini's `contenteditable` div caused 30-second timeouts on every request.

**Solution** — Two parallel tracks:

**A. DOM Type Safety**
- Created `src/types/browser-types.ts` defining clean interfaces: `PageCheckResult`, `FreshSessionResult`, `InputAreaCheckResult`, `ClearPollStateResult`
- Replaced all `new Function(...) as any` in `session-manager.ts` and `response-extractor.ts` with type-safe `page.evaluate(() => { ... })` arrow functions
- Applied `// @ts-expect-error — window/document are browser globals inside page.evaluate` as inline suppression (must be **inside** the arrow function body, not outside)

**B. Contenthable Injection Fix**
- Replaced `fill()` with `page.evaluate()` + `InputEvent` dispatch
- Root cause: Playwright's `fill()` checks editable-state on `contenteditable` divs even though `contenteditable="true"` is set
- Result: Injection went from **30-second timeout → instant success**

**Additional improvements in Step 2**:
- Model regex expanded: `pro` → `/Pro|Advanced/i` (accounts for "Advanced" UI label)
- Loop prevention: `applyTargetMode()` now max 2 attempts (eliminates infinite page-reload spiral)
- Overlay selectors enhanced: added `.cdk-overlay-backdrop`, `[class*="modal-backdrop"]`, `[role="dialog"][aria-modal="true"]`

**Key Pitfall — TS Environment Conflict**:
```
// ❌ WRONG: @ts-expect-error BEFORE page.evaluate — suppresses nothing
// @ts-expect-error
await page.evaluate(() => { const win = window as any; ... });

// ✅ CORRECT: @ts-expect-error INSIDE the arrow function body
await page.evaluate(() => {
  // @ts-expect-error — window/document are browser globals inside page.evaluate
  const win = (window as any);
  win.document.querySelectorAll(...);
});
```

---

### Step 3 ✅ — DX Standardization (2026-05-25)

**Health API Enhancement**:
- `/health` now returns `uptime_seconds`, `current_prompt_size`, and `last_error { message, timestamp }`
- `SessionManager.getLastError()` / `setLastError()` tracks critical errors at: model-switch failure, startNewChat click/route failures, DOM prune failure
- `getServerStartTime()` exported from `http-server.ts` for uptime calculation

**Developer Experience**:
- `config.example.json` — Standard configuration template for all settings (server, playwright, model)
- `setup.sh` — Automated setup script: `npm install` → `npx playwright install chromium` → config copy → user data dir creation

---

## 📊 v0.3.0 Deliverables

| Item | Path | Description |
|------|------|-------------|
| PromptEngine | `src/services/prompt-engine.ts` | Decoupled prompt formatting logic |
| Browser Types | `src/types/browser-types.ts` | Typed DOM interfaces |
| Enhanced Health | `src/routes/health.ts` | uptime + prompt_size + last_error |
| Config Template | `config.example.json` | Standard settings reference |
| Setup Script | `setup.sh` | One-command environment setup |
| Technical Spec | `spec.md` | Architecture documentation |

---

## 🔧 Technical Decisions

| Decision | Rationale |
|----------|-----------|
| `fill()` → `evaluate()` for contenteditable | Playwright's editable-check times out on Gemini's `contenteditable` div |
| `@ts-expect-error` inside arrow function body | TS errors originate inside `page.evaluate` callback, not the call site |
| `maxAttempts = 2` for model switch | Prevents infinite loop when model switch keeps failing |
| `git restore` restores entire file to branch HEAD | Never use on a file with uncommitted changes — use `git checkout path` or `git diff` first |
| `systemctl --user restart` vs `kill -9 node` | systemd auto-restarts node, so kill+start is the reliable restart pattern |
| Singleton SessionManager | Late-initialized with `mergeOptions()` for runtime config changes |

---

## 📈 Git History

```
b2f2bab (main, before refactor)
   ↓
refactor/type-safety branch:
  70d329f — Step 1+2: new Function() eliminated, evaluate() for contenteditable
  309c870 — Step 3: DX Standardization (Health API, config.example.json, setup.sh)
   ↓ merged (fast-forward)
main @ 309c870
   ↓ tagged
v0.3.0
```

---

## 🏁 Current Status

- **Branch**: `main` (production-ready)
- **Tag**: `v0.3.0` (GitHub)
- **Build**: Clean (0 TypeScript errors)
- **Service**: Running on port 3001, tested with OpenClaw gemini-pro injection ✅
- **Known limitations**: `prompt_tokens` in response is 0 (RPA cannot accurately count); `current_prompt_size` tracks message text length only (not tools or overhead)

---

## 🚀 Next Steps (Suggestions)

1. **RPADriver separation** — Extract `typeInput`, `clickSend`, `waitForResponse` from `gollm-transport-stream.ts` into a dedicated `RPADriver` class
2. **GuardRail separation** — Extract `validateWithHallucinationGuard` into a standalone middleware
3. **Prompt Caching** — When OpenClaw adds support, gollm-service should tag static sections of System Prompt for cache-friendly delivery
4. **GitHub Release notes** — Create formal release at https://github.com/yywang99/gollm-service/releases/new with the v0.3.0 tag