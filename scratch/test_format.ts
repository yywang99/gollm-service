import { PromptEngine } from "../src/services/prompt-engine.js";

const engine = new PromptEngine();

const messages = [
  { role: "system", content: "System instructions here." },
  { role: "user", content: "Hello model." }
];

const tools = [
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch URL content",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string" }
        },
        required: ["url"]
      }
    }
  }
];

const result = engine.formatTranscript(messages, tools);
console.log("Result length:", result.length);
console.log("Result content preview:\n", result);
console.log("Result contains raw newlines (code 10):", result.includes('\n'));
console.log("Result contains escaped newlines (\\n):", result.includes('\\n'));
