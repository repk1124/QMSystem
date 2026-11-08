/**
 * 檔案資料層。
 *
 * 舊系統把 `https://<舊主機>/uploads/xxx.pdf` 整串存進
 * 報價欄位，造成兩個問題：換部署環境舊連結全失效；而且沒有任何檢查，
 * 導致 11 筆簽回檔裡有 4 筆掛到別張報價上。
 *
 * 這裡的做法：
 *   - 只存相對的 storage_key，主機名稱由讀取時組上去
 *   - 存 sha256，同一份檔案被掛到多張單據時主動標記為可疑
 *   - 刪除是軟刪除，檔案是證據不能真的消失
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { pool, transaction } from "../db";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import type { Actor } from "./quotations";

export const ALLOWED_MIME = new Map<string, string>([
  ["application/pdf", ".pdf"],
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
]);

export const MAX_BYTES = 20 * 1024 * 1024;

export interface UploadInput {
  buffer: Buffer;
  originalFilename: string;
  mimeType: string;
  kind?: string;
  storageBackend?: string;
}

export interface LinkTarget {
  entityType: "quotation" | "contract" | "order" | "invoice" | "employee";
  entityId: number;
  linkRole?: string;
}

/**
 * 產生儲存路徑。
 * 用 sha256 前 16 碼當檔名，同一份檔案上傳兩次會落在同一個 key，
 * 天然去重；按年月分資料夾避免單一目錄塞太多檔案。
 */
export function storageKeyFor(sha256: string, ext: string, when = new Date()) {
  const yyyymm = `${when.getFullYear()}${String(when.getMonth() + 1).padStart(2, "0")}`;
  return `documents/${yyyymm}/${sha256.slice(0, 16)}${ext}`;
}

export async function storeDocument(input: UploadInput, actor: Actor) {
  if (!input.buffer?.length) throw new ValidationError("檔案是空的");
  if (input.buffer.length > MAX_BYTES) {
    throw new ValidationError(`檔案超過 ${MAX_BYTES / 1024 / 1024} MB 上限`);
  }

  const ext = ALLOWED_MIME.get(input.mimeType);
  if (!ext) {
    throw new ValidationError(
      `不支援的檔案類型 ${input.mimeType}，只接受 PDF、PNG、JPEG、WebP`,
    );
  }

  // 驗證檔頭與宣稱的類型相符 —— 光看副檔名或 Content-Type 會被騙
  if (input.mimeType === "application/pdf" && input.buffer.subarray(0, 5).toString() !== "%PDF-") {
    throw new ValidationError("這個檔案不是有效的 PDF");
  }

  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const key = storageKeyFor(sha256, ext);

  return transaction(async client => {
    const existing = await client.query(
      "SELECT * FROM documents WHERE storage_key=$1",
      [key],
    );
    if (existing.rowCount) {
      // 同樣的檔案已經在了，不重複存，但要讓呼叫端知道
      return { document: existing.rows[0], deduplicated: true, sha256, storageKey: key };
    }

    const res = await client.query(
      `INSERT INTO documents
         (storage_key, storage_backend, original_filename, mime_type, byte_size, sha256, kind, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [
        key, input.storageBackend ?? "local",
        path.basename(input.originalFilename).slice(0, 200),
        input.mimeType, input.buffer.length, sha256,
        input.kind ?? "attachment", actor.userId,
      ],
    );

    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
       VALUES ($1,$2,'document',$3,'create',$4)`,
      [actor.userId, actor.label, res.rows[0].id,
       JSON.stringify({ filename: input.originalFilename, bytes: input.buffer.length, sha256 })],
    );

    return { document: res.rows[0], deduplicated: false, sha256, storageKey: key };
  });
}

/**
 * 把檔案掛到單據上。
 *
 * 如果這份檔案（同一個 sha256）已經掛在別的單據上，就標記為 suspect
 * 並回報 —— 舊資料那 4 筆掛錯的簽回檔就是這樣被找出來的。
 * 不直接擋下，因為確實有「一份驗收單涵蓋多張報價」的正當情況。
 */
export async function linkDocument(
  documentId: number,
  target: LinkTarget,
  actor: Actor,
) {
  return transaction(async client => {
    const doc = await client.query(
      "SELECT id, sha256, original_filename FROM documents WHERE id=$1 AND deleted_at IS NULL",
      [documentId],
    );
    if (!doc.rowCount) throw new NotFoundError("檔案");

    const others = await client.query(
      `SELECT l.entity_type, l.entity_id, q.quotation_number
       FROM document_links l
       LEFT JOIN quotations q ON q.id = l.entity_id AND l.entity_type='quotation'
       WHERE l.document_id IN (SELECT id FROM documents WHERE sha256=$1 AND deleted_at IS NULL)
         AND NOT (l.entity_type=$2 AND l.entity_id=$3)`,
      [doc.rows[0].sha256, target.entityType, target.entityId],
    );

    const suspect = (others.rowCount ?? 0) > 0;
    const note = suspect
      ? `同一份檔案已掛在：${others.rows.map(r => r.quotation_number ?? `${r.entity_type}#${r.entity_id}`).join("、")}，請確認是否掛錯`
      : null;

    const res = await client.query(
      `INSERT INTO document_links
         (document_id, entity_type, entity_id, link_role, verification_status, verification_note, linked_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (document_id, entity_type, entity_id, link_role) DO UPDATE
         SET verification_status = EXCLUDED.verification_status,
             verification_note = EXCLUDED.verification_note
       RETURNING *`,
      [
        documentId, target.entityType, target.entityId,
        target.linkRole ?? "attachment",
        suspect ? "suspect" : "unverified", note, actor.userId,
      ],
    );

    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
       VALUES ($1,$2,'document_link',$3,'create',$4)`,
      [actor.userId, actor.label, res.rows[0].id,
       JSON.stringify({ documentId, ...target, suspect })],
    );

    return {
      link: res.rows[0],
      suspect,
      conflictsWith: others.rows.map(r => r.quotation_number ?? `${r.entity_type}#${r.entity_id}`),
    };
  });
}

/** 人工確認這份檔案確實屬於這張單 */
export async function verifyLink(linkId: number, actor: Actor, note?: string) {
  const res = await pool.query(
    `UPDATE document_links
     SET verification_status='verified', verification_note=$1
     WHERE id=$2 RETURNING *`,
    [note ?? "已人工確認", linkId],
  );
  if (!res.rowCount) throw new NotFoundError("檔案關聯");

  await pool.query(
    `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
     VALUES ($1,$2,'document_link',$3,'verify',$4)`,
    [actor.userId, actor.label, linkId, JSON.stringify({ note })],
  );
  return res.rows[0];
}

export async function unlinkDocument(linkId: number, actor: Actor) {
  const res = await pool.query("DELETE FROM document_links WHERE id=$1 RETURNING *", [linkId]);
  if (!res.rowCount) throw new NotFoundError("檔案關聯");
  await pool.query(
    `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
     VALUES ($1,$2,'document_link',$3,'delete',$4)`,
    [actor.userId, actor.label, linkId, JSON.stringify(res.rows[0])],
  );
  return res.rows[0];
}

/** 軟刪除。檔案是證據，不真的從磁碟移除。 */
export async function softDeleteDocument(documentId: number, actor: Actor) {
  const links = await pool.query(
    "SELECT count(*)::int AS n FROM document_links WHERE document_id=$1",
    [documentId],
  );
  if (links.rows[0].n > 0) {
    throw new ConflictError(
      `這份檔案還掛在 ${links.rows[0].n} 張單據上，請先解除關聯再刪除`,
    );
  }
  const res = await pool.query(
    `UPDATE documents SET deleted_at=now(), deleted_by=$1 WHERE id=$2 AND deleted_at IS NULL RETURNING *`,
    [actor.userId, documentId],
  );
  if (!res.rowCount) throw new NotFoundError("檔案");
  return res.rows[0];
}

export async function getDocument(id: number) {
  const res = await pool.query(
    "SELECT * FROM documents WHERE id=$1 AND deleted_at IS NULL",
    [id],
  );
  if (!res.rowCount) throw new NotFoundError("檔案");
  return res.rows[0];
}

/** 這份檔案掛在哪些實體上（下載授權用） */
export async function getDocumentLinkTypes(documentId: number): Promise<string[]> {
  const res = await pool.query(
    "SELECT DISTINCT entity_type FROM document_links WHERE document_id=$1",
    [documentId],
  );
  return res.rows.map(r => r.entity_type as string);
}

/** 找出所有被標記為可疑的關聯，給待辦清單用 */
export async function listSuspectLinks() {
  const res = await pool.query(
    `SELECT l.id, l.verification_note AS "note",
            d.original_filename AS "filename", d.sha256,
            q.id AS "quotationId", q.quotation_number AS "quotationNumber",
            v.client_name_snapshot AS "clientName", v.quotation_date AS "quotationDate"
     FROM document_links l
     JOIN documents d ON d.id = l.document_id
     LEFT JOIN quotations q ON q.id = l.entity_id AND l.entity_type='quotation'
     LEFT JOIN quotation_versions v ON v.id = q.current_version_id
     WHERE l.verification_status='suspect' AND d.deleted_at IS NULL
     ORDER BY v.quotation_date`,
  );
  return res.rows;
}
