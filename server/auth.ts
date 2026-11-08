/**
 * 認證與權限。
 *
 * 只有一種登入方式：帳號密碼 + 伺服器端 session（存在 PostgreSQL 的
 * user_sessions 表）。權限綁在自己的 users / roles 表上，離職停用帳號
 * 立即生效，不依賴任何外部身分供應商。
 */

import type { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import ConnectPgSimple from "connect-pg-simple";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { pool } from "./db";
import { ForbiddenError, UnauthorizedError, ValidationError } from "./errors";
import { PERMISSIONS } from "../shared/schema";

const BCRYPT_ROUNDS = 12;

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  displayName: string | null;
  role: string;
  mustChangePassword: boolean;
  permissions: Set<string>;
}

declare module "express-session" {
  interface SessionData {
    userId: number;
  }
}

export interface AuthedRequest extends Request {
  user?: AuthUser;
}

/* ── Session ──────────────────────────────────────────── */

export function setupSession(app: Express) {
  const isProduction = process.env.NODE_ENV === "production";
  const secret = process.env.SESSION_SECRET;

  if (!secret && isProduction) {
    throw new Error(
      "SESSION_SECRET 未設定。請用 openssl rand -hex 32 產生一組隨機字串，" +
      "寫進 .env（或環境變數）後再啟動正式環境。",
    );
  }
  if (!secret) {
    console.warn(
      "\n⚠️  SESSION_SECRET 未設定，開發環境使用隨機密鑰（每次重啟都會登出所有人）。\n",
    );
  }

  const PgSession = ConnectPgSimple(session);
  app.use(session({
    store: new PgSession({
      pool: pool as never,
      // 專屬表名。人事系統原本讓 connect-pg-simple 跟 drizzle 搶
      // `sessions` 這個表名，在乾淨的資料庫上會導致登入一律 500。
      tableName: "user_sessions",
      createTableIfMissing: true,
    }),
    secret: secret || randomBytes(32).toString("hex"),
    resave: false,
    saveUninitialized: false,
    cookie: {
      // "auto"：走 HTTPS（或反向代理帶 X-Forwarded-Proto: https）時才標 Secure，
      // 直接用 http://主機:5000 存取時也能登入。要強制一律 Secure 就設 COOKIE_SECURE=true。
      secure: process.env.COOKIE_SECURE === "true" ? true
        : process.env.COOKIE_SECURE === "false" ? false : "auto",
      httpOnly: true,
      sameSite: "lax",
      maxAge: 12 * 60 * 60 * 1000,
    },
  }));
}

/* ── 密碼 ─────────────────────────────────────────────── */

export const hashPassword = (plain: string) => bcrypt.hash(plain, BCRYPT_ROUNDS);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

/* ── 登入爆破防護 ─────────────────────────────────────── */

const MAX_ATTEMPTS = 8;
// 帳號層級的上限放寬一點，避免有人故意鎖別人。但仍然是硬上限：
// 換 IP（偽造 X-Forwarded-For）也繞不過，因為這個 key 只看帳號。
const MAX_ATTEMPTS_ACCOUNT = 20;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; firstAt: number }>();

export function isLockedOut(key: string, max = MAX_ATTEMPTS): boolean {
  const record = attempts.get(key);
  if (!record) return false;
  if (Date.now() - record.firstAt > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return record.count >= max;
}

export function recordFailure(key: string) {
  const record = attempts.get(key);
  if (!record || Date.now() - record.firstAt > WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: Date.now() });
    return;
  }
  record.count += 1;
}

export const clearFailures = (key: string) => attempts.delete(key);

/**
 * 帳號層級的爆破防護。跟 IP 無關，所以偽造來源 IP 也無法重置。
 * 回傳這個帳號目前是否已被鎖、以及記錄一次失敗、清除計數。
 */
export const accountKey = (username: string) => `acct|${username.toLowerCase()}`;
export const isAccountLockedOut = (username: string) =>
  isLockedOut(accountKey(username), MAX_ATTEMPTS_ACCOUNT);

/** 測試用：清空所有計數 */
export const resetLockouts = () => attempts.clear();

/* ── 使用者查詢 ───────────────────────────────────────── */

export async function loadUser(userId: number): Promise<AuthUser | null> {
  const res = await pool.query(
    `SELECT u.id, u.username, u.email, u.display_name, u.role, u.is_active,
            u.must_change_password,
            COALESCE(r.permissions, ARRAY[]::text[]) AS permissions
     FROM users u
     LEFT JOIN roles r ON r.name = u.role
     WHERE u.id = $1`,
    [userId],
  );
  if (!res.rowCount || !res.rows[0].is_active) return null;
  const row = res.rows[0];
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    mustChangePassword: Boolean(row.must_change_password),
    permissions: new Set<string>(row.permissions),
  };
}

/**
 * 登入時換發新的 session id，防止 session fixation：
 * 攻擊者先讓受害者帶著自己準備好的 session id 登入，
 * 登入成功後兩人就共用同一個 session。
 */
export function regenerateSession(req: Request): Promise<void> {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => (err ? reject(err) : resolve()));
  });
}

/* ── 中介層 ───────────────────────────────────────────── */

export async function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.session?.userId) return next(new UnauthorizedError());
  const user = await loadUser(req.session.userId);
  if (!user) {
    req.session.destroy(() => {});
    return next(new UnauthorizedError("使用者不存在或已停用"));
  }
  req.user = user;
  next();
}

export function requirePermission(...required: string[]) {
  return (req: AuthedRequest, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new UnauthorizedError());
    if (req.user.permissions.has(PERMISSIONS.SYSTEM_ADMIN)) return next();
    const has = required.some(p => req.user!.permissions.has(p));
    if (!has) {
      return next(new ForbiddenError(`需要「${required.join(" 或 ")}」權限`));
    }
    next();
  };
}

export function can(user: AuthUser | undefined, permission: string): boolean {
  if (!user) return false;
  return user.permissions.has(PERMISSIONS.SYSTEM_ADMIN) || user.permissions.has(permission);
}

/** 這個人看不看得到成本與毛利 */
export const canSeeCost = (user?: AuthUser) => can(user, PERMISSIONS.QUOTATION_VIEW_COST);

export function actorFrom(req: AuthedRequest) {
  return {
    userId: req.user?.id ?? null,
    label: req.user ? `${req.user.displayName ?? req.user.username}（${req.user.email}）` : "未登入",
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  };
}

/* ── 初始化 ───────────────────────────────────────────── */

const ROLE_PRESETS = [
  {
    name: "admin", description: "系統管理員", isSystem: true,
    permissions: Object.values(PERMISSIONS),
  },
  {
    name: "manager", description: "主管", isSystem: true,
    permissions: [
      PERMISSIONS.QUOTATION_READ, PERMISSIONS.QUOTATION_WRITE,
      PERMISSIONS.QUOTATION_APPROVE, PERMISSIONS.QUOTATION_VOID,
      PERMISSIONS.QUOTATION_VIEW_COST,
      PERMISSIONS.CLIENT_READ, PERMISSIONS.CLIENT_WRITE,
      PERMISSIONS.PRODUCT_READ, PERMISSIONS.PRODUCT_WRITE,
      PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.EMPLOYEE_WRITE,
      PERMISSIONS.ATTENDANCE_READ, PERMISSIONS.ATTENDANCE_MANAGE,
      PERMISSIONS.LEAVE_READ, PERMISSIONS.LEAVE_APPROVE,
      PERMISSIONS.USER_READ, PERMISSIONS.AUDIT_READ,
    ],
  },
  {
    name: "sales", description: "業務", isSystem: true,
    permissions: [
      PERMISSIONS.QUOTATION_READ, PERMISSIONS.QUOTATION_WRITE,
      PERMISSIONS.CLIENT_READ, PERMISSIONS.CLIENT_WRITE,
      PERMISSIONS.PRODUCT_READ,
      PERMISSIONS.ATTENDANCE_WRITE, PERMISSIONS.LEAVE_WRITE, PERMISSIONS.LEAVE_READ,
    ],
  },
  {
    name: "accounting", description: "會計", isSystem: true,
    permissions: [
      PERMISSIONS.QUOTATION_READ, PERMISSIONS.QUOTATION_VIEW_COST,
      PERMISSIONS.CLIENT_READ, PERMISSIONS.PRODUCT_READ,
      PERMISSIONS.EMPLOYEE_READ, PERMISSIONS.EMPLOYEE_VIEW_SALARY,
      PERMISSIONS.AUDIT_READ,
    ],
  },
  {
    name: "employee", description: "一般員工", isSystem: true,
    permissions: [
      PERMISSIONS.ATTENDANCE_WRITE, PERMISSIONS.LEAVE_WRITE, PERMISSIONS.LEAVE_READ,
    ],
  },
];

/**
 * 自動把「還沒對上系統帳號」的員工跟使用者連起來。
 * 比對規則：帳號 = 員編，或 email 相同（不分大小寫）。
 * 啟動時跑一次全表；新增員工或使用者時也會針對那一筆再跑，
 * 不然先建帳號、後建員工的人會一直被標成「無帳號」，打卡也打不了。
 */
export async function linkEmployeesToUsers(
  client: { query: typeof pool.query } = pool,
  scope: { employeeId?: number; userId?: number } = {},
) {
  const extra = scope.employeeId ? " AND e.id = $1" : scope.userId ? " AND u.id = $1" : "";
  const params = scope.employeeId ? [scope.employeeId] : scope.userId ? [scope.userId] : [];
  await client.query(
    `UPDATE employees e SET user_id = u.id
       FROM users u
      WHERE e.user_id IS NULL
        AND u.id NOT IN (SELECT user_id FROM employees WHERE user_id IS NOT NULL)
        AND (u.username = e.employee_id
             OR (e.email IS NOT NULL AND e.email <> '' AND lower(u.email) = lower(e.email)))${extra}`,
    params,
  );
}

export async function ensureRolesAndAdmin() {
  for (const preset of ROLE_PRESETS) {
    await pool.query(
      `INSERT INTO roles (name, description, permissions, is_system)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (name) DO UPDATE
         SET permissions = EXCLUDED.permissions, description = EXCLUDED.description`,
      [preset.name, preset.description, preset.permissions, preset.isSystem],
    );
  }

  await linkEmployeesToUsers();

  // 只在「資料庫裡一個使用者都沒有」時建立第一個管理員。
  // 已經有人的系統不會再自動建帳號，避免環境變數留著就被重複建。
  const count = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
  if (count.rows[0].n > 0) return;

  const username = (process.env.INITIAL_ADMIN_USERNAME || "admin").trim();
  const email = (process.env.INITIAL_ADMIN_EMAIL || "admin@example.com").trim();
  let password = process.env.INITIAL_ADMIN_PASSWORD;
  let generated = false;
  if (!password || password.length < 12) {
    // 沒給密碼就產生一組隨機的，印在啟動 log（只會發生在第一次啟動）。
    // 產生的密碼同時含英數，符合 assertStrongPassword 的規則。
    password = `Qm${randomBytes(9).toString("base64url")}1`;
    generated = true;
  }

  await pool.query(
    `INSERT INTO users (username, password, email, display_name, role, must_change_password)
     VALUES ($1,$2,$3,'系統管理員','admin',true)`,
    [username, await hashPassword(password), email],
  );

  if (generated) {
    console.log(
      "\n════════════════════════════════════════════════════════\n" +
      `  已建立初始管理員帳號：${username}\n` +
      `  初始密碼：${password}\n` +
      "  （未設定 INITIAL_ADMIN_PASSWORD，故由系統隨機產生；\n" +
      "    首次登入後會強制修改密碼，這組密碼只會顯示這一次）\n" +
      "════════════════════════════════════════════════════════\n",
    );
  } else {
    console.log(`已建立初始管理員帳號 ${username}（密碼取自 INITIAL_ADMIN_PASSWORD，首次登入須修改）`);
  }
}

export function assertStrongPassword(password: unknown): string {
  if (typeof password !== "string" || password.length < 10) {
    throw new ValidationError("密碼至少需要 10 個字元");
  }
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    throw new ValidationError("密碼必須同時包含英文字母與數字");
  }
  return password;
}
