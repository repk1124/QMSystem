/**
 * API 端對端測試。
 * 用真的 HTTP 請求打真的伺服器，包含登入、權限邊界、檔案上傳。
 */
import express from "express";
import type { Server } from "node:http";
import { pool } from "../server/db";
import { registerRoutes } from "../server/routes";
import { hashPassword, resetLockouts } from "../server/auth";
import { seedDefaults } from "../server/seed";
import { getSettings } from "../server/repositories/settings";

const PORT = 5188;
const BASE = `http://127.0.0.1:${PORT}/api`;

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${extra}`); fail++; }
};
const eq = (name: string, actual: unknown, expected: unknown) =>
  ok(name, String(actual) === String(expected), `期望 ${expected}，實得 ${actual}`);

/** 帶 cookie 的簡易 client */
function makeClient() {
  let cookie = "";
  return async function call(method: string, path: string, body?: unknown, isForm = false) {
    const headers: Record<string, string> = {};
    if (cookie) headers.cookie = cookie;
    let payload: string | FormData | undefined;
    if (isForm) payload = body as FormData;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    // 用 arrayBuffer 而不是 text()：回應可能是二進位（PDF），
    // 而且要比對「位元組數」而不是「字串長度」——中文一個字是 3 個 byte，
    // 拿 string.length 去比 Buffer.length 一定對不起來。
    const buffer = Buffer.from(await res.arrayBuffer());
    const text = buffer.toString("utf8");
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { /* 二進位回應 */ }
    return {
      status: res.status,
      body: (json ?? {}) as Record<string, any>,
      raw: text, buffer, bytes: buffer.length,
    };
  };
}

async function seedUser(username: string, role: string, password: string) {
  await pool.query(
    `INSERT INTO users (username, password, email, display_name, role, must_change_password, is_active)
     VALUES ($1,$2,$3,$4,$5,false,true)
     ON CONFLICT (username) DO UPDATE SET password=EXCLUDED.password, role=EXCLUDED.role`,
    [username, await hashPassword(password), `${username}@example.com`, username, role],
  );
}

async function main() {
  const app = express();
  await seedDefaults();
  await registerRoutes(app);
  const server: Server = await new Promise(resolve => {
    const s = app.listen(PORT, "127.0.0.1", () => resolve(s));
  });

  try {
    await seedUser("boss", "admin", "BossPassword123");
    await seedUser("sales1", "sales", "SalesPassword123");
    await seedUser("acct", "accounting", "AcctPassword123");
    resetLockouts();

    const anon = makeClient();
    const boss = makeClient();
    const sales = makeClient();
    const acct = makeClient();

    console.log("\n── 1. 未登入一律擋下 ──");
    for (const [m, p] of [["GET", "/quotations"], ["POST", "/quotations"],
                          ["GET", "/clients"], ["GET", "/audit"]] as const) {
      const r = await anon(m, p, m === "POST" ? {} : undefined);
      eq(`${m} ${p}`, r.status, 401);
    }

    console.log("\n── 2. 登入 ──");
    eq("錯誤密碼", (await boss("POST", "/auth/login", { username: "boss", password: "wrong" })).status, 401);
    const login = await boss("POST", "/auth/login", { username: "boss", password: "BossPassword123" });
    eq("正確密碼", login.status, 200);
    ok("回傳權限清單", Array.isArray(login.body.user.permissions) && login.body.user.permissions.length > 0);
    eq("admin 角色", login.body.user.role, "admin");

    await sales("POST", "/auth/login", { username: "sales1", password: "SalesPassword123" });
    await acct("POST", "/auth/login", { username: "acct", password: "AcctPassword123" });
    eq("業務登入後可查身分", (await sales("GET", "/auth/me")).status, 200);

    console.log("\n── 3. 統編驗證與客戶重複偵測 ──");
    {
      const bad = await boss("POST", "/clients", { name: "測試", taxId: "1234" });
      eq("統編位數不對被擋", bad.status, 400);

      const badCheck = await boss("POST", "/clients", { name: "測試", taxId: "12345670" });
      eq("統編檢查碼不對被擋", badCheck.status, 400);

      const created = await boss("POST", "/clients", { name: "測試學院", taxId: "10000021" });
      eq("建立客戶", created.status, 201);
      const clientId = created.body.id;

      const dup = await boss("POST", "/clients", { name: "測試大學", taxId: "10000021" });
      eq("同統編重複建立被擋", dup.status, 409);
      ok("錯誤訊息指出已存在的客戶", String(dup.body.message).includes("測試學院"), dup.body.message);

      console.log("\n── 4. 客戶更名保留時間軸 ──");
      const renamed = await boss("POST", `/clients/${clientId}/rename`, {
        name: "測試大學", effectiveFrom: "2025-09-25", reason: "upgrade",
      });
      eq("更名成功", renamed.status, 200);
      const detail = await boss("GET", `/clients/${clientId}`);
      eq("現行名稱", detail.body.name, "測試大學");
      eq("名稱歷史 2 筆", detail.body.nameHistory.length, 2);
      const old = detail.body.nameHistory.find((h: { name: string }) => h.name === "測試學院");
      eq("舊名稱有結束日", old.validUntil, "2025-09-25");
      ok("舊名稱進入別名可搜尋", detail.body.aliases.includes("測試學院"));

      const search = await boss("GET", "/clients?search=" + encodeURIComponent("測試學院"));
      eq("用舊名稱仍搜尋得到", search.body.length, 1);

      console.log("\n── 5. 建立報價 ──");
      const contact = await boss("POST", `/clients/${clientId}/contacts`, {
        name: "王小明", email: "wang@example.com", isPrimary: true,
      });
      eq("新增聯絡人", contact.status, 201);

      const company = await pool.query(
        `INSERT INTO companies (name, tax_id, is_default) VALUES ('範例公司','12345678',true)
         ON CONFLICT (tax_id) DO UPDATE SET name=EXCLUDED.name RETURNING id`);
      const companyId = company.rows[0].id;

      const draft = {
        clientId, companyId, quotationDate: "2026-08-15",
        subject: "多功能聊天機器人使用費",
        clientContactId: contact.body.id,
        lineItems: [{ productName: "系統租賃", quantity: 4, unitPrice: 30952, unitCost: 20000 }],
      };
      const q = await boss("POST", "/quotations", draft);
      eq("建立報價", q.status, 201);
      const quotationId = q.body.id;
      const versionId = q.body.versionId;
      const { quotationPrefix } = await getSettings();
      ok("編號格式（前綴來自系統設定）",
        new RegExp(`^${quotationPrefix}-20260815-\\d{3}$`).test(q.body.quotationNumber), q.body.quotationNumber);

      console.log("\n── 6. 前端傳假金額不算數 ──");
      const forged = await boss("POST", "/quotations", {
        ...draft, subtotal: 1, totalAmount: 1, taxAmount: 0,
      });
      const forgedDetail = await boss("GET", `/quotations/${forged.body.id}`);
      eq("金額仍由伺服器算", Math.round(+forgedDetail.body.versions[0].totalAmount),
         Math.round(4 * 30952 * 1.05));

      console.log("\n── 7. 成本與毛利的權限邊界 ──");
      {
        const bossView = await boss("GET", `/quotations/${quotationId}`);
        ok("admin 看得到毛利", bossView.body.versions[0].marginPercent != null);

        const acctView = await acct("GET", `/quotations/${quotationId}`);
        ok("會計看得到毛利", acctView.body.versions[0].marginPercent != null);

        const salesView = await sales("GET", `/quotations/${quotationId}`);
        ok("業務看不到毛利", !("marginPercent" in salesView.body.versions[0]));
        ok("業務看不到單項成本",
          salesView.body.versions[0].items.every((i: Record<string, unknown>) => !("unit_cost" in i)));

        const salesList = await sales("GET", "/quotations");
        ok("業務的列表也沒有成本", !("totalCost" in salesList.body.items[0]));
      }

      console.log("\n── 8. 業務不能核准也不能作廢 ──");
      {
        const approve = await sales("POST", `/quotations/versions/${versionId}/status`,
          { status: "approved" });
        eq("業務核准被擋", approve.status, 403);

        const void_ = await sales("POST", `/quotations/versions/${versionId}/status`,
          { status: "voided", reason: "測試" });
        eq("業務作廢被擋", void_.status, 403);

        const send = await sales("POST", `/quotations/versions/${versionId}/status`,
          { status: "sent" });
        eq("業務可以寄出", send.status, 200);
      }

      console.log("\n── 9. 狀態機透過 API 也擋得住 ──");
      {
        const back = await boss("POST", `/quotations/versions/${versionId}/status`,
          { status: "draft" });
        eq("已寄出不能倒回草稿", back.status, 409);

        await boss("POST", `/quotations/versions/${versionId}/status`, { status: "accepted" });
        const locked = await boss("PATCH", `/quotations/versions/${versionId}`,
          { lineItems: [{ productName: "偷改", quantity: 1, unitPrice: 1 }] });
        eq("已接受後改價被擋", locked.status, 409);
        ok("錯誤訊息可以直接顯示給使用者",
          String(locked.body.message).includes("鎖定"), locked.body.message);

        const after = await boss("GET", `/quotations/${quotationId}`);
        eq("履約自動變成進行中", after.body.fulfillment_status, "in_progress");
      }

      console.log("\n── 10. 檔案上傳與掛錯偵測 ──");
      {
        const pdf = Buffer.concat([
          Buffer.from("%PDF-1.4\n"),
          Buffer.from("簽回文件內容 A".repeat(20)),
        ]);
        const form = new FormData();
        form.append("file", new Blob([pdf], { type: "application/pdf" }), "簽回單.pdf");
        const up = await boss("POST", `/quotations/${quotationId}/documents`, form, true);
        eq("上傳成功", up.status, 201);
        ok("回傳相對路徑而非絕對網址",
          String(up.body.url).startsWith("/api/documents/"), up.body.url);
        eq("首次上傳不算可疑", up.body.suspect, false);

        const dl = await boss("GET", `/documents/${up.body.document.id}/download`);
        eq("下載得回來", dl.status, 200);
        eq("下載回來的位元組數一致", dl.bytes, pdf.length);
        ok("下載回來的內容逐位元組相同", dl.buffer.equals(pdf));

        // 同一份檔案掛到第二張報價 —— 這就是舊資料那 4 筆的情況
        const q2 = await boss("POST", "/quotations", { ...draft, subject: "另一張報價" });
        const form2 = new FormData();
        form2.append("file", new Blob([pdf], { type: "application/pdf" }), "簽回單.pdf");
        const up2 = await boss("POST", `/quotations/${q2.body.id}/documents`, form2, true);
        eq("第二次上傳同一份檔案", up2.status, 201);
        eq("偵測到重複檔案不重存", up2.body.deduplicated, true);
        eq("標記為可疑", up2.body.suspect, true);
        ok("指出跟哪張報價衝突",
          up2.body.conflictsWith.includes(q.body.quotationNumber),
          JSON.stringify(up2.body.conflictsWith));

        const suspects = await boss("GET", "/documents/suspect-links");
        ok("可疑清單查得到", suspects.body.length >= 1);

        console.log("\n── 11. 非 PDF 偽裝成 PDF 被擋 ──");
        const fakeForm = new FormData();
        fakeForm.append("file",
          new Blob([Buffer.from("<?php system($_GET['c']); ?>")], { type: "application/pdf" }),
          "evil.pdf");
        const fake = await boss("POST", `/quotations/${quotationId}/documents`, fakeForm, true);
        eq("內容不是 PDF 被擋下", fake.status, 400);

        const exeForm = new FormData();
        exeForm.append("file",
          new Blob([Buffer.from("MZ\x90\x00")], { type: "application/x-msdownload" }),
          "evil.exe");
        const exe = await boss("POST", `/quotations/${quotationId}/documents`, exeForm, true);
        eq("不支援的類型被擋下", exe.status, 400);
      }

      console.log("\n── 12. 稽核軌跡 ──");
      {
        const audit = await boss("GET", "/audit?limit=200");
        eq("admin 讀得到", audit.status, 200);
        const actions = new Set(audit.body.map((r: { action: string }) => r.action));
        ok("登入有紀錄", actions.has("login"));
        ok("建立報價有紀錄", actions.has("create"));
        ok("狀態變更有紀錄", actions.has("status_change"));
        ok("客戶更名有紀錄", actions.has("rename"));

        const salesAudit = await sales("GET", "/audit");
        eq("業務讀不到稽核", salesAudit.status, 403);
      }

      console.log("\n── 13. 登入爆破防護 ──");
      {
        resetLockouts();
        const attacker = makeClient();
        let last = 0;
        for (let i = 0; i < 10; i += 1) {
          last = (await attacker("POST", "/auth/login",
            { username: "boss", password: `guess${i}` })).status;
        }
        eq("連續失敗後鎖定", last, 429);
        const correct = await attacker("POST", "/auth/login",
          { username: "boss", password: "BossPassword123" });
        eq("鎖定期間正確密碼也擋", correct.status, 429);
        eq("已登入的 session 不受影響", (await boss("GET", "/auth/me")).status, 200);
      }

      console.log("\n── 14. 系統設定（白牌化）──");
      {
        const pub = await anon("GET", "/settings/public");
        eq("免登入可讀公開設定", pub.status, 200);
        ok("公開設定只有名稱／logo／主色",
          Object.keys(pub.body).sort().join(",") === "appName,logoUrl,primaryColor",
          Object.keys(pub.body).join(","));

        const salesPut = await sales("PUT", "/settings", { appName: "偷改" });
        eq("業務不能改設定", salesPut.status, 403);
        eq("業務讀完整設定 403", (await sales("GET", "/settings")).status, 403);
        eq("業務可讀品牌／公司資料（PDF 要用）", (await sales("GET", "/settings/branding")).status, 200);

        const bad = await boss("PUT", "/settings", { quotationPrefix: "a-b" });
        eq("前綴格式錯誤被擋", bad.status, 400);

        const put = await boss("PUT", "/settings", { companyName: "測試公司", quotationPrefix: "ab" });
        eq("管理員可以改設定", put.status, 200);
        eq("回傳的是更新後的值", put.body.companyName, "測試公司");
        eq("前綴轉大寫", put.body.quotationPrefix, "AB");

        const co = await boss("GET", "/companies");
        ok("預設公司名稱同步更新", co.body.some((c: { name: string; isDefault: boolean }) => c.isDefault && c.name === "測試公司"),
          JSON.stringify(co.body));

        const q3 = await boss("POST", "/quotations", { ...draft, subject: "新前綴" });
        ok("新報價用新前綴", /^AB-20260815-\d{3}$/.test(q3.body.quotationNumber), q3.body.quotationNumber);

        const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZqOngAAAABJRU5ErkJggg==", "base64");
        const logoForm = new FormData();
        logoForm.append("file", new Blob([png], { type: "image/png" }), "logo.png");
        const up = await boss("POST", "/settings/logo", logoForm, true);
        eq("上傳 logo", up.status, 201);
        ok("回傳 logo 網址", String(up.body.logoUrl).startsWith("/api/settings/logo"), up.body.logoUrl);
        eq("logo 免登入可讀", (await anon("GET", "/settings/logo")).status, 200);

        const stampForm = new FormData();
        stampForm.append("file", new Blob([png], { type: "image/png" }), "stamp.png");
        eq("上傳印章", (await boss("POST", "/settings/stamp", stampForm, true)).status, 201);
        eq("印章未登入不可讀", (await anon("GET", "/settings/stamp")).status, 401);
        eq("印章登入後可讀", (await sales("GET", "/settings/stamp")).status, 200);

        const evilForm = new FormData();
        evilForm.append("file", new Blob([Buffer.from("<svg><script>1</script></svg>")], { type: "image/svg+xml" }), "e.svg");
        eq("含 script 的 SVG 被擋", (await boss("POST", "/settings/logo", evilForm, true)).status, 400);

        eq("移除 logo", (await boss("DELETE", "/settings/logo")).status, 200);
        eq("移除後 404", (await anon("GET", "/settings/logo")).status, 404);

        // 還原，免得影響其他測試
        await boss("PUT", "/settings", { companyName: "範例公司", quotationPrefix: "QT" });
        await boss("DELETE", "/settings/stamp");
      }

      console.log("\n── 15. 輸入驗證 ──");
      {
        eq("缺少品項被擋",
          (await boss("POST", "/quotations", { ...draft, lineItems: [] })).status, 400);
        eq("日期格式錯誤被擋",
          (await boss("POST", "/quotations", { ...draft, quotationDate: "2026/08/15" })).status, 400);
        eq("報價 id 非數字被擋",
          (await boss("GET", "/quotations/abc")).status, 400);
        eq("不存在的報價回 404",
          (await boss("GET", "/quotations/999999")).status, 404);
        eq("未知狀態被擋",
          (await boss("POST", `/quotations/versions/${versionId}/status`,
            { status: "whatever" })).status, 400);
      }
    }

    console.log(`\n════════ 通過 ${pass}／失敗 ${fail} ════════`);
  } finally {
    server.close();
    await pool.end();
  }
  process.exit(fail ? 1 : 0);
}

main().catch(async error => {
  console.error("\n測試執行失敗:", error);
  await pool.end();
  process.exit(1);
});
