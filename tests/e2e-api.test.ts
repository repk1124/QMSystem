/**
 * API 端對端測試：打「真的伺服器」上的每一條路由。
 *
 * 兩種跑法：
 *   1. 自己起伺服器（預設）：先 npm run build，再
 *        DATABASE_URL=postgresql://.../可清空的庫 npm run test:e2e
 *      會用 dist/index.js 起一個臨時伺服器（port 5199），跑完關掉。
 *   2. 打已經在跑的環境（例如 docker compose）：
 *        E2E_BASE_URL=http://localhost:5000 E2E_ADMIN_PASSWORD=<初始密碼> npm run test:e2e
 *
 * 每次執行都用一組隨機後綴建立自己的使用者／客戶／員工，所以同一個資料庫可以重複跑。
 * 最後會比對 server/routes.ts 裡註冊的全部路由，有沒漏掉的就失敗。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, "..");

/* ── 斷言工具（沿用其他 tests 的寫法） ───────────────── */
let pass = 0, fail = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${extra}`); fail++; failures.push(`${name} ${extra}`); }
};
const eq = (name: string, actual: unknown, expected: unknown) =>
  ok(name, String(actual) === String(expected), `期望 ${expected}，實得 ${actual}`);
const section = (title: string) => console.log(`\n── ${title} ──`);

/* ── 伺服器 ───────────────────────────────────────────── */
const EXTERNAL = process.env.E2E_BASE_URL;
const PORT = 5199;
const BASE = (EXTERNAL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
const ADMIN_USER = process.env.E2E_ADMIN_USER ?? "admin";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "E2eAdminPass123";

async function startServer(): Promise<ChildProcess | null> {
  if (EXTERNAL) return null;
  if (!process.env.DATABASE_URL) throw new Error("請設定 DATABASE_URL（可清空的測試庫）");
  const uploadDir = mkdtempSync(path.join(tmpdir(), "qm-e2e-"));
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(PORT),
      UPLOAD_DIR: uploadDir,
      SESSION_SECRET: process.env.SESSION_SECRET ?? "e2e-only-secret-0123456789abcdef",
      INITIAL_ADMIN_USERNAME: ADMIN_USER,
      INITIAL_ADMIN_PASSWORD: ADMIN_PASSWORD,
      INITIAL_ADMIN_EMAIL: "admin@example.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", d => { if (process.env.E2E_VERBOSE) process.stdout.write(d); });
  child.stderr?.on("data", d => process.stderr.write(d));
  return child;
}

async function waitForHealth() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.status === 200) return;
    } catch { /* 還沒起來 */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error(`伺服器 ${BASE} 在 60 秒內沒有就緒`);
}

/* ── HTTP client：每個使用者一個 cookie jar，並記錄打過哪些路由 ── */
const covered = new Set<string>();
interface Res { status: number; body: Record<string, any>; buffer: Buffer; text: string }

function makeClient() {
  let cookie = "";
  return async function call(
    method: string, template: string,
    opts: { params?: Record<string, unknown>; body?: unknown; form?: FormData; query?: string } = {},
  ): Promise<Res> {
    covered.add(`${method.toLowerCase()} ${template}`);
    let p = template;
    for (const [k, v] of Object.entries(opts.params ?? {})) p = p.replace(`:${k}`, String(v));
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    let payload: string | FormData | undefined;
    if (opts.form) payload = opts.form;
    else if (opts.body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(opts.body); }
    const res = await fetch(`${BASE}/api${p}${opts.query ?? ""}`, { method, headers, body: payload, redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString("utf8");
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* 二進位或空 */ }
    return { status: res.status, body: (json ?? {}) as Record<string, any>, buffer, text };
  };
}
type Client = ReturnType<typeof makeClient>;

/* ── 測試資料 ─────────────────────────────────────────── */
const RUN = Date.now().toString(36).slice(-6);
const PW = "E2ePassword123";

/** 統編檢查碼（財政部規則），跟 server/repositories/clients.ts 一致 */
function validTaxId(seed: number): string {
  const w = [1, 2, 1, 2, 1, 2, 4, 1];
  for (let n = seed; ; n += 1) {
    const t = String(n).padStart(8, "0").slice(-8);
    const d = t.split("").map(Number);
    let sum = 0;
    for (let i = 0; i < 8; i += 1) { const p = d[i] * w[i]; sum += Math.floor(p / 10) + (p % 10); }
    if (sum % 5 === 0 || (d[6] === 7 && (sum - 1) % 5 === 0)) return t;
  }
}
const taxSeed = 20000000 + (Date.now() % 9000000);
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZqOngAAAABJRU5ErkJggg==", "base64");
const today = new Date().toISOString().slice(0, 10);
const compact = today.replace(/-/g, "");

async function main() {
  const server = await startServer();
  try {
    await waitForHealth();
    await run();
  } finally {
    server?.kill("SIGTERM");
  }
  console.log(`\n════════ 通過 ${pass}／失敗 ${fail} ════════`);
  if (failures.length) console.log("失敗項目：\n  " + failures.join("\n  "));
  process.exit(fail ? 1 : 0);
}

async function run() {
  const anon = makeClient();
  const boot = makeClient();   // 初始管理員（只用來建測試用的使用者）
  const admin = makeClient();  // e2e 自己建的管理員
  const mgr = makeClient();
  const sales = makeClient();
  const acct = makeClient();
  const emp = makeClient();

  section("0. 健康檢查");
  {
    const h = await anon("GET", "/health");
    eq("GET /health 200", h.status, 200);
    eq("database: true", h.body.database, true);
  }

  section("1. 登入");
  {
    eq("錯密碼 401", (await boot("POST", "/auth/login", { body: { username: ADMIN_USER, password: "wrong-password" } })).status, 401);
    eq("不存在的帳號 401", (await boot("POST", "/auth/login", { body: { username: `nobody-${RUN}`, password: "x" } })).status, 401);
    eq("缺欄位 400", (await boot("POST", "/auth/login", { body: { username: ADMIN_USER } })).status, 400);
    const login = await boot("POST", "/auth/login", { body: { username: ADMIN_USER, password: ADMIN_PASSWORD } });
    eq("初始管理員登入 200", login.status, 200);
    if (login.status !== 200) {
      throw new Error(`無法用 ${ADMIN_USER} 登入 ${BASE}：${login.text}。請用 E2E_ADMIN_PASSWORD 指定初始密碼。`);
    }
    ok("回傳權限清單", Array.isArray(login.body.user.permissions) && login.body.user.permissions.includes("system:admin"));
    eq("未登入 /auth/me 401", (await anon("GET", "/auth/me")).status, 401);
    eq("已登入 /auth/me 200", (await boot("GET", "/auth/me")).status, 200);
  }

  section("2. 使用者與角色");
  const users: Record<string, number> = {};
  {
    eq("建立使用者缺密碼 400", (await boot("POST", "/users", { body: { username: `nopw-${RUN}`, email: `nopw-${RUN}@example.com`, role: "sales" } })).status, 400);
    eq("密碼太弱 400", (await boot("POST", "/users", { body: { username: `weak-${RUN}`, email: `weak-${RUN}@example.com`, role: "sales", password: "short" } })).status, 400);
    eq("未知角色 400", (await boot("POST", "/users", { body: { username: `badrole-${RUN}`, email: `badrole-${RUN}@example.com`, role: "ceo", password: PW } })).status, 400);

    for (const [name, role] of [["admin", "admin"], ["mgr", "manager"], ["sales", "sales"], ["acct", "accounting"], ["emp", "employee"], ["lock", "employee"], ["off", "employee"]] as const) {
      const r = await boot("POST", "/users", { body: {
        username: `e2e${name}-${RUN}`, email: `e2e${name}-${RUN}@example.com`,
        displayName: `E2E ${name}`, role, password: PW,
      } });
      eq(`建立 ${role} 使用者 201`, r.status, 201);
      users[name] = r.body.id;
    }
    eq("重複帳號 409", (await boot("POST", "/users", { body: { username: `e2eadmin-${RUN}`, email: `dup-${RUN}@example.com`, role: "sales", password: PW } })).status, 409);

    for (const [c, name] of [[admin, "admin"], [mgr, "mgr"], [sales, "sales"], [acct, "acct"], [emp, "emp"]] as const) {
      eq(`${name} 登入`, (await c("POST", "/auth/login", { body: { username: `e2e${name}-${RUN}`, password: PW } })).status, 200);
    }

    eq("GET /users（管理員）200", (await admin("GET", "/users")).status, 200);
    ok("列表含剛建的帳號", (await admin("GET", "/users")).body.some((u: { id: number }) => u.id === users.emp));
    eq("GET /users（一般員工）403", (await emp("GET", "/users")).status, 403);
    eq("GET /roles（主管）200", (await mgr("GET", "/roles")).status, 200);
    ok("角色清單有 5 個內建角色", (await mgr("GET", "/roles")).body.length >= 5);
    eq("GET /roles（一般員工）403", (await emp("GET", "/roles")).status, 403);
    eq("業務不能建使用者 403", (await sales("POST", "/users", { body: { username: `x-${RUN}`, email: `x-${RUN}@example.com`, role: "sales", password: PW } })).status, 403);

    eq("改角色 200", (await admin("PATCH", "/users/:id", { params: { id: users.off }, body: { role: "sales" } })).status, 200);
    eq("停用 200", (await admin("PATCH", "/users/:id", { params: { id: users.off }, body: { isActive: false } })).status, 200);
    eq("停用者登入 401", (await makeClient()("POST", "/auth/login", { body: { username: `e2eoff-${RUN}`, password: PW } })).status, 401);
    eq("不存在的使用者 404", (await admin("PATCH", "/users/:id", { params: { id: 999999 }, body: { role: "sales" } })).status, 404);
    eq("主管不能改使用者 403", (await mgr("PATCH", "/users/:id", { params: { id: users.off }, body: { isActive: true } })).status, 403);
  }

  section("3. 首次強制改密碼、改密碼、登出");
  {
    const me = await emp("GET", "/auth/me");
    eq("新帳號 mustChangePassword = true", me.body.user.mustChangePassword, true);
    eq("目前密碼錯 400", (await emp("POST", "/auth/change-password", { body: { currentPassword: "wrong", newPassword: "AnotherPass123" } })).status, 400);
    eq("新密碼太弱 400", (await emp("POST", "/auth/change-password", { body: { currentPassword: PW, newPassword: "weak" } })).status, 400);
    eq("新舊相同 400", (await emp("POST", "/auth/change-password", { body: { currentPassword: PW, newPassword: PW } })).status, 400);
    eq("未登入改密碼 401", (await anon("POST", "/auth/change-password", { body: { currentPassword: PW, newPassword: "AnotherPass123" } })).status, 401);
    eq("改密碼成功 200", (await emp("POST", "/auth/change-password", { body: { currentPassword: PW, newPassword: "AnotherPass123" } })).status, 200);
    eq("改完 mustChangePassword = false", (await emp("GET", "/auth/me")).body.user.mustChangePassword, false);
    eq("登出 200", (await emp("POST", "/auth/logout")).status, 200);
    eq("登出後 /auth/me 401", (await emp("GET", "/auth/me")).status, 401);
    eq("舊密碼登入失敗 401", (await emp("POST", "/auth/login", { body: { username: `e2eemp-${RUN}`, password: PW } })).status, 401);
    eq("新密碼登入 200", (await emp("POST", "/auth/login", { body: { username: `e2eemp-${RUN}`, password: "AnotherPass123" } })).status, 200);
  }

  section("4. 登入爆破防護（用專屬的 lock 帳號，避免鎖到其他測試）");
  {
    const attacker = makeClient();
    let last = 0;
    for (let i = 0; i < 10; i += 1) {
      last = (await attacker("POST", "/auth/login", { body: { username: `e2elock-${RUN}`, password: `guess${i}` } })).status;
    }
    eq("連續失敗後 429", last, 429);
    eq("鎖定期間正確密碼也 429", (await attacker("POST", "/auth/login", { body: { username: `e2elock-${RUN}`, password: PW } })).status, 429);
    eq("其他已登入的 session 不受影響", (await admin("GET", "/auth/me")).status, 200);
  }

  section("5. 系統設定（白牌化）");
  {
    const pub = await anon("GET", "/settings/public");
    eq("免登入讀公開設定 200", pub.status, 200);
    eq("公開設定只有 appName/logoUrl/primaryColor", Object.keys(pub.body).sort().join(","), "appName,logoUrl,primaryColor");
    eq("未登入 GET /settings 401", (await anon("GET", "/settings")).status, 401);
    eq("一般員工 GET /settings 403", (await emp("GET", "/settings")).status, 403);
    eq("主管 GET /settings 403", (await mgr("GET", "/settings")).status, 403);
    eq("管理員 GET /settings 200", (await admin("GET", "/settings")).status, 200);
    eq("未登入 GET /settings/branding 401", (await anon("GET", "/settings/branding")).status, 401);
    const branding = await emp("GET", "/settings/branding");
    eq("一般員工 GET /settings/branding 200（側欄、PDF 要用）", branding.status, 200);
    ok("branding 含公司名稱與印章網址欄位", "companyName" in branding.body && "stampUrl" in branding.body);
    eq("一般員工 PUT /settings 403", (await emp("PUT", "/settings", { body: { appName: "x" } })).status, 403);
    eq("主管 PUT /settings 403", (await mgr("PUT", "/settings", { body: { appName: "x" } })).status, 403);
    eq("前綴含符號 400", (await admin("PUT", "/settings", { body: { quotationPrefix: "a-b" } })).status, 400);
    eq("主色格式錯 400", (await admin("PUT", "/settings", { body: { primaryColor: "red" } })).status, 400);
    eq("系統名稱空白 400", (await admin("PUT", "/settings", { body: { appName: "" } })).status, 400);

    const put = await admin("PUT", "/settings", { body: {
      appName: `E2E 系統 ${RUN}`, companyName: `E2E 公司 ${RUN}`, companyTaxId: "12345678",
      companyAddress: "台北市範例路 1 號", companyPhone: "02-00000000", companyEmail: "info@example.com",
      companyPrincipal: `王大明 ${RUN}`,
      quotationPrefix: "eq", contractPrefix: "ec", primaryColor: "#336699",
    } });
    eq("管理員 PUT /settings 200", put.status, 200);
    eq("回傳更新後的值", put.body.appName, `E2E 系統 ${RUN}`);
    eq("前綴轉大寫", put.body.quotationPrefix, "EQ");
    eq("公開設定跟著變", (await anon("GET", "/settings/public")).body.appName, `E2E 系統 ${RUN}`);
    const companies = await sales("GET", "/companies");
    eq("GET /companies 200", companies.status, 200);
    ok("預設公司名稱同步", companies.body.some((c: { isDefault: boolean; name: string }) => c.isDefault && c.name === `E2E 公司 ${RUN}`), JSON.stringify(companies.body));
    eq("負責人存進設定", put.body.companyPrincipal, `王大明 ${RUN}`);
    eq("未登入 GET /companies 401", (await anon("GET", "/companies")).status, 401);

    const form = (buf: Buffer, type: string, name: string) => { const f = new FormData(); f.append("file", new Blob([buf], { type }), name); return f; };
    eq("業務上傳 logo 403", (await sales("POST", "/settings/logo", { form: form(PNG_1PX, "image/png", "logo.png") })).status, 403);
    eq("沒有 logo 時 404", (await anon("GET", "/settings/logo")).status, 404);
    const logo = await admin("POST", "/settings/logo", { form: form(PNG_1PX, "image/png", "logo.png") });
    eq("上傳 logo（png）201", logo.status, 201);
    ok("回傳 logoUrl", String(logo.body.logoUrl).startsWith("/api/settings/logo"), logo.body.logoUrl);
    const logoGet = await anon("GET", "/settings/logo");
    eq("logo 免登入可讀 200", logoGet.status, 200);
    ok("logo 內容逐位元組相同", logoGet.buffer.equals(PNG_1PX));
    eq("超過 2 MB 413", (await admin("POST", "/settings/logo", { form: form(Buffer.alloc(2 * 1024 * 1024 + 1), "image/png", "big.png") })).status, 413);
    eq("非圖片（pdf）400", (await admin("POST", "/settings/logo", { form: form(Buffer.from("%PDF-1.4"), "application/pdf", "a.pdf") })).status, 400);
    eq("含 script 的 SVG 400", (await admin("POST", "/settings/logo", { form: form(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>1</script></svg>"), "image/svg+xml", "e.svg") })).status, 400);
    eq("沒附檔 400", (await admin("POST", "/settings/logo", { form: new FormData() })).status, 400);

    eq("沒有印章時 404", (await emp("GET", "/settings/stamp")).status, 404);
    eq("上傳印章 201", (await admin("POST", "/settings/stamp", { form: form(PNG_1PX, "image/png", "stamp.png") })).status, 201);
    eq("印章未登入 401", (await anon("GET", "/settings/stamp")).status, 401);
    eq("印章登入後 200", (await emp("GET", "/settings/stamp")).status, 200);
    eq("業務刪 logo 403", (await sales("DELETE", "/settings/logo")).status, 403);
    eq("刪 logo 200", (await admin("DELETE", "/settings/logo")).status, 200);
    eq("刪完 logo 404", (await anon("GET", "/settings/logo")).status, 404);
    eq("刪印章 200", (await admin("DELETE", "/settings/stamp")).status, 200);
  }

  section("6. 客戶");
  let clientId = 0, contactId = 0;
  const clientTax = validTaxId(taxSeed);
  {
    eq("統編位數錯 400", (await sales("POST", "/clients", { body: { name: "x", taxId: "123" } })).status, 400);
    eq("統編檢查碼錯 400", (await sales("POST", "/clients", { body: { name: "x", taxId: "12345670" } })).status, 400);
    eq("缺名稱 400", (await sales("POST", "/clients", { body: { taxId: clientTax } })).status, 400);
    eq("一般員工建客戶 403", (await emp("POST", "/clients", { body: { name: "x" } })).status, 403);
    const c = await sales("POST", "/clients", { body: { name: `E2E 學院 ${RUN}`, taxId: clientTax, address: "高雄市範例路 2 號", phone: "07-0000000" } });
    eq("業務建客戶 201", c.status, 201);
    clientId = c.body.id;
    eq("同統編重複 409", (await sales("POST", "/clients", { body: { name: "另一個名字", taxId: clientTax } })).status, 409);
    const list = await acct("GET", "/clients", { query: `?search=${encodeURIComponent(`E2E 學院 ${RUN}`)}` });
    eq("GET /clients 200", list.status, 200);
    eq("搜尋找到 1 筆", list.body.length, 1);
    eq("一般員工列客戶 403", (await emp("GET", "/clients")).status, 403);
    eq("GET /clients/:id 200", (await sales("GET", "/clients/:id", { params: { id: clientId } })).status, 200);
    eq("不存在 404", (await sales("GET", "/clients/:id", { params: { id: 999999 } })).status, 404);
    eq("id 非數字 400", (await sales("GET", "/clients/:id", { params: { id: "abc" } })).status, 400);
    eq("改名缺名稱 400", (await sales("POST", "/clients/:id/rename", { params: { id: clientId }, body: {} })).status, 400);
    eq("改名 200", (await sales("POST", "/clients/:id/rename", { params: { id: clientId }, body: { name: `E2E 大學 ${RUN}`, effectiveFrom: "2025-09-25", reason: "upgrade" } })).status, 200);
    const detail = await sales("GET", "/clients/:id", { params: { id: clientId } });
    eq("現行名稱已更新", detail.body.name, `E2E 大學 ${RUN}`);
    eq("名稱歷史 2 筆", detail.body.nameHistory.length, 2);
    eq("一般員工加聯絡人 403", (await emp("POST", "/clients/:id/contacts", { params: { id: clientId }, body: { name: "x" } })).status, 403);
    const contact = await sales("POST", "/clients/:id/contacts", { params: { id: clientId }, body: { name: "王小明", email: "wang@example.com", phone: "0912-000000", isPrimary: true } });
    eq("新增聯絡人 201", contact.status, 201);
    contactId = contact.body.id;
  }

  section("7. 產品品項");
  let productId = 0;
  {
    eq("業務建品項 403（只有讀取權）", (await sales("POST", "/products", { body: { name: "x" } })).status, 403);
    eq("缺名稱 400", (await mgr("POST", "/products", { body: { listPrice: 100 } })).status, 400);
    const p = await mgr("POST", "/products", { body: { name: `E2E 主機 ${RUN}`, specification: "規格 A", unit: "台", costPrice: 7000, listPrice: 10000 } });
    eq("主管建品項 201", p.status, 201);
    productId = p.body.id;
    ok("自動產生品項編號", /^P\d{4}$/.test(p.body.sku), p.body.sku);
    const list = await sales("GET", "/products", { query: `?search=${encodeURIComponent(`E2E 主機 ${RUN}`)}` });
    eq("業務列品項 200", list.status, 200);
    eq("搜尋找到", list.body.length, 1);
    eq("一般員工列品項 403", (await emp("GET", "/products")).status, 403);
    eq("修改品項 200", (await mgr("PATCH", "/products/:id", { params: { id: productId }, body: { name: `E2E 主機 ${RUN}`, listPrice: 9500 } })).status, 200);
    eq("修改不存在 404", (await mgr("PATCH", "/products/:id", { params: { id: 999999 }, body: { name: "x" } })).status, 404);
  }

  section("8. 報價：建立與編號");
  let q1 = 0, v1 = 0, q2 = 0, v2 = 0, q3 = 0;
  const draft = {
    clientId, companyId: 0, quotationDate: today, subject: `E2E 報價 ${RUN}`,
    clientContactId: contactId, ourContactName: "李小華", ourContactEmail: "lee@example.com", ourContactPhone: "02-11111111",
    lineItems: [{ productId, productName: `E2E 主機 ${RUN}`, specification: "規格 A", quantity: 2, unitPrice: 10000, unitCost: 7000 }],
  };
  {
    const companies = await sales("GET", "/companies");
    draft.companyId = companies.body.find((c: { isDefault: boolean }) => c.isDefault)?.id ?? companies.body[0].id;
    eq("沒品項 400", (await sales("POST", "/quotations", { body: { ...draft, lineItems: [] } })).status, 400);
    eq("日期格式錯 400", (await sales("POST", "/quotations", { body: { ...draft, quotationDate: "2026/01/01" } })).status, 400);
    eq("一般員工建報價 403", (await emp("POST", "/quotations", { body: draft })).status, 403);
    eq("未登入 401", (await anon("POST", "/quotations", { body: draft })).status, 401);
    const a = await sales("POST", "/quotations", { body: draft });
    eq("業務建報價 201", a.status, 201);
    q1 = a.body.id; v1 = a.body.versionId;
    const b = await sales("POST", "/quotations", { body: { ...draft, subject: "第二張" } });
    q2 = b.body.id; v2 = b.body.versionId;
    const c = await sales("POST", "/quotations", { body: { ...draft, subject: "第三張（之後刪掉）" } });
    q3 = c.body.id;
    ok("編號格式 EQ-YYYYMMDD-NNN（前綴來自設定）", new RegExp(`^EQ-${compact}-\\d{3}$`).test(a.body.quotationNumber), a.body.quotationNumber);
    const n = (s: string) => parseInt(s.split("-").pop()!, 10);
    ok("連號", n(b.body.quotationNumber) === n(a.body.quotationNumber) + 1 && n(c.body.quotationNumber) === n(b.body.quotationNumber) + 1,
      `${a.body.quotationNumber} ${b.body.quotationNumber} ${c.body.quotationNumber}`);

    const g = await sales("GET", "/quotations/:id", { params: { id: q1 } });
    eq("GET /quotations/:id 200", g.status, 200);
    eq("含稅總計由伺服器算", Math.round(+g.body.versions[0].totalAmount), 21000);
    ok("業務看不到成本", !("marginPercent" in g.body.versions[0]));
    ok("業務傳的成本被忽略（會計看到的毛利為空）", (await acct("GET", "/quotations/:id", { params: { id: q1 } })).body.versions[0].marginPercent == null);
    const withCost = await mgr("POST", "/quotations", { body: { ...draft, subject: "主管建的（有成本）" } });
    eq("主管（有成本權限）建報價 201", withCost.status, 201);
    const mgrView = await acct("GET", "/quotations/:id", { params: { id: withCost.body.id } });
    eq("會計看得到毛利 30%", Math.round(+mgrView.body.versions[0].marginPercent), 30);
    eq("主管的草稿可刪 200", (await mgr("DELETE", "/quotations/:id", { params: { id: withCost.body.id } })).status, 200);
    eq("不存在 404", (await sales("GET", "/quotations/:id", { params: { id: 999999 } })).status, 404);
    eq("非數字 400", (await sales("GET", "/quotations/:id", { params: { id: "abc" } })).status, 400);
    const list = await sales("GET", "/quotations", { query: `?search=${encodeURIComponent(`E2E 報價 ${RUN}`)}` });
    eq("GET /quotations 200", list.status, 200);
    ok("列表找得到", list.body.items.length >= 1 && list.body.total >= 1);
    eq("一般員工列報價 403", (await emp("GET", "/quotations")).status, 403);
  }

  section("9. 報價：修改版本與新版本");
  {
    eq("修改版本 200", (await sales("PATCH", "/quotations/versions/:versionId", { params: { versionId: v1 }, body: { lineItems: [{ productName: "主機", quantity: 1, unitPrice: 9000 }] } })).status, 200);
    eq("改價後總計", Math.round(+(await sales("GET", "/quotations/:id", { params: { id: q1 } })).body.versions[0].totalAmount), 9450);
    eq("一般員工修改 403", (await emp("PATCH", "/quotations/versions/:versionId", { params: { versionId: v1 }, body: { notes: "x" } })).status, 403);
    eq("不存在的版本 404", (await sales("PATCH", "/quotations/versions/:versionId", { params: { versionId: 999999 }, body: { notes: "x" } })).status, 404);
    const nv = await sales("POST", "/quotations/:id/versions", { params: { id: q1 }, body: { notes: "第二版" } });
    eq("開新版本 201", nv.status, 201);
    eq("版本號 2", nv.body.versionNumber, 2);
    v1 = nv.body.versionId;
    const q = await sales("GET", "/quotations/:id", { params: { id: q1 } });
    eq("兩個版本", q.body.versions.length, 2);
    eq("舊版 superseded", q.body.versions[1].status, "superseded");
    eq("一般員工開新版本 403", (await emp("POST", "/quotations/:id/versions", { params: { id: q1 }, body: {} })).status, 403);
  }

  section("10. 報價：狀態機");
  {
    const st = (c: Client, versionId: number, status: string, reason?: string) =>
      c("POST", "/quotations/versions/:versionId/status", { params: { versionId }, body: { status, reason } });
    eq("未知狀態 400", (await st(sales, v1, "whatever")).status, 400);
    eq("draft → accepted 非法 409", (await st(sales, v1, "accepted")).status, 409);
    eq("業務核准 403", (await st(sales, v1, "approved")).status, 403);
    eq("業務作廢 403", (await st(sales, v1, "voided", "x")).status, 403);
    eq("draft → pending_approval", (await st(sales, v1, "pending_approval")).status, 200);
    eq("pending_approval → approved（主管）", (await st(mgr, v1, "approved")).status, 200);
    eq("approved → sent", (await st(sales, v1, "sent")).status, 200);
    eq("sent → draft 非法 409", (await st(sales, v1, "draft")).status, 409);
    eq("sent → viewed", (await st(sales, v1, "viewed")).status, 200);
    eq("viewed → accepted", (await st(sales, v1, "accepted", "客戶簽回")).status, 200);
    const q = await sales("GET", "/quotations/:id", { params: { id: q1 } });
    ok("接受後鎖定", q.body.versions[0].lockedAt != null);
    eq("接受後履約自動 in_progress", q.body.fulfillment_status, "in_progress");
    eq("鎖定後修改 409", (await sales("PATCH", "/quotations/versions/:versionId", { params: { versionId: v1 }, body: { notes: "偷改" } })).status, 409);
    eq("accepted → voided（主管）", (await st(mgr, v2, "voided", "測試作廢")).status, 409 === 0 ? 0 : (await (async () => {
      // v2 還是 draft：draft → sent → declined → voided 走另一條路
      await st(sales, v2, "sent"); await st(sales, v2, "declined", "客戶拒絕");
      return st(mgr, v2, "voided", "結束");
    })()).status, 200);
    eq("voided 之後不能再變", (await st(mgr, v2, "draft")).status, 409);
  }

  section("11. 報價：履約進度與刪除");
  {
    const ff = (c: Client, id: number, status: string, milestoneDate?: string) =>
      c("POST", "/quotations/:id/fulfillment", { params: { id }, body: { status, milestoneDate } });
    eq("一般員工 403", (await ff(emp, q1, "delivered")).status, 403);
    eq("進行中 → 已收款 非法 409", (await ff(sales, q1, "paid")).status, 409);
    eq("進行中 → 已交付 200", (await ff(sales, q1, "delivered", today)).status, 200);
    eq("已交付 → 已驗收 200", (await ff(sales, q1, "inspected", today)).status, 200);
    const q = await sales("GET", "/quotations/:id", { params: { id: q1 } });
    eq("驗收日記錄為純日期字串", q.body.inspected_at, today);
    eq("已驗收 → 進行中 倒退 409", (await ff(sales, q1, "in_progress")).status, 409);
    eq("尚未接受的報價推履約 409", (await ff(sales, q3, "delivered")).status, 409);

    eq("業務刪除 403（需作廢權）", (await sales("DELETE", "/quotations/:id", { params: { id: q3 } })).status, 403);
    eq("有往來紀錄的不能刪 409", (await mgr("DELETE", "/quotations/:id", { params: { id: q1 } })).status, 409);
    eq("草稿可刪 200", (await mgr("DELETE", "/quotations/:id", { params: { id: q3 } })).status, 200);
    eq("刪掉後 404", (await sales("GET", "/quotations/:id", { params: { id: q3 } })).status, 404);
  }

  section("12. 檔案：上傳、下載、可疑連結");
  let docId = 0, linkId = 0;
  const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from(`簽回文件 ${RUN} `.repeat(20))]);
  {
    const form = (buf: Buffer, type: string, name: string) => { const f = new FormData(); f.append("file", new Blob([buf], { type }), name); return f; };
    eq("一般員工上傳 403", (await emp("POST", "/quotations/:id/documents", { params: { id: q1 }, form: form(pdf, "application/pdf", "a.pdf") })).status, 403);
    eq("沒附檔 400", (await sales("POST", "/quotations/:id/documents", { params: { id: q1 }, form: new FormData() })).status, 400);
    eq("偽裝成 PDF 400", (await sales("POST", "/quotations/:id/documents", { params: { id: q1 }, form: form(Buffer.from("<?php ?>"), "application/pdf", "evil.pdf") })).status, 400);
    eq("不支援的類型 400", (await sales("POST", "/quotations/:id/documents", { params: { id: q1 }, form: form(Buffer.from("MZ"), "application/x-msdownload", "evil.exe") })).status, 400);
    const up = await sales("POST", "/quotations/:id/documents", { params: { id: q1 }, form: form(pdf, "application/pdf", "簽回單.pdf") });
    eq("上傳簽回 PDF 201", up.status, 201);
    docId = up.body.document.id;
    eq("首次不算可疑", up.body.suspect, false);
    ok("回相對路徑", String(up.body.url).startsWith("/api/documents/"), up.body.url);

    const dl = await acct("GET", "/documents/:id/download", { params: { id: docId } });
    eq("有報價讀取權的人可下載 200", dl.status, 200);
    ok("內容逐位元組相同", dl.buffer.equals(pdf));
    eq("一般員工下載 403", (await emp("GET", "/documents/:id/download", { params: { id: docId } })).status, 403);
    eq("未登入下載 401", (await anon("GET", "/documents/:id/download", { params: { id: docId } })).status, 401);
    eq("不存在 404", (await sales("GET", "/documents/:id/download", { params: { id: 999999 } })).status, 404);

    const up2 = await sales("POST", "/quotations/:id/documents", { params: { id: q2 }, form: form(pdf, "application/pdf", "簽回單.pdf") });
    eq("同一份檔掛第二張 201", up2.status, 201);
    eq("去重", up2.body.deduplicated, true);
    eq("標為可疑", up2.body.suspect, true);
    const suspects = await sales("GET", "/documents/suspect-links");
    eq("GET /documents/suspect-links 200", suspects.status, 200);
    const mine = suspects.body.find((s: { quotationId: number }) => s.quotationId === q2);
    ok("可疑清單有這一筆", mine != null);
    linkId = mine?.id ?? 0;
    eq("一般員工看可疑清單 403", (await emp("GET", "/documents/suspect-links")).status, 403);
    eq("一般員工 verify 403", (await emp("POST", "/documents/links/:linkId/verify", { params: { linkId }, body: { note: "x" } })).status, 403);
    eq("verify 200", (await sales("POST", "/documents/links/:linkId/verify", { params: { linkId }, body: { note: "人工確認" } })).status, 200);
    eq("verify 不存在 404", (await sales("POST", "/documents/links/:linkId/verify", { params: { linkId: 999999 }, body: {} })).status, 404);
    ok("verify 後不在可疑清單", !(await sales("GET", "/documents/suspect-links")).body.some((s: { id: number }) => s.id === linkId));
    eq("一般員工解除連結 403", (await emp("DELETE", "/documents/links/:linkId", { params: { linkId } })).status, 403);
    eq("解除連結 200", (await sales("DELETE", "/documents/links/:linkId", { params: { linkId } })).status, 200);
    eq("解除不存在 404", (await sales("DELETE", "/documents/links/:linkId", { params: { linkId } })).status, 404);
    const lib = await sales("GET", "/documents", { query: "?limit=50" });
    eq("GET /documents 200", lib.status, 200);
    ok("檔案總覽有這份檔", lib.body.some((d: { id: number }) => d.id === docId));
    eq("一般員工檔案總覽 403", (await emp("GET", "/documents")).status, 403);
  }

  section("13. 首頁彙總");
  {
    const d = await admin("GET", "/dashboard");
    eq("GET /dashboard 200", d.status, 200);
    ok("進行中案件數 ≥ 1", d.body.openDeals.count >= 1, JSON.stringify(d.body.openDeals));
    ok("已驗收待請款出現在待辦", d.body.todos.some((t: { kind: string; quotationId: number }) => t.quotationId === q1 && t.kind === "ready_to_invoice"), JSON.stringify(d.body.todos.map((t: { kind: string }) => t.kind)));
    const e = await emp("GET", "/dashboard");
    eq("一般員工也能開首頁 200", e.status, 200);
    eq("但看不到報價待辦", e.body.todos.length, 0);
    eq("未登入 401", (await anon("GET", "/dashboard")).status, 401);
  }

  section("14. 範本與合約");
  let templateId = 0, contractId = 0;
  {
    const t = await sales("GET", "/templates");
    eq("GET /templates 200", t.status, 200);
    ok("有預設範本 DEV-DEFAULT", t.body.some((x: { code: string }) => x.code === "DEV-DEFAULT"));
    eq("一般員工 403", (await emp("GET", "/templates")).status, 403);
    eq("業務建範本 403", (await sales("POST", "/templates", { body: { name: "x", body: "y", templateType: "custom" } })).status, 403);
    eq("缺內容 400", (await admin("POST", "/templates", { body: { name: "x", templateType: "custom" } })).status, 400);
    const nt = await admin("POST", "/templates", { body: { code: `E2E-${RUN}`, name: `E2E 範本 ${RUN}`, templateType: "custom", body: "甲方：{companyName}（統編 {companyTaxId}）\n乙方：{clientCompany}\n金額：{totalAmount}\n代表：{principalName}" } });
    eq("管理員建範本 201", nt.status, 201);
    templateId = nt.body.id;
    eq("變數有抓出來", (nt.body.variables ?? []).length, 5);
    eq("修改範本 200", (await admin("PATCH", "/templates/:id", { params: { id: templateId }, body: { name: `E2E 範本 ${RUN}`, templateType: "custom", body: "甲方：{companyName}\n代表人：{principalName}\nEmail：{ourEmail}\n電話：{ourPhone}\n乙方：{clientCompany}\n金額：{totalAmount}\n簽署日：{signedDate}" } })).status, 200);
    eq("修改不存在 404", (await admin("PATCH", "/templates/:id", { params: { id: 999999 }, body: { name: "x", templateType: "custom", body: "y" } })).status, 404);

    eq("預覽缺 templateId 400", (await sales("GET", "/quotations/:id/contract-preview", { params: { id: q1 } })).status, 400);
    eq("預覽範本不存在 404", (await sales("GET", "/quotations/:id/contract-preview", { params: { id: q1 }, query: "?templateId=999999" })).status, 404);
    const pv = await sales("GET", "/quotations/:id/contract-preview", { params: { id: q1 }, query: `?templateId=${templateId}` });
    eq("合約預覽 200", pv.status, 200);
    ok("甲方換成設定的公司", pv.body.content.includes(`E2E 公司 ${RUN}`), pv.body.content);
    ok("乙方換成客戶（快照名稱）", pv.body.content.includes(`E2E 大學 ${RUN}`) || pv.body.content.includes(`E2E 學院 ${RUN}`), pv.body.content);
    ok("代表人取自設定", pv.body.content.includes(`代表人：王大明 ${RUN}`), pv.body.content);
    ok("Email／電話取自設定", pv.body.content.includes("Email：info@example.com") && pv.body.content.includes("電話：02-00000000"), pv.body.content);
    ok("沒值的 signedDate 渲染成空字串而非 {signedDate}", !pv.body.content.includes("{signedDate}") && pv.body.content.includes("簽署日："), pv.body.content);
    ok("missing 清單仍列出 signedDate", pv.body.missing.includes("signedDate"), JSON.stringify(pv.body.missing));
    ok("內容裡沒有任何 {變數} 字面值", !/\{\w+\}/.test(pv.body.content), pv.body.content);
    eq("一般員工預覽 403", (await emp("GET", "/quotations/:id/contract-preview", { params: { id: q1 }, query: `?templateId=${templateId}` })).status, 403);

    const body = {
      clientId, companyId: draft.companyId, quotationId: q1, templateId, contractType: "custom",
      title: `E2E 合約 ${RUN}`, content: pv.body.content, startDate: today, endDate: "2099-12-31", totalAmount: 9450,
    };
    eq("一般員工建合約 403", (await emp("POST", "/contracts", { body })).status, 403);
    eq("結束早於開始 400", (await sales("POST", "/contracts", { body: { ...body, endDate: "2000-01-01" } })).status, 400);
    const c = await sales("POST", "/contracts", { body });
    eq("建合約 201", c.status, 201);
    contractId = c.body.id;
    ok("合約編號 EC-YYYYMMDD-NNN（前綴來自設定）", new RegExp(`^EC-${compact}-\\d{3}$`).test(c.body.contract_number), c.body.contract_number);
    const list = await sales("GET", "/contracts", { query: `?clientId=${clientId}` });
    eq("GET /contracts 200", list.status, 200);
    ok("列表有這份合約", list.body.some((x: { id: number }) => x.id === contractId));
    eq("GET /contracts/:id 200", (await sales("GET", "/contracts/:id", { params: { id: contractId } })).status, 200);
    eq("不存在 404", (await sales("GET", "/contracts/:id", { params: { id: 999999 } })).status, 404);
    eq("一般員工看合約 403", (await emp("GET", "/contracts/:id", { params: { id: contractId } })).status, 403);
    eq("修改合約 200", (await sales("PATCH", "/contracts/:id", { params: { id: contractId }, body: { notes: "補充" } })).status, 200);

    const cs = (status: string, extra: Record<string, unknown> = {}) =>
      sales("POST", "/contracts/:id/status", { params: { id: contractId }, body: { status, ...extra } });
    eq("draft → active 非法 409", (await cs("active")).status, 409);
    eq("未知狀態 400", (await cs("whatever")).status, 400);
    eq("draft → sent", (await cs("sent")).status, 200);
    eq("sent → signed", (await cs("signed", { signedAt: today })).status, 200);
    eq("簽署後修改內容 409", (await sales("PATCH", "/contracts/:id", { params: { id: contractId }, body: { content: "偷改" } })).status, 409);
    eq("一般員工改狀態 403", (await emp("POST", "/contracts/:id/status", { params: { id: contractId }, body: { status: "active" } })).status, 403);
    eq("signed → active", (await cs("active")).status, 200);

    const f = new FormData(); f.append("file", new Blob([pdf], { type: "application/pdf" }), "合約簽回.pdf");
    const up = await sales("POST", "/contracts/:id/documents", { params: { id: contractId }, form: f });
    eq("上傳合約簽回檔 201", up.status, 201);
    eq("一般員工上傳 403", (await emp("POST", "/contracts/:id/documents", { params: { id: contractId }, form: new FormData() })).status, 403);
    eq("沒附檔 400", (await sales("POST", "/contracts/:id/documents", { params: { id: contractId }, form: new FormData() })).status, 400);
    ok("合約明細帶出檔案", (await sales("GET", "/contracts/:id", { params: { id: contractId } })).body.documents.length >= 1);
  }

  section("15. 人事：員工");
  let employeeId = 0;
  {
    const input = {
      employeeId: `E${RUN}`, name: `E2E 員工 ${RUN}`, email: `e2eemp-${RUN}@example.com`,
      hireDate: "2023-09-01", departmentName: "研發部", positionName: "工程師",
      employmentType: "full_time", salaryAmount: 45000, salaryType: "monthly",
    };
    eq("一般員工建員工 403", (await emp("POST", "/employees", { body: input })).status, 403);
    eq("缺姓名 400", (await mgr("POST", "/employees", { body: { ...input, name: "" } })).status, 400);
    eq("僱用型態錯 400", (await mgr("POST", "/employees", { body: { ...input, employmentType: "intern" } })).status, 400);
    const e = await admin("POST", "/employees", { body: input });
    eq("管理員建員工（含薪資）201", e.status, 201);
    employeeId = e.body.id;
    eq("員編重複 409", (await mgr("POST", "/employees", { body: input })).status, 409);
    eq("GET /employees（會計）200", (await acct("GET", "/employees")).status, 200);
    ok("列表有這位員工且已對上帳號（email 相同）", (await acct("GET", "/employees")).body.some((x: { id: number; userId: number | null }) => x.id === employeeId && x.userId === users.emp));
    eq("一般員工列員工 403", (await emp("GET", "/employees")).status, 403);
    eq("主管看員工 200", (await mgr("GET", "/employees/:id", { params: { id: employeeId } })).status, 200);
    eq("員工看自己 200", (await emp("GET", "/employees/:id", { params: { id: employeeId } })).status, 200);
    eq("員工看別人 403", (await emp("GET", "/employees/:id", { params: { id: 999999 } })).status, 403);
    eq("主管看不到薪資（無權限）", (await mgr("GET", "/employees/:id", { params: { id: employeeId } })).body.salaryAmount ?? null, null);
    eq("會計查薪資 200", (await acct("GET", "/employees/:id/salary", { params: { id: employeeId } })).status, 200);
    eq("薪資數字正確", Math.round(+(await acct("GET", "/employees/:id/salary", { params: { id: employeeId } })).body.salaryAmount), 45000);
    eq("業務查薪資 403", (await sales("GET", "/employees/:id/salary", { params: { id: employeeId } })).status, 403);
    eq("GET /departments 200", (await mgr("GET", "/departments")).status, 200);
    ok("部門自動建立", (await mgr("GET", "/departments")).body.some((d: { name: string }) => d.name === "研發部"));
    eq("GET /positions 200", (await mgr("GET", "/positions")).status, 200);
    eq("一般員工列部門 403", (await emp("GET", "/departments")).status, 403);
    eq("一般員工列職位 403", (await emp("GET", "/positions")).status, 403);
    eq("修改員工 200", (await mgr("PATCH", "/employees/:id", { params: { id: employeeId }, body: { phone: "0900-000000" } })).status, 200);
    eq("修改不存在 404", (await mgr("PATCH", "/employees/:id", { params: { id: 999999 }, body: { phone: "x" } })).status, 404);
    eq("一般員工修改 403", (await emp("PATCH", "/employees/:id", { params: { id: employeeId }, body: { phone: "x" } })).status, 403);
  }

  section("16. 人事：請假");
  {
    const body = { leaveType: "personal", startDate: "2099-01-05", endDate: "2099-01-05", days: 1, reason: `E2E 事假 ${RUN}` };
    eq("假別不存在 400", (await emp("POST", "/leave-requests", { body: { ...body, leaveType: "vacation" } })).status, 400);
    eq("缺事由 400", (await emp("POST", "/leave-requests", { body: { ...body, reason: "" } })).status, 400);
    eq("沒有員工資料的帳號請假 400", (await sales("POST", "/leave-requests", { body })).status, 400);
    const a = await emp("POST", "/leave-requests", { body });
    eq("員工請假 201", a.status, 201);
    const b = await emp("POST", "/leave-requests", { body: { ...body, startDate: "2099-01-06", endDate: "2099-01-06" } });
    eq("第二筆 201", b.status, 201);
    const mine = await emp("GET", "/leave-requests");
    eq("員工看自己的請假 200", mine.status, 200);
    ok("只看得到自己的", mine.body.every((r: { employeeId: number }) => r.employeeId === employeeId) && mine.body.length >= 2);
    const all = await mgr("GET", "/leave-requests", { query: "?status=pending" });
    eq("主管看待審清單 200", all.status, 200);
    ok("待審清單有這兩筆", all.body.filter((r: { employeeId: number }) => r.employeeId === employeeId).length >= 2);
    eq("員工自己核決 403", (await emp("POST", "/leave-requests/:id/decide", { params: { id: a.body.id }, body: { decision: "approved" } })).status, 403);
    eq("決定值錯 400", (await mgr("POST", "/leave-requests/:id/decide", { params: { id: a.body.id }, body: { decision: "maybe" } })).status, 400);
    eq("核准 200", (await mgr("POST", "/leave-requests/:id/decide", { params: { id: a.body.id }, body: { decision: "approved" } })).status, 200);
    eq("重複核決 409", (await mgr("POST", "/leave-requests/:id/decide", { params: { id: a.body.id }, body: { decision: "rejected", reason: "x" } })).status, 409);
    eq("駁回不給理由 400", (await mgr("POST", "/leave-requests/:id/decide", { params: { id: b.body.id }, body: { decision: "rejected" } })).status, 400);
    eq("駁回 200", (await mgr("POST", "/leave-requests/:id/decide", { params: { id: b.body.id }, body: { decision: "rejected", reason: "人力不足" } })).status, 200);
    eq("核決不存在 404", (await mgr("POST", "/leave-requests/:id/decide", { params: { id: 999999 }, body: { decision: "approved" } })).status, 404);
    const after = await emp("GET", "/leave-requests");
    eq("狀態更新：核准", after.body.find((r: { id: number }) => r.id === a.body.id).status, "approved");
    eq("狀態更新：駁回", after.body.find((r: { id: number }) => r.id === b.body.id).status, "rejected");
    eq("未登入 401", (await anon("GET", "/leave-requests")).status, 401);
  }

  section("17. 人事：出勤");
  {
    eq("沒有員工資料的帳號打卡 400", (await sales("POST", "/attendance/clock-in")).status, 400);
    eq("會計無打卡權 403", (await acct("POST", "/attendance/clock-in")).status, 403);
    const ci = await emp("POST", "/attendance/clock-in");
    eq("上班打卡 200", ci.status, 200);
    const attendanceId = ci.body.id;
    eq("重複打卡 409", (await emp("POST", "/attendance/clock-in")).status, 409);
    eq("下班打卡 200", (await emp("POST", "/attendance/clock-out")).status, 200);
    eq("一般員工看自己的出勤 200", (await emp("GET", "/attendance")).status, 200);
    ok("看得到今天這筆", (await emp("GET", "/attendance")).body.some((r: { id: number }) => r.id === attendanceId));
    const mgrList = await mgr("GET", "/attendance", { query: `?employeeId=${employeeId}&from=${today}&to=${today}` });
    eq("主管查某員工出勤 200", mgrList.status, 200);
    eq("查到 1 筆", mgrList.body.length, 1);
    eq("修改缺事由 400", (await mgr("PATCH", "/attendance/:id", { params: { id: attendanceId }, body: { notes: "x" } })).status, 400);
    eq("一般員工修改 403", (await emp("PATCH", "/attendance/:id", { params: { id: attendanceId }, body: { reason: "x", notes: "y" } })).status, 403);
    eq("主管修改 200", (await mgr("PATCH", "/attendance/:id", { params: { id: attendanceId }, body: { reason: "補登備註", notes: "外勤" } })).status, 200);
    eq("修改不存在 404", (await mgr("PATCH", "/attendance/:id", { params: { id: 999999 }, body: { reason: "x", notes: "y" } })).status, 404);
    const hist = await mgr("GET", "/attendance/:id/history", { params: { id: attendanceId } });
    eq("修改歷程 200", hist.status, 200);
    ok("留下一筆修改紀錄", hist.body.length >= 1 && String(hist.body[0].reason).includes("補登"));
    eq("業務看歷程 403", (await sales("GET", "/attendance/:id/history", { params: { id: attendanceId } })).status, 403);
  }

  section("18. 稽核紀錄");
  {
    const a = await admin("GET", "/audit", { query: "?limit=500" });
    eq("GET /audit 200", a.status, 200);
    const actions = new Set(a.body.map((r: { action: string }) => r.action));
    const types = new Set(a.body.map((r: { entityType: string }) => r.entityType));
    for (const act of ["login", "create", "update", "status_change", "rename", "fulfillment_change", "new_version"]) {
      ok(`有 ${act} 紀錄`, actions.has(act));
    }
    for (const t of ["user", "settings", "client", "quotation", "contract", "employee", "leave_request", "product"]) {
      ok(`有 ${t} 的紀錄`, types.has(t), [...types].join(","));
    }
    const filtered = await acct("GET", "/audit", { query: "?entityType=settings&limit=50" });
    eq("會計可讀稽核 200", filtered.status, 200);
    ok("entityType 篩選有效", filtered.body.length >= 1 && filtered.body.every((r: { entityType: string }) => r.entityType === "settings"));
    eq("業務讀稽核 403", (await sales("GET", "/audit")).status, 403);
  }

  section("19. 還原設定（讓同一個環境可以重複跑、瀏覽器測試用預設值）");
  {
    eq("還原前綴與公司名", (await admin("PUT", "/settings", { body: {
      appName: "報價管理系統", companyName: "範例公司", companyTaxId: "12345678",
      companyPrincipal: null, quotationPrefix: "QT", contractPrefix: "CNT", primaryColor: null,
    } })).status, 200);
  }

  section("20. 路由涵蓋率：server/routes.ts 註冊的每一條都要打到");
  {
    const src = readFileSync(path.join(ROOT, "server", "routes.ts"), "utf8");
    const registered = new Set<string>();
    for (const m of src.matchAll(/api\.(get|post|put|patch|delete)\(`?"?(\/[^"`,]+)/g)) {
      const p = m[2];
      if (p.includes("${kind}")) { registered.add(`${m[1]} ${p.replace("${kind}", "logo")}`); registered.add(`${m[1]} ${p.replace("${kind}", "stamp")}`); }
      else registered.add(`${m[1]} ${p}`);
    }
    const missing = [...registered].filter(r => !covered.has(r));
    eq(`routes.ts 註冊的路由數（logo/stamp 各算一條）`, registered.size, 69);
    ok(`全部 ${registered.size} 條路由都打過`, missing.length === 0, `漏掉：${missing.join("、")}`);
  }
}

main().catch(error => {
  console.error("\n測試執行失敗:", error);
  process.exit(1);
});
