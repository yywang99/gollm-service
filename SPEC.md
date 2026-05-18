# GoLLM Service 規格書

> **用 Playwright RPA + Gemini Web UI 包裝成獨立 LLM Microservice**
>
> 定位類似 Ollama，但用 Gemini Web UI（已登入的瀏覽器）取代本地模型。

---

## 1. 願景與目標

### 核心目標

把 `gollm-transport-stream.ts`（取自 project-golem 的 RPA 邏輯）封裝成一個**獨立的 HTTP Microservice**，任何 OpenAI-compatible Client 都可以透過標準 API 呼叫：

- ✅ 用 **Google Gemini App** 的完整能力（長上下文、Pro 訂閱功能）當 LLM 大腦
- ✅ 與其他 LLM Provider（OpenAI、Anthropic、MiniMax）同時並存、自由切換
- ✅ 可被任何 OpenAI-compatible Client 呼叫（OpenClaw、Hermes、curl、Python 指令稿）
- ✅ **gollm-service 獨立部署，不受 OpenClaw 更新影響**

### 非目標

- ❌ 不做 standalone Telegram bridge（那是 Project GoLLM 的用途）
- ❌ 不支援高並發多 session（Browser RPA 的本質限制）
- ❌ 不做 Tool Use / Function Calling 轉譯（純 LLM Provider）
- ❌ 不是 OpenClaw Plugin，而是獨立 HTTP Service

---

## 2. 產品定位

### 定位：獨立 Microservice（類似 Ollama）

```
┌───────────────────────────────────────────────────────┐
│              gollm-service (port 3001)                 │
│  ┌──────────────┐  ┌────────────────┐  ┌───────────┐  │
│  │  HTTP API    │  │  Session       │  │   DOM     │  │
│  │  /v1/chat    │──│  Manager       │──│   Doctor  │  │
│  └──────────────┘  └────────────────┘  └───────────┘  │
│        │                  │                   │        │
│        ▼                  ▼                   ▼        │
│  ┌──────────────┐  ┌────────────────┐  ┌───────────┐  │
│  │  Transport   │  │  Playwright    │  │  Selectors│  │
│  │  Streamer    │  │  Chromium      │  │  Pool     │  │
│  └──────────────┘  └────────────────┘  └───────────┘  │
└───────────────────────────────────────────────────────┘
        │ HTTP (OpenAI-compatible)
        ▼
┌───────────────────┐     ┌───────────────────┐
│     OpenClaw       │     │     Hermes         │
│  (當其中一個 Model) │     │  (當其中一個 Model) │
└───────────────────┘     └───────────────────┘
        │
        ▼
┌─────────────────────────────────────────────────────┐
│           Gemini Web UI（已登入的瀏覽器）               │
└─────────────────────────────────────────────────────┘
```

### 適用情境

| 情境 | 建議 Provider |
|------|--------------|
| 日常對話、寫作、翻譯 | MiniMax / OpenAI / Anthropic API |
| 需要 Gemini Pro 長上下文（>128K）| **gollm Gemini Web** |
| 需要 Gemini 獨有工具（Google Workspace）| **gollm Gemini Web** |
| 本地、私密、不走網路的任務 | Ollama / LM Studio |
| 程式碼生成、專業分析 | DeepSeek Coder / Claude |

---

## 3. 功能規格

### 3.1 Transport Provider 核心

**檔案：** `src/agents/gollm-transport-stream.ts`

**職責：**
- 管理 Playwright Chromium Browser Context（單例）
- 將 `messages` 陣列轉換為 Gemini Web UI 可理解的形式
- 執行 輸入 → 發送 → 輪詢回應 的 RPA 流程
- 自動偵測並切換 Gemini 模式（Think / Pro / Fast）
- 過濾不必要的 metadata，確保乾淨的 prompt

**事件流程：**

```
User Message
    ↓
getLatestUserMessage() → 取出 prompt
    ↓
[Event: thinking_start]
    ↓ RPA 流程
Launch / Get Browser Context
    ↓
navigateToGemini() → 確認在 Gemini 頁面
    ↓
startNewChat() / setGeminiMode() → 點擊 New Chat + 選模式
    ↓
typeInput() → DOM injection + Keyboard Events（pool → DOMDoctor → throw）
    ↓
clickSend() → Enter + 按鈕備援
    ↓
waitForNewStableResponse() → DOM 輪詢直到穩定
    ↓
[Event: text_start] → text block #1
[Event: text_delta] → 回覆文字
[Event: text_end]
    ↓
[Event: done]
```

### 3.2 DOM Doctor（Selector 修復）

**檔案：** `src/services/dom-doctor.ts`（移植自 `project-golem/src/services/DOMDoctor.js`）

**職責：**
- 維護 CSS Selector 池（input / send / response）
- 當 Selector 失效時，用 AI（Gemini）診斷並修復（可選，需要 GEMINI_API_KEY）
- 學習 Gemini Web UI 的 DOM 結構變化

**Selector 池（來自 `src/utils/selectors.ts`）：**

```typescript
const SELECTORS = {
  input: [
    ".ql-editor",           // Quill editor (2024+ Gemini)
    ".ProseMirror",         // ProseMirror
    "rich-textarea",        // custom element
    'div[role="textbox"][contenteditable="true"]',
    'div[contenteditable="true"]',
    "textarea",
  ],
  send: [
    'button[aria-label*="Send"]',
    'button[aria-label*="傳送"]',
    'button[aria-label*="發送"]',
  ],
  response: [
    "model-response .model-response-text",
    "model-response",
    "message-content",
    ".response-container-content",
  ]
}
```

### 3.3 設定面板

**檔案：** `service.gollmrc.json`（唯一的設定檔，無需環境變數）

| 設定 key | 說明 | 預設值 |
|----------|------|--------|
| `server.port` | HTTP Server Port | `3001` |
| `server.host` | HTTP Server Host | `127.0.0.1` |
| `playwright.headless` | 是否 headless 啟動瀏覽器 | `false` |
| `playwright.userDataDir` | Chromium Profile 路徑 | `~/.openclaw/gollm-playwright-profile` |
| `playwright.stealth` | 啟用 Stealth 模式 | `true` |
| `gemini.url` | Gemini 目標網址 | `https://gemini.google.com/app` |
| `gemini.thinkingLog` | 輸出 thinking progress 到 console | `true` |
| `gemini.autoLogin` | 自動完成 Google 登入 | `true` |

### 3.4 Gemini 模式追蹤（Target Mode）

gollm-service 支援自動偵測並切換 Gemini 的三種模式：

| 模式 | 說明 | API 模型名稱 |
|------|------|-------------|
| `think` | 深度思考模式（Think / 思考） | `gemini-think` |
| `pro` | Pro 標準模式 | `gemini-pro` |
| `fast` | 快捷模式（Flash） | `gemini-fast` |

**運作流程：**
1. `chat.ts` 從 model ID（`gemini-think` / `gemini-pro` / `gemini-fast`）偵測目標模式
2. `SessionManager.setTargetMode()` 記錄目標模式
3. 每次 navigate 或 startNewChat 後，自動點擊對應的模式按鈕
4. 確保 Gemini 回覆時使用正確的模式

### 3.5 Session 管理

**檔案：** `src/services/session-manager.ts`

**職責：**
- 維護一個 Playwright PersistentContext 單例
- 追蹤 Browser 狀態（已登入 / 需要驗證 / 崩潰重啟）
- 處理 Session 過期時的 re-auth 流程
- 支援 Target Mode 追蹤與自動恢復
- 自動移除 Angular CDK overlay backdrop（解決點擊被阻擋的問題）
- 提供 `mergeOptions()` 讓後續設定載入能更新既有 singleton

**CDK Overlay 問題說明：**
Gemini Web UI 使用 Angular CDK，`.cdk-overlay-backdrop` 會攔截所有點擊事件。SessionManager 在所有點擊操作前會先移除這些 overlay 元素，確保 DOM 操作能正常到達目標按鈕。

### 3.6 尚未實作的功能（未來規劃）

以下功能在 SPEC 中有規劃，但目前尚未實作：

- 多帳號 / 多 Context 支援（Browser Pooling）
- Web Dashboard 控制面板
- Token 消耗 / 使用量估算
- 與 Ollama / LM Studio 的自動 fallback 策略
- Selector 池自動更新（Gemini UI 改版時）

---

## 4. 技術架構

### 4.1 目錄結構

```
gollm-service/
├── src/
│   ├── server/
│   │   └── http-server.ts          # HTTP Server (Fastify)
│   ├── agents/
│   │   └── gollm-transport-stream.ts  # Core RPA → Transport logic
│   ├── services/
│   │   ├── dom-doctor.ts           # DOM Selector AI 修復
│   │   ├── session-manager.ts     # Playwright Browser 生命週期
│   │   └── response-extractor.ts  # DOM 回應輪詢邏輯
│   ├── routes/
│   │   ├── chat.ts                 # /v1/chat (OpenAI-compatible)
│   │   ├── models.ts               # /v1/models
│   │   └── health.ts               # /health
│   └── utils/
│       ├── selectors.ts            # CSS Selector 池
│       └── timings.ts              # Polling intervals, timeouts
├── service.gollmrc.json            # 設定檔（無需環境變數）
├── package.json
├── tsconfig.json
├── SPEC.md
└── README.md
```

### 4.2 HTTP API（OpenAI-compatible）

```
POST /v1/chat/completions
Authorization: Bearer ***（任意值，gollm-service 不驗證）
Content-Type: application/json

{
  "model": "gemini-think",
  "messages": [
    {"role": "system", "content": "你是一個專業助理"},
    {"role": "user", "content": "台灣最高的山是什麼？"}
  ],
  "stream": false
}
```

**其他端點：**
- `GET /v1/models` — 列出可用模型（gemini-fast / gemini-think / gemini-pro）
- `GET /health` — 健康檢查（回傳 session 狀態與 browser 狀態）

### 4.3 依賴

```json
{
  "dependencies": {
    "playwright": "^1.40.0",
    "fastify": "^4.0.0",
    "@fastify/cors": "^8.0.0",
    "dotenv": "^16.0.0",
    "pino-pretty": "^13.1.3",
    "@google/generative-ai": "^0.24.1"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "tsx": "^4.0.0",
    "vitest": "^1.0.0",
    "@types/node": "^20.0.0"
  }
}
```

### 4.4 與 Project GoLLM 的關係

```
Project GoLLM（完整 AI Agent 系統）
├── GolemBrain.js         ← 獨立 AI Agent 系統
├── PageInteractor.js     ← Playwright DOM 操作
├── DOMDoctor.js          ← Selector 修復
└── 自己的記憶、技能、Bridge 系統

gollm-service（本專案）
├── HTTP Server (Fastify)        ← 新增：獨立 HTTP API
├── gollm-transport-stream.ts    ← 只取 PageInteractor 核心
├── dom-doctor.ts                ← 只取 DOMDoctor 的 Selector 修復
└── session-manager.ts           ← 新增：Playwright Context 單例管理
```

**關鍵差異：**
- Project GoLLM 是完整的 AI Agent 系統（有自己的記憶、技能、橋接系統）
- 本專案只是**把 Gemini Web 當成一顆 LLM**，以 OpenAI-compatible API 輸出
- 不需要 GoLLM 的 Skill 系統、Multi-Agent 系統（那些是 OpenClaw 的職責）

### 4.5 與 Ollama 的類比

| 層面 | Ollama | gollm-service |
|------|--------|---------------|
| 底層模型 | 本地 LLM（Llama, Mistral） | Gemini Web UI（雲端） |
| HTTP API | `localhost:11434` | `localhost:3001` |
| API 格式 | OpenAI-compatible | OpenAI-compatible |
| 依賴 | GPU/CPU | 瀏覽器 + 網路 |
| 更新頻率 | 模型下載 | Selector 維護 |

**核心價值：等同於 Ollama，但用 Google Gemini Pro 取代本地模型**

---

## 5. 開發里程碑

### Phase 0：奠基 ✅

- [x] 建立 Service 基本結構
- [x] 實作 Fastify HTTP Server（`/v1/chat`, `/v1/models`, `/health`）
- [x] 移植 `gollm-transport-stream.ts`
- [x] 移植 `dom-doctor.ts`
- [x] 解決多行文字與特殊符號注入造成的 SyntaxError 崩潰問題

### Phase 1：核心功能 ✅

- [x] Playwright Browser 單例管理（Session Manager）
- [x] Selector 自動修復流程整合（DOMDoctor）
- [x] 實作 Request Mutex 處理單一 Browser 實例的併發防護
- [x] 回應輪詢穩定性強化（偵測 Stop 按鈕避免提早擷取）
- [x] 無狀態 API 到有狀態網頁的映射（Transcript Snapshotting / Context Sync）
- [x] 實作 `/v1/models` 正確回傳三個模型（gemini-fast / gemini-think / gemini-pro）

### Phase 2：穩定化 ✅

- [x] 處理 Google 登入 session 過期 re-auth 流程
- [x] DOM Pruning 防止長對話記憶體洩漏（Memory Leak）
- [x] 崩潰恢復（Crash Recovery）與事件監聽
- [x] Gemini 模式偵測與追蹤（Think / Pro / Fast）
- [x] SessionManager `mergeOptions()` 讓 gollmrc.json 設定能動態更新
- [x] Angular CDK overlay backdrop 移除，解決點擊被阻擋的問題
- [x] Health endpoint 改為真實查詢 session 狀態與瀏覽器回應能力

### Phase 3：強化（規劃中）

- [ ] 多帳號 / 多 Context 支援（Browser Pooling）
- [ ] Web Dashboard 控制面板
- [ ] Token 消耗 / 使用量估算
- [ ] 與 Ollama / LM Studio 的自動 fallback 策略
- [ ] Selector 池自動更新（Gemini UI 改版時）
- [ ] `~` 路徑自動展開（目前 `userDataDir` 中的 `~` 不會被 Node.js 展開）

### Phase 4：幻覺防制 ✅（實作中）

- [x] Hallucination Guard 機制（攔截「已處理」類幻覺回覆）
- [x] System Observation 反饋注入（讓 Gemini 自我修正）
- [x] 嚴格的 Action 格式約束（強化 Prompt 提示）
- [x] 回應驗證層（Response Validation Layer）
- [x] Retry Feedback Loop（最多 2 次重試）

---

## 6. 風險與對應

| 風險 | 機率 | 影響 | 對應 |
|------|------|------|------|
| Google 改 UI 導致 Selector 失效 | 高 | 中 | DOM Doctor AI 修復 + Selector 池 fallback |
| 單一 Browser Context 無法高並發 | 高 | 低 | 這是已知限制，不追求這個場景 |
| Playwright 版本與 Chromium 相容問題 | 中 | 中 | 用 `@playwright/test` 的版本固定機制 |
| Google 封鎖自動化操作 | 低 | 高 | 降低操作頻率、用 Stealth 模式 |
| Session cookie 過期 | 中 | 中 | Session Manager 自動偵測 + 提示 re-login |
| `userDataDir` 路徑 `~` 未展開 | 中 | 中 | 導致瀏覽器实例使用錯誤的 Profile 目錄 |

---

## 7. 驗收標準

### 功能驗收

- [x] 啟動 gollm-service（`npm start`）後，可以透過 curl 與 Gemini Web 對話
- [x] Selector 失效時，DOM Doctor 會嘗試 AI 修復（可選功能，需 GEMINI_API_KEY）
- [x] 與 OpenAI / Anthropic Provider 同時存在不衝突
- [x] `/v1/models` 正確回傳三個模型
- [x] `/health` 正確反映 session 狀態與瀏覽器回應能力
- [ ] Session 過期後有合理的錯誤訊息與復原指引
- [ ] Headless 模式下在 Server/VPS 可正常運作

### 穩定度驗收

- [ ] 連續 50 回合對話不發生 DOM 洩漏
- [ ] CDK overlay 移除穩定，點擊操作不再被阻擋

### 幻覺防制驗收

- [x] 當 Gemini 回覆「我已經修改了檔案」但無 action 標籤時，系統自動注入 System Observation
- [x] 重試後仍無 action，回覆攔截並附加 `unconfirmed_action` flag
- [x] 不影響正常的純文字對話流程（不可過度警覺）
- [x] 重試次數上限 2 次，防止無限循環
- [x] 可以透過 `service.gollmrc.json` 設定 `hallucinationGuard.enabled` 開關

---

## 8. 幻覺防制機制（Hallucination Guard）

> **問題定義**：透過 gollm-service 的 Gemini Web App，模型常見的幻覺是聲稱「我已經修改了檔案」、「已處理完成」，但實際上並未執行任何工具，直接將回覆傳給 Hermes/OpenClaw，導致 Agent 誤以為任務已完成。

### 8.1 問題根因

| 層次 | 根因 |
|------|------|
| **第一層：Chatbot Bias** | Gemini 網頁版被訓練成「貼心的對話助理」，看到「修改檔案」類任務會直接說「已處理好」，而不知道自己被關在 RPA 殼裡 |
| **第二層：Tool Call 缺失** | gollm-service 靠 Prompt 要求 Gemini 輸出格式，但上下文過長或任務複雜時，Gemini 會漏看格式要求，直接輸出純文字 |
| **第三層：無驗證迴路** | `executeGollmRPA()` 收到回覆後，若 `parseToolCalls()` 為空，直接當成「普通文字回覆」傳回，沒有任何重新引導機制 |

### 8.2 解決方案：四層防衛

#### 第一層｜Prompt 強約束（輸入時）
在 `formatTranscript()` 中加入 STRICT SYSTEM REMINDER：

```
[STRICT SYSTEM REMINDER - NON-NEGOTIABLE]
You are running inside a Playwright RPA shell. You do NOT have direct filesystem access.
- If user asks you to modify/create/delete files or run shell commands, you MUST output the appropriate action tags.
- If you claim "I have already done X" without outputting action tags, you are HALLUCINATING.
- Every file modification must be requested via action tags. You cannot fabricate completion.
```

#### 第二層｜回應驗證（收到回覆時）
在 `executeGollmRPA()` 收到 `waitForStableResponse()` 的回覆後，立刻進行幻覺偵測：

```typescript
// 偽代碼
const result = await waitForStableResponse(page, baseline);
const toolCalls = parseToolCalls(result.text);
const hallucination = detectHallucination(result.text, toolCalls);

if (hallucination.isHallucination) {
  await injectSystemObservation(page, hallucination.reason);
  // 重試（最多 2 次）
}
```

#### 第三層｜System Observation 注入（Feedback Loop）
當偵測到幻覺時，向 Gemini 注入：

```
[System Observation] ⚠️ HALLUCINATION DETECTED

Your previous response claimed completion without outputting action tags.
You do NOT have filesystem access. You MUST output your intended action in the correct format.
```

#### 第四層｜熔斷機制
重試 2 次後仍無有效 action，回傳時附加 metadata flag：
```json
{
  "content": "我已經修改了檔案...",
  "_gollm_hallucination_warn": true,
  "_gollm_unconfirmed_action": true
}
```

### 8.3 實作變更

| 檔案 | 變更內容 |
|------|---------|
| `src/utils/hallucination-patterns.ts` | **新增**：幻覺關鍵字 pattern 集合 |
| `src/utils/tool-parser.ts` | 新增 `detectHallucination()` 函式 |
| `src/agents/gollm-transport-stream.ts` | 加入驗證 → 重試迴路 + STRICT SYSTEM REMINDER |
| `src/routes/chat.ts` | 附加 `_gollm_hallucination_warn` metadata |

---

## 9. 設定檔新增選項（service.gollmrc.json）

```json
{
  "hallucinationGuard": {
    "enabled": true,
    "maxRetries": 2,
    "patterns": [
      "已處理", "已修改", "已完成", "已經做好",
      "I have already modified", "I have already created", "Done!"
    ]
  }
}
```

---

_規格書版本：v0.3.0_
_更新日期：2026-05-17_
_適用版本：gollm-service v0.3.0_