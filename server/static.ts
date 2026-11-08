/**
 * 正式環境的靜態檔服務。
 *
 * 刻意跟 server/vite.ts 分開：vite.ts 會 import "vite"（devDependency），
 * esbuild 打包時若兩者在同一個檔案，dist/index.js 就會在正式環境要求安裝 vite。
 * 這裡只用 express 本身。
 */
import express, { type Express } from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function serveStatic(app: Express) {
  // 打包後 dist/index.js 旁邊就是 dist/public；開發時（tsx）則是 ../dist/public
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.resolve(here, "public"), path.resolve(here, "..", "dist", "public")];
  const distPath = candidates.find(p => fs.existsSync(p));

  if (!distPath) {
    throw new Error(
      `找不到前端打包結果（試過：${candidates.join("、")}）。請先執行 npm run build。`,
    );
  }

  app.use(express.static(distPath, { index: false, maxAge: "1h" }));

  // 其餘路徑交給前端路由（SPA）
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
