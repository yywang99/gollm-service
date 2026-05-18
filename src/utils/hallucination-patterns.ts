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
    /做好了/i,
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
    /我無法(直接)?(執行|跑|存取|修改|建立)/i,
    /我沒有權限/i,
    /抱歉，我不能/i,
    // English Refusals
    /I cannot (directly )?(execute|run|access|modify)/i,
    /I am (just )?an? (AI|language model)/i,
    /I do not have access to/i,
    /I don't have access to/i,
    /I'm unable to (execute|run|access)/i,
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