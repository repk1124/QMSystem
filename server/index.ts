import express from "express";
import { createServer } from "node:http";
import { registerRoutes } from "./routes";
import { checkConnection, lastConnectionError } from "./db";
import { runMigrations } from "./migrate";
import { seedDefaults } from "./seed";
import { getSettings } from "./repositories/settings";

const app = express();

// 反向代理（nginx / Caddy / docker 網路）後面跑時，不設這個的話 req.ip 會全部變成
// 代理伺服器的 IP，登入爆破防護與稽核紀錄就失去意義。
app.set("trust proxy", 1);

// 請求記錄。只記 /api，而且截斷長度避免把整包回應寫進日誌。
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    if (!req.path.startsWith("/api")) return;
    const line = `${req.method} ${req.path} ${res.statusCode} ${Date.now() - started}ms`;
    console.log(`[api] ${line}`);
  });
  next();
});

async function start() {
  if (!await checkConnection()) {
    console.error(
      `\n無法連線到資料庫：${lastConnectionError ?? "未知原因"}\n` +
      "  請確認 DATABASE_URL 是否正確設定。\n" +
      "  Docker：確認 db 服務已啟動（docker compose ps）；若是密碼錯誤，通常是 .env 的\n" +
      "          POSTGRES_PASSWORD 在資料庫建立後被改過 —— 請改回原值，或 docker compose down -v 重建（會清空資料）\n" +
      "  本機開發：export DATABASE_URL=postgresql://user:password@localhost:5432/quotationmaster\n",
    );
    process.exit(1);
  }

  // 順序很重要：先建表，再補預設資料（角色、設定、公司、範本、管理員），最後才掛路由。
  await runMigrations();
  await seedDefaults();
  await registerRoutes(app);

  // 開發模式掛 Vite，正式模式送靜態檔。
  // 一定要在 API 路由之後，否則 catch-all 會把 /api 也吃掉。
  if (app.get("env") === "development") {
    // 用變數路徑讓 esbuild 不要把 vite.ts 打進正式 bundle（它會 import "vite"）。
    const viteModule = "./vite.js";
    const { setupVite } = await import(viteModule) as typeof import("./vite");
    await setupVite(app, server);
  } else {
    const { serveStatic } = await import("./static");
    serveStatic(app);
  }

  const port = Number(process.env.PORT) || 5000;

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(
        `\n⚠️  埠 ${port} 已被占用 —— 通常是上一個伺服器還在執行中。\n\n` +
        `   解法擇一：\n` +
        `     1. 終止舊的程序：  pkill -f "node dist/index.js" 或 pkill -f tsx\n` +
        `     2. 改用其他埠：    PORT=5001 npm start\n`,
      );
      process.exit(1);
    }
    console.error("伺服器啟動失敗:", error);
    process.exit(1);
  });

  server.listen({ port, host: "0.0.0.0" }, async () => {
    const settings = await getSettings();
    console.log(`${settings.appName} 已啟動於 http://localhost:${port}`);
  });
}

const server = createServer(app);

// 未預期的例外不該讓伺服器靜靜地死掉
process.on("unhandledRejection", reason => {
  console.error("未處理的 Promise rejection:", reason);
});

// 收到終止訊號時把連線收乾淨，避免容器重啟時留下半開的資料庫連線
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`\n收到 ${signal}，正在關閉…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

start().catch(error => {
  console.error("啟動失敗:", error);
  process.exit(1);
});
