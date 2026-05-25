# GoLLM Service

> **Universal OpenAI-compatible LLM Microservice — Gemini Web UI via Playwright RPA**

將 Gemini Web UI 透過 Playwright RPA 包裝成一個 OpenAI 相容的本地 LLM Provider，專為 OpenClaw 與 Hermes 等 Agent 框架設計，解決 API 配額限制並利用網頁端的功能。

## 🚀 快速啟動

```bash
cd ~/gollm-service
npm install
# 開發模式（tsx 熱重載）
npm start          
# 或生產模式
npm run build && node dist/server/http-server.js
```

服務運行在：`http://127.0.0.1:3001`

## 🌟 核心功能與優化 (Latest)

### 1. Context Overflow 防護機制
針對 OpenClaw 等 Agent 注入大量 System Prompt（如 60+ 工具定義）導致的瀏覽器卡死問題，引入了**減壓閥機制**：
- **`MAX_TOOLS_SECTION_LENGTH = 8000`**: 當工具描述過長時，自動截斷並僅保留高優先級工具，防止單次注入撐破 Gemini 網頁輸入框。
- **`MAX_TRANSCRIPT_LENGTH = 80000`**: 提升對話歷史緩衝區上限，確保長對話的穩定性。

### 2. 強制會話重置 (Hard Reset)
針對 `startNewChat` 請求，不再單純依賴點擊按鈕，而是改用硬重置邏輯：
- **強制導向** $\rightarrow$ **驗證清空** $\rightarrow$ **必要時 Reload**。
- 確保在 Context Shift (Compress/Compact) 後，Gemini Session 真正回到 Fresh 狀態。

### 3. RPA 魯棒性增強
- **DOMDoctor**: 內建 Selector 池，當 Gemini 更新 DOM 結構時可嘗試自動修復。
- **Thinking Level 鎖定**: 在模型切換後自動執行 `setThinkingLevel()`，防止 Gemini 將思考模式重置回「標準」。

## 🛠️ 整合指南

### OpenClaw / Hermes 設定
```json
{
  "models": {
    "gollm": {
      "provider": "custom",
      "baseURL": "http://127.0.0.1:3001/v1",
      "apiKey": "not-required",
      "model": "pro"
    }
  }
}
```

### 支援模型
- `flash-lite`: Gemini Flash-Lite（行動版 / 最低延遲）
- `flash`: Gemini Flash（快速回覆）
- `pro`: Gemini Pro（標準深度回覆，預設）

在請求中指定：
```json
{ "model": "pro", "messages": [...] }
```
模型名稱不區分大小寫，`"Pro"`、`"gemini-pro"` 都能正確匹配。

## 📁 設定與部署

所有設定集中在 `service.gollmrc.json`：
- `server.port`: 預設 3001。
- `playwright.userDataDir`: 指定 Chrome Profile 路徑（建議使用絕對路徑）。
- `playwright.headless`: 設定為 `false` 以便在除錯時觀察瀏覽器行為。

## 🏗️ 系統架構

```
gollm-service (port 3001)
├── /v1/chat/completions   ← OpenAI API 進入點
├── /v1/models             ← 模型列表
└── /health                ← 健康檢查 (狀態: session, browser)
    │
    ▼
SessionManager (Playwright Chromium 單例)
    │
    ├── gollm-transport-stream.ts  ← RPA 核心 (含 Tools 截斷邏輯)
    │   ├── typeInput()           ← 智能輸入 (含 Timeout 處理)
    │   └── clickSend()           ← 發送觸發
    │
    ├── dom-doctor.ts             ← DOM 結構修復與 Selector 驗證
    │
    └── response-extractor.ts     ← 異步回應輪詢與解析
```

## ⚠️ 運維注意
- **單一實例**：由於依賴單一瀏覽器 Session，不支援高併發。
- **初始化**：第一次啟動需在 `headless: false` 模式下完成 Google 帳號登入。
- **重啟建議**：若遇瀏覽器僵死，請使用 `pkill -9 -f gollm-service` 後再啟動。

---
MIT 🌸
