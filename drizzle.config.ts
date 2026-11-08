import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit 設定。
 *   npm run db:generate  依 shared/schema.ts 產生 SQL migration 到 migrations/
 *   npm run db:push      開發用：直接把 schema 推到資料庫（不產 migration）
 * 正式環境不用這個檔：啟動時由 server/migrate.ts 套用 migrations/。
 */
export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/quotationmaster",
  },
});
