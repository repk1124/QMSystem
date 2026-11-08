/**
 * 客戶主檔資料層。
 *
 * 舊系統沒有客戶主檔，客戶資料直接重打在每張報價上，造成：
 *   - 同一個單位分裂成多個客戶（國防醫學大學 / 國防醫學院）
 *   - 客戶代號每張報價各生一組（國防醫學大學有 12 組）
 *   - 同一客戶的多個聯絡人無處可放
 */

import { pool, transaction } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { Actor } from "./quotations";

export interface ClientInput {
  name: string;
  taxId?: string | null;
  address?: string | null;
  phone?: string | null;
  category?: string | null;
  aliases?: string[];
}

/** 統編 8 碼檢查碼驗證（財政部規則） */
export function isValidTaxId(taxId: string): boolean {
  if (!/^\d{8}$/.test(taxId)) return false;
  const weights = [1, 2, 1, 2, 1, 2, 4, 1];
  const digits = taxId.split("").map(Number);

  const sumOf = (sevenAsZero: boolean) => {
    let total = 0;
    for (let i = 0; i < 8; i += 1) {
      const product = digits[i] * weights[i];
      total += Math.floor(product / 10) + (product % 10);
    }
    // 第 7 碼為 7 時，該位的乘積可視為 1 或 0（財政部 2023 起的規則）
    if (sevenAsZero && digits[6] === 7) total -= 1;
    return total;
  };

  const check = (total: number) => total % 5 === 0;
  if (digits[6] === 7) return check(sumOf(false)) || check(sumOf(true));
  return check(sumOf(false));
}

function makeCode(name: string, taxId?: string | null) {
  const prefix = (name || "").replace(/[^一-鿿A-Za-z0-9]/g, "").slice(0, 3) || "CUS";
  const suffix = (taxId || "").slice(-4) || String(Date.now()).slice(-4);
  return `${prefix}-${suffix}`;
}

export async function createClient(input: ClientInput, actor: Actor) {
  if (!input.name?.trim()) throw new ValidationError("客戶名稱為必填");

  const taxId = input.taxId?.trim() || null;
  if (taxId) {
    if (!/^\d{8}$/.test(taxId)) throw new ValidationError("統一編號必須是 8 位數字");
    if (!isValidTaxId(taxId)) throw new ValidationError("統一編號檢查碼不正確，請確認是否輸入錯誤");

    // 統編重複代表這個客戶已經存在 —— 直接擋下，這就是防止
    // 「國防醫學大學」與「國防醫學院」變成兩筆的機制
    const dup = await pool.query(
      "SELECT id, name FROM clients WHERE tax_id=$1",
      [taxId],
    );
    if (dup.rowCount) {
      throw new ConflictError(
        `統一編號 ${taxId} 已經是客戶「${dup.rows[0].name}」。` +
        `如果這是同一個單位改名，請改用更名功能而不是新增客戶。`,
        { existingClientId: dup.rows[0].id, existingName: dup.rows[0].name },
      );
    }
  }

  return transaction(async client => {
    let code = makeCode(input.name, taxId);
    // 代號碰撞時加後綴
    for (let i = 2; ; i += 1) {
      const exists = await client.query("SELECT 1 FROM clients WHERE code=$1", [code]);
      if (!exists.rowCount) break;
      code = `${makeCode(input.name, taxId)}-${i}`;
    }

    const res = await client.query(
      `INSERT INTO clients (code, name, tax_id, address, phone, category, aliases)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [code, input.name.trim(), taxId, input.address ?? null,
       input.phone ?? null, input.category ?? null, input.aliases ?? []],
    );
    const created = res.rows[0];

    await client.query(
      `INSERT INTO client_name_history (client_id, name, valid_from, note)
       VALUES ($1,$2,CURRENT_DATE,'建立客戶時的名稱')`,
      [created.id, created.name],
    );
    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
       VALUES ($1,$2,'client',$3,'create',$4)`,
      [actor.userId, actor.label, created.id, JSON.stringify({ name: created.name, taxId })],
    );

    return created;
  });
}

/**
 * 客戶更名。
 *
 * 這不是「改一個欄位」而已 —— 舊名稱要留下生效區間，這樣
 * 重印歷史報價才能顯示當時正確的名稱，開發票才能用現行名稱。
 */
export async function renameClient(
  clientId: number,
  newName: string,
  actor: Actor,
  options: { effectiveFrom?: string; reason?: string } = {},
) {
  if (!newName?.trim()) throw new ValidationError("新名稱為必填");

  return transaction(async client => {
    const res = await client.query("SELECT * FROM clients WHERE id=$1 FOR UPDATE", [clientId]);
    if (!res.rowCount) throw new NotFoundError("客戶");
    const current = res.rows[0];

    if (current.name === newName.trim()) {
      return { clientId, unchanged: true, name: current.name };
    }

    const effectiveFrom = options.effectiveFrom ?? new Date().toISOString().slice(0, 10);

    // 舊名稱收尾
    await client.query(
      `UPDATE client_name_history
       SET valid_until = $1, change_reason = COALESCE(change_reason,$2), note = '舊名稱'
       WHERE client_id = $3 AND name = $4 AND valid_until IS NULL`,
      [effectiveFrom, options.reason ?? "rename", clientId, current.name],
    );

    await client.query(
      `INSERT INTO client_name_history (client_id, name, valid_from, change_reason, note)
       VALUES ($1,$2,$3,$4,'現行名稱')
       ON CONFLICT (client_id, name) DO UPDATE
         SET valid_from = EXCLUDED.valid_from, valid_until = NULL, note = '現行名稱'`,
      [clientId, newName.trim(), effectiveFrom, options.reason ?? "rename"],
    );

    await client.query(
      `UPDATE clients
       SET name = $1,
           aliases = CASE WHEN $2 = ANY(aliases) THEN aliases ELSE array_append(aliases, $2) END,
           updated_at = now()
       WHERE id = $3`,
      [newName.trim(), current.name, clientId],
    );

    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
       VALUES ($1,$2,'client',$3,'rename',$4)`,
      [actor.userId, actor.label, clientId,
       JSON.stringify({ from: current.name, to: newName.trim(), effectiveFrom })],
    );

    return { clientId, from: current.name, to: newName.trim(), effectiveFrom };
  });
}

/** 查出某個日期當下這個客戶的正確名稱 */
export async function nameAsOf(clientId: number, onDate: string): Promise<string | null> {
  const res = await pool.query<{ name: string }>(
    `SELECT name FROM client_name_history
     WHERE client_id = $1
       AND (valid_from IS NULL OR valid_from <= $2)
       AND (valid_until IS NULL OR $2 <= valid_until)
     ORDER BY valid_from NULLS FIRST LIMIT 1`,
    [clientId, onDate],
  );
  return res.rows[0]?.name ?? null;
}

export async function listClients(search?: string) {
  const params: unknown[] = [];
  let where = "WHERE c.is_active = true";
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (c.name ILIKE $1 OR c.code ILIKE $1 OR c.tax_id ILIKE $1
                    OR EXISTS (SELECT 1 FROM unnest(c.aliases) a WHERE a ILIKE $1))`;
  }

  const res = await pool.query(
    `SELECT c.id, c.code, c.name, c.tax_id AS "taxId", c.aliases,
            c.address, c.phone, c.category,
            (SELECT count(*) FROM quotations q WHERE q.client_id=c.id)::int AS "quotationCount",
            (SELECT count(*) FROM client_contacts cc WHERE cc.client_id=c.id AND cc.is_active)::int AS "contactCount",
            (SELECT coalesce(sum(v.total_amount),0) FROM quotations q
               JOIN quotation_versions v ON v.id=q.current_version_id
              WHERE q.client_id=c.id AND v.status='accepted') AS "wonAmount"
     FROM clients c ${where}
     ORDER BY "quotationCount" DESC, c.name`,
    params,
  );
  return res.rows;
}

export async function getClient(id: number) {
  const res = await pool.query("SELECT * FROM clients WHERE id=$1", [id]);
  if (!res.rowCount) throw new NotFoundError("客戶");

  const contacts = await pool.query(
    `SELECT id, name, title, email, phone, department, is_primary AS "isPrimary"
     FROM client_contacts WHERE client_id=$1 AND is_active=true
     ORDER BY is_primary DESC, name`,
    [id],
  );
  const history = await pool.query(
    `SELECT name, valid_from AS "validFrom", valid_until AS "validUntil",
            change_reason AS "changeReason", note
     FROM client_name_history WHERE client_id=$1 ORDER BY valid_from NULLS FIRST`,
    [id],
  );

  return { ...res.rows[0], contacts: contacts.rows, nameHistory: history.rows };
}

export async function addContact(
  clientId: number,
  input: { name: string; title?: string; email?: string; phone?: string; department?: string; isPrimary?: boolean },
  actor: Actor,
) {
  if (!input.name?.trim()) throw new ValidationError("聯絡人姓名為必填");

  return transaction(async client => {
    const exists = await client.query("SELECT 1 FROM clients WHERE id=$1", [clientId]);
    if (!exists.rowCount) throw new NotFoundError("客戶");

    if (input.isPrimary) {
      await client.query(
        "UPDATE client_contacts SET is_primary=false WHERE client_id=$1",
        [clientId],
      );
    }

    const res = await client.query(
      `INSERT INTO client_contacts (client_id, name, title, email, phone, department, is_primary)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [clientId, input.name.trim(), input.title ?? null, input.email ?? null,
       input.phone ?? null, input.department ?? null, input.isPrimary ?? false],
    );

    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
       VALUES ($1,$2,'client_contact',$3,'create',$4)`,
      [actor.userId, actor.label, res.rows[0].id, JSON.stringify({ clientId, name: input.name })],
    );

    return res.rows[0];
  });
}
