/**
 * 啟動時的預設資料（全部 idempotent，重複啟動不會重複建）。
 *
 *   1. app_settings 那一列
 *   2. 內建角色與（使用者數為 0 時）初始管理員
 *   3. companies 為空時，用設定裡的公司名稱建一筆 is_default 公司
 *   4. 預設合約範本（同 code 已存在就不動，不覆蓋使用者的修改）
 */
import { pool } from "./db";
import { ensureRolesAndAdmin } from "./auth";
import { ensureSettingsRow, getSettings, invalidateSettingsCache } from "./repositories/settings";
import { SEED_TEMPLATES } from "./seed/contractTemplates";

export async function ensureDefaultCompany() {
  const count = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM companies");
  if (count.rows[0].n > 0) return;
  const s = await getSettings();
  await pool.query(
    `INSERT INTO companies (name, tax_id, address, phone, principal, is_default)
     VALUES ($1,$2,$3,$4,$5,true)`,
    [s.companyName, s.companyTaxId, s.companyAddress, s.companyPhone, s.companyPrincipal],
  );
  console.log(`[seed] 已建立預設公司「${s.companyName}」`);
}

export async function seedTemplates() {
  for (const t of SEED_TEMPLATES) {
    const vars = [...new Set([...t.body.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort();
    const res = await pool.query(
      `INSERT INTO document_templates (code, name, template_type, body, variables, description)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO NOTHING`,
      [t.code, t.name, t.templateType, t.body, vars, t.description]);
    if (res.rowCount) console.log(`[seed] 已建立合約範本 ${t.code}（${t.name}）`);
  }
}

export async function seedDefaults() {
  await ensureSettingsRow();
  invalidateSettingsCache();
  await ensureRolesAndAdmin();
  await ensureDefaultCompany();
  await seedTemplates();
}
