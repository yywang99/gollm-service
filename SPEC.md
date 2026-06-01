# GoLLM Service — SPEC.md

> **Specs are the contract.** If an AI agent or developer reads one document to understand this service, it should be this one.

---

## 1. 概述

**GoLLM Service** 是一個將 Gemini Web UI（`gemini.google.com`）包裝成 OpenAI Compatible API 的本地代理服務。它透過 Playwright RPA 控制真實瀏覽器執行 Prompt 注入，而非使用官方 Gemini API。

**為什麼用 RPA 而非 API？**
- 規避 Gemini API 的 Rate Limit 與配額限制
- 網頁端有更多功能（如深度搜尋、多模態上傳）
- 可使用 Gemini Pro/Flash 的更強模型

**限制：**
- 單一 Browser Session，無併發支援
- 需要稳定的 Google 帳號登入狀態

---

## 2. API Contract

### 2.1 Request — `POST /v1/chat/completions`

```json
{
  "model": "flash",           // flash | flash-lite | pro（可混合大小寫）
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ],
  "tools": [...],             // OpenAI tool definitions（可選）
  "stream": false              // 目前固定不支援 streaming
}
```

### 2.2 Response — `POST /v1/chat/completions`

```json
{
  "id": "gollm-1749991234567",
  "object": "chat.completion",
  "model": "flash",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "文字回覆，或 null（當為 pure tool call 時）",
      "tool_calls": [...]        // 當有工具呼叫時
    },
    "finish_reason": "stop"      // stop | tool_calls
  }],
  "usage": { "total_tokens": 0 },
  // ── Custom fields（給 OpenClaw / Hermes 整合用）───────────────
  "_gollm_unconfirmed_action": true,   // Hallucination Guard 觸發過（可選）
  "_gollm_hallucination_warn": true    // 同上，附加在 choice 內（可選）
}
```

**Custom fields 說明：**
- `_gollm_unconfirmed_action: true` — 表示模型在這次回覆中聲稱執行了某動作但未成功輸出 tool call，Hallucination Guard 已嘗試修正但仍失敗。Agent 可以拿這個欄位做額外的使用者提示或降級處理。
- 這個欄位**不影響** HTTP status code（200），純粹是 response body 內的metadata。

---

## 3. Tool Call 格式（重要）

### 3.1 輸入格式（gollm-service → Gemini）

Tool definitions 會以 JSON 形式注入到 Prompt 中，Gemini 需要輸出以下兩種格式之一：

**格式 A — `<tool_call>` JSON block（主要）：**
```
<tool_call>
{"name": "web_fetch", "arguments": {"url": "https://..."}}
</tool_call>
```

**格式 B — `<call:domain:method>` XML 標籤（向後兼容 Hermes）：**
```
<call:default_api:run_shell_command>{"command": "ls -la"}</call>
```

### 3.2 輸出清洗（gollm-service → Client）

回覆給 client 前，`sanitizeWebRpaOutput()` 會：
1. **剝離 Markdown code block wrappers** — ```json ... ``` → 內部內容
2. **還原 HTML 實體** — `<` → `<`，`>` → `>`，`&` → `&`

這是因為 Gemini Web UI 會自動將 `<` 轉換為 `<`，所以解析時必須還原。

### 3.3 媒體發送提醒（Media Send Reminder）

當 `config.prompt.enableMediaSendReminder: true` 時，在工具清單下方會自動注入：

```
[Critical: How to Send Images/Media]
When sending images or files, you MUST use the MEDIA: prefix with a LOCAL ABSOLUTE PATH.
Example correct: In a send_message tool call, use "MEDIA:/home/yywang/.hermes/image_cache/photo.jpg"
NEVER claim "photo sent" or "image delivered" without actually outputting a valid tool_call.
NEVER use an external HTTP URL (e.g. Bing URL) as the media path — Telegram cannot fetch it.
```

這是因為 Gemini 模型常見的「聲稱已發送圖片」幻覺，實際上根本沒有輸出 tool call。

---

## 4. Hallucination Guard（幻覺防護）

### 4.1 偵測邏輯

`detectHallucination()` 在每次 Gemini 回覆後執行，檢查三種模式：

| 類型 | 模式 | 觸發條件 |
|------|------|---------|
| **Refusal** | 拒絕執行指令（「我是 AI 無法...」） | 出現拒絕關鍵詞 |
| **Completion Claim** | 聲稱完成但沒有 tool call | 有「已發送」「已修改」「已完成」等關鍵詞，且無 tool call 輸出 |
| **File Intent + Short** | 意圖修改檔案但回覆極短 | 有檔案操作意圖 + 回覆 < 200 字元 |

### 4.2 修正流程

```
Gemini 回覆
    │
    ▼
detectHallucination()
    │
    ├── 無幻覺 → 回傳給 client
    │
    └── 有幻覺 → injectSystemObservation() 注入強制定義：
                "⚠️ HALLUCINATION DETECTED
                 You MUST use tool_call format.
                 Do NOT claim completion without tool call."
                → clickSend() → Gemini 重試
                   │
                   ▼
              waitForStableResponse()
                   │
                   ▼
              validateWithHallucinationGuard()（遞迴，maxRetries=2）
                   │
                   ├── 成功消除幻覺 → 回傳修正後回覆
                   └── 仍失敗（max retries）→ 回傳並附加 _gollm_unconfirmed_action: true
```

### 4.3 通訊幻覺偵測模式

以下是專門針對「聲稱發送訊息/圖片」的模式（`completionClaims` 中的 `messaging` 子集）：

**中文：** `已發送好了`、`圖片已發送`、`照片已傳送`、`訊息已發送`、`發送成功`、`已把圖片發過去` 等。

**英文：** `I have sent the photo`、`photo sent successfully`、`I've shared the image` 等。

當模型說出這些話卻**沒有**輸出 tool call 時，Hallucination Guard 會觸發修正。

---

## 5. Prompt 策略（Incremental vs Full）

### 5.1 決策邏輯

`determinePromptStrategy()` 每次請求都會評估：

```
isSameConversation(oldMsgs, newMsgs)?
    ├── YES → 增量模式（只送新訊息，理論上最快）
    │          但若新訊息全是 metadata 無實際內容 → 退為全量
    └── NO  → 全量模式（全新對話，或 Context Shift）
               └── requireNewChat: true（點擊「New Chat」避免混淆）
```

**isSameConversation 判定：**
1. **主要**：從 system message 的 metadata JSON 中取 `chat_id`，比對雙方是否相同
2. **Fallback**：比較 message role sequence（role 相同則視為同一對話）

### 5.2 System Prompt 變更檢查

即使 `chat_id` 不變，只要 system message 有實質變更（排除 `[Note: model was just switched...]` 這類瞬態註記），就會觸發 `requireNewChat: true`，確保新指示被正確套用。

### 5.3 Metadata 剝離

`cleanContent()` 會移除：
- OpenClaw 格式：`Conversation info (untrusted metadata):\n\`\`\`json\n{...}\n\`\`\``
- Hermes 格式：`[Metadata]\n...`
- 單行 header：`Conversation context (untrusted ...): ...`

避免這些 metadata 進入 Gemini 污染 Prompt。

---

## 6. 設定檔完整參考 (`service.gollmrc.json`)

```json
{
  "server": {
    "host": "127.0.0.1",
    "port": 3001
  },
  "playwright": {
    "browser": "chromium",
    "headless": false,
    "userDataDir": "gollm-playwright-profile",
    "stealth": true
  },
  "gemini": {
    "url": "https://gemini.google.com/app",
    "thinkingLog": true,
    "autoLogin": true
  },
  "selectors": {
    "input":   [".ql-editor", ".ProseMirror", "div[contenteditable='true']"],
    "send":    ["button[aria-label*='Send']", "button[aria-label*='傳送']"],
    "response":["model-response .model-response-text", "message-content"]
  },
  "limits": {
    "maxResponseTimeMs": 300000,
    "pollIntervalMs": 500,
    "stableThreshold": 10,
    "maxRetries": 3
  },
  "prompt": {
    "maxTranscriptLength":    60000,
    "maxToolsSectionLength":   64000,
    "maxToolOutputLength":     3000,
    "enableMediaSendReminder": true
  }
}
```

| 欄位 | 類型 | 說明 |
|------|------|------|
| `server.port` | number | HTTP 監聽埠，預設 3001 |
| `playwright.headless` | boolean | `false` 時可觀察瀏覽器，適合首次登入 |
| `playwright.userDataDir` | string | Chromium profile 目錄（影響登入狀態持久化）|
| `gemini.thinkingLog` | boolean | 是否在 console 輸出 Thinking log |
| `selectors.*` | string[] | DOM 選擇器池，按順序嘗試找元素 |
| `limits.maxResponseTimeMs` | number | Gemini 回覆最大等待時間（300s）|
| `prompt.maxTranscriptLength` | number | 對話歷史總長上限（chars） |
| `prompt.maxToolsSectionLength` | number | 工具清單總長上限（chars） |
| `prompt.maxToolOutputLength` | number | 單次工具輸出截斷門檻（chars） |
| `prompt.enableMediaSendReminder` | boolean | 是否注入媒體發送強制規範 |

---

## 7. 錯誤碼與狀態對照

### HTTP Status Codes

| Code | 意義 |
|------|------|
| 200 | 成功（含 hallucination warning） |
| 400 | 請求格式錯誤（如缺少 `messages`）|
| 401 | Google Session 失效（`needs_reauth`）|
| 500 | Internal error（如 Playwright 崩潰、Timeout）|

### `session` field（`/health` 或 error payload 中）

| 值 | 意義 | 處理方式 |
|----|------|---------|
| `new` | 首次啟動，尚未登入 | 設 `headless: false` 手動登入 |
| `logged_in` | 正常 | — |
| `needs_reauth` | Session 過期 | 需重新登入 Google 帳號 |
| `crashed` | 瀏覽器崩潰 | `pkill -9 -f gollm-service && start` |

### `browser` field

| 值 | 意義 |
|----|------|
| `responsive` | 瀏覽器正常運行 |
| `unresponsive` | 瀏覽器無響應（可能需要重啟）|

---

## 8. 設計決策記錄（Design Decisions）

### Q: 為什麼用 `<tool_call>` JSON block 而非 function calling？
**A:** Gemini Web UI 本身沒有原生 function calling，模型輸出的是自由格式文字。我們用 `<tool_call>` XML/JSON 標籤將工具呼叫語義化，再從回覆文字中用正則表達式解析出來。這是 Web UI 的限制，也是為什麼需要 `sanitizeWebRpaOutput()`。

### Q: 為什麼不直接用 Gemini API？
**A:** API 有嚴格的 Rate Limit（如 15 req/min），且無法使用 Gemini Pro 等高階模型。RPA 方式能繞過這些限制，代價是犧牲了併發能力和穩定性。

### Q: Hallucination Guard 的 maxRetries = 2 是怎麼訂出來的？
**A:** 經驗值。測試中發現 Gemini 通常在第一次 self-correction 就能修正；第二次 retry 的邊際效益已經很低。設成 3 以上會明顯拖慢回應速度且效果有限。

### Q: 為什麼工具清單截斷是從頭遍歷？
**A:** 因為 OpenAI tool definitions 中，越前面的工具被截掉的機會越大。從頭遍歷意味著高優先級工具（在陣列前面）更可能被保留。如果需要更智能的優先級排序，可以在 `includedTools` 收集時加入 priority score。

---

## 9. 安全性考量

- **Session Cookie**：存放在 `playwright.userDataDir`，應設定適當的檔案權限（建議 `chmod 700`）。
- **API Key**：目前 `apiKey: "not-required"`，但若未來要加強安全，可替換為固定密鑰並在 `Authorization: Bearer <key>` header 驗證。
- **Config 中的 Secret**：如果 `service.gollmrc.json` 包含任何敏感資訊，不要 commit 到 Git（已加入 `.gitignore`）。

---

*Last updated: 2026-06-01*