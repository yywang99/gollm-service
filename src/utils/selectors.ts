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
  response: [
    "model-response .model-response-text",  // Latest Gemini
    "model-response",                        // custom element wrapper
    ".markdown",                             // prose container
    ".response-container-content",           // alternative container
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