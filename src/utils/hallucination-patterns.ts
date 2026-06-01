/**
 * Hallucination Patterns
 *
 * Centralized collection of hallucination detection patterns.
 * Patterns are regex-based for performance and maintainability.
 */

export interface HallucinationPatterns {
  // Keywords that indicate a completion claim without tool call
  completionClaims: RegExp[];
  // Keywords that indicate file modification intent
  fileModificationIntent: RegExp[];
  // Keywords that indicate a refusal to execute commands
  refusalClaims: RegExp[];
}

/**
 * Default hallucination patterns.
 * Covers Chinese and English completion claim phrases.
 */
export const DEFAULT_PATTERNS: HallucinationPatterns = {
  completionClaims: [
    // ── [File / System Operations] ──────────────────────────────────────────────
    // Chinese
    /已處理好了?/i,
    /已修改好了?/i,
    /已完成好了?/i,
    /已經做好了?/i,
    /已經完成了?/i,
    /已經處理好了?/i,
    /已經修改好了?/i,
    /做好了/i,
    /完成好了/i,
    /處理好了/i,
    /修改好了/i,
    /搞定好了?/i,
    /都好了/i,
    // English
    /I have already (modified|created|deleted|completed|finished|done|executed)/i,
    /I've already (modified|created|deleted|completed|finished|done|executed)/i,
    /Already (modified|created|deleted|completed|finished|done|executed)/i,
    /Done!?\s*$/i,
    /All done!?\s*$/i,
    /It's (all )?done/i,
    /I (have )?finished (the )?(task|job|modification)/i,
    /The file (has been|was) (modified|created|deleted|updated)/i,
    /I (just )?(modified|created|deleted|updated) the file/i,

    // ── [Messaging / Media Send Operations] ───────────────────────────────────
    // Chinese — "I sent the photo/message" without tool call
    /已發送(?:好了|完)?/i,
    /圖片已發送/i,
    /照片已傳送/i,
    /訊息已發送/i,
    /已幫你發送/i,
    /已幫您發送/i,
    /已傳送完畢/i,
    /已經發送圖片/i,
    /已經傳送照片/i,
    /已經發送完畢/i,
    /發送成功/i,
    /傳送成功/i,
    /已把圖片發過去/i,
    /已把照片傳過去/i,
    // English — "sent the photo/message/image" without tool call
    /I have sent (the )?(photo|image|message|media|file|picture)/i,
    /I've sent (the )?(photo|image|message|media|file|picture)/i,
    /The (photo|image|message|media|file|picture) (has been|was) sent/i,
    /(photo|image|message|media|file|picture) sent successfully/i,
    /Sent (the )?(photo|image|message|media|file|picture)/i,
    /I('ve| have) (just )?uploaded and sent/i,
    /Photo has been (delivered|sent|uploaded)/i,
    /I('ve| have) (just )?shared (the )?(photo|image|file)/i,
  ],

  fileModificationIntent: [
    // Chinese
    /修改.*檔案/i,
    /修改.*文件/i,
    /建立.*檔案/i,
    /建立.*文件/i,
    /刪除.*檔案/i,
    /刪除.*文件/i,
    /更新.*檔案/i,
    /執行.*指令/i,
    /執行.*命令/i,
    /跑.*腳本/i,
    /執行.*腳本/i,
    /修改\s+\//i,          // 修改 /path/to/file
    /變更.*設定/i,
    // English
    /modify (the )?file/i,
    /create (a )?(new )?file/i,
    /delete (the )?file/i,
    /update (the )?file/i,
    /edit (the )?file/i,
    /run (the )?(shell )?(command|script)/i,
    /execute (the )?(shell )?(command|script)/i,
    /change (the )?(config|setting)/i,
  ],
  
  refusalClaims: [
    // Chinese Refusals
    /我只是一個\s*(AI|人工智慧|語言模型)/i,
    // Must have AI identification AND inability/refusal — avoids false positives
    // on normal self-introductions like "我是一個由 Google 開發的 AI 協作者"
    /我是.*(AI|人工智慧|語言模型).*(無法|不能|沒有能力|做不到)/i,
    /我是.*(AI|人工智慧|語言模型).*所以.*(無法|不能)/i,
    /我無法(直接)?(執行|跑|存取|修改|建立|連線|連接|提供)/i,
    /我沒有.*權限/i,
    /抱歉，我不能/i,
    /無法(直接)?替您?(執行|操作)/i,
    // English Refusals\n    /I cannot (directly )?(execute|run|access|modify)/i,\n    /I am (just )?an? (AI|language model)/i,\n    /I do not have access to/i,\n    /I don't have access to/i,\n    /I'm unable to (execute|run|access)/i,\n    /I(.?)m having (a )?hard time (fulfilling|understanding|with)/i,\n    /can(.?)t (fulfill|help with|assist with)/i,\n    /not able to (help|assist|fulfill)/i,
  ],
};

/**
 * Checks if text contains any completion claims.
 */
export function hasCompletionClaim(text: string, patterns: RegExp[] = DEFAULT_PATTERNS.completionClaims): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Checks if text contains file modification intent.
 */
export function hasFileModificationIntent(text: string, patterns: RegExp[] = DEFAULT_PATTERNS.fileModificationIntent): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Checks if text contains refusal claims.
 */
export function hasRefusalClaim(text: string, patterns: RegExp[] = DEFAULT_PATTERNS.refusalClaims): boolean {
  return patterns.some((p) => p.test(text));
}

/**
 * Get the specific pattern that matched (if any).
 */
export function getMatchedPattern(
  text: string,
  patterns: RegExp[]
): RegExp | null {
  for (const p of patterns) {
    if (p.test(text)) return p;
  }
  return null;
}