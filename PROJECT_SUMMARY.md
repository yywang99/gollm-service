# gollm-service v0.4.0 Project Summary

**Date**: 2026-06-27
**Version**: v0.4.0 (Robust RPA + Session Recovery + Prompt Reliability)
**Status**: ✅ Released & Merged to main

---

## 📌 Project Overview

**gollm-service** bridges the Gemini Web UI to an OpenAI-compatible API endpoint (port 3001), enabling the Hermes/OpenClaw ecosystem to use Gemini as an LLM provider via Playwright RPA — bypassing API quota limits and unlocking "Thinking" model capabilities directly from the web interface.

---

## Tracks & Milestones (v0.3.0 to v0.4.0)

### 1. Type Safety & DX Standardization (v0.3.0)
- Decoupled `PromptEngine` logic into dedicated services.
- Replaced `new Function(...)` statements with type-safe `page.evaluate()` closures.
- Resolved Playwright `fill()` timeout on `contenteditable` divs using native DOM events.
- Created standard `/health` endpoints tracking uptime, last errors, and lazy-loading state.

### 2. Robust RPA, Session Recovery & Prompt Reliability (v0.4.0)
- **Headless Browser Execution Recovery**: Manually unzipped and reinstalled verified `chromium-headless-shell v1217` package to resolve launching errors when headless is enabled.
- **Global Prepending of System Prompt**: Moved system prompt injection out of the messages loop to prevent it from being trimmed in long conversations, ensuring files like `MEMORY.md`, `AGENTS.md`, and `SOUL.md` are always present.
- **Dynamic System Prompt Change Detection**: Added system prompt content comparison between consecutive requests. If any change is detected (e.g., dynamic updates to `MEMORY.md`), it automatically bypasses incremental mode and forces a new session with full prompt injection.
- **Browser Crash/Close Recovery**: Configured context/page listeners to clear active `lastChatId` and reset session state on manual close or crash, ensuring the subsequent request correctly triggers full injection on relaunch.
- **Metadata Whitelist Extension**: Added `identify`, `identify.md`, and `IDENTIFY.md` to prevent metadata cleaning tools from stripping identity files used by Hermes/OpenClaw.

---

## 📊 v0.4.0 Deliverables

| Item | Path | Description |
|------|------|-------------|
| PromptEngine | `src/services/prompt-engine.ts` | Decoupled prompt formatting, global prepending, change detection |
| SessionManager | `src/services/session-manager.ts` | Headless configuration, state reset, close event listeners |
| Health Route | `src/routes/health.ts` | Standardized version and status endpoints |
| Config Template | `config.example.json` | Reference configuration |
| Project Spec | `spec.md` | System design specifications |

---

## 🔧 Technical Decisions & Rationale

| Decision | Rationale |
|----------|-----------|
| Global system prompt prepending | Prevents critical agent persona and files from being trimmed in long message history |
| `resetState()` on browser close | Ensures clean state recovery and full prompt injection when recreating crashed/closed browser instances |
| Dynamic `systemPromptChanged` diffing | Automatically restarts session to apply new memories/agent configurations instantly |
| `chromium-headless-shell` manual setup | Bypasses corrupted cache downloads to ensure 100% stable headless runs |

---

## 📈 Git History

```
v0.3.0
  ↓
main @ caf1015 (RPA Context Close / Page Relaunch Fix)
  ↓
main @ 87902f2 (Identify metadata whitelist extension)
  ↓
v0.4.0 (Version unification to 0.4)
```

---

## 🏁 Current Status

- **Branch**: `main` (production-ready)
- **Tag**: `v0.4.0` (GitHub)
- **Build**: Clean (0 TypeScript errors)
- **Service**: Running on port 3001, tested with OpenClaw and smallHermes integration.