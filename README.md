# GoLLM Service

> **Universal OpenAI-compatible LLM Microservice** — Gemini Web UI via Playwright RPA

GoLLM Service wraps the Gemini Web UI as an OpenAI-compatible local LLM provider via Playwright RPA. Designed for OpenClaw and Hermes agent frameworks, it bypasses API quota limits and leverages the full feature set available in Gemini's web interface.

---

## 🌏 English

> **GoLLM Service** — Gemini Web RPA as a local OpenAI-compatible LLM Provider

GoLLM wraps Google Gemini (via the web UI at [gemini.google.com](https://gemini.google.com)) as an OpenAI-compatible microservice. Instead of calling the Gemini API directly, it uses Playwright to automate the browser-based Gemini chat — giving you API-quota-free access to all web-only features.

**Key features:**
- 🎯 **OpenAI-compatible** — drop-in replacement for OpenAI API calls in OpenClaw, Hermes, or any OpenAI SDK
- 🆓 **No API costs** — uses the Gemini web UI, not the billed API
- 🔧 **Tool/function calling** — parses tool schemas from your prompt and executes them in-browser
- 🧠 **Incremental context** — tracks conversation history, injects system prompts, and avoids re-sending full transcripts
- 🛡️ **Hallucination Guard** — detects and retries repeated or blank responses

**Supported models** (set via `model` in your request):
- `flash-lite` — lowest latency, lightweight tasks
- `flash` — fast responses (default)
- `pro` — deep, thoughtful responses

---

## 🚀 Quick Start

```bash
cd ~/gollm-service
npm install

# Development (tsx hot-reload)
npm start

# Production
npm run build && node dist/server/http-server.js
```

Server runs at: `http://127.0.0.1:3001`

**First-time setup — login confirmation checklist:**

```
1. Ensure playwright.headless is set to false in service.gollmrc.json (default)
2. Start the service: systemctl --user start gollm-service
3. Check browser is open: curl http://127.0.0.1:3001/health
   → status should be "degraded", session "new" or "needs_reauth"
4. Manually log into your Google account in the browser
5. Verify session: query /health again
   → session should become "logged_in"
6. Test Gemini: type any question in the browser, confirm it responds
7. After login, set headless back to true and restart the service
```

> 💡 **Note:** Playwright's browser binary and your logged-in user profile (cookies, session, etc.) are completely separate. The browser binary lives in the system cache (e.g. `~/.cache/ms-playwright/`), while your login state is stored in the project's `gollm-playwright-profile` folder. Upgrading, reinstalling, or switching headless binaries **will not** affect your logged-in Google session.

**Quick tests (no login required for health):**

```bash
# Health check
curl http://127.0.0.1:3001/health

# Test API (may require login on first run)
curl -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"flash","messages":[{"role":"user","content":"hello"}]}'
```

---

## ⚙️ Configuration (`service.gollmrc.json`)

```json
{
  "server": { "host": "127.0.0.1", "port": 3001 },
  "playwright": {
    "headless": true,
    "userDataDir": "gollm-playwright-profile"
  },
  "prompt": {
    "maxTranscriptLength":   60000,
    "maxToolsSectionLength":  64000,
    "maxToolOutputLength":    3000,
    "enableMediaSendReminder": true
  }
}
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `maxTranscriptLength` | Max total conversation history (chars), older messages are truncated | 60000 |
| `maxToolsSectionLength` | Max combined tool list size (chars), truncated if exceeded | 64000 |
| `maxToolOutputLength` | Per-call tool output truncation limit (chars) | 3000 |
| `enableMediaSendReminder` | Inject media-sending instructions into tool schema section | true |

---

## 🔌 OpenClaw / Hermes Integration

```json
{
  "models": {
    "gollm": {
      "provider": "custom",
      "baseURL": "http://127.0.0.1:3001/v1",
      "apiKey": "***",
      "model": "flash"
    }
  }
}
```

**Supported models** (specify via `model` field in request):
- `flash-lite` — minimum latency
- `flash` — fast (default)
- `pro` — deep responses

---

## 📡 API Endpoints

| Endpoint | Description |
|----------|-------------|
| `POST /v1/chat/completions` | Main API (OpenAI-compatible) |
| `GET /v1/models` | Model list |
| `GET /health` | Health check (see status values below) |

### `/health` status values

```json
{
  "status": "healthy",
  "service": "gollm-service",
  "version": "0.4.0",
  "session": "logged_in",    // new | logged_in | needs_reauth | crashed
  "browser": "responsive"  // responsive | unresponsive
}
```

- `status: healthy` — session OK, browser OK
- `status: degraded` — session usable, but browser is slow or just restarted
- `status: error` — session invalid (re-login required)

---

## 🏗️ System Architecture

```
HTTP Server (Fastify)
├── POST /v1/chat/completions
│   └── ChatRoute → executeGollmRPA()
│                      │
│                      ▼
│               PromptEngine
│               ├── Decides "incremental" vs "full" prompt strategy
│               ├── Truncates tool list + conversation history
│               └── Injects tool format specs + media reminders
│                      │
│                      ▼
│               SessionManager (singleton Chromium)
│               ├── navigateToGemini()
│               ├── startNewChat()   ← skipped in incremental mode
│               └── typeInput() / clickSend()
│                      │
│                      ▼
│               ResponseExtractor
│               ├── waitForStableResponse()
│               └── Hallucination Guard (see SPEC.md)
│
└── GET /health
    └── SessionManager status report
```

---

## ⚠️ Operations Notes

- **Service name:** `systemctl --user list-units --type=service | grep gollm`
- **Single instance only:** relies on a singleton browser session — not suitable for high concurrency
- **Session expired:** set `headless: false`, re-login, then restart
- **Browser frozen:** `pkill -9 -f gollm-service && systemctl --user start gollm-service`
- **View logs:** `journalctl --user -u gollm-service -f`

---

## 📚 Full Documentation

- [SPEC.md](SPEC.md) — API contracts, design decisions, Hallucination Guard, error code reference
- [service.gollmrc.json](service.gollmrc.json) — complete config reference

---

## 中文說明

將 Gemini Web UI 透過 Playwright RPA 包裝成 OpenAI 相容的本地 LLM Provider，專為 OpenClaw 與 Hermes 等 Agent 框架設計，繞過 API 配額限制並利用網頁端的深度功能。

## 🚀 快速啟動

```bash
cd ~/gollm-service
npm install

# 開發模式（tsx 熱重載）
npm start

# 生產模式
npm run build && node dist/server/http-server.js
```

服務運行在：`http://127.0.0.1:3001`

**首次啟動：登入確認清單**

```
1. 確認 service.gollmrc.json 中的 playwright.headless 為 false（預設即為 false）
2. 啟動服務：systemctl --user start gollm-service
3. 確認瀏覽器已開啟：curl http://127.0.0.1:3001/health
   → 此時 status 應為 "degraded"，session 為 "new" 或 "needs_reauth"
4. 手動在瀏覽器中完成 Google 帳號登入
5. 驗證 session 已建立：再次查詢 /health
   → session 變為 "logged_in"
6. 確認 Gemini 可用：在瀏覽器輸入任意問題，確認有回覆
7. 登入成功後，可將 headless 改回 true 並重啟服務
```

> 💡 **提示**：Playwright 的瀏覽器執行檔與使用者登入 Profile（包含登入狀態、Cookies 等）是完全分離的。瀏覽器主程式位於系統快取中（例如 `~/.cache/ms-playwright/`），而登入資料則完整保存在專案目錄的 `gollm-playwright-profile` 資料夾。因此，不論是升級、重新安裝、或是切換無頭（headless）瀏覽器二進位檔，**均不會影響或遺失**您已經登入的 Google 帳號 Session。

---

**快速測試（不需登入）：**

```bash
# 健康檢查
curl http://127.0.0.1:3001/health

# 測試 API（首次可能需登入）
curl -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"flash","messages":[{"role":"user","content":"hello"}]}'
```

---

## ⚙️ 設定 (`service.gollmrc.json`)

```json
{
  "server": { "host": "127.0.0.1", "port": 3001 },
  "playwright": {
    "headless": false,
    "userDataDir": "gollm-playwright-profile"
  },
  "prompt": {
    "maxTranscriptLength":   60000,
    "maxToolsSectionLength":  64000,
    "maxToolOutputLength":    3000,
    "enableMediaSendReminder": true
  }
}
```

| 參數 | 說明 | 預設值 |
|------|------|--------|
| `maxTranscriptLength` | 對話歷史總長度上限（chars），超過則截斷舊訊息 | 60000 |
| `maxToolsSectionLength` | 工具清單總長度上限（chars），超過則截斷 | 64000 |
| `maxToolOutputLength` | 單次工具輸出截斷上限（chars） | 3000 |
| `enableMediaSendReminder` | 是否在工具區塊注入媒體發送規範提醒 | true |

---

## 🔌 OpenClaw / Hermes 整合

```json
{
  "models": {
    "gollm": {
      "provider": "custom",
      "baseURL": "http://127.0.0.1:3001/v1",
      "apiKey": "not-required",
      "model": "flash"
    }
  }
}
```

**支援模型**（在請求中指定 `model` 欄位）：
- `flash-lite` — 最低延遲，輕量場景
- `flash` — 快速回覆（預設）
- `pro` — 深度回覆

---

## 📡 API 端點

| 端點 | 說明 |
|------|------|
| `POST /v1/chat/completions` | 主要 API（OpenAI compatible） |
| `GET /v1/models` | 模型列表 |
| `GET /health` | 健康檢查（見下方狀態說明） |

### `/health` 狀態值

```json
{
  "status": "degraded",
  "service": "gollm-service",
  "version": "0.4.0",
  "session": "logged_in",   // new | logged_in | needs_reauth | crashed
  "browser": "unresponsive" // responsive | unresponsive
}
```

- `status: healthy` — session 正常，browser 正常
- `status: degraded` — session 可用，但 browser 響應緩慢或剛重啟
- `status: error` — session 失效（需重新登入）

---

## 🏗️ 系統架構

```
HTTP Server (Fastify)
├── POST /v1/chat/completions
│   └── ChatRoute → executeGollmRPA()
│                      │
│                      ▼
│               PromptEngine
│               ├── 決定使用「增量」或「全量」prompt
│               ├── 截斷工具清單、對話歷史
│               └── 注入工具格式規範 + 媒體發送提醒
│                      │
│                      ▼
│               SessionManager（單例 Chromium）
│               ├── navigateToGemini()
│               ├── startNewChat()   ← 增量模式時省略
│               └── typeInput() / clickSend()
│                      │
│                      ▼
│               ResponseExtractor
│               ├── waitForStableResponse()
│               └── Hallucination Guard（見 SPEC.md）
│
└── GET /health
    └── SessionManager 狀態報告
```

---

## ⚠️ 運維須知

- **確認 service 名稱**：`systemctl --user list-units --type=service | grep gollm`
- **單一實例**：依賴單一瀏覽器 Session，不支援高併發。
- **Session 失效**：若 `session: needs_reauth`，需將 `headless: false` 並重新登入。
- **瀏覽器僵死**：`pkill -9 -f gollm-service && systemctl --user start gollm-service`。
- **日誌查看**：`journalctl --user -u gollm-service -f`

---

## 📚 完整文件

- [SPEC.md](SPEC.md) — API 合約、設計決策、Hallucination Guard、錯誤碼對照
- [service.gollmrc.json](service.gollmrc.json) — 完整設定範例

---

MIT 🌸