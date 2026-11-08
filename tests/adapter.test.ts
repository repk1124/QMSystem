/**
 * 轉接層測試。
 *
 * 目的很具體：確認「資料庫 → API 讀出 → 轉成 pdfService 的形狀」
 * 這條路上沒有任何欄位掉了或錯位。PDF 產生邏輯本身沒動，
 * 所以只要餵進去的資料一樣，輸出就會一樣。測試資料由這支自己建立。
 */
import { pool } from "../server/db";
import { getQuotation, createQuotation, createNewVersion } from "../server/repositories/quotations";
import { renameClient } from "../server/repositories/clients";
import {
  toLegacyQuotation, toApiDraft, pickVersion, nextAction, formatMoney,
  type LegacyQuotationData,
} from "../client/src/lib/adapters";
import type { ApiQuotation } from "../client/src/lib/api";

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra = "") => {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name} ${extra}`); fail++; }
};
const eq = (name: string, actual: unknown, expected: unknown) =>
  ok(name, String(actual) === String(expected), `期望 ${expected}，實得 ${actual}`);

const COMPANY = {
  name: "範例公司",
  address: "台北市信義區範例路 1 號",
  taxId: "12345678",
};

const actor = { userId: null, label: "測試" };

/** 這支測試自己造資料：一家公司、一個會改名的客戶、兩張報價（其中一張有兩個版本） */
async function seed() {
  const co = await pool.query(
    `INSERT INTO companies (name, tax_id, is_default) VALUES ('範例公司','12345678',true)
     ON CONFLICT (tax_id) DO UPDATE SET name=EXCLUDED.name RETURNING id`);
  const companyId = co.rows[0].id;

  // 先清掉上一輪留下的
  await pool.query(`DELETE FROM quotations WHERE id IN (
    SELECT q.id FROM quotations q JOIN clients c ON c.id=q.client_id WHERE c.code='ADPT-0001')`);
  await pool.query(`DELETE FROM clients WHERE code='ADPT-0001'`);

  const cl = await pool.query(
    `INSERT INTO clients (code, name, tax_id, address) VALUES ('ADPT-0001','範例學院','10000015','高雄市範例路 2 號')
     RETURNING id`);
  const clientId = cl.rows[0].id;
  await pool.query(
    `INSERT INTO client_name_history (client_id, name, valid_from) VALUES ($1,'範例學院','2020-01-01')`, [clientId]);
  const contact = await pool.query(
    `INSERT INTO client_contacts (client_id, name, email, phone, is_primary)
     VALUES ($1,'王小明','wang@example.com','02-12345678',true) RETURNING id`, [clientId]);

  const base = {
    clientId, companyId, clientContactId: contact.rows[0].id,
    ourContactName: "李小華", ourContactEmail: "lee@example.com", ourContactPhone: "02-87654321",
  };
  // 第一張：改名前開的，客戶名稱快照應該是舊名
  const q1 = await createQuotation({
    ...base, quotationDate: "2025-05-01", subject: "舊名稱時期的報價",
    taxAdjustment: -1,
    lineItems: [
      { productName: "主機", specification: "規格 A", quantity: 2, unitPrice: 1000 },
      { productName: "安裝", quantity: 1, unitPrice: 500 },
    ],
  }, actor);

  // 客戶改名（主檔變新名，舊報價的快照不動）
  await renameClient(clientId, "範例大學", actor, { effectiveFrom: "2025-09-25", reason: "upgrade" });

  // 第二張：改名後開，然後開第二版改價
  const q2 = await createQuotation({
    ...base, quotationDate: "2026-01-10", subject: "新名稱時期的報價",
    lineItems: [{ productName: "維護", quantity: 12, unitPrice: 3000 }],
  }, actor);
  await createNewVersion(q2.id, {
    lineItems: [{ productName: "維護", quantity: 12, unitPrice: 2800 }],
  }, actor);

  return { ids: [q1.id, q2.id], oldNameQuotationId: q1.id, multiVersionId: q2.id };
}

async function main() {
  const seeded = await seed();

  console.log("\n── 1. 轉換後 PDF 會印的欄位都要有值 ──");
  const rows = await pool.query<{ id: number; quotation_number: string }>(
    `SELECT id, quotation_number FROM quotations WHERE id = ANY($1::int[]) ORDER BY id`, [seeded.ids]);
  eq("造出了 2 張報價", rows.rowCount, 2);

  let converted = 0;
  const problems: string[] = [];

  for (const row of rows.rows) {
    const api = await getQuotation(row.id, true) as unknown as ApiQuotation;
    const legacy = toLegacyQuotation(api, COMPANY);

    if (!legacy.quotationNumber) problems.push(`${row.quotation_number}: 缺少報價編號`);
    if (!legacy.clientCompany) problems.push(`${row.quotation_number}: 缺少客戶名稱`);
    if (!legacy.quotationDate) problems.push(`${row.quotation_number}: 缺少報價日期`);
    if (!legacy.lineItems.length) problems.push(`${row.quotation_number}: 沒有品項`);
    // PDF 會印出來的每一個欄位都要有值，少一個就在報價單上開天窗
    if (!legacy.clientAddress) problems.push(`${row.quotation_number}: 缺少客戶地址`);
    if (!legacy.buyerTaxId) problems.push(`${row.quotation_number}: 缺少買方統編`);
    if (!legacy.ourContact) problems.push(`${row.quotation_number}: 缺少我方聯絡人`);
    if (!legacy.ourEmail) problems.push(`${row.quotation_number}: 缺少我方 Email`);
    if (!legacy.ourPhone) problems.push(`${row.quotation_number}: 缺少我方電話`);
    if (!legacy.customerCode) problems.push(`${row.quotation_number}: 缺少客戶代號`);
    if (!legacy.companyName) problems.push(`${row.quotation_number}: 缺少我方公司名稱`);
    if (!legacy.clientContact) problems.push(`${row.quotation_number}: 缺少客戶聯絡人`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(legacy.quotationDate)) {
      problems.push(`${row.quotation_number}: 日期格式異常 ${legacy.quotationDate}`);
    }
    for (const item of legacy.lineItems) {
      if (typeof item.quantity !== "number" || Number.isNaN(item.quantity)) {
        problems.push(`${row.quotation_number}: 數量不是數字`);
      }
      if (typeof item.price !== "number" || Number.isNaN(item.price)) {
        problems.push(`${row.quotation_number}: 單價不是數字`);
      }
    }
    converted += 1;
  }

  eq("全部轉換成功", converted, rows.rowCount);
  ok("沒有欄位遺失或格式異常", problems.length === 0, problems.slice(0, 5).join("; "));

  console.log("\n── 2. 金額在轉換後仍然算得出一樣的結果 ──");
  {
    // 轉換後用 pdfService 那套算法重算，跟資料庫存的值比對
    let mismatches = 0;
    for (const row of rows.rows) {
      const api = await getQuotation(row.id, true) as unknown as ApiQuotation;
      const legacy = toLegacyQuotation(api, COMPANY);
      const version = pickVersion(api);

      const subtotal = legacy.lineItems.reduce(
        (sum, i) => sum + Math.round(i.quantity * i.price), 0);
      const tax = Math.round(subtotal * 0.05) + (legacy.taxAdjustment ?? 0);

      if (subtotal !== Math.round(parseFloat(version.subtotal))
        || tax !== Math.round(parseFloat(version.taxAmount))) {
        mismatches += 1;
        console.log(`     ${row.quotation_number}: 轉換後 ${subtotal}/${tax}，` +
          `資料庫 ${version.subtotal}/${version.taxAmount}`);
      }
    }
    eq("金額全部一致（含稅額調整）", mismatches, 0);
  }

  console.log("\n── 3. 歷史報價印的是當時的客戶名稱 ──");
  {
    const api = await getQuotation(seeded.oldNameQuotationId, true) as unknown as ApiQuotation;
    const legacy = toLegacyQuotation(api, COMPANY);
    eq("PDF 上印舊名稱", legacy.clientCompany, "範例學院");
    eq("客戶主檔已經是新名稱", api.client_current_name, "範例大學");
    ok("兩者確實不同（快照有生效）", legacy.clientCompany !== api.client_current_name);
  }

  console.log("\n── 4. 指定版本時取到正確的那一版 ──");
  {
    const api = await getQuotation(seeded.multiVersionId, true) as unknown as ApiQuotation;
    eq("有兩個版本", api.versions.length, 2);
    const older = api.versions[api.versions.length - 1];
    const legacyOld = toLegacyQuotation(api, COMPANY, older.id);
    const legacyCurrent = toLegacyQuotation(api, COMPANY);
    eq("舊版單價", legacyOld.lineItems[0].price, 3000);
    eq("現行版單價", legacyCurrent.lineItems[0].price, 2800);
  }

  console.log("\n── 5. 反向轉換不送金額 ──");
  {
    const draft: LegacyQuotationData = {
      companyName: COMPANY.name, companyAddress: COMPANY.address, companyTaxId: COMPANY.taxId,
      quotationNumber: "", quotationDate: "2026-08-15",
      clientCompany: "測試", clientContact: "王先生", clientEmail: "", clientPhone: "",
      clientAddress: "", buyerTaxId: "", customerCode: "",
      ourContact: "王小明", ourPhone: "", ourEmail: "",
      quotationSubject: "測試案", notes: "備註",
      taxAdjustment: -3, requireSignature: true,
      lineItems: [
        { id: "1", productName: "主機", specification: "規格", quantity: 2, price: 1000 },
        { id: "2", productName: "", specification: "", quantity: 0, price: 0 },
      ],
    };
    const api = toApiDraft(draft, { clientId: 1, companyId: 1, clientContactId: 5 });

    ok("沒有 subtotal 欄位", !("subtotal" in api));
    ok("沒有 totalAmount 欄位", !("totalAmount" in api));
    ok("沒有 taxAmount 欄位", !("taxAmount" in api));
    eq("空白列被濾掉", api.lineItems.length, 1);
    eq("稅額調整有帶", api.taxAdjustment, -3);
    eq("需簽回有帶", api.requireSignature, true);
    eq("聯絡人 id 有帶", api.clientContactId, 5);
    eq("品項數量是數字", typeof api.lineItems[0].quantity, "number");
  }

  console.log("\n── 6. 列表的行動建議 ──");
  {
    const cases: Array<[Record<string, unknown>, string | null]> = [
      [{ status: "draft", fulfillmentStatus: "not_started", validUntil: null, suspectDocuments: 0 }, "尚未寄出"],
      [{ status: "sent", fulfillmentStatus: "not_started", validUntil: "2099-01-01", suspectDocuments: 0 }, "等待客戶回覆"],
      [{ status: "sent", fulfillmentStatus: "not_started", validUntil: "2020-01-01", suspectDocuments: 0 }, "已過期，需重新報價或延期"],
      [{ status: "viewed", fulfillmentStatus: "not_started", validUntil: null, suspectDocuments: 0 }, "客戶已讀，可以跟進"],
      [{ status: "accepted", fulfillmentStatus: "inspected", validUntil: null, suspectDocuments: 0 }, "可以請款"],
      [{ status: "accepted", fulfillmentStatus: "invoiced", validUntil: null, suspectDocuments: 0 }, "待收款"],
      [{ status: "accepted", fulfillmentStatus: "paid", validUntil: null, suspectDocuments: 0 }, "可以結案"],
      [{ status: "accepted", fulfillmentStatus: "closed", validUntil: null, suspectDocuments: 0 }, null],
      [{ status: "accepted", fulfillmentStatus: "in_progress", validUntil: null, suspectDocuments: 2 }, "簽回檔可能掛錯，待確認"],
    ];
    for (const [input, expected] of cases) {
      eq(`${input.status}/${input.fulfillmentStatus} → ${expected ?? "無"}`,
         nextAction(input as never, "2026-08-15"), expected);
    }
  }

  console.log("\n── 7. 金額顯示 ──");
  {
    eq("字串轉顯示", formatMoney("129998.00"), "NT$ 129,998");
    eq("數字轉顯示", formatMoney(1234567), "NT$ 1,234,567");
    eq("null 安全", formatMoney(null), "NT$ 0");
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
