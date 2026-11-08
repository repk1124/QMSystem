/**
 * 報價資料層。
 *
 * 所有「不能被繞過」的規則都放在這裡，而不是路由或前端：
 *   - 已鎖定的版本不能改（accepted / superseded / voided / expired）
 *   - 狀態只能照狀態機轉移
 *   - 金額一律由品項重算，不接受前端傳進來的總額
 *   - 每一次異動都寫稽核紀錄
 *
 * 舊系統這些規則散在前端，只要有人直接打 API 就全部失效。
 */

import type { PoolClient } from "pg";
import { pool, transaction } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { getSettings } from "./settings";
import {
  canTransition, canTransitionFulfillment, LOCKED_STATUSES,
  QUOTATION_STATUS, FULFILLMENT_STATUS,
  type QuotationStatus, type FulfillmentStatus,
} from "../../shared/schema";

export const TAX_RATE = 0.05;

export interface LineItemInput {
  productId?: number | null;
  productName: string;
  specification?: string | null;
  unit?: string | null;
  quantity: number;
  unitPrice: number;
  unitCost?: number | null;
}

export interface QuotationDraft {
  clientId: number;
  companyId: number;
  quotationDate: string;
  validUntil?: string | null;
  subject?: string | null;
  clientContactId?: number | null;
  ourContactName?: string | null;
  ourContactEmail?: string | null;
  ourContactPhone?: string | null;
  notes?: string | null;
  requireSignature?: boolean;
  taxAdjustment?: number;
  lineItems: LineItemInput[];
}

export interface Actor {
  userId: number | null;
  label: string;
  ip?: string | null;
  userAgent?: string | null;
}

/* ── 金額計算 ────────────────────────────────────────────
   跟前端 lib/calc.ts 用同一套規則，但這裡才是有效力的那份。
   前端算的只是即時預覽，存檔時一律以伺服器重算的為準。 */

export function computeTotals(items: LineItemInput[], taxAdjustment = 0) {
  let subtotal = 0;
  let totalCost = 0;
  let hasCost = false;

  for (const item of items) {
    const qty = safeNumber(item.quantity);
    const price = safeNumber(item.unitPrice);
    subtotal += Math.round(qty * price);
    if (item.unitCost != null) {
      hasCost = true;
      totalCost += Math.round(qty * safeNumber(item.unitCost));
    }
  }

  const adjustment = Math.round(safeNumber(taxAdjustment));
  const baseTax = Math.round(subtotal * TAX_RATE);
  const taxAmount = baseTax + adjustment;

  return {
    subtotal,
    baseTax,
    taxAdjustment: adjustment,
    taxAmount,
    totalAmount: subtotal + taxAmount,
    totalCost: hasCost ? totalCost : null,
    marginPercent: hasCost && subtotal > 0
      ? Math.round(((subtotal - totalCost) / subtotal) * 10000) / 100
      : null,
  };
}

function safeNumber(v: unknown): number {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/* ── 稽核 ──────────────────────────────────────────────── */

async function audit(
  client: PoolClient,
  actor: Actor,
  entityType: string,
  entityId: number | null,
  action: string,
  changes?: unknown,
) {
  await client.query(
    `INSERT INTO audit_log
       (actor_user_id, actor_label, entity_type, entity_id, action, changes, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      actor.userId, actor.label, entityType, entityId, action,
      changes ? JSON.stringify(changes) : null,
      actor.ip ?? null, actor.userAgent ?? null,
    ],
  );
}

/* ── 編號產生 ──────────────────────────────────────────── */

/**
 * 產生報價編號 <前綴>-YYYYMMDD-NNN（前綴來自系統設定，預設 QT）。
 *
 * 舊系統用 Math.random() 產生後三碼，一天開到 38 張時碰撞機率就超過 50%。
 * 改成查當天已用過的號碼取下一個，並且在同一個交易裡做，
 * 靠 quotation_number 的 unique index 兜底。
 */
export async function nextQuotationNumber(
  client: PoolClient,
  date: string,
  prefix = "QT",
): Promise<string> {
  const compact = date.replace(/-/g, "");
  const res = await client.query<{ quotation_number: string }>(
    `SELECT quotation_number FROM quotations
     WHERE quotation_number LIKE $1
     ORDER BY quotation_number DESC LIMIT 1`,
    [`${prefix}-${compact}-%`],
  );

  let next = 1;
  if (res.rowCount) {
    const tail = res.rows[0].quotation_number.split("-").pop() ?? "0";
    next = parseInt(tail, 10) + 1;
  }
  return `${prefix}-${compact}-${String(next).padStart(3, "0")}`;
}

/* ── 建立 ──────────────────────────────────────────────── */

export async function createQuotation(draft: QuotationDraft, actor: Actor) {
  if (!draft.lineItems?.length) {
    throw new ValidationError("報價至少要有一個品項");
  }

  // 同一天兩張報價同時建立時，兩邊可能算出同一個流水號。
  // unique index 會擋掉重複，但被擋的那一筆會整個交易失敗（500）。
  // 這裡遇到唯一鍵衝突就重新產號重試幾次，讓併發也能順利建立。
  const MAX_RETRIES = 5;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await transaction(async client => {
        const { quotationPrefix } = await getSettings();
        const number = await nextQuotationNumber(client, draft.quotationDate, quotationPrefix);

        const qres = await client.query<{ id: number }>(
          `INSERT INTO quotations
             (quotation_number, company_id, client_id, owner_user_id, created_by, fulfillment_status)
           VALUES ($1,$2,$3,$4,$4,'not_started') RETURNING id`,
          [number, draft.companyId, draft.clientId, actor.userId],
        );
        const quotationId = qres.rows[0].id;

        const versionId = await insertVersion(client, quotationId, 1, draft, actor);

        await client.query(
          "UPDATE quotations SET current_version_id=$1 WHERE id=$2",
          [versionId, quotationId],
        );
        await audit(client, actor, "quotation", quotationId, "create", { quotationNumber: number });

        return { id: quotationId, quotationNumber: number, versionId };
      });
    } catch (err) {
      // 23505 = unique_violation（撞號）。還有重試次數就換號再試。
      if ((err as { code?: string }).code === "23505" && attempt < MAX_RETRIES) continue;
      throw err;
    }
  }
}

/** 把客戶當下的資料快照進版本，之後客戶主檔改名也不會動到已寄出的報價 */
async function insertVersion(
  client: PoolClient,
  quotationId: number,
  versionNumber: number,
  draft: QuotationDraft,
  actor: Actor,
): Promise<number> {
  const cres = await client.query(
    "SELECT name, tax_id, address FROM clients WHERE id=$1",
    [draft.clientId],
  );
  if (!cres.rowCount) throw new NotFoundError("客戶");
  const c = cres.rows[0];

  let contact = { name: null as string | null, email: null as string | null, phone: null as string | null };
  if (draft.clientContactId) {
    const pres = await client.query(
      "SELECT name, email, phone FROM client_contacts WHERE id=$1 AND client_id=$2",
      [draft.clientContactId, draft.clientId],
    );
    if (pres.rowCount) contact = pres.rows[0];
  }

  const totals = computeTotals(draft.lineItems, draft.taxAdjustment ?? 0);

  const vres = await client.query<{ id: number }>(
    `INSERT INTO quotation_versions (
       quotation_id, version_number, status, quotation_date, valid_until, subject,
       client_name_snapshot, client_tax_id_snapshot, client_address_snapshot,
       client_contact_id, client_contact_name_snapshot,
       client_contact_email_snapshot, client_contact_phone_snapshot,
       our_contact_name, our_contact_email, our_contact_phone,
       subtotal, tax_rate, tax_amount, tax_adjustment, total_amount,
       total_cost, margin_percent, notes, require_signature, created_by
     ) VALUES (
       $1,$2,'draft',$3,$4,$5,
       $6,$7,$8,
       $9,$10,$11,$12,
       $13,$14,$15,
       $16,$17,$18,$19,$20,
       $21,$22,$23,$24,$25
     ) RETURNING id`,
    [
      quotationId, versionNumber, draft.quotationDate, draft.validUntil ?? null, draft.subject ?? null,
      c.name, c.tax_id, c.address,
      draft.clientContactId ?? null, contact.name, contact.email, contact.phone,
      draft.ourContactName ?? null, draft.ourContactEmail ?? null, draft.ourContactPhone ?? null,
      totals.subtotal, TAX_RATE, totals.taxAmount, totals.taxAdjustment, totals.totalAmount,
      totals.totalCost, totals.marginPercent, draft.notes ?? null,
      draft.requireSignature ?? false, actor.userId,
    ],
  );
  const versionId = vres.rows[0].id;

  let sort = 0;
  for (const item of draft.lineItems) {
    const qty = safeNumber(item.quantity);
    const price = safeNumber(item.unitPrice);
    await client.query(
      `INSERT INTO quotation_items
         (version_id, sort_order, product_id, product_name, specification, unit,
          quantity, unit_price, amount, unit_cost)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        versionId, sort, item.productId ?? null, item.productName,
        item.specification ?? null, item.unit ?? null,
        qty, price, Math.round(qty * price), item.unitCost ?? null,
      ],
    );
    sort += 1;
  }

  await client.query(
    `INSERT INTO quotation_status_history
       (quotation_id, version_id, scope, from_status, to_status, reason, changed_by)
     VALUES ($1,$2,'quote',NULL,'draft',$3,$4)`,
    [quotationId, versionId, versionNumber === 1 ? "建立報價" : `建立第 ${versionNumber} 版`, actor.userId],
  );

  return versionId;
}

/* ── 修改 ──────────────────────────────────────────────── */

async function loadVersionForWrite(client: PoolClient, versionId: number) {
  const res = await client.query(
    `SELECT v.*, q.id AS q_id, q.quotation_number
     FROM quotation_versions v
     JOIN quotations q ON q.id = v.quotation_id
     WHERE v.id = $1 FOR UPDATE OF v`,
    [versionId],
  );
  if (!res.rowCount) throw new NotFoundError("報價版本");
  return res.rows[0];
}

/**
 * 修改現有版本。已鎖定的版本會被擋下 —— 這是舊系統最大的洞：
 * 客戶簽回之後還能把價格改掉，而且完全沒有紀錄。
 */
export async function updateVersion(
  versionId: number,
  patch: Partial<QuotationDraft>,
  actor: Actor,
) {
  return transaction(async client => {
    const v = await loadVersionForWrite(client, versionId);

    if (v.locked_at) {
      throw new ConflictError(
        `這個版本已於 ${new Date(v.locked_at).toLocaleDateString("zh-TW")} 鎖定（狀態：${v.status}），不能再修改。` +
        `若要調整內容，請建立新版本。`,
        { versionId, status: v.status, lockedAt: v.locked_at },
      );
    }
    if (LOCKED_STATUSES.includes(v.status as QuotationStatus)) {
      throw new ConflictError(`狀態為 ${v.status} 的版本不能修改`);
    }

    const before = {
      subtotal: v.subtotal, taxAmount: v.tax_amount, totalAmount: v.total_amount,
      notes: v.notes, subject: v.subject,
    };

    // 品項有傳就整批換掉，並重算金額
    let totals: ReturnType<typeof computeTotals> | null = null;
    if (patch.lineItems) {
      if (!patch.lineItems.length) throw new ValidationError("報價至少要有一個品項");
      await client.query("DELETE FROM quotation_items WHERE version_id=$1", [versionId]);
      let sort = 0;
      for (const item of patch.lineItems) {
        const qty = safeNumber(item.quantity);
        const price = safeNumber(item.unitPrice);
        await client.query(
          `INSERT INTO quotation_items
             (version_id, sort_order, product_id, product_name, specification, unit,
              quantity, unit_price, amount, unit_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            versionId, sort, item.productId ?? null, item.productName,
            item.specification ?? null, item.unit ?? null,
            qty, price, Math.round(qty * price), item.unitCost ?? null,
          ],
        );
        sort += 1;
      }
      totals = computeTotals(
        patch.lineItems,
        patch.taxAdjustment ?? safeNumber(v.tax_adjustment),
      );
    } else if (patch.taxAdjustment != null) {
      // 只改稅額調整時，要用現有品項重算
      const items = await client.query(
        "SELECT quantity, unit_price AS \"unitPrice\", unit_cost AS \"unitCost\", product_name AS \"productName\" FROM quotation_items WHERE version_id=$1",
        [versionId],
      );
      totals = computeTotals(items.rows as LineItemInput[], patch.taxAdjustment);
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, value: unknown) => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };

    if (patch.subject !== undefined) set("subject", patch.subject);
    if (patch.notes !== undefined) set("notes", patch.notes);
    if (patch.validUntil !== undefined) set("valid_until", patch.validUntil);
    if (patch.quotationDate !== undefined) set("quotation_date", patch.quotationDate);
    if (patch.requireSignature !== undefined) set("require_signature", patch.requireSignature);
    if (patch.ourContactName !== undefined) set("our_contact_name", patch.ourContactName);
    if (patch.ourContactEmail !== undefined) set("our_contact_email", patch.ourContactEmail);
    if (patch.ourContactPhone !== undefined) set("our_contact_phone", patch.ourContactPhone);
    if (totals) {
      set("subtotal", totals.subtotal);
      set("tax_amount", totals.taxAmount);
      set("tax_adjustment", totals.taxAdjustment);
      set("total_amount", totals.totalAmount);
      set("total_cost", totals.totalCost);
      set("margin_percent", totals.marginPercent);
    }
    set("updated_at", new Date());

    params.push(versionId);
    await client.query(
      `UPDATE quotation_versions SET ${sets.join(", ")} WHERE id = $${params.length}`,
      params,
    );

    await audit(client, actor, "quotation_version", versionId, "update", {
      before,
      after: totals
        ? { subtotal: totals.subtotal, taxAmount: totals.taxAmount, totalAmount: totals.totalAmount }
        : undefined,
      fields: Object.keys(patch),
    });

    return { versionId, totals };
  });
}

/**
 * 建立新版本。
 * 舊版本轉成 superseded 並鎖定 —— 這樣「客戶手上那版」永遠查得到。
 */
export async function createNewVersion(
  quotationId: number,
  draft: Partial<QuotationDraft>,
  actor: Actor,
) {
  return transaction(async client => {
    const qres = await client.query(
      "SELECT * FROM quotations WHERE id=$1 FOR UPDATE",
      [quotationId],
    );
    if (!qres.rowCount) throw new NotFoundError("報價");
    const quotation = qres.rows[0];

    const cur = await client.query(
      "SELECT * FROM quotation_versions WHERE id=$1",
      [quotation.current_version_id],
    );
    if (!cur.rowCount) throw new NotFoundError("目前版本");
    const current = cur.rows[0];

    if (current.status === "voided") {
      throw new ConflictError("已作廢的報價不能再開新版本");
    }

    const items = await client.query(
      `SELECT product_id AS "productId", product_name AS "productName",
              specification, unit, quantity::float8 AS quantity,
              unit_price::float8 AS "unitPrice", unit_cost::float8 AS "unitCost"
       FROM quotation_items WHERE version_id=$1 ORDER BY sort_order`,
      [current.id],
    );

    const merged: QuotationDraft = {
      clientId: quotation.client_id,
      companyId: quotation.company_id,
      quotationDate: draft.quotationDate ?? current.quotation_date,
      validUntil: draft.validUntil ?? current.valid_until,
      subject: draft.subject ?? current.subject,
      clientContactId: draft.clientContactId ?? current.client_contact_id,
      ourContactName: draft.ourContactName ?? current.our_contact_name,
      ourContactEmail: draft.ourContactEmail ?? current.our_contact_email,
      ourContactPhone: draft.ourContactPhone ?? current.our_contact_phone,
      notes: draft.notes ?? current.notes,
      requireSignature: draft.requireSignature ?? current.require_signature,
      taxAdjustment: draft.taxAdjustment ?? safeNumber(current.tax_adjustment),
      lineItems: draft.lineItems ?? (items.rows as LineItemInput[]),
    };

    const nextNumber = current.version_number + 1;
    const versionId = await insertVersion(client, quotationId, nextNumber, merged, actor);

    // 舊版本標記為被取代並鎖定
    await client.query(
      `UPDATE quotation_versions
       SET status='superseded', locked_at=COALESCE(locked_at, now()), locked_by=$1, updated_at=now()
       WHERE id=$2`,
      [actor.userId, current.id],
    );
    await client.query(
      `INSERT INTO quotation_status_history
         (quotation_id, version_id, scope, from_status, to_status, reason, changed_by)
       VALUES ($1,$2,'quote',$3,'superseded',$4,$5)`,
      [quotationId, current.id, current.status, `被第 ${nextNumber} 版取代`, actor.userId],
    );

    await client.query(
      "UPDATE quotations SET current_version_id=$1, updated_at=now() WHERE id=$2",
      [versionId, quotationId],
    );
    await audit(client, actor, "quotation", quotationId, "new_version", {
      from: current.version_number, to: nextNumber,
    });

    return { versionId, versionNumber: nextNumber };
  });
}

/* ── 狀態轉移 ──────────────────────────────────────────── */

export async function changeQuoteStatus(
  versionId: number,
  to: QuotationStatus,
  actor: Actor,
  reason?: string,
) {
  if (!QUOTATION_STATUS.includes(to)) {
    throw new ValidationError(`未知的報價狀態：${to}`);
  }

  return transaction(async client => {
    const v = await loadVersionForWrite(client, versionId);
    const from = v.status as QuotationStatus;

    if (from === to) return { versionId, status: to, unchanged: true };

    if (!canTransition(from, to)) {
      throw new ConflictError(
        `不允許把狀態從「${from}」改成「${to}」。`,
        { from, to },
      );
    }

    const shouldLock = LOCKED_STATUSES.includes(to);
    await client.query(
      `UPDATE quotation_versions
       SET status=$1,
           locked_at = CASE WHEN $2::boolean THEN COALESCE(locked_at, now()) ELSE locked_at END,
           locked_by = CASE WHEN $2::boolean THEN COALESCE(locked_by, $3) ELSE locked_by END,
           voided_at = CASE WHEN $1='voided' THEN now() ELSE voided_at END,
           void_reason = CASE WHEN $1='voided' THEN $4 ELSE void_reason END,
           updated_at = now()
       WHERE id=$5`,
      [to, shouldLock, actor.userId, reason ?? null, versionId],
    );

    await client.query(
      `INSERT INTO quotation_status_history
         (quotation_id, version_id, scope, from_status, to_status, reason, changed_by)
       VALUES ($1,$2,'quote',$3,$4,$5,$6)`,
      [v.quotation_id, versionId, from, to, reason ?? null, actor.userId],
    );

    // 客戶接受了，履約自然就開始了
    if (to === "accepted") {
      const q = await client.query(
        "SELECT fulfillment_status FROM quotations WHERE id=$1",
        [v.quotation_id],
      );
      if (q.rows[0]?.fulfillment_status === "not_started") {
        await client.query(
          "UPDATE quotations SET fulfillment_status='in_progress', updated_at=now() WHERE id=$1",
          [v.quotation_id],
        );
        await client.query(
          `INSERT INTO quotation_status_history
             (quotation_id, version_id, scope, from_status, to_status, reason, changed_by)
           VALUES ($1,NULL,'fulfillment','not_started','in_progress','客戶接受報價，自動開始履約',$2)`,
          [v.quotation_id, actor.userId],
        );
      }
    }

    await audit(client, actor, "quotation_version", versionId, "status_change", { from, to, reason });
    return { versionId, status: to, locked: shouldLock };
  });
}

export async function changeFulfillmentStatus(
  quotationId: number,
  to: FulfillmentStatus,
  actor: Actor,
  options: { reason?: string; milestoneDate?: string } = {},
) {
  if (!FULFILLMENT_STATUS.includes(to)) {
    throw new ValidationError(`未知的履約進度：${to}`);
  }

  return transaction(async client => {
    const res = await client.query(
      "SELECT * FROM quotations WHERE id=$1 FOR UPDATE",
      [quotationId],
    );
    if (!res.rowCount) throw new NotFoundError("報價");
    const q = res.rows[0];
    const from = q.fulfillment_status as FulfillmentStatus;

    if (from === to) return { quotationId, fulfillmentStatus: to, unchanged: true };

    if (!canTransitionFulfillment(from, to)) {
      throw new ConflictError(
        `不允許把履約進度從「${from}」改成「${to}」。`,
        { from, to },
      );
    }

    // 履約只能在「客戶已接受」之後才推進。
    // 沒有這道關卡的話，一張還在草稿的報價可以被一路標成已交付、已收款、已結案，
    // 等於幫一筆客戶根本沒答應的案子記錄了交貨與收款。
    // （唯一例外：把卡住的案子收尾成 canceled 不需要先接受。）
    if (to !== "canceled") {
      const cv = await client.query(
        `SELECT status FROM quotation_versions WHERE id=$1`,
        [q.current_version_id],
      );
      const versionStatus = cv.rows[0]?.status;
      if (versionStatus !== "accepted") {
        throw new ConflictError(
          "這張報價還沒有「客戶已接受」，不能推進履約進度。請先在報價狀態把它標成已接受。",
          { quotationStatus: versionStatus, attempted: to },
        );
      }
    }

    // 里程碑日期。沒指定就用今天。
    const dateColumn: Partial<Record<FulfillmentStatus, string>> = {
      delivered: "delivered_at",
      inspected: "inspected_at",
      invoiced: "invoiced_at",
      paid: "paid_at",
      closed: "closed_at",
    };
    const column = dateColumn[to];
    const stamp = options.milestoneDate ?? new Date().toISOString().slice(0, 10);

    await client.query(
      `UPDATE quotations
       SET fulfillment_status=$1${column ? `, ${column}=COALESCE(${column}, $3)` : ""}, updated_at=now()
       WHERE id=$2`,
      column ? [to, quotationId, stamp] : [to, quotationId],
    );

    await client.query(
      `INSERT INTO quotation_status_history
         (quotation_id, version_id, scope, from_status, to_status, reason, changed_by)
       VALUES ($1,NULL,'fulfillment',$2,$3,$4,$5)`,
      [quotationId, from, to, options.reason ?? null, actor.userId],
    );
    await audit(client, actor, "quotation", quotationId, "fulfillment_change", { from, to });

    return { quotationId, fulfillmentStatus: to };
  });
}

/* ── 查詢 ──────────────────────────────────────────────── */

export interface ListFilters {
  search?: string;
  status?: string;
  fulfillmentStatus?: string;
  clientId?: number;
  /** 只看還在跑的案子 */
  openOnly?: boolean;
  limit?: number;
  offset?: number;
}

export async function listQuotations(filters: ListFilters = {}, canSeeCost = false) {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (clause: string, value: unknown) => {
    params.push(value);
    where.push(clause.replace("?", `$${params.length}`));
  };

  if (filters.search) {
    params.push(`%${filters.search}%`);
    const p = `$${params.length}`;
    where.push(`(q.quotation_number ILIKE ${p} OR v.client_name_snapshot ILIKE ${p} OR v.subject ILIKE ${p})`);
  }
  if (filters.status) add("v.status = ?", filters.status);
  if (filters.fulfillmentStatus) add("q.fulfillment_status = ?", filters.fulfillmentStatus);
  if (filters.clientId) add("q.client_id = ?", filters.clientId);
  if (filters.openOnly) {
    where.push("q.fulfillment_status IN ('in_progress','delivered','inspected','invoiced','on_hold')");
  }

  const limit = Math.min(filters.limit ?? 50, 200);
  const offset = filters.offset ?? 0;

  const sql = `
    SELECT
      q.id, q.quotation_number AS "quotationNumber",
      q.fulfillment_status AS "fulfillmentStatus",
      q.delivered_at AS "deliveredAt", q.inspected_at AS "inspectedAt",
      q.invoiced_at AS "invoicedAt", q.paid_at AS "paidAt", q.closed_at AS "closedAt",
      v.id AS "versionId", v.version_number AS "versionNumber", v.status,
      v.quotation_date AS "quotationDate", v.valid_until AS "validUntil",
      v.subject, v.client_name_snapshot AS "clientName",
      v.subtotal, v.tax_amount AS "taxAmount", v.total_amount AS "totalAmount",
      ${canSeeCost ? 'v.total_cost AS "totalCost", v.margin_percent AS "marginPercent",' : ""}
      (v.locked_at IS NOT NULL) AS locked,
      c.id AS "clientId", c.name AS "clientCurrentName",
      (SELECT count(*) FROM quotation_items i WHERE i.version_id = v.id)::int AS "itemCount",
      (SELECT count(*) FROM document_links dl
        WHERE dl.entity_type='quotation' AND dl.entity_id=q.id
          AND dl.verification_status='suspect')::int AS "suspectDocuments"
    FROM quotations q
    JOIN quotation_versions v ON v.id = q.current_version_id
    JOIN clients c ON c.id = q.client_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY v.quotation_date DESC, q.id DESC
    LIMIT ${limit} OFFSET ${offset}`;

  const rows = await pool.query(sql, params);

  const countSql = `
    SELECT count(*)::int AS total
    FROM quotations q
    JOIN quotation_versions v ON v.id = q.current_version_id
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`;
  const count = await pool.query<{ total: number }>(countSql, params);

  return { items: rows.rows, total: count.rows[0].total, limit, offset };
}

export async function getQuotation(id: number, canSeeCost = false) {
  const q = await pool.query(
    `SELECT q.*, c.name AS client_current_name, c.tax_id AS client_tax_id,
            c.code AS client_code, c.address AS client_address, c.phone AS client_phone
     FROM quotations q JOIN clients c ON c.id=q.client_id WHERE q.id=$1`,
    [id],
  );
  if (!q.rowCount) throw new NotFoundError("報價");

  const versions = await pool.query(
    // 快照欄位一定要全部回傳 —— PDF 是用這些欄位印的，少一個
    // 客戶地址或聯絡電話就會在報價單上開天窗。
    `SELECT id, version_number AS "versionNumber", status, quotation_date AS "quotationDate",
            valid_until AS "validUntil", subject,
            client_name_snapshot AS "clientName",
            client_tax_id_snapshot AS "clientTaxId",
            client_address_snapshot AS "clientAddress",
            client_contact_id AS "clientContactId",
            client_contact_name_snapshot AS "contactName",
            client_contact_email_snapshot AS "contactEmail",
            client_contact_phone_snapshot AS "contactPhone",
            our_contact_name AS "ourContactName",
            our_contact_email AS "ourContactEmail",
            our_contact_phone AS "ourContactPhone",
            subtotal, tax_rate AS "taxRate", tax_amount AS "taxAmount",
            tax_adjustment AS "taxAdjustment", total_amount AS "totalAmount",
            ${canSeeCost ? 'total_cost AS "totalCost", margin_percent AS "marginPercent",' : ""}
            notes, require_signature AS "requireSignature",
            locked_at AS "lockedAt", voided_at AS "voidedAt", void_reason AS "voidReason",
            created_at AS "createdAt", updated_at AS "updatedAt"
     FROM quotation_versions WHERE quotation_id=$1 ORDER BY version_number DESC`,
    [id],
  );

  const items = await pool.query(
    `SELECT i.*, i.version_id AS "versionId"
     FROM quotation_items i
     JOIN quotation_versions v ON v.id=i.version_id
     WHERE v.quotation_id=$1 ORDER BY i.version_id, i.sort_order`,
    [id],
  );

  const history = await pool.query(
    `SELECT scope, from_status AS "fromStatus", to_status AS "toStatus",
            reason, changed_at AS "changedAt", version_id AS "versionId"
     FROM quotation_status_history WHERE quotation_id=$1 ORDER BY changed_at, id`,
    [id],
  );

  const documents = await pool.query(
    `SELECT d.id, d.original_filename AS "filename", d.byte_size AS "byteSize",
            d.sha256, d.uploaded_at AS "uploadedAt",
            l.link_role AS "role", l.verification_status AS "verificationStatus",
            l.verification_note AS "verificationNote"
     FROM document_links l JOIN documents d ON d.id=l.document_id
     WHERE l.entity_type='quotation' AND l.entity_id=$1 AND d.deleted_at IS NULL`,
    [id],
  );

  const byVersion = new Map<number, unknown[]>();
  for (const item of items.rows) {
    if (!byVersion.has(item.versionId)) byVersion.set(item.versionId, []);
    const row = { ...item };
    if (!canSeeCost) delete (row as Record<string, unknown>).unit_cost;
    byVersion.get(item.versionId)!.push(row);
  }

  return {
    ...q.rows[0],
    versions: versions.rows.map(v => ({ ...v, items: byVersion.get(v.id) ?? [] })),
    history: history.rows,
    documents: documents.rows,
  };
}

/**
 * 刪除 = 作廢。真正的 DELETE 只在草稿且從未寄出時允許。
 * 報價是商業紀錄，隨手刪掉等於湮滅證據。
 */
export async function deleteQuotation(id: number, actor: Actor) {
  return transaction(async client => {
    const res = await client.query(
      `SELECT q.id, v.status, v.version_number
       FROM quotations q JOIN quotation_versions v ON v.id=q.current_version_id
       WHERE q.id=$1 FOR UPDATE OF q`,
      [id],
    );
    if (!res.rowCount) throw new NotFoundError("報價");
    const { status, version_number } = res.rows[0];

    const neverSent = status === "draft" && version_number === 1;
    const hasHistory = await client.query(
      `SELECT count(*)::int AS n FROM quotation_status_history
       WHERE quotation_id=$1 AND to_status IN ('sent','viewed','accepted','declined')`,
      [id],
    );

    if (!neverSent || hasHistory.rows[0].n > 0) {
      throw new ConflictError(
        "只有從未寄出的草稿可以刪除。這張報價已經有往來紀錄，請改用「作廢」保留稽核軌跡。",
        { status, versionNumber: version_number },
      );
    }

    await audit(client, actor, "quotation", id, "delete", { status });
    await client.query("DELETE FROM quotations WHERE id=$1", [id]);
    return { deleted: true };
  });
}
