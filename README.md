# GoLLM Service

> **Universal OpenAI-compatible LLM Microservice** — Gemini Web UI via Playwright RPA

將 Gemini Web UI 透過 Playwright RPA 包裝成 OpenAI 相容的本地 LLM Provider，專為 OpenClaw 與 Hermes 等 Agent 框架設計，繞過 API 配額限制並利用網頁端的深度功能。

---

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

**首次啟動**：將 `playwright.headless` 設為 `false`，手動完成 Google 帳號登入。之後可改回 `true`。

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