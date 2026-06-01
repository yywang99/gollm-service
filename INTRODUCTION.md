# 為什麼我寫了 gollm-service：用 Playwright RPA 把 Gemini 包裝成 OpenAI API

**gollm-service** 是我個人用來繞過 Gemini API 配額限制的side project。它用 Playwright 控制真實的 Gemini 網頁介面，對外暴露成一個標準的 OpenAI Compatible API，讓 OpenClaw 和 Hermes 這些 Agent 框架可以像對接 Ollama 一樣直接用上 Gemini 的能力，代價是犧牲一點穩定性換取更大的模型可用性。

---

## 痛點：Gemini API 的配額實在太窄了

用 Gemini 官方 API 的時候，15 req/min 的 Rate Limit 讓多agent 系統很容易就撞牆。特別是當你有好幾個並行的 subagent 同時在跑，一分鐘15次根本不够用。

Gemini 網頁端（`gemini.google.com`）本身沒有這個限制——起碼在我的使用情境裡，它更穩定也更寛松。於是就有了這個念頭：與其想辦法繞 API Rate Limit，不如直接控制瀏覽器。

---

## 核心思路：不要 SDK，只要瀏覽器

```
Client (OpenClaw/Hermes)
    │  POST /v1/chat/completions
    ▼
gollm-service (Fastify + Playwright)
    │
    ├── PromptEngine ──── 裁剪tools、歷史、注入格式規範
    │
    └── SessionManager ── 控制 Chromium，注入Prompt，輪詢回覆
         │
         └── Gemini Web UI (gemini.google.com)
```

gollm-service 的本質是一個**瀏覽器自動化中介層**。它不做任何 LLM 的事情——只是把 OpenAI 格式的請求翻譯成 Playwright 操作，把網頁回覆翻譯回 OpenAI 格式回來。

好處：
- 不需要 Gemini API Key
- 不受 Rate Limit 限制
- 可以用 Gemini Pro / Flash 等網頁端才有的模型

代價：
- 單一瀏覽器 Session，不支援高併發
- 需要維持 Google 登入狀態
- 絕對延遲比原生 API 高（網頁 UI 的代價）

---

## 這次重構解決的三個問題

### 1. Prompt Limits 寫死在程式碼裡

之前 `MAX_TOOLS_SECTION_LENGTH = 8000` 這種數字是 hardcoded 的，OpenClaw 工具一多就被截斷，導致模型「看不到某個工具所以假裝做了」。

現在這些數字全部外部化到 `service.gollmrc.json`，未來調整不需要改 code：

```json
"prompt": {
  "maxTranscriptLength":    60000,
  "maxToolsSectionLength":    64000,
  "maxToolOutputLength":      3000,
  "enableMediaSendReminder":  true
}
```

### 2. 「發送圖片」幻覺

這是最惱人的 bug：小嵐（OpenClaw）告訴我「照片已發送」，但實際上壓根沒有呼叫任何工具。原因是 Gemini 模型在處理圖片時常常直接聲稱完成，而不是老老實實輸出 tool call。

解決方案是兩層的：

**第一層：Prompt 規範**
在所有工具注入時，自動附帶一段強制說明：
```
[Critical: How to Send Images/Media]
When sending images, you MUST use MEDIA:/local/path — NEVER external URL.
NEVER claim "photo sent" without outputting a valid tool_call.
```

**第二層：Hallucination Guard**
如果模型還是說了「已發送」却沒有 tool call，正則表達式會立刻抓到這種模式，觸發 `injectSystemObservation()` 強迫 Gemini 重新思考並輸出正確的工具呼叫（最多重試 2 次）。

### 3. 文件和實際程式碼對不上

之前的 README 說 `MAX_TOOLS_SECTION_LENGTH = 8000`，但實際程式碼早就不是這個數字了。一個文件誤導的問題。後來補了 `SPEC.md`，裡面記錄了 API 合約、錯誤碼、Hallucination Guard 邏輯和設計決策的理由——這個才是真正拿來當合約的文件。

---

## 如何整合

### OpenClaw（Hermes）

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

### 啟動服務

```bash
cd ~/gollm-service
npm run build && node dist/server/http-server.js

# 首次啟動（需登入）
# 編輯 service.gollmrc.json：playwright.headless: false
# 啟動後手動在瀏覽器中完成 Google 登入
#之後可改回 headless: true
```

### 發送請求

```bash
curl -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "flash",
    "messages": [{"role": "user", "content": "幫我查一下明天台北的天氣"}],
    "tools": [{"type": "function", "function": {"name": "get_weather", "parameters": {...}}}]
  }'
```

---

## 這個專案的定位

gollm-service 不是一個通用的生產級服務。它解決的是一個非常特定的問題：「我需要 Gemini Pro/Flash 的能力，但 API Rate Limit 不够用，而且我願意犠牲一點穩定性換取更大的模型可用性」。

如果你也在做類似的 Agent 系統並且被 Rate Limit 困擾，或許可以參考這個思路——用瀏覽器自動化繞過 API 限制，缺點自己承擔。好與不好，看你的使用場景。

---

**Repo**: https://github.com/yywang99/gollm-service
**文件**: [README.md](README.md) · [SPEC.md](SPEC.md)