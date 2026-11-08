/**
 * 系統設定（白牌化）。
 *
 * 單列表 app_settings（id = 1）。讀取走記憶體快取：報價編號、PDF、登入頁
 * 都會讀設定，不該每次都打資料庫；寫入時清掉快取即可（單一程序足夠，
 * 多副本部署時請改成每次讀取或加上 TTL）。
 */
import { pool, transaction } from "../db";
import { ValidationError } from "../errors";
import type { Actor } from "./quotations";

export interface Settings {
  appName: string;
  companyName: string;
  companyTaxId: string;
  companyAddress: string | null;
  companyPhone: string | null;
  companyEmail: string | null;
  companyPrincipal: string | null;
  logoPath: string | null;
  stampPath: string | null;
  quotationPrefix: string;
  contractPrefix: string;
  primaryColor: string | null;
  updatedAt: string;
}

export type SettingsPatch = Partial<Omit<Settings, "logoPath" | "stampPath" | "updatedAt">>;

export const SETTINGS_DEFAULTS = {
  appName: "報價管理系統",
  companyName: "範例公司",
  companyTaxId: "12345678",
  quotationPrefix: "QT",
  contractPrefix: "CNT",
} as const;

const SELECT = `
  SELECT app_name AS "appName", company_name AS "companyName",
         company_tax_id AS "companyTaxId", company_address AS "companyAddress",
         company_phone AS "companyPhone", company_email AS "companyEmail",
         company_principal AS "companyPrincipal",
         logo_path AS "logoPath", stamp_path AS "stampPath",
         quotation_prefix AS "quotationPrefix", contract_prefix AS "contractPrefix",
         primary_color AS "primaryColor", updated_at AS "updatedAt"
  FROM app_settings WHERE id = 1`;

let cache: Settings | null = null;
export const invalidateSettingsCache = () => { cache = null; };

/** 確保那一列存在（啟動時呼叫；也讓測試在空庫上能直接用） */
export async function ensureSettingsRow() {
  await pool.query(`INSERT INTO app_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
}

export async function getSettings(): Promise<Settings> {
  if (cache) return cache;
  let res = await pool.query<Settings>(SELECT);
  if (!res.rowCount) {
    await ensureSettingsRow();
    res = await pool.query<Settings>(SELECT);
  }
  cache = res.rows[0];
  return cache;
}

/** 免登入的那一小部分：登入頁與 <title> 用 */
export async function getPublicSettings() {
  const s = await getSettings();
  return {
    appName: s.appName,
    logoUrl: s.logoPath ? `/api/settings/logo?v=${Date.parse(String(s.updatedAt)) || 0}` : null,
    primaryColor: s.primaryColor,
  };
}

/** 給前端的完整設定（檔案路徑換成可取用的網址，不暴露磁碟路徑） */
export function toClientSettings(s: Settings) {
  const v = Date.parse(String(s.updatedAt)) || 0;
  return {
    appName: s.appName,
    companyName: s.companyName,
    companyTaxId: s.companyTaxId,
    companyAddress: s.companyAddress,
    companyPhone: s.companyPhone,
    companyEmail: s.companyEmail,
    companyPrincipal: s.companyPrincipal,
    logoUrl: s.logoPath ? `/api/settings/logo?v=${v}` : null,
    stampUrl: s.stampPath ? `/api/settings/stamp?v=${v}` : null,
    quotationPrefix: s.quotationPrefix,
    contractPrefix: s.contractPrefix,
    primaryColor: s.primaryColor,
    updatedAt: s.updatedAt,
  };
}

const PREFIX_RE = /^[A-Z0-9]{1,10}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function cleanText(value: unknown, label: string, max: number, required = false): string | null {
  if (value === undefined) return undefined as never;
  if (value === null || value === "") {
    if (required) throw new ValidationError(`${label}為必填`);
    return null;
  }
  if (typeof value !== "string") throw new ValidationError(`${label}格式錯誤`);
  const v = value.trim();
  if (required && !v) throw new ValidationError(`${label}為必填`);
  if (v.length > max) throw new ValidationError(`${label}不能超過 ${max} 個字`);
  return v;
}

export async function updateSettings(input: SettingsPatch, actor: Actor) {
  const patch: Record<string, unknown> = {};
  const put = (col: string, value: unknown) => { if (value !== undefined) patch[col] = value; };

  put("app_name", cleanText(input.appName, "系統名稱", 60, true));
  put("company_name", cleanText(input.companyName, "公司名稱", 120, true));
  put("company_tax_id", cleanText(input.companyTaxId, "統一編號", 20, true));
  put("company_address", cleanText(input.companyAddress, "公司地址", 200));
  put("company_phone", cleanText(input.companyPhone, "公司電話", 40));
  put("company_email", cleanText(input.companyEmail, "公司 Email", 120));
  put("company_principal", cleanText(input.companyPrincipal, "公司負責人", 60));

  if (input.quotationPrefix !== undefined) {
    const v = String(input.quotationPrefix).trim().toUpperCase();
    if (!PREFIX_RE.test(v)) throw new ValidationError("報價編號前綴只能是 1～10 個英數字");
    patch.quotation_prefix = v;
  }
  if (input.contractPrefix !== undefined) {
    const v = String(input.contractPrefix).trim().toUpperCase();
    if (!PREFIX_RE.test(v)) throw new ValidationError("合約編號前綴只能是 1～10 個英數字");
    patch.contract_prefix = v;
  }
  if (input.primaryColor !== undefined) {
    if (input.primaryColor === null || input.primaryColor === "") patch.primary_color = null;
    else if (!COLOR_RE.test(String(input.primaryColor))) {
      throw new ValidationError("主色必須是 #rrggbb 格式");
    } else patch.primary_color = String(input.primaryColor).toLowerCase();
  }

  if (!Object.keys(patch).length) return getSettings();

  await transaction(async client => {
    const before = (await client.query<Settings>(SELECT)).rows[0];

    const cols = Object.keys(patch);
    const sets = cols.map((c, i) => `${c}=$${i + 1}`).join(", ");
    await client.query(
      `UPDATE app_settings SET ${sets}, updated_at=now() WHERE id=1`,
      cols.map(c => patch[c]),
    );

    // 預設公司跟著設定走：報價上的「我方」才會跟設定頁一致
    await client.query(
      `UPDATE companies SET
         name = COALESCE($1, name), tax_id = COALESCE($2, tax_id),
         address = CASE WHEN $3::boolean THEN $4 ELSE address END,
         phone   = CASE WHEN $5::boolean THEN $6 ELSE phone END,
         principal = CASE WHEN $7::boolean THEN $8 ELSE principal END,
         updated_at = now()
       WHERE is_default = true`,
      [
        patch.company_name ?? null, patch.company_tax_id ?? null,
        "company_address" in patch, patch.company_address ?? null,
        "company_phone" in patch, patch.company_phone ?? null,
        "company_principal" in patch, patch.company_principal ?? null,
      ],
    );

    await client.query(
      `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes, ip_address)
       VALUES ($1,$2,'settings',1,'update',$3,$4)`,
      [actor.userId, actor.label, JSON.stringify({ before: pickChanged(before, patch), after: patch }),
       actor.ip ?? null],
    );
  });

  // 一定要在 COMMIT 之後才重讀，否則快取會裝到交易前的舊值
  invalidateSettingsCache();
  return getSettings();
}

/** 只記錄有變動的欄位的舊值，稽核紀錄才不會每次整包塞進去 */
function pickChanged(before: Settings, patch: Record<string, unknown>) {
  const map: Record<string, keyof Settings> = {
    app_name: "appName", company_name: "companyName", company_tax_id: "companyTaxId",
    company_address: "companyAddress", company_phone: "companyPhone", company_email: "companyEmail",
    company_principal: "companyPrincipal",
    quotation_prefix: "quotationPrefix", contract_prefix: "contractPrefix", primary_color: "primaryColor",
  };
  const out: Record<string, unknown> = {};
  for (const col of Object.keys(patch)) {
    const key = map[col];
    if (key) out[col] = before?.[key] ?? null;
  }
  return out;
}

/** 記錄 logo / 印章檔案的相對路徑（實際寫檔在 routes 層） */
export async function setBrandingPath(kind: "logo" | "stamp", relPath: string | null, actor: Actor) {
  const col = kind === "logo" ? "logo_path" : "stamp_path";
  await pool.query(`UPDATE app_settings SET ${col}=$1, updated_at=now() WHERE id=1`, [relPath]);
  await pool.query(
    `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, changes)
     VALUES ($1,$2,'settings',1,'update',$3)`,
    [actor.userId, actor.label, JSON.stringify({ [col]: relPath })]);
  invalidateSettingsCache();
  return getSettings();
}
