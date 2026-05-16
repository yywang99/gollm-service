/**
 * DOM Doctor
 *
 * Automatically diagnoses and repairs broken CSS selectors when Gemini UI changes.
 * Uses Gemini to analyze HTML and find working selectors.
 */

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { SELECTORS, type SelectorType } from "../utils/selectors.js";
import { LIMITS } from "../utils/timings.js";

const CACHE_FILE = ".gollm_selectors.json";

interface SelectorCache {
  input?: string;
  send?: string;
  response?: string;
  upload?: string;
  updatedAt?: string;
}

export class DOMDoctor {
  private cacheFile: string;
  private cache: SelectorCache = {};

  constructor(cacheDir: string = process.cwd()) {
    this.cacheFile = join(cacheDir, CACHE_FILE);
    this.loadCache();
  }

  private loadCache(): void {
    try {
      if (existsSync(this.cacheFile)) {
        this.cache = JSON.parse(readFileSync(this.cacheFile, "utf-8"));
        console.log(`[DOMDoctor] Loaded cached selectors from ${this.cacheFile}`);
      }
    } catch (e) {
      console.warn("[DOMDoctor] Failed to load selector cache:", e);
    }
  }

  saveCache(): void {
    try {
      this.cache.updatedAt = new Date().toISOString();
      writeFileSync(this.cacheFile, JSON.stringify(this.cache, null, 2));
      console.log("[DOMDoctor] Selectors cached.");
    } catch (e) {
      console.warn("[DOMDoctor] Failed to save selector cache:", e);
    }
  }

  getSelector(type: SelectorType): string {
    if (this.cache[type as keyof SelectorCache]) {
      return this.cache[type as keyof SelectorCache]!;
    }
    const pool = SELECTORS[type];
    return pool?.[0] || "";
  }

  getSelectors(): { input: string; send: string; response: string } {
    return {
      input: this.getSelector("input"),
      send: this.getSelector("send"),
      response: this.getSelector("response"),
    };
  }

  async diagnose(htmlSnippet: string, targetType: SelectorType): Promise<string | null> {
    // Note: AI diagnosis requires GEMINI_API_KEY to be set.
    // Without it, the system falls back to the hardcoded selector pool in selectors.ts.
    // This is usually sufficient unless Google changes the UI structure significantly.
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.log("[DOMDoctor] GEMINI_API_KEY not set — skipping AI diagnosis, using selector pool fallback");
      return null;
    }

    const hints: Record<SelectorType, string> = {
      input: '目標是輸入框。請找具備 contenteditable="true" 或 class="ql-editor" 屬性的容器。',
      send: '目標是發送按鈕。請找出 aria-label="Send" 的 <button>。',
      response: "找尋 AI 回覆的文字氣泡。",
      upload: "找尋上傳圖片的按鈕或 input[type=file]。",
      workspaceButtons: "找尋 Workspace 擴充功能的儲存/建立按鈕。",
    };

    const targetDescription = hints[targetType] || targetType;
    console.log(`[DOMDoctor] Diagnosing: ${targetType}...`);

    let safeHtml = htmlSnippet;
    if (htmlSnippet.length > LIMITS.HTMLSnippet_MAX_CHARS) {
      safeHtml =
        htmlSnippet.substring(0, 5000) +
        "\n\n\n...[truncated]...\n\n\n" +
        htmlSnippet.substring(htmlSnippet.length - 55000);
    }

    const prompt = `你是 Playwright 自動化專家。CSS Selector 失效了。
請分析 HTML，找出目標: "${targetType}" (${targetDescription}) 的最佳 CSS Selector。

HTML 片段:
\`\`\`html
${safeHtml}
\`\`\`

規則：
1. 只回傳 JSON: {"selector": "your_css_selector"}
2. 選擇器要有高特異性，不要依賴隨機生成的 ID
3. 優先使用 id, name, role, aria-label, data-attribute`;

    try {
      // Dynamic import - only works if @google/generative-ai is installed
      let GoogleGenerativeAI: any;
      try {
        ({ GoogleGenerativeAI } = await import("@google/generative-ai"));
      } catch {
        console.warn("[DOMDoctor] @google/generative-ai not installed, skipping AI diagnosis.");
        return null;
      }

      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
      const result = await model.generateContent(prompt);
      const rawText = result.response.text().trim();

      const jsonMatch = rawText.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) {
        console.warn("[DOMDoctor] No JSON found in response:", rawText);
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);
      const selector = parsed.selector?.replace(/^css\s+/i, "").replace(/`/g, "").trim();

      if (selector) {
        console.log(`[DOMDoctor] New selector found: ${selector}`);
        this.cache[targetType as keyof SelectorCache] = selector;
        this.saveCache();
        return selector;
      }
    } catch (e) {
      console.warn("[DOMDoctor] AI diagnosis failed:", e);
    }

    return null;
  }

  async healIfNeeded(page: any, type: SelectorType, currentSelector: string): Promise<boolean> {
    try {
      const element = await page.$(currentSelector);
      if (element) return true;

      console.log(`[DOMDoctor] Selector "${currentSelector}" not found, attempting repair...`);
      const html = await page.content();
      const newSelector = await this.diagnose(html, type);

      if (newSelector) {
        console.log(`[DOMDoctor] Repaired: ${newSelector}`);
        return true;
      }
    } catch (e) {
      console.warn(`[DOMDoctor] Healing failed for ${type}:`, e);
    }
    return false;
  }
}
