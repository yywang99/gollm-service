/**
 * Browser DOM types for Gemini Web UI interactions.
 * Replaces unsafe `new Function(...)` and `as any` casts with typed interfaces.
 */

/** Result of checking whether a Gemini input area exists */
export interface PageCheckResult {
  hasInput: boolean;
}

/** Result of checking if the session's input area is empty */
export interface FreshSessionResult {
  isEmpty: boolean;
  textLen: number;
}

/** Detected Gemini model mode */
export type GeminiMode = "flash-lite" | "flash" | "pro" | "unknown";

/** Result of captureBaseline — innerText of the last response bubble */
export interface CaptureBaselineResult {
  innerText: string;
}