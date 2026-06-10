// CSS Selector pool for Gemini Web UI
// Prioritized list - first working selector is used

export const SELECTORS = {
  // Input area - Quill editor is the latest (2024+ Gemini)
  input: [
    ".ql-editor",                                    // Quill editor (Gemini 2024+)
    ".ProseMirror",                                  // ProseMirror
    "rich-textarea",                                 // custom element
    'div[role="textbox"][contenteditable="true"]',   // ARIA textbox
    'div[contenteditable="true"]',                   // generic contenteditable
    "textarea",                                      // fallback
  ],

  // Send button
  send: [
    'button[aria-label*="Send"]',
    'button[aria-label*="傳送"]',
    'button[aria-label*="發送"]',
    'button[aria-label*="Submit"]',
    'span[data-icon="send"]',
    "button.bg-primary",
  ],

  // Response / message container
  // Priority: most specific first; body fallback in response-extractor will filter
  response: [
    ".model-response-text",                  // 2024-2025 Gemini
    "model-response",                        // custom element wrapper
    "[role='article']",                      // ARIA article container
    ".markdown",                             // prose container
    "c-wiz div[aria-label]",                 // Google WIZ container
    "div[data-message-content]",             // message wrapper
    "div.gen-content-wrapper",               // AI response wrapper
    ".conversation-response-model",          // alternative model response
    ".response-container-content",           // older container
    "message-content",                       // generic message wrapper
  ],

  // Upload / attachment
  upload: [
    'input[type="file"]',
    'button[aria-label*="Add image"]',
    'button[aria-label*="上傳"]',
    'button[aria-label*="圖片"]',
  ],

  // Workspace / extension save buttons
  workspaceButtons: [
    "button[aria-label*='儲存']",
    "button[aria-label*='Save']",
    "button[aria-label*='建立']",
    "button[aria-label*='Create']",
  ],
} as const;

export type SelectorType = keyof typeof SELECTORS;