/**
 * Response Extractor
 *
 * Polls the Gemini Web DOM until a stable response is detected.
 * Uses Playwright-native polling via repeated page.evaluate calls.
 */

import { type Page } from "playwright";
import { SELECTORS } from "../utils/selectors.js";
import { LIMITS } from "../utils/timings.js";
import { getPromptLimits } from "../services/prompt-config.js";

// ── Paragraph Break Restoration ──────────────────────────────────────
// textContent merges <p>A</p><p>B</p> into one string with no \n.
// Detect long text with few newlines and insert paragraph breaks at
// sentence boundaries (Chinese-style。！？ etc.) to restore readability.
function restoreParagraphBreaks(text: string): string {
  // Short text or text with already-decent line breaks — leave it alone
  const existingBreaks = (text.match(/\n/g) || []).length;
  if (text.length < 400 || existingBreaks >= text.length / 200) return text;

  // At sentence-ending punctuation, insert one \n (but not after short lines)
  const lines = text.split('\n');
  const rebuilt = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.length < 40) return line; // skip short fragments
    // Split at Chinese/English sentence endings and rejoin with \n
    const segments = trimmed.split(/(?<=[。！？.!?])\s*/);
    return segments.join('\n');
  });

  return rebuilt.join('\n');
}

export interface WaitForResponseResult {
  text: string;
  status: "ok" | "timeout";
  stable: boolean;
}

const SELECTOR_POOL = SELECTORS.response.join(", ");

/** Clears the window.__pollState sentinel (call after timeout or completion). */
async function clearPollState(page: Page): Promise<void> {
  await page.evaluate(() => {
    // @ts-expect-error — window is a browser global inside page.evaluate
    (window as any).__pollState = null;
  });
}

/**
 * Single-shot DOM check — runs in browser, returns current response text or null.
 * Returns null if still waiting; returns text (possibly empty string) if done/error.
 */
function buildCheckFn(sel: string, oldText: string, stableThr: number, timeoutMs: number, postGenBufferMs: number): string {
  const safeStr = JSON.stringify(oldText);
  // Escape single quotes so the selector string can be safely embedded in querySelectorAll('...')
  const escapedSel = sel.replace(/'/g, "\\'");
  return `(function(){
    var _S = window.__pollState = window.__pollState || {lastText:'',stableCount:0,startTime:Date.now(),done:false,result:'',generationDoneTime:0};
    if (_S.done) return _S.result;
    if (Date.now() - _S.startTime > ${timeoutMs}) { _S.done = true; _S.result = ''; return ''; }

    var stopBtn = document.querySelector('button[aria-label*="Stop"], button[aria-label*="停止"], button[aria-label*="中斷"]');
    var isGenerating = !!(stopBtn && stopBtn.offsetHeight > 0);

    // Track when generation truly completes (stop button disappears).
    // IMPORTANT: If isGenerating becomes true again after being false (e.g. Gemini
    // thinking phase ends → streaming phase begins → stop btn reappears), we must
    // RESET generationDoneTime so the buffer starts from the real completion, not
    // from the flicker during the thinking→streaming transition.
    if (isGenerating && _S.generationDoneTime > 0) {
      // Stop button came back — generation still in progress, reset the timer
      _S.generationDoneTime = 0;
      _S.stableCount = 0;
    } else if (!isGenerating && _S.generationDoneTime === 0) {
      _S.generationDoneTime = Date.now();
    }

    var b = document.querySelectorAll('${escapedSel}');
    var ct = '';
    if (b.length > 0) {
      var last = b[b.length - 1];
      var c = last.closest('model-response') || last.closest('.markdown') || last.closest('.model-response-text') || last.closest('[role="article"]') || last.parentElement || last;
      // Use textContent instead of innerText — innerText triggers CSS layout recalc
      // and can return stale/cutoff content during streaming. textContent reads raw
      // text synchronously and is faster for polling.
      ct = (c ? (c.textContent || c.innerText) : '') || '';
    }

    ct = ct.replace(/^(?:顯示程式碼\\s*|Show code\\s*)?(?:顯示思路\\s*|Show thought process\\s*)?(?:Gemini 說了|Gemini said|Gemini says|Gemini)\\s*/i, '').trim();

    if (!ct || ct === ${safeStr}) {
      // Use textContent here too — innerText can lag during streaming
      var body = document.body ? (document.body.textContent || document.body.innerText) : '';
      // Remove Gemini UI chrome with simple string operations (no complex regex)
      var markers = ['思考型', 'Gemini', '輸入', '停止回覆', '你說了'];
      for (var i = 0; i < markers.length; i++) {
        var idx = body.indexOf(markers[i]);
        if (idx >= 0) {
          var end = body.indexOf('\\n', idx);
          if (end < 0) end = body.length;
          body = body.substring(0, idx) + body.substring(end + 1);
        }
      }
      // Filter Google Toolbar JS: if result starts with likely JS keywords, discard
      var firstLine = body.split('\\n')[0].trim();
      if (firstLine.length > 0 && (firstLine.indexOf('=') > 0 || firstLine.indexOf('function') >= 0 || firstLine.indexOf('catch') === 0)) {
        body = '';
      }
      ct = body.trim();
      var inp = document.querySelector('.ql-editor,.ProseMirror,textarea,[contenteditable]');
      if (inp) {
        var inpT = (inp.innerText || '').trim();
        if (inpT && ct.startsWith(inpT)) ct = ct.slice(inpT.length).trim();
      }
      if (ct === ${safeStr} || ct === '') ct = '';
    }

    if (ct && ct !== _S.lastText) {
      _S.stableCount = 0;
      _S.lastText = ct;
    } else if (ct && ct === _S.lastText) {
      // Only count toward stability AFTER the post-generation buffer has elapsed
      // This prevents premature capture of streaming content (e.g. partial tool_call JSON)
      if (!isGenerating && _S.generationDoneTime > 0) {
        var elapsedSinceGenDone = Date.now() - _S.generationDoneTime;
        if (elapsedSinceGenDone >= ${postGenBufferMs}) {
          _S.stableCount++;
        } else {
          // Buffer not elapsed yet — reset stableCount to be safe
          // This prevents any stability from accumulating during the buffer window
          _S.stableCount = 0;
        }
      }
    } else {
      _S.stableCount = 0;
    }

    // If we've waited past buffer but keep getting no content, force completion
    if (!ct && _S.lastText && !isGenerating && _S.generationDoneTime > 0) {
      var elapsedSinceGenDone = Date.now() - _S.generationDoneTime;
      if (elapsedSinceGenDone >= ${postGenBufferMs} + 5000) {
        _S.done = true;
        _S.result = _S.lastText;
      }
    }

    // Additional minimum wait after buffer — even if content keeps changing,
  // we need to give slow streaming (Python code with nested strings) time to complete.
  // Buffer (8s) + MIN_STABLE_WAIT (8s) = 16s minimum, then use whatever we have.
  var minStableWaitMs = 8000;
  if (_S.generationDoneTime > 0 && !isGenerating) {
    var elapsedSinceGenDone = Date.now() - _S.generationDoneTime;
    if (elapsedSinceGenDone >= ${postGenBufferMs} + minStableWaitMs) {
      _S.done = true;
      _S.result = ct || _S.lastText;
    }
  }

  // Standard stability check — but apply a minimum length floor.
  // Don't declare done on a very short result unless we've waited extra long
  // (guarding against 56-char thinking-phase truncation).
  // 60 chars: enough to filter streaming partials, but allows short complete answers.
  var MIN_RESPONSE_LENGTH = 60;
  var finalResult = ct || _S.lastText;
  if (_S.stableCount >= ${stableThr}) {
    if (finalResult.length >= MIN_RESPONSE_LENGTH) {
      _S.done = true;
      _S.result = finalResult;
    } else if (_S.generationDoneTime > 0 && !isGenerating) {
      // Short result but generation truly done — wait at least one extra buffer
      // before accepting (gives streaming more time to deliver the rest)
      var elapsedSinceGenDone = Date.now() - _S.generationDoneTime;
      if (elapsedSinceGenDone >= ${postGenBufferMs} * 2) {
        _S.done = true;
        _S.result = finalResult;
      }
      // else: keep polling, don't declare done on a short partial
    }
  }
  return _S.done ? _S.result : null;
  })()`;
}

export async function waitForStableResponse(
  page: Page,
  baselineText: string
): Promise<WaitForResponseResult> {
  const limits = getPromptLimits();
  const timeoutMs = LIMITS.RESPONSE_TIMEOUT_MS;
  const pollMs = limits.pollIntervalMs;
  const stableThreshold = limits.stableThreshold;
  const postGenBufferMs = limits.postGenerationBufferMs;

  console.log(`[POLL] Starting (timeout=${timeoutMs}ms, poll=${pollMs}ms, stable=${stableThreshold}, postGenBuffer=${postGenBufferMs}ms)`);

  // Reset stale state
  await clearPollState(page);

  const checkFnStr = buildCheckFn(SELECTOR_POOL, baselineText, stableThreshold, timeoutMs, postGenBufferMs);
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;

  // Keep polling until done or timeout
  while (Date.now() < deadline) {
    // Run the check function in the browser
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: string | null = await (page.evaluate(checkFnStr) as any);

    if (result !== null) {
      // Done (result may be empty string = no response found)
      const elapsed = Date.now() - startTime;
      await clearPollState(page);
      if (!result) {
        console.log(`[POLL] Done but empty after ${elapsed}ms`);
        return { text: '', status: 'timeout', stable: false };
      }
      console.log(`[POLL] Done after ${elapsed}ms, got ${result.length} chars`);
      return { text: restoreParagraphBreaks(result), status: 'ok', stable: true };
    }

    // Still waiting — check again after poll interval
    await page.waitForTimeout(pollMs);
  }

  // Timed out
  const elapsed = Date.now() - startTime;
  const result: string = await page.evaluate(() => {
    // @ts-expect-error — window is a browser global inside page.evaluate
    const state = (window as any).__pollState;
    return state ? state.result : '';
  });
  await clearPollState(page);
  console.log(`[POLL] TIMEOUT after ${elapsed}ms, result=${result ? result.length + 'chars' : 'empty'}`);
  return { text: restoreParagraphBreaks(result || ''), status: 'timeout', stable: false };
}

export async function captureBaseline(page: Page): Promise<string> {
  const result: string = await page.evaluate((sel: string) => {
    // @ts-expect-error — window is a browser global inside page.evaluate
    const doc = (window as any).document;
    const bubbles = doc.querySelectorAll(sel);
    if (bubbles.length === 0) return '';
    const target = bubbles[bubbles.length - 1];
    const container = target.closest('model-response')
      || target.closest('.markdown')
      || target.closest('.model-response-text')
      || target.closest('[role="article"]')
      || target.parentElement
      || target;
    return container ? (container.innerText || '') : '';
  }, SELECTOR_POOL);

  console.log(`[DEBUG captureBaseline] page URL: ${page.url()}`);

  return result || "";
}