/**
 * 報價資料層的業務規則測試。
 * 每一項都對應到舊系統實際存在的缺陷。
 */
import { pool } from "../server/db";
import {
  createQuotation, updateVersion, createNewVersion,
  changeQuoteStatus, changeFulfillmentStatus,
  listQuotations, getQuotation, deleteQuotation,
  computeTotals, nextQuotationNumber,
} from "../server/repositories/quotations";
import { ConflictError } from "../server/errors";
import { getSettings } from "../server/repositories/settings";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${extra}`); fail++; }
};
const eq = (name: string, actual: unknown, expected: unknown) =>
  ok(name, Object.is(actual, expected) || String(actual) === String(expected),
     `期望 ${expected}，實得 ${actual}`);

async function expectConflict(name: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    ok(name, false, "（應該要被擋下卻成功了）");
  } catch (error) {
    ok(name, error instanceof ConflictError,
       `拋出的是 ${(error as Error)?.constructor?.name}: ${(error as Error).message}`);
  }
}

const actor = { userId: null, label: "測試" };

async function main() {
  // 準備一個乾淨的客戶與公司
  const co = await pool.query(
    `INSERT INTO companies (name, tax_id, is_default) VALUES ('範例公司','12345678',true)
     ON CONFLICT (tax_id) DO UPDATE SET name=EXCLUDED.name RETURNING id`);
  const companyId = co.rows[0].id;
  const cl = await pool.query(
    `INSERT INTO clients (code, name, tax_id) VALUES ('TEST-0001','測試客戶','12345678')
     ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`);
  const clientId = cl.rows[0].id;

  console.log("\n── 1. 金額計算（伺服器端才是有效力的那份）──");
  {
    const t = computeTotals([{ productName: "A", quantity: 3, unitPrice: 1000 }], 0);
    eq("3 × 1000 未稅", t.subtotal, 3000);
    eq("5% 稅額", t.taxAmount, 150);
    eq("含稅總計", t.totalAmount, 3150);

    const adj = computeTotals([{ productName: "A", quantity: 1, unitPrice: 30952 }], -2);
    eq("稅額調整 -2 生效", adj.taxAmount, Math.round(30952 * 0.05) - 2);
    eq("調整後總計", adj.totalAmount, 30952 + Math.round(30952 * 0.05) - 2);

    const m = computeTotals([{ productName: "A", quantity: 2, unitPrice: 1000, unitCost: 600 }]);
    eq("成本合計", m.totalCost, 1200);
    eq("毛利率 40%", m.marginPercent, 40);

    const none = computeTotals([{ productName: "A", quantity: 1, unitPrice: 100 }]);
    ok("沒有成本時毛利為 null", none.marginPercent === null);
  }

  console.log("\n── 2. 報價編號不再靠亂數（舊系統一天 38 張就過半機率碰撞）──");
  {
    const client = await pool.connect();
    const { quotationPrefix } = await getSettings();
    const numbers = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const created = await createQuotation({
        clientId, companyId, quotationDate: "2026-09-01",
        lineItems: [{ productName: "測試品項", quantity: 1, unitPrice: 100 }],
      }, actor);
      numbers.add(created.quotationNumber);
    }
    client.release();
    eq("連開 5 張編號全不重複", numbers.size, 5);
    const pattern = new RegExp(`^${quotationPrefix}-20260901-\\d{3}$`);
    ok("編號格式正確（前綴來自系統設定）", [...numbers].every(n => pattern.test(n)), [...numbers][0]);
    // 檢查「連號」而不是「剛好是 001~005」——
    // 這支測試跑在有真實資料的共用庫上，起始序號不一定是 0，
    // 所以驗證這 5 個尾碼彼此連續遞增即可（也順便涵蓋撞號重試的正確性）。
    const tails = [...numbers].map(n => parseInt(n.split("-").pop()!, 10)).sort((a, b) => a - b);
    const consecutive = tails.every((t, i) => i === 0 || t === tails[i - 1] + 1);
    ok("編號連號遞增", consecutive, tails.join(","));
  }

  console.log("\n── 3. 建立與修改 ──");
  const created = await createQuotation({
    clientId, companyId, quotationDate: "2026-09-10",
    subject: "測試報價", notes: "初版備註",
    lineItems: [
      { productName: "主機", quantity: 1, unitPrice: 100000, unitCost: 70000 },
      { productName: "安裝", quantity: 2, unitPrice: 5000 },
    ],
  }, actor);
  {
    const q = await getQuotation(created.id, true);
    eq("版本數", q.versions.length, 1);
    eq("初始狀態", q.versions[0].status, "draft");
    eq("未稅小計", Math.round(+q.versions[0].subtotal), 110000);
    eq("含稅總計", Math.round(+q.versions[0].totalAmount), 110000 + 5500);
    eq("品項數", q.versions[0].items.length, 2);
    eq("履約進度初始值", q.fulfillment_status, "not_started");
  }

  console.log("\n── 4. 金額由伺服器重算，前端傳什麼都不算數 ──");
  {
    await updateVersion(created.versionId, {
      lineItems: [{ productName: "主機", quantity: 1, unitPrice: 90000 }],
    }, actor);
    const q = await getQuotation(created.id, true);
    eq("改價後未稅", Math.round(+q.versions[0].subtotal), 90000);
    eq("改價後總計", Math.round(+q.versions[0].totalAmount), 94500);
    eq("品項被整批換掉", q.versions[0].items.length, 1);
  }

  console.log("\n── 5. 狀態機（舊系統可以任意跳）──");
  {
    await expectConflict("draft 不能直接跳到 accepted",
      () => changeQuoteStatus(created.versionId, "accepted", actor));

    await changeQuoteStatus(created.versionId, "sent", actor, "寄給客戶");
    const q1 = await getQuotation(created.id);
    eq("已寄出", q1.versions[0].status, "sent");
    ok("寄出後尚未鎖定", q1.versions[0].lockedAt === null);

    await changeQuoteStatus(created.versionId, "viewed", actor);
    await changeQuoteStatus(created.versionId, "accepted", actor, "客戶簽回");
    const q2 = await getQuotation(created.id);
    eq("已接受", q2.versions[0].status, "accepted");
    ok("接受後自動鎖定", q2.versions[0].lockedAt !== null);
    eq("接受後履約自動開始", q2.fulfillment_status, "in_progress");
  }

  console.log("\n── 6. 已接受的報價不能再改價（舊系統最大的洞）──");
  {
    await expectConflict("修改已鎖定的版本被擋下",
      () => updateVersion(created.versionId, {
        lineItems: [{ productName: "偷改價", quantity: 1, unitPrice: 1 }],
      }, actor));

    await expectConflict("已接受不能倒回 draft",
      () => changeQuoteStatus(created.versionId, "draft", actor));

    const q = await getQuotation(created.id);
    eq("金額沒有被改動", Math.round(+q.versions[0].totalAmount), 94500);
  }

  console.log("\n── 7. 開新版本，舊版本保留可查 ──");
  {
    const v2 = await createNewVersion(created.id, {
      lineItems: [{ productName: "主機", quantity: 1, unitPrice: 85000 }],
      notes: "第二版：客戶議價後",
    }, actor);
    eq("新版本號", v2.versionNumber, 2);

    const q = await getQuotation(created.id, true);
    eq("版本數變成 2", q.versions.length, 2);
    const [newer, older] = q.versions;
    eq("新版本狀態", newer.status, "draft");
    eq("新版本金額", Math.round(+newer.totalAmount), Math.round(85000 * 1.05));
    eq("舊版本被標記為 superseded", older.status, "superseded");
    ok("舊版本仍鎖定且查得到", older.lockedAt !== null);
    eq("舊版本金額不變（客戶手上那版）", Math.round(+older.totalAmount), 94500);
    eq("備註有繼承後覆寫", newer.notes, "第二版：客戶議價後");
  }

  console.log("\n── 8. 履約進度 ──");
  {
    // 履約只能在報價被「客戶接受」之後才推進。先把目前版本推到 accepted。
    const before = await getQuotation(created.id, true);
    const currentVersionId = before.current_version_id;
    await expectConflict("報價還沒接受，不能推進履約",
      () => changeFulfillmentStatus(created.id, "delivered", actor));
    await changeQuoteStatus(currentVersionId, "sent", actor);
    await changeQuoteStatus(currentVersionId, "accepted", actor);

    await expectConflict("進行中不能直接跳到已收款",
      () => changeFulfillmentStatus(created.id, "paid", actor));

    await changeFulfillmentStatus(created.id, "delivered", actor, { milestoneDate: "2026-10-01" });
    await changeFulfillmentStatus(created.id, "inspected", actor, { milestoneDate: "2026-10-15" });
    const q = await getQuotation(created.id);
    eq("已驗收", q.fulfillment_status, "inspected");
    eq("交付日有記錄（純日期不帶時區）", q.delivered_at, "2026-10-01");
    eq("驗收日有記錄（保固起算基準）", q.inspected_at, "2026-10-15");
    ok("日期是字串不是 Date 物件", typeof q.inspected_at === "string", typeof q.inspected_at);
    ok("JSON 序列化後日期不位移", JSON.parse(JSON.stringify({d: q.inspected_at})).d === "2026-10-15");

    await expectConflict("已驗收不能倒退回進行中",
      () => changeFulfillmentStatus(created.id, "in_progress", actor));
  }

  console.log("\n── 9. 刪除保護 ──");
  {
    await expectConflict("有往來紀錄的報價不能刪除",
      () => deleteQuotation(created.id, actor));

    const draft = await createQuotation({
      clientId, companyId, quotationDate: "2026-09-20",
      lineItems: [{ productName: "臨時", quantity: 1, unitPrice: 1 }],
    }, actor);
    const res = await deleteQuotation(draft.id, actor);
    ok("從未寄出的草稿可以刪除", res.deleted === true);
  }

  console.log("\n── 10. 成本欄位遮蔽 ──");
  {
    const withCost = await listQuotations({ clientId }, true);
    const without = await listQuotations({ clientId }, false);
    ok("有權限時看得到毛利", "marginPercent" in withCost.items[0]);
    ok("沒權限時看不到毛利", !("marginPercent" in without.items[0]));
    ok("沒權限時看不到成本", !("totalCost" in without.items[0]));

    const detail = await getQuotation(created.id, false);
    ok("明細也不會洩漏單項成本",
      detail.versions.every((v: { items: Record<string, unknown>[] }) => v.items.every((i: Record<string, unknown>) => !("unit_cost" in i))));
  }

  console.log("\n── 11. 稽核軌跡 ──");
  {
    const log = await pool.query(
      `SELECT action, count(*)::int AS n FROM audit_log
       WHERE entity_type IN ('quotation','quotation_version') GROUP BY action ORDER BY action`);
    const actions = Object.fromEntries(log.rows.map(r => [r.action, r.n]));
    ok("建立有留紀錄", (actions.create ?? 0) > 0);
    ok("修改有留紀錄", (actions.update ?? 0) > 0);
    ok("狀態變更有留紀錄", (actions.status_change ?? 0) > 0);
    ok("開新版本有留紀錄", (actions.new_version ?? 0) > 0);
    ok("履約變更有留紀錄", (actions.fulfillment_change ?? 0) > 0);

    const hist = await pool.query(
      `SELECT scope, count(*)::int AS n FROM quotation_status_history
       WHERE quotation_id=$1 GROUP BY scope`, [created.id]);
    const scopes = Object.fromEntries(hist.rows.map(r => [r.scope, r.n]));
    ok("報價軌跡與履約軌跡分開記錄", scopes.quote > 0 && scopes.fulfillment > 0,
       JSON.stringify(scopes));
  }

  console.log("\n── 12. 列表查詢 ──");
  {
    const open = await listQuotations({ openOnly: true });
    ok("只看進行中的案子", open.items.every((i: Record<string, unknown>) =>
      ["in_progress", "delivered", "inspected", "invoiced", "on_hold"].includes(i.fulfillmentStatus as string)));

    const search = await listQuotations({ search: "測試報價" });
    ok("關鍵字搜尋找得到", search.items.length > 0);

    const paged = await listQuotations({ limit: 2 });
    eq("分頁生效", paged.items.length, 2);
    ok("回傳總數", paged.total >= 2);
  }

  console.log(`\n════════ 通過 ${pass}／失敗 ${fail} ════════`);
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch(async error => {
  console.error("\n測試執行失敗:", error);
  await pool.end();
  process.exit(1);
});
