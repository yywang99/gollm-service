# gollm-service — Bug Handoff for Antigravity

**Created**: 2026-05-27
**Priority**: P1 (broken — poll returns truncated response)
**Uncommitted changes**: `src/services/prompt-engine.ts` (+110/-25 lines)

---

## 🐛 Bug: Poll Returns Truncated Response (56 chars)

### Symptom

User sends 3 consecutive messages → Gemini replies the **same repeated text** every time:

> "沒錯！每次開啟新的 session，系統就會自動重置回預設的模型設定。所以現在為你服務是 Gemini 喔！✨"

This 56-char string is the first partial chunk of a streaming response. The polling logic is **prematurely declaring done** after capturing only the opening fragment, before the full response renders in the DOM.

### Root Cause (Hypothesis)

The poll's `done` condition fires when:
1. `stableCount >= 15` consecutive polls return the same text **AND**
2. The text is checked **after** `POST_GENERATION_BUFFER_MS` (8s) elapsed since generation stopped

**Problem**: The stop-button detection (`button[aria-label*="Stop"]` missing) may fire too early — before streaming actually finishes — especially for responses with embedded markdown/code. If `isGenerating` flips to `false` prematurely, the 8s buffer starts counting from an incomplete state, and `stableCount` accumulates on a truncated partial response.

### Evidence from log

```
[POLL] Starting (timeout=300000ms, poll=500ms, stable=15, postGenBuffer=8000ms)
[POLL] Done after 15320ms, got 56 chars
```

- 15 polls × 500ms = 7500ms base stability window
- Plus some buffer = ~15s total, which is less than 8s postGenBuffer + 8s minStableWait = 16s
- This means **neither the 8s buffer NOR the 16s minimum fully elapsed**, yet polling returned `done`
- Something else is triggering `_S.done = true`

### Secondary Factor

The repeated message is injected back into the conversation via incremental mode, contaminating future turns. After one truncated response:
1. That 56-char gets stored as `lastProcessedMessages[-1]`
2. Next user turn: `getNewMessages()` returns only the new user text (incremental)
3. But the **truncated response was already in the DOM** as the last assistant message
4. Gemini sees: new user input + old incomplete response as prior context
5. Response amplifies/repeats the pattern

---

## 🗺️ System Architecture

### Component Map

```
OpenClaw / Hermes
    ↓ POST /v1/chat/completions (with full message history)
           ↓
    ┌─────── Route: /v1/chat/completions ──────────────────────────┐
    │                                                           │
    │   PromptEngine.determinePromptStrategy()                 │
    │   ├── isSameConversation() → checks chat_id from metadata │
    │   ├── if same: formatIncrementalPrompt(new msgs only)    │
    │   └── if new/diff: formatTranscript(full history)         │
    │                                                           │
    │   SessionManager (singleton)                              │
    │   ├── getPage() → Playwright page (persistent context)   │
    │   ├── navigateToGemini() / startNewChat()                 │
    │   ├── applyTargetMode() → model switch                    │
    │   └── pruneDOM() → remove old conversation turns         │
    │                                                           │
    │   gollm-transport-stream.ts (RPA driver)                 │
    │   ├── captureBaseline() → text before injection          │
    │   ├── typeInput() → page.evaluate() + InputEvent          │
    │   ├── clickSend()                                         │
    │   └── waitForStableResponse()  ←── polling lives here    │
    │                                                           │
    │   response-extractor.ts (polling logic)                 │
    │   └── buildCheckFn() → injected into browser as JS       │
    │       └── window.__pollState sentinel (stateful)         │
    │                                                       │
    └───────────────────────────────────────────────────────────┘
    ↓
Gemini Web UI (https://gemini.google.com)
```

### Polling State Machine (`window.__pollState`)

Each poll cycle (500ms) runs this JS in-browser:

```javascript
window.__pollState = {
  lastText,       // previous captured text
  stableCount,    // consecutive polls with same text
  startTime,
  done,           // terminal state
  result,         // final captured text
  generationDoneTime  // when stop button disappeared
};
```

**Done conditions** (any one triggers):
1. `stableCount >= 15` **AND** `elapsedSinceGenDone >= 8000ms` (postGenBuffer)
2. `elapsedSinceGenDone >= 8000 + 8000ms` (buffer + minStableWait)
3. `elapsedSinceGenDone >= 13000ms` AND no content → force return `_S.lastText`
4. Global 300s timeout

**Key timing constants** (`src/utils/timings.ts`):

| Constant | Value | Purpose |
|----------|-------|---------|
| `POLL_INTERVAL_MS` | 500ms | Poll frequency |
| `STABLE_THRESHOLD` | 15 | Stable polls before considered done |
| `POST_GENERATION_BUFFER_MS` | 8000ms | Min wait after stop button disappears |
| `RESPONSE_TIMEOUT_MS` | 300000ms | Hard timeout |

### Incremental vs Full Injection (`prompt-engine.ts`)

**Decision logic** (`determinePromptStrategy`):

```
1. Extract system prompt from old vs new messages
   → If system changed: FULL injection + newChat

2. isSameConversation() checks:
   - Primary: chat_id from JSON metadata in system content
   - Fallback: role sequence (user/assistant/tool pattern)

3. If same conversation:
   - getNewMessages() returns only the new messages since last turn
   - formatIncrementalPrompt() skips system/assistant, formats only user+tool
   - If new messages contain no real user content (only metadata): fallback to full
   - If all new messages are metadata: full injection

4. If new conversation or fallback: formatTranscript() (full history)
```

**Critical state**: `session.lastProcessedMessages` — stored in `SessionManager` singleton. This is the reference point for incremental detection.

---

## 🔧 What to Fix

### Primary: Poll Premature Done

**File**: `src/services/response-extractor.ts`

**Problem lines**: The stop-button detection and `generationDoneTime` tracking can fire on an incomplete DOM state.

```typescript
// Current code — problematic:
var stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="停止"], ...');
var isGenerating = !!(stopBtn && stopBtn.offsetHeight > 0);

// If stopBtn was present but is now hidden (generation paused for streaming),
// generationDoneTime gets set, and the 8s countdown starts from an incomplete state.
```

**Suggested fix directions** (pick one):

**Option A — Add response-length floor**: Don't accept a result unless it exceeds a minimum length. If result < 200 chars, continue polling even if stability is reached.

**Option B — Use Gemini's native streaming indicator**: Instead of relying on stop button visibility, look for the actual streaming animation element (typing indicator, or `aria-busy="true"`, or a specific progress element).

**Option C — Increase postGenBuffer + minStableWait**: The current 8s+8s = 16s may still be too short for responses with nested markdown. Increase to 10s+10s = 20s and tune from there.

**Option D — Cross-check result against previous turn**: Store `lastSuccessfulResult` in `window.__pollState`. If `result === lastSuccessfulResult` and result is very short, suspect truncation.

### Secondary: Incremental Mode Contamination

Once a truncated response gets stored in `lastProcessedMessages`, incremental mode will keep reusing it. After fixing the poll, you may also need to verify that `captureBaseline()` in the RPA driver correctly excludes the previous partial response from the baseline.

---

## 📁 Key Files

| File | Role |
|------|------|
| `src/services/response-extractor.ts` | Poll logic — **primary fix target** |
| `src/services/prompt-engine.ts` | Incremental/full decision — uncommitted changes |
| `src/utils/timings.ts` | All timing constants |
| `src/services/session-manager.ts` | Singleton browser state, `lastProcessedMessages` |
| `src/services/gollm-transport-stream.ts` | Orchestrates capture → type → send → poll |
| `src/agents/gollm-transport-stream.ts` | Handles streaming, mutex |

---

## ✅ Verification Plan

1. **Local test**: Send 3 consecutive messages in the same session. All 3 should return different, complete responses. Watch `journalctl --user -u gollm-service` — `got NNN chars` should be > 500 for normal responses.

2. **Cross-session test**: Send a message, restart RPA (`pkill -9 -f gollm-service && systemctl --user start gollm-service`), send again. Should use full injection and not repeat.

3. **Regression check**: Normal single-turn Q&A still works (verify response is sensible, not just the 56-char fragment).

---

## 🔄 Restart Command

```bash
pkill -9 -f gollm-service && sleep 2 && systemctl --user start gollm-service
```

Do **not** use `systemctl restart` — use pkill + start to ensure clean restart.