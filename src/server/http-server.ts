import Fastify from "fastify";
import cors from "@fastify/cors";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { chatRoute } from "../routes/chat.js";
import { modelsRoute } from "../routes/models.js";
import { healthRoute } from "../routes/health.js";
import { getSessionManager } from "../services/session-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 載入設定檔
const configPath = join(__dirname, "../../service.gollmrc.json");
let config: any = {};
try {
  config = JSON.parse(readFileSync(configPath, "utf-8"));
} catch (e) {
  console.warn("⚠️ service.gollmrc.json 未找到，使用預設設定");
}

// 提前初始化 SessionManager，確保 config.playwright 設定被正確套用
const playwrightConfig = config.playwright || {};
getSessionManager({
  headless: playwrightConfig.headless ?? process.env.GOLLM_BROWSER_HEADLESS === "true",
  userDataDir: playwrightConfig.userDataDir,
  stealth: playwrightConfig.stealth,
});

const HOST = config.server?.host || "127.0.0.1";
const PORT = config.server?.port || 3001;

const fastify = Fastify({
  logger: {
    level: "info",
    // Simple console output - timestamps in local time
    transport: {
      target: "pino-pretty",
      options: {
        translateTime: "SYS:standard",
        ignore: "pid,hostname",
      },
    },
  },
});

// CORS
await fastify.register(cors, {
  origin: true,
  credentials: true,
});

// Routes
fastify.register(chatRoute, { config });
fastify.register(modelsRoute);
fastify.register(healthRoute);

// Start
const start = async () => {
  try {
    await fastify.listen({ host: HOST, port: PORT });
    console.log(`
╔═══════════════════════════════════════════════╗
║       GoLLM Service 啟動中                    ║
║  HTTP Server: http://${HOST}:${PORT}                ║
║  Health:      http://${HOST}:${PORT}/health       ║
║  API Docs:    http://${HOST}:${PORT}/v1/models     ║
╚═══════════════════════════════════════════════╝
    `);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();