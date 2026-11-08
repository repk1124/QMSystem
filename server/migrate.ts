/**
 * 資料庫 migration。
 *
 * 啟動時自動套用 migrations/ 底下由 drizzle-kit generate 產生的 SQL，
 * 已套用過的會記錄在 drizzle.__drizzle_migrations，重複執行不會再跑一次。
 * 這樣 Docker 一鍵部署、或是直接 npm start，都不需要另外手動建表。
 *
 * 也可以單獨執行：npm run db:migrate
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db, pool } from "./db";

/** migrations/ 的位置：相對於專案根目錄（dist/ 與 server/ 都在根目錄下一層） */
export function migrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "migrations"),
    path.resolve(process.cwd(), "migrations"),
  ];
  const found = candidates.find(p => existsSync(p));
  if (!found) {
    throw new Error(
      `找不到 migrations 資料夾（試過：${candidates.join("、")}）。` +
      "請確認 migrations/ 有跟程式一起部署。",
    );
  }
  return found;
}

export async function runMigrations() {
  const folder = migrationsFolder();
  await migrate(db, { migrationsFolder: folder });
  console.log(`[db] migrations 已套用（${folder}）`);
}

// 直接以 `tsx server/migrate.ts` 執行時：跑完就結束
const invokedDirectly = process.argv[1] && /migrate\.(ts|js)$/.test(process.argv[1]);
if (invokedDirectly) {
  runMigrations()
    .then(async () => { await pool.end(); process.exit(0); })
    .catch(async error => {
      console.error("migration 失敗:", error);
      await pool.end();
      process.exit(1);
    });
}
