# GoLLM Service — Agent Installation Guide

> 本檔案專為 AI Agent 設計，提供線性、無歧義的安裝流程。  
> 適合從頭部署到新機器，包括 OpenClaw + gollm-service 串接。

---

## 前置環境檢測

在開始之前，先確認以下環境條件。如果缺失，請先安裝。

```bash
# 1. Node.js (需要 v18+)
node -v || (curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt install -y nodejs)

# 2. npm
npm -v || sudo apt install -y npm

# 3. git
git -v || sudo apt install -y git

# 4. 驗證 Playwright 依賴（可選）
npx playwright install-deps chromium || echo 'deps install failed, continue anyway'
```

---

## 安裝流程（順序執行）

### Step 1: Clone 或進入專案目錄

```bash
# 如果是從 GitHub clone：
git clone https://github.com/your-org/gollm-service.git ~/gollm-service
cd ~/gollm-service

# 如果已經在 workspace 中：
cd ~/gollm-service
```

### Step 2: 安裝依賴

```bash
npm install
```

### Step 3: 安裝 Playwright Chromium

```bash
npx playwright install chromium
```

### Step 4: 設定 Configuration

```bash
[ ! -f service.gollmrc.json ] && cp config.example.json service.gollmrc.json
# 編輯 service.gollmrc.json，將 playwright.headless 設為 false
```

### Step 5: 編譯專案

```bash
npm run build
```

### Step 6: 建立 systemd Service（可選，但推薦）

```bash
mkdir -p ~/.config/systemd/user/

cat > ~/.config/systemd/user/gollm-service.service << 'SERVICE_EOF'
[Unit]
Description=gollm-service - Universal OpenAI-compatible LLM Microservice
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/gollm-service
ExecStart=/usr/bin/node %h/gollm-service/dist/server/http-server.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
SERVICE_EOF

systemctl --user daemon-reload
```

### Step 7: 啟動服務

```bash
systemctl --user enable gollm-service
systemctl --user start gollm-service
```

---

## 人類介入點

### ⚠️ [HUMAN_ACTION_REQUIRED] 首次登入

服務啟動後，Chromium 視窗會自動開啟（因為 headless=false）。

**請在 60 秒內完成以下動作：**
1. 在開啟的 Chromium 視窗中登入 Google 帳號
2. 確認 Gemini 回覆正常（隨便問一個問題）

**Agent 監控方式：**
```bash
until curl -s http://127.0.0.1:3001/health | grep -q '\"session\":\"logged_in\"'; do
  sleep 5
  echo "Waiting for login... ($(date +%H:%M:%S))"
done
echo "✅ Login confirmed!"
```

### 登入完成後

確認 `/health` 回返 `logged_in` 後，可以改回 headless 模式：

```bash
# 將 service.gollmrc.json 中的 playwright.headless 改回 true
# 然後重啟服務
systemctl --user restart gollm-service
```

> 💡 **運維提示**：Playwright 的瀏覽器二進位執行檔（主程式，位於 `~/.cache/ms-playwright/`）與使用者的 Profile 狀態是解耦且完全獨立的。登入資訊、Cookies 與 Local Storage 全數存在您專案根目錄的 `gollm-playwright-profile` 資料夾下。這意味著就算您執行清除並重裝 Playwright 瀏覽器、更新套件或在有頭/無頭（headed/headless）間切換，**都不會造成登入狀態遺失**，只要保持 `gollm-playwright-profile` 目錄完整即可。

---

## 驗證流程

全部完成後，執行以下驗證：

```bash
# 1. 健康檢查
curl http://127.0.0.1:3001/health
# 預期：{"status":"healthy","session":"logged_in","browser":"responsive"}

# 2. API 測試
curl -X POST http://127.0.0.1:3001/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"flash","messages":[{"role":"user","content":"Hi"}]}'
# 預期：收到 Gemini 的回覆
```

---

## 常見錯誤排查

| 錯誤訊息 | 原因 | 解決方式 |
|----------|------|----------|
| `sudo: 需要密碼` | sudo 沒有 NOPASSWD 設定 | 執行 `sudo visudo` 加入 `<USERNAME> ALL=(ALL) NOPASSWD: ALL`（請替換為當前使用者名稱） |
| `port 3001 is already in use` | 舊的 gollm-service 行程還活著 | `pkill -9 -f gollm-service && systemctl --user restart gollm-service` |
| `session: needs_reauth` | Google session 過期 | 將 `headless` 設為 `false`，重新登入 |
| `browser: unresponsive` | Playwright CDP 無法連線 | `pkill -9 -f gollm-service && systemctl --user start gollm-service` |
| `node: command not found` | Node.js 未安裝 | `curl -fsSL https://deb.nodesource.com/setup_18.x \| sudo -E bash - && sudo apt install -y nodejs` |
| `npm: command not found` | npm 未安裝 | `sudo apt install -y npm` |

---

## OpenClaw 整合設定

在 OpenClaw 的 `config.yaml` 中加入：

```yaml
models:
  gollm:
    provider: custom
    baseURL: http://127.0.0.1:3001/v1
    apiKey: local-dev
    model: flash
```

---

## 快速重置（清除所有狀態）

如果需要乾淨重來：

```bash
# 停止服務
systemctl --user stop gollm-service

# 清除瀏覽器 profile
rm -rf ~/.cache/ms-playwright/
rm -rf ~/gollm-service/gollm-playwright-profile

# 重新編譯（可選）
npm run build

# 重啟
systemctl --user start gollm-service
```

---

## 成功標準

全部完成後，確認以下三個條件都滿足：

1. ✅ `curl http://127.0.0.1:3001/health` 回返 `"status":"healthy"`
2. ✅ `curl http://127.0.0.1:3001/health` 回返 `"session":"logged_in"`
3. ✅ API 測試能收到 Gemini 的文字回覆（非 error 或 empty）

如果三個都滿足，gollm-service 已完全就緒！

*本檔案由 AI Agent 社群貢獻，安裝問題請開 GitHub Issue。*
