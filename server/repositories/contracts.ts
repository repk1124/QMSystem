/**
 * 合約資料層。
 *
 * 舊系統把合約內容塞在報價單的一個欄位 —— 合約從來沒有被當成一種單據管理：
 * 沒有編號、沒有起訖日、沒有狀態，也查不到哪些合約還在期限內。
 *
 * 範本也從程式碼搬進資料庫。舊系統改一句條款要改程式碼再重新部署，法務改不動。
 */

import { pool, transaction } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { getSettings } from "./settings";
import { canTransitionContract, LOCKED_CONTRACT_STATUSES,
         CONTRACT_STATUS, type ContractStatus } from "../../shared/schema";
import type { Actor } from "./quotations";

/* ── 範本 ── */

export async function listTemplates() {
  const res = await pool.query(
    `SELECT id, code, name, template_type AS "templateType", body,
            variables, description, is_active AS "isActive",
            updated_at AS "updatedAt"
     FROM document_templates WHERE is_active = true ORDER BY template_type, name`);
  return res.rows;
}

/** 從內容抓出 {變數} 供編輯畫面提示 */
export function extractVariables(body: string): string[] {
  return [...new Set([...body.matchAll(/\{(\w+)\}/g)].map(m => m[1]))].sort();
}

export async function upsertTemplate(
  input: { id?: number; code?: string; name: string; templateType: string; body: string; description?: string },
  actor: Actor,
) {
  if (!input.name?.trim()) throw new ValidationError("範本名稱為必填");
  if (!input.body?.trim()) throw new ValidationError("範本內容為必填");

  const variables = extractVariables(input.body);

  return transaction(async client => {
    if (input.id) {
      const res = await client.query(
        `UPDATE document_templates
         SET name=$1, template_type=$2, body=$3, variables=$4,
             description=$5, updated_by=$6, updated_at=now()
         WHERE id=$7 RETURNING *`,
        [input.name.trim(), input.templateType, input.body, variables,
         input.description ?? null, actor.userId, input.id]);
      if (!res.rowCount) throw new NotFoundError("範本");
      await audit(client, actor, "document_template", input.id, "update",
        { name: input.name, variables });
      return res.rows[0];
    }

    const code = input.code?.trim() || `TPL-${Date.now()}`;
    const res = await client.query(
      `INSERT INTO document_templates (code, name, template_type, body, variables, description, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [code, input.name.trim(), input.templateType, input.body, variables,
       input.description ?? null, actor.userId]);
    await audit(client, actor, "document_template", res.rows[0].id, "create", { code, name: input.name });
    return res.rows[0];
  });
}

/* ── 套用範本 ── */

/**
 * 把 {變數} 換成實際內容。
 *
 * 找不到對應值的變數會保留原樣（而不是變成空白或 undefined）——
 * 這樣使用者一眼就看得出哪裡沒填，不會出現「代表人：」後面空一片
 * 卻沒人發現的情況。
 */
/**
 * 套用變數。沒填到的變數渲染成空字串，不留 {xxx} 字面值在合約上
 * （缺了什麼由 missingVariables 另外列給前端提示）。
 */
export function renderTemplate(body: string, values: Record<string, string | number | null | undefined>): string {
  return body.replace(/\{(\w+)\}/g, (_whole, key: string) => {
    const value = values[key];
    if (value === null || value === undefined) return "";
    return String(value);
  });
}

/** 列出還沒填到的變數，建立合約時提醒 */
export function missingVariables(body: string, values: Record<string, unknown>): string[] {
  return extractVariables(body).filter(key => {
    const v = values[key];
    return v === null || v === undefined || v === "";
  });
}

/** 從報價單組出可套用的變數 */
export async function templateValuesFromQuotation(quotationId: number) {
  const res = await pool.query(
    `SELECT q.quotation_number, q.id,
            co.name AS company_name, co.tax_id AS company_tax_id,
            co.address AS company_address, co.phone AS company_phone,
            co.principal AS company_principal,
            s.company_email AS settings_email, s.company_phone AS settings_phone,
            s.company_principal AS settings_principal,
            c.name AS client_current_name, c.tax_id AS client_tax_id,
            c.address AS client_address,
            v.client_name_snapshot, v.client_address_snapshot,
            v.client_contact_name_snapshot, v.client_contact_email_snapshot,
            v.client_contact_phone_snapshot,
            v.our_contact_name, v.our_contact_email, v.our_contact_phone,
            v.subject, v.notes, v.total_amount, v.quotation_date
     FROM quotations q
     JOIN quotation_versions v ON v.id = q.current_version_id
     JOIN clients c ON c.id = q.client_id
     JOIN companies co ON co.id = q.company_id
     LEFT JOIN app_settings s ON s.id = 1
     WHERE q.id = $1`, [quotationId]);
  if (!res.rowCount) throw new NotFoundError("報價");
  const r = res.rows[0];

  const items = await pool.query(
    `SELECT i.product_name, i.quantity, i.unit_price
     FROM quotation_items i
     JOIN quotation_versions v ON v.id = i.version_id
     WHERE v.quotation_id=$1 ORDER BY i.sort_order`, [quotationId]);

  const total = Math.round(Number(r.total_amount));
  const fmt = (n: number) => n.toLocaleString("zh-TW");

  return {
    quotationNumber: r.quotation_number,
    quotationDate: r.quotation_date,
    quotationSubject: r.subject,
    notes: r.notes,

    companyName: r.company_name,
    companyTaxId: r.company_tax_id,
    companyAddress: r.company_address,
    // 我方電話／Email／代表人以系統設定為準；報價上的聯絡窗口只是退路
    ourPhone: r.company_phone ?? r.settings_phone ?? r.our_contact_phone,
    ourEmail: r.settings_email ?? r.our_contact_email,
    principalName: r.company_principal ?? r.settings_principal ?? r.our_contact_name,

    clientCompany: r.client_name_snapshot ?? r.client_current_name,
    clientContact: r.client_contact_name_snapshot,
    clientEmail: r.client_contact_email_snapshot,
    clientPhone: r.client_contact_phone_snapshot,
    clientAddress: r.client_address_snapshot ?? r.client_address,
    buyerTaxId: r.client_tax_id,

    totalAmount: fmt(total),
    // 開發合約的 30/40/30 分期。用整數相減讓三段加起來剛好等於總額，
    // 不會因為各自四捨五入而差個一兩塊。
    firstPayment: fmt(Math.round(total * 0.3)),
    secondPayment: fmt(Math.round(total * 0.4)),
    thirdPayment: fmt(total - Math.round(total * 0.3) - Math.round(total * 0.4)),

    lineItemsDescription: items.rows
      .map(i => `${i.product_name} × ${Number(i.quantity)}`).join("、"),
  };
}

/* ── 合約 ── */

/** 合約編號 <前綴>-YYYYMMDD-NNN（前綴來自系統設定，預設 CNT） */
export async function nextContractNumber(
  client: { query: typeof pool.query }, date: string, prefix = "CNT",
) {
  const compact = date.replace(/-/g, "");
  const res = await client.query(
    `SELECT contract_number FROM contracts WHERE contract_number LIKE $1
     ORDER BY contract_number DESC LIMIT 1`, [`${prefix}-${compact}-%`]);
  const next = res.rowCount
    ? parseInt(res.rows[0].contract_number.split("-").pop() ?? "0", 10) + 1 : 1;
  return `${prefix}-${compact}-${String(next).padStart(3, "0")}`;
}

export async function listContracts(filters: { status?: string; clientId?: number; expiringDays?: number } = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.status) { params.push(filters.status); where.push(`c.status=$${params.length}`); }
  if (filters.clientId) { params.push(filters.clientId); where.push(`c.client_id=$${params.length}`); }
  if (filters.expiringDays != null) {
    params.push(filters.expiringDays);
    where.push(`c.end_date IS NOT NULL AND c.end_date <= CURRENT_DATE + $${params.length}::int`);
  }

  const res = await pool.query(
    `SELECT c.id, c.contract_number AS "contractNumber", c.contract_type AS "contractType",
            c.title, c.status, c.start_date AS "startDate", c.end_date AS "endDate",
            c.total_amount AS "totalAmount", c.signed_at AS "signedAt",
            c.billing_cycle AS "billingCycle", c.billing_amount AS "billingAmount",
            (c.locked_at IS NOT NULL) AS locked,
            cl.id AS "clientId", cl.name AS "clientName",
            q.quotation_number AS "quotationNumber",
            (c.end_date IS NOT NULL AND c.end_date < CURRENT_DATE) AS "pastDue",
            (SELECT count(*) FROM document_links dl
              WHERE dl.entity_type='contract' AND dl.entity_id=c.id)::int AS "documentCount"
     FROM contracts c
     JOIN clients cl ON cl.id = c.client_id
     LEFT JOIN quotations q ON q.id = c.quotation_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY c.created_at DESC`, params);
  return res.rows;
}

export async function getContract(id: number) {
  const res = await pool.query(
    `SELECT c.*, cl.name AS client_name, cl.tax_id AS client_tax_id,
            q.quotation_number
     FROM contracts c
     JOIN clients cl ON cl.id = c.client_id
     LEFT JOIN quotations q ON q.id = c.quotation_id
     WHERE c.id=$1`, [id]);
  if (!res.rowCount) throw new NotFoundError("合約");

  const docs = await pool.query(
    `SELECT d.id, d.original_filename AS "filename", d.byte_size AS "byteSize",
            d.uploaded_at AS "uploadedAt", l.id AS "linkId", l.link_role AS "role"
     FROM document_links l JOIN documents d ON d.id = l.document_id
     WHERE l.entity_type='contract' AND l.entity_id=$1 AND d.deleted_at IS NULL`, [id]);

  return { ...res.rows[0], documents: docs.rows };
}

export async function createContract(
  input: {
    clientId: number; companyId: number; quotationId?: number | null;
    templateId?: number | null; contractType: string; title: string;
    content: string; startDate?: string | null; endDate?: string | null;
    totalAmount?: number | null; billingCycle?: string | null;
    billingAmount?: number | null; depositAmount?: number | null; notes?: string | null;
  },
  actor: Actor,
) {
  if (!input.title?.trim()) throw new ValidationError("合約標題為必填");
  if (!input.content?.trim()) throw new ValidationError("合約內容為必填");
  if (input.startDate && input.endDate && input.endDate < input.startDate) {
    throw new ValidationError("結束日期不能早於開始日期");
  }

  // 跟報價一樣：併發建立可能撞號，靠 unique index 兜底、撞到就換號重試。
  const MAX_RETRIES = 5;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await transaction(async client => {
        const today = new Date().toISOString().slice(0, 10);
        const { contractPrefix } = await getSettings();
        const number = await nextContractNumber(client as never, today, contractPrefix);

        const res = await client.query(
          `INSERT INTO contracts
             (contract_number, company_id, client_id, quotation_id, template_id,
              contract_type, title, content, start_date, end_date, total_amount,
              billing_cycle, billing_amount, deposit_amount, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
          [number, input.companyId, input.clientId, input.quotationId ?? null,
           input.templateId ?? null, input.contractType, input.title.trim(), input.content,
           input.startDate ?? null, input.endDate ?? null, input.totalAmount ?? null,
           input.billingCycle ?? null, input.billingAmount ?? null,
           input.depositAmount ?? null, input.notes ?? null, actor.userId]);

        await audit(client, actor, "contract", res.rows[0].id, "create",
          { contractNumber: number, type: input.contractType });
        return res.rows[0];
      });
    } catch (err) {
      if ((err as { code?: string }).code === "23505" && attempt < MAX_RETRIES) continue;
      throw err;
    }
  }
}

export async function updateContract(
  id: number,
  patch: Record<string, unknown>,
  actor: Actor,
) {
  return transaction(async client => {
    const res = await client.query("SELECT * FROM contracts WHERE id=$1 FOR UPDATE", [id]);
    if (!res.rowCount) throw new NotFoundError("合約");
    const before = res.rows[0];

    if (before.locked_at) {
      throw new ConflictError(
        `這份合約已於 ${new Date(before.locked_at).toLocaleDateString("zh-TW")} 鎖定` +
        `（狀態：${before.status}），內容不能再修改。已簽署的合約要改，` +
        `法律上應該簽補充協議而不是改原本那份。`);
    }

    const map: Record<string, string> = {
      title: "title", content: "content", startDate: "start_date", endDate: "end_date",
      totalAmount: "total_amount", billingCycle: "billing_cycle",
      billingAmount: "billing_amount", depositAmount: "deposit_amount", notes: "notes",
    };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [key, column] of Object.entries(map)) {
      if (patch[key] !== undefined) { params.push(patch[key]); sets.push(`${column}=$${params.length}`); }
    }
    if (!sets.length) return { id, unchanged: true };
    params.push(id);
    await client.query(
      `UPDATE contracts SET ${sets.join(", ")}, updated_at=now() WHERE id=$${params.length}`, params);

    await audit(client, actor, "contract", id, "update", { fields: Object.keys(patch) });
    return { id, updated: Object.keys(patch) };
  });
}

export async function changeContractStatus(
  id: number, to: ContractStatus, actor: Actor,
  options: { signedAt?: string; reason?: string } = {},
) {
  if (!CONTRACT_STATUS.includes(to)) throw new ValidationError(`未知的合約狀態：${to}`);

  return transaction(async client => {
    const res = await client.query("SELECT * FROM contracts WHERE id=$1 FOR UPDATE", [id]);
    if (!res.rowCount) throw new NotFoundError("合約");
    const before = res.rows[0];
    const from = before.status as ContractStatus;

    if (from === to) return { id, status: to, unchanged: true };
    if (!canTransitionContract(from, to)) {
      throw new ConflictError(`不允許把合約狀態從「${from}」改成「${to}」`, { from, to });
    }

    const shouldLock = LOCKED_CONTRACT_STATUSES.includes(to);
    await client.query(
      `UPDATE contracts
       SET status=$1,
           signed_at = CASE WHEN $1='signed' THEN COALESCE(signed_at, $2::date) ELSE signed_at END,
           locked_at = CASE WHEN $3::boolean THEN COALESCE(locked_at, now()) ELSE locked_at END,
           updated_at = now()
       WHERE id=$4`,
      [to, options.signedAt ?? new Date().toISOString().slice(0, 10), shouldLock, id]);

    await audit(client, actor, "contract", id, "status_change", { from, to, reason: options.reason });
    return { id, status: to, locked: shouldLock };
  });
}

async function audit(
  client: { query: typeof pool.query },
  actor: Actor, entityType: string, entityId: number, action: string, changes?: unknown,
) {
  await client.query(
    `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [actor.userId, actor.label, entityType, entityId, action,
     changes ? JSON.stringify(changes) : null]);
}
