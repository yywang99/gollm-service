/**
 * Session Manager
 *
 * Manages Playwright Browser lifecycle as a singleton.
 * Handles:
 * - Single browser instance (persistent context)
 * - Session state tracking (logged in / needs re-auth / crashed)
 * - Automatic recovery on crash
 * - Memory management (DOM pruning)
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { SELECTORS } from "../utils/selectors.js";

export type SessionState = "new" | "logged_in" | "needs_reauth" | "crashed";

export interface SessionManagerOptions {
  userDataDir?: string;
  headless?: boolean;
  stealth?: boolean;
}

export class SessionManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private state: SessionState = "new";
  private options: SessionManagerOptions;
  private lastProcessedMessages: any[] = [];
  private _targetMode: "think" | "pro" | "fast" | null = null;

  getLastProcessedMessages(): any[] {
    return this.lastProcessedMessages;
  }

  setLastProcessedMessages(msgs: any[]) {
    this.lastProcessedMessages = msgs;
  }

  /**
   * Remove Angular CDK overlay backdrops that intercept pointer events.
   */
  private async dismissOverlays(): Promise<void> {
    try {
      await this.page?.evaluate(
        new Function(
          "document.querySelectorAll(" +
            "'.cdk-overlay-backdrop, .cdk-overlay-transparent-backdrop, .cdk-overlay-container'" +
          ").forEach(function(el){if(el.parentNode)el.parentNode.removeChild(el);})"
        ) as any
      );
    } catch { /* best-effort */ }
  }

  /**
   * Set the target Gemini mode that should be enforced after any page navigation.
   * OpenClaw can call this to tell GoLLM which mode the user selected.
   */
  setTargetMode(mode: "think" | "pro" | "fast" | null) {
    this._targetMode = mode;
    console.log(`[SessionManager] Target mode set to: ${mode}`);
  }

  /**
   * Apply the target mode by clicking the correct button if needed.
   * Returns true if mode was applied or already correct, false if button not found.
   */
  private async applyTargetMode(): Promise<boolean> {
    if (!this._targetMode) {
      console.log(`[SessionManager] No target mode set, skipping apply`);
      return true;
    }

    const page = await this.getPage();
    if (!page) return false;

    // First detect current mode
    const currentMode = await this.detectGeminiMode();
    if (currentMode === this._targetMode) {
      console.log(`[SessionManager] Mode already correct: ${currentMode}`);
      return true;
    }

    console.log(`[SessionManager] Applying target mode: ${this._targetMode} (current: ${currentMode})`);
    return await this.setGeminiMode(this._targetMode);
  }

  constructor(options: SessionManagerOptions = {}) {
    const headlessEnv = process.env.GOLLM_BROWSER_HEADLESS === "true";
    this.options = {
      userDataDir: options.userDataDir || process.env.GOLLM_USER_DATA_DIR || "~/.openclaw/gollm-playwright-profile",
      headless: options.headless ?? headlessEnv,
      stealth: options.stealth ?? true,
    };
  }

  async getPage(): Promise<Page> {
    if (!this.context || !this.page) {
      await this.launch();
    }
    return this.page!;
  }

  async launch(): Promise<void> {
    if (this.browser) {
      console.log("[SessionManager] Browser already launched");
      return;
    }

    console.log(`[SessionManager] Launching Chromium (headless=${this.options.headless})...`);
    this.state = "new";

    const stealthArgs = [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--disable-gpu",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--no-default-browser-check",
      "--use-mock-keychain",
      "--disable-web-security",
    ];

    this.context = await chromium.launchPersistentContext(this.options.userDataDir!, {
      headless: this.options.headless,
      viewport: null,
      args: stealthArgs,
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    });

    // Remove automation indicators from the browser context
    await this.context.addInitScript(() => {
      Object.defineProperty(globalThis, "webdriver", { get: () => false });
      // @ts-ignore
      Object.defineProperty(globalThis, "navigator", { value: { chrome: { runtime: {} }, plugins: { length: 5 }, languages: ["zh-TW", "en-US"] }, configurable: true, get: function(){ return this._navigator; } });
      Object.defineProperty(globalThis, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(globalThis, 'languages', { get: () => ['zh-TW', 'en-US'] });
    });

    this.page = this.context.pages()[0] || (await this.context.newPage());

    this.context.on("close", () => {
      console.log("[SessionManager] Browser context closed/crashed.");
      this.context = null;
      this.page = null;
      this.browser = null;
      this.state = "new";
    });

    // Detect session state
    await this.detectSessionState();

    console.log(`[SessionManager] Launched. State: ${this.state}`);
  }

  async detectSessionState(): Promise<void> {
    if (!this.page) return;

    const url = this.page.url();
    console.log(`[SessionManager] Detecting session state, URL: ${url}`);

    if (url.includes("accounts.google.com/signin")) {
      this.state = "needs_reauth";
    } else if (url.includes("gemini.google.com")) {
      // Wait a bit for page to load after navigation
      await this.page.waitForTimeout(1000);

      // Try multiple selectors for the input area
      try {
        const selectorsToTry = SELECTORS.input.join(", ");
        const inputArea = await this.page.waitForSelector(selectorsToTry, {
          state: "attached",
          timeout: 5000
        }).catch(() => null);

        if (inputArea) {
          this.state = "logged_in";
          console.log("[SessionManager] Session detected as logged in");
        } else {
          this.state = "needs_reauth";
          console.log("[SessionManager] Input area not found, setting needs_reauth");
        }
      } catch (e) {
        this.state = "needs_reauth";
        console.log(`[SessionManager] Session detection error: ${e}`);
      }
    } else {
      this.state = "new";
    }
  }

  // ─── Mode Detection ─────────────────────────────────────────────────────────

  /**
   * Detect current Gemini mode by looking for active mode buttons.
   * Returns: "think" (深度思考/思考), "pro" (Pro), "fast" (快捷), or "unknown"
   */
  async detectGeminiMode(): Promise<"think" | "pro" | "fast" | "unknown"> {
    const page = await this.getPage();
    if (!page) return "unknown";

    try {
      // @ts-ignore
      const modeFn = new Function(
        `var checked = document.querySelectorAll('button[aria-checked=\"true\"], button[aria-pressed=\"true\"], [role=\"radio\"][aria-checked=\"true\"]');
        if (checked && checked.length > 0) {
          for (var i = 0; i < checked.length; i++) {
            var txt = (checked[i].textContent || '').trim().toLowerCase();
            if (txt.includes('思考') || txt.includes('think')) return 'think';
            if (txt.includes('pro') && !txt.includes('快捷')) return 'pro';
            if (txt.includes('快捷') || txt.includes('flash')) return 'fast';
          }
        }
        
        // Check the mode selector button by its known aria-label
        var modeBtn = document.querySelector('[aria-label=\"開啟模式挑選器\"], [aria-label=\"Model selector\"], [aria-label=\"模型選擇器\"]');
        if (modeBtn) {
          var txt = (modeBtn.textContent || '').trim();
          if (txt === '快捷' || txt.includes('Flash')) return 'fast';
          if (txt === '思考型' || txt.includes('Think')) return 'think';
          if (txt === 'Pro' || txt.includes('Advanced')) return 'pro';
        }
        
        // Fallback: Check for grey pill button with exact text
        var buttons = document.querySelectorAll('button, [role="button"], div[role="button"]');
        for (var i = 0; i < buttons.length; i++) {
          var b = buttons[i];
          var txt = (b.textContent || '').trim();
          if (txt === '快捷' || txt === '思考型' || txt === 'Pro' || txt === 'Gemini Advanced' || txt === 'Gemini Pro') {
            if (txt === '快捷' || txt.includes('Flash')) return 'fast';
            if (txt === '思考型' || txt.includes('Think')) return 'think';
            if (txt === 'Pro' || txt.includes('Advanced')) return 'pro';
          }
        }
        
        return 'unknown';`
      );
      const mode = await page.evaluate(modeFn as any);
      console.log(`[SessionManager] Detected Gemini mode: ${mode}`);
      return mode as "think" | "pro" | "fast" | "unknown";
    } catch (e) {
      console.log(`[SessionManager] Mode detection error: ${e}`);
      return "unknown";
    }
  }

  /**
   * Set Gemini mode via the dropdown menu in the input area.
   */
  async setGeminiMode(targetMode: "think" | "pro" | "fast"): Promise<boolean> {
    const page = await this.getPage();
    if (!page) return false;

    const modeTextMap: Record<string, string> = {
      think: "思考型",
      pro: "Pro",
      fast: "快捷",
    };
    const targetText = modeTextMap[targetMode];
    if (!targetText) return false;

    // Step 1: Dismiss any CDK overlays that may be blocking clicks
    await this.dismissOverlays();

    // Step 2: Click the dropdown button
    const dropdownSelectors = [
      '[aria-label="開啟模式挑選器"]',
      '[aria-label="Model selector"]',
      '[aria-label="模型選擇器"]',
      '[aria-haspopup="menu"]',
      '[aria-haspopup="listbox"]',
      '[role="combobox"]'
    ];

    let clicked = false;
    for (const sel of dropdownSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.count() > 0) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) {
            console.log(`[SessionManager] Clicking dropdown with selector: ${sel}`);
            await el.click();
            clicked = true;
            break;
          }
        }
      } catch (e) { /* try next */ }
    }

    if (!clicked) {
      // Fallback: dismiss overlays, press Escape to close any overlay, then look for dropdown by exact text
      await this.dismissOverlays();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);
      try {
        // Find button with exact text matching the current mode
        const textBtn = page.locator('div[role="button"], span[role="button"], button').filter({ hasText: /^(快捷|思考型|Pro|Gemini Advanced|Gemini Pro)$/i }).first();
        if (await textBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          const btnText = await textBtn.textContent().catch(() => '') || '';
          console.log(`[SessionManager] Clicking dropdown by text: "${btnText.trim()}"`);
          await textBtn.click();
          clicked = true;
        }
      } catch (e) { /* ignore */ }
    }

    if (!clicked) {
      console.log("[SessionManager] Could not find dropdown button");
      return false;
    }

    // Step 3: Dismiss overlays before clicking an option in the menu
    await this.dismissOverlays();
    await page.waitForTimeout(500);

    // Step 4: Click the target mode option in the dropdown menu
    try {
      const locators = [
        page.getByRole('menuitemradio', { name: new RegExp(targetText, 'i') }),
        page.getByRole('menuitem', { name: new RegExp(targetText, 'i') }),
        page.getByRole('option', { name: new RegExp(targetText, 'i') })
      ];

      for (const loc of locators) {
        const count = await loc.count();
        for (let i = 0; i < count; i++) {
          const el = loc.nth(i);
          if (await el.isVisible().catch(() => false)) {
            console.log(`[SessionManager] ✅ Clicking option via ARIA role: "${targetText}"`);
            await el.click();
            await page.waitForTimeout(1000);
            return true;
          }
        }
      }

      // If ARIA roles didn't work, fallback to text matching inside the menu overlay.
      // We must avoid clicking the original button again!
      const menuLoc = page.locator('[role="menu"], [role="listbox"]').filter({ hasText: new RegExp(targetText, 'i') }).last();
      if (await menuLoc.isVisible().catch(() => false)) {
         const itemLoc = menuLoc.locator(`text="${targetText}"`).first();
         if (await itemLoc.isVisible().catch(() => false)) {
            console.log(`[SessionManager] ✅ Clicking option via menu fallback: "${targetText}"`);
            await itemLoc.click();
            await page.waitForTimeout(1000);
            return true;
         }
      }
    } catch (e) {
      console.log("[SessionManager] Option scan error: " + e);
    }

    console.log("[SessionManager] Failed to set mode: " + targetMode);
    return false;
  }

  async navigateToGemini(): Promise<void> {
    const page = await this.getPage();
    const currentUrl = page.url();

    // ─── Save mode before navigation ───
    const prevMode = await this.detectGeminiMode();
    console.log(`[SessionManager] Current mode before nav: ${prevMode}, URL: ${currentUrl}`);

    // Check if we have a visible input area
    // @ts-ignore
    const pageCheckFn = new Function('return { hasInput: !!document.querySelector(".ql-editor,.ProseMirror,[contenteditable],textarea") }');
    const pageCheck: any = await page.evaluate(pageCheckFn as any);

    console.log(`[SessionManager] Page check: hasInput=${pageCheck.hasInput}`);

    if (!currentUrl.includes("gemini.google.com")) {
      console.log("[SessionManager] Navigating to Gemini...");
      await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
      await (this.page!)?.waitForTimeout(2000);
    }

    // Re-check after navigation
    // @ts-ignore
    const pageCheckFn2 = new Function('return { hasInput: !!document.querySelector(".ql-editor,.ProseMirror,[contenteditable],textarea") }');
    const pageCheck2: any = await page.evaluate(pageCheckFn2 as any);

    if (!pageCheck2.hasInput) {
      console.log("[SessionManager] No input found, looking for New Chat...");
      try {
        // Dismiss overlays and press Escape to close any blocking dialogs
        await this.dismissOverlays();
        await page.keyboard.press("Escape");
        await page.waitForTimeout(500);

        // Try clicking any "New Chat" or "新對話" button
        const newChatBtn = await page.$('button[aria-label*="New"],button[aria-label*="新對話"],button[aria-label*="新建"]');
        if (newChatBtn) {
          await this.dismissOverlays();
          await newChatBtn.click({ force: true, timeout: 3000 });
          await page.waitForTimeout(2000);
          console.log("[SessionManager] Clicked New Chat button");
        } else {
          // Try navigating directly to gemini with a hash to force new chat
          console.log("[SessionManager] No New Chat button, trying direct navigation...");
          await page.goto("https://gemini.google.com/app#new", { waitUntil: "domcontentloaded" });
          await page.waitForTimeout(2000);
        }
      } catch (e) {
        console.log("[SessionManager] Error clicking New Chat: " + e + " - falling back to direct navigation...");
        await page.goto("https://gemini.google.com/app#new", { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);
      }
    }

    // ─── Apply target mode after navigation ───
    await this.page?.waitForTimeout(2000); // Wait for page to fully settle including mode buttons
    await this.applyTargetMode();

    // Always re-detect session state after potential navigation or even if already on Gemini
    await this.detectSessionState();
  }

  async startNewChat(): Promise<void> {
    const page = await this.getPage();

    // ─── Save mode before starting new chat ───
    await this.detectGeminiMode(); // detect before clicking
    await this.dismissOverlays();

    try {
      const newChatBtn = await page.$('a[href="/app"], button[aria-label*="New"], button[aria-label*="新對話"], button[aria-label*="新建"]');
      if (newChatBtn) {
        await newChatBtn.click({ force: true, timeout: 3000 });
        await page.waitForTimeout(2000);
      } else {
        await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      console.log("[SessionManager] Error starting new chat via click: " + e + " - falling back to navigation...");
      await page.goto("https://gemini.google.com/app", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);
    }
    
    await page.waitForTimeout(1000); // Wait for new chat UI to settle

    // ─── Apply target mode after new chat ───
    await this.applyTargetMode();

    console.log("[SessionManager] Done starting new chat");
  }

  async pruneDOM(): Promise<void> {
    const page = await this.page;
    if (!page) return;

    try {
      // Use Function constructor to avoid tsx arrow function transformation issues
      // @ts-ignore
      const pruneFn = new Function(
        `
        var nodes = document.querySelectorAll(
          "message-content, model-response, user-message, .message-row, .conversation-turn"
        );

        if (nodes.length <= 6) return;

        for (var i = 0; i < nodes.length - 6; i++) {
          var wrapper =
            nodes[i].closest(".message-row") ||
            nodes[i].closest(".conversation-turn") ||
            nodes[i].closest(".chat-message-group") ||
            nodes[i];
          if (wrapper && wrapper.parentNode) {
            wrapper.parentNode.removeChild(wrapper);
          }
        }
        `
      );
      await page.evaluate(pruneFn as any);
      console.log("[SessionManager] DOM pruned successfully");
    } catch (e) {
      console.warn("[SessionManager] DOM prune failed:", e);
    }
  }

  /**
   * Apply new options on top of existing ones (used by getSessionManager to re-configure
   * the singleton after initial creation).
   */
  mergeOptions(updates: Partial<SessionManagerOptions>): void {
    this.options = { ...this.options, ...updates };
  }

  getState(): SessionState {
    return this.state;
  }

  isReady(): boolean {
    return this.state === "logged_in" && this.page !== null;
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
      this.context = null;
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.state = "new";
  }
}

// Singleton export for the service
let globalSessionManager: SessionManager | null = null;

export function getSessionManager(options?: SessionManagerOptions): SessionManager {
  if (!globalSessionManager) {
    globalSessionManager = new SessionManager(options);
  } else if (options) {
    // Merge new options into the existing singleton so that config loaded after
    // the first call (e.g., from gollmrc.json) is applied without restarting.
    globalSessionManager.mergeOptions(options);
  }
  return globalSessionManager;
}