# GoLLM Service

> **Universal OpenAI-compatible LLM Microservice — Gemini Web UI via Playwright RPA**
>
> 把 Playwright RPA + Gemini Web UI 包裝成一個類似 Ollama 的本地 LLM Provider，支援 OpenClaw 與 Hermes 接入。

## 🚀 快速啟動

```bash
cd ~/gollm-service
npm install
npm start          # 開發模式（tsx 熱重載）
# 或
npm run build && node dist/server/http-server.js  # 生產模式
```

服務運行在：`http://127.0.0.1:3001`

## 支援的模型

| Model ID | 說明 |
|----------|------|
| `gemini-fast` | Gemini Flash 快捷模式 |
| `gemini-think` | Gemini 深度思考模式 |
| `gemini-pro` | Gemini Pro 標準模式 |

使用方式（curl 測試）：

```bash
curl -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-think",
    "messages": [{"role": "user", "content": "台灣最高的山是什麼？"}],
    "stream": false
  }'
```

## 🔧 與 OpenClaw / Hermes 整合

在 OpenClaw 或 Hermes 的模型設定中，加入 custom provider：

```json
{
  "models": {
    "gollm": {
      "provider": "custom",
      "baseURL": "http://127.0.0.1:3001/v1",
      "apiKey": "dummy",
      "model": "gemini-think"
    }
  }
}
```

## 📁 設定檔

所有設定集中在 `service.gollmrc.json`，不需要環境變數：

```json
{
  "server": { "port": 3001 },
  "playwright": {
    "headless": false,
    "userDataDir": "~/.openclaw/gollm-playwright-profile"
  },
  "gemini": {
    "url": "https://gemini.google.com/app",
    "thinkingLog": true,
    "autoLogin": true
  }
}
```

## 🏗️ 架構

```
gollm-service (port 3001)
├── /v1/chat/completions   ← OpenAI-compatible API
├── /v1/models             ← 可用模型列表
└── /health                ← 健康檢查
    │
    ▼
SessionManager (Playwright Chromium 單例)
    │
    ├── gollm-transport-stream.ts  ← RPA 流程控制
    │   ├── typeInput()           ← DOM / Keyboard 注入
    │   └── clickSend()           ← Enter + 按鈕備援
    │
    ├── dom-doctor.ts             ← Selector 池 + AI 修復
    │
    └── response-extractor.ts     ← DOM 輪詢回應解析
```

## ⚠️ 已知限制

1. **單一瀏覽器實例**：不支援高並發，同一時間只能處理一個請求
2. **需要登入過的 Gemini Session**：第一次啟動需手動登入 Google 帳號
3. **Selector 依賴 DOM 結構**：Gemini Web UI 更新可能導致 Selector 失效
4. **~ 路徑未展開**：目前 `userDataDir` 中的 `~` 不會被 shell 展開，預設路徑會是專案目錄下的 `~/`

## 📝 License

MIT 🌸