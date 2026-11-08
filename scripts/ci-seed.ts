/**
 * 測試前置資料（CI 與本機 npm test 都用）。可重複執行。
 *
 *   - 啟動時的預設資料（設定、角色、預設公司、合約範本）
 *   - hr.test.ts 依賴的員工 001「王小明」（到職 2023-09-01）
 *   - contracts.test.ts 依賴的報價 QT-20260811-399（客戶「範例大學」、金額 129,998）
 *
 * 跑法：npx tsx scripts/ci-seed.ts
 */
import { pool } from "../server/db";
import { seedDefaults } from "../server/seed";
import { createQuotation } from "../server/repositories/quotations";

await seedDefaults();

await pool.query(
  `INSERT INTO employees (employee_id, name, email, hire_date)
   VALUES ('001', '王小明', 'ci-seed@example.invalid', '2023-09-01')
   ON CONFLICT (employee_id) DO UPDATE SET name=EXCLUDED.name, hire_date=EXCLUDED.hire_date`);

const exists = await pool.query(
  `SELECT id FROM quotations WHERE quotation_number='QT-20260811-399' LIMIT 1`);
if (exists.rowCount) {
  console.log("QT-20260811-399 已存在，略過");
} else {
  const cl = await pool.query(
    `INSERT INTO clients (code, name, tax_id) VALUES ('CI-DEMO','範例大學','10000009')
     ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name RETURNING id`);
  const co = await pool.query(`SELECT id FROM companies WHERE is_default = true LIMIT 1`);
  const created = await createQuotation({
    clientId: cl.rows[0].id, companyId: co.rows[0].id, quotationDate: "2026-08-11",
    subject: "多功能聊天機器人開發",
    lineItems: [{ productName: "多功能聊天機器人開發", quantity: 1, unitPrice: 129998 }],
  }, { userId: null, label: "ci-seed" });
  // 報價編號是日期+流水號，不會剛好是 399 —— 改成測試要找的編號
  await pool.query(`UPDATE quotations SET quotation_number='QT-20260811-399' WHERE id=$1`, [created.id]);
  console.log(`seeded QT-20260811-399 (id=${created.id})`);
}

await pool.end();
