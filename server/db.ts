import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../shared/schema";

/**
 * DATE 欄位一律以字串回傳，不要轉成 JavaScript 的 Date。
 *
 * node-postgres 預設會把 DATE（OID 1082）轉成 Date 物件，而 Date 物件
 * 帶時區。`2026-10-01` 會變成當地時間午夜的 Date，序列化成 JSON 時
 * 依環境不同可能變成 `2026-09-30T16:00:00.000Z`——日期整整差一天。
 *
 * 這正是舊系統報價日期會跑掉的原因（`new Date("2026-08-11")` 被當成
 * UTC 午夜解析）。報價日、驗收日、到期日這些都是「純日期」，
 * 沒有時間也沒有時區，就該原樣當字串處理。
 *
 * 1082 = DATE，1114 = TIMESTAMP WITHOUT TIME ZONE
 */
pg.types.setTypeParser(1082, value => value);

/**
 * NUMERIC 也維持字串（這是 node-postgres 的預設行為，這裡只是明講）。
 * 金額轉成 JavaScript number 會有浮點誤差，稅額差一塊錢就對不上發票。
 * 需要運算時再明確轉換。
 */
pg.types.setTypeParser(1700, value => value);

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL 未設定。請在 .env（或環境變數）加上 PostgreSQL 連線字串，\n" +
    "例如 postgresql://user:password@localhost:5432/quotationmaster",
  );
}

/**
 * 用 node-postgres 的連線池。對「一直開著的伺服器」最合適，
 * 也能直接接任何 PostgreSQL（本機、Docker、雲端託管的都可以）。
 */
export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  // 連線字串帶 sslmode=require（雲端託管常見）才走 SSL；
  // 本機與 docker compose 內部網路一律不用。
  ssl: /sslmode=require/.test(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
});

// 連線池的錯誤如果沒有監聽，Node 會直接讓整個 process 崩潰
pool.on("error", error => {
  console.error("資料庫連線池錯誤:", error.message);
});

export const db = drizzle(pool, { schema });

/** 在交易中執行。任何例外都會 rollback。 */
export async function transaction<T>(
  fn: (tx: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** 最近一次連線失敗的原因，啟動訊息會印出來（密碼錯跟連不到主機的處理方式差很多） */
export let lastConnectionError: string | null = null;

export async function checkConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    lastConnectionError = null;
    return true;
  } catch (error) {
    lastConnectionError = (error as Error).message;
    return false;
  }
}
