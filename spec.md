# GoLLM Service Technical Specification

## 1. Overview
GoLLM Service is a bridge that converts the Gemini Web UI into an OpenAI-compatible API. It uses Playwright RPA to simulate human interaction, bypassing API quota limitations and enabling "Thinking" model capabilities directly from the web interface.

## 2. API Specification

### `POST /v1/chat/completions`
- **Input**: OpenAI Chat Completion format.
- **Processing**:
    1. **Prompt Assembly**: Combines system prompts, tools, and history.
    2. **Truncation**: If `tools` section > `MAX_TOOLS_SECTION_LENGTH` (8,000 chars), it truncates the list and adds a notice.
    3. **Injection**: Uses `typeInput` to simulate typing into the Gemini text area.
    4. **Extraction**: Polls the DOM for the assistant's response using `response-extractor`.
- **Output**: OpenAI-compatible JSON response.

### `GET /health`
- **Returns**: `{ status, service, version, session, browser, timestamp }`
- **Browser Statuses**:
    - `responsive`: Browser is active and controllable.
    - `unresponsive`: Browser is hanging or session is lost.

## 3. Core Logic Components

### A. Session Management (`SessionManager`)
- Maintains a singleton Chromium instance.
- **`startNewChat()`**: 
    - Performs a hard reset: `page.goto(URL)` $\rightarrow$ `checkIsFreshSession()` $\rightarrow$ `page.reload()` (if needed).
    - Ensures no residue from previous contexts remains.

### B. Transport Stream (`gollm-transport-stream.ts`)
- Handles the actual RPA sequence.
- **Input Handling**: Implements `typeInput` with visibility checks and `TimeoutError` handling.
- **Constraint**: `MAX_TRANSCRIPT_LENGTH` (80,000 chars) prevents the prompt from exceeding Gemini's stability threshold.

### C. DOM Healing (`dom-doctor.ts`)
- Implements a "Selector Pool" strategy.
- If a primary selector fails, it iterates through alternatives or uses AI-assisted recovery to find the correct element.

## 4. Stability Constraints & Limits

| Constraint | Limit / Behavior | Purpose |
| :--- | :--- | :--- |
| **Concurrency** | 1 (Serial) | Prevent session collisions in a single Chrome profile. |
| **Tool Limit** | 8,000 characters | Prevent Web UI hang/crash due to oversized prompt. |
| **Context Limit** | 80,000 characters | Balance between history depth and page performance. |
| **Retry Logic** | Exponential Backoff | Handle transient DOM delays or network lag. |

## 5. Deployment Architecture
- **Runtime**: Node.js (Fastify / TypeScript).
- **Driver**: Playwright Chromium.
- **Persistence**: Local Chrome User Data Directory (UDP).
- **Process Management**: systemd user service.
