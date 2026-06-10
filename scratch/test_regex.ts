import { PromptEngine } from "../src/services/prompt-engine.js";

const engine = new PromptEngine();

const sampleInput = `Conversation info (untrusted metadata):
\`\`\`json
{
  "/home/yywang/project/MEMORY.md": "Memory Content Here",
  "/home/yywang/project/USER.md": "User Content Here",
  "~/.openclaw/workspace/custom_system_prompt": "Custom Prompt Content Here",
  "chat_id": "test-chat-id"
}
\`\`\`
Hello, how are you?`;

console.log("Original text:");
console.log(sampleInput);

console.log("\n-------------------\nRunning cleanContent:");
const cleaned = engine.cleanContent(sampleInput);
console.log("Cleaned output:");
console.log(cleaned);
