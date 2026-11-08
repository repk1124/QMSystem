/**
 * 單據編號產生 —— 序號制，取代原本的隨機碼。
 *
 * 問題背景：報價單號／合約編號／客戶編號原本都用 `Math.random()`，
 * 且完全沒有查重。一天約 38 張報價單就有 >50% 機率撞號
 * （生日問題：1000 個槽位），而編號同時也是 PDF 的檔名，
 * 撞號會讓下載的檔案互相覆蓋、客戶端對不上單。
 *
 * 改為：掃描既有編號，取出同一天（或同一月）的最大流水號 +1。
 * 這在單一使用者的情境下可保證唯一；多人同時建立時仍可能碰撞，
 * 因此另外提供 `ensureUniqueNumber()` 做最終防呆。
 */

import { localDateKey } from './dateUtils';

/**
 * 預設前綴。實際使用的前綴以系統設定（/api/settings 的 quotationPrefix、
 * contractPrefix）為準；這兩個常數只是設定讀不到時的退路。
 */
export const DEFAULT_QUOTATION_PREFIX = 'QT';
export const DEFAULT_CONTRACT_PREFIX = 'CNT';

function dateStamp(date: Date = new Date()): string {
  return localDateKey(date).replace(/-/g, '');
}

/**
 * 從既有編號中找出「同前綴同日期」的最大流水號，回傳下一號。
 *
 * @param existingNumbers 目前資料庫中所有的編號（可含 undefined）
 * @param prefix          編號前綴（例如 QT / CNT）
 * @param date            要產生的日期，預設今天
 * @param padding         流水號位數，預設 3（001 ~ 999）
 */
export function nextSequentialNumber(
  existingNumbers: Array<string | undefined | null>,
  prefix: string,
  date: Date = new Date(),
  padding = 3,
): string {
  const stamp = dateStamp(date);
  // 例如 ^QT-20260811-(\d+)$
  const pattern = new RegExp(`^${prefix}-${stamp}-(\\d+)$`);

  let max = 0;
  for (const raw of existingNumbers) {
    if (!raw) continue;
    const match = pattern.exec(String(raw).trim());
    if (!match) continue;
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }

  const next = max + 1;
  return `${prefix}-${stamp}-${String(next).padStart(padding, '0')}`;
}

/**
 * 最終防呆：若產生的編號仍與既有編號重複（例如多人同時建立），
 * 就往後遞增直到找到沒被使用的號碼。
 */
export function ensureUniqueNumber(
  candidate: string,
  existingNumbers: Array<string | undefined | null>,
): string {
  const used = new Set(
    existingNumbers.filter(Boolean).map(n => String(n).trim()),
  );
  if (!used.has(candidate)) return candidate;

  const match = /^(.*-)(\d+)$/.exec(candidate);
  if (!match) {
    // 沒有可遞增的尾碼，退回加上時間毫秒以保證唯一
    return `${candidate}-${Date.now() % 100000}`;
  }

  const [, head, tail] = match;
  const padding = tail.length;
  let n = parseInt(tail, 10);

  // 上限保護：避免資料異常時無窮迴圈
  for (let guard = 0; guard < 10000; guard++) {
    n += 1;
    const next = `${head}${String(n).padStart(padding, '0')}`;
    if (!used.has(next)) return next;
  }

  return `${head}${Date.now() % 100000}`;
}

/**
 * 產生客戶編號：客戶名稱前 3 字 + 年月 + 同月流水號。
 * 例如「範例公-260801」。
 */
export function nextCustomerCode(
  clientName: string,
  existingCodes: Array<string | undefined | null>,
  date: Date = new Date(),
): string {
  const name = String(clientName ?? '').trim();
  if (!name) return '';

  const prefix = name.substring(0, 3);
  const yearMonth =
    String(date.getFullYear() % 100).padStart(2, '0') +
    String(date.getMonth() + 1).padStart(2, '0');

  // 同一個客戶前綴 + 同年月的既有流水號
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}-${yearMonth}(\\d+)$`);

  let max = 0;
  for (const raw of existingCodes) {
    if (!raw) continue;
    const match = pattern.exec(String(raw).trim());
    if (!match) continue;
    const n = parseInt(match[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }

  return `${prefix}-${yearMonth}${String(max + 1).padStart(2, '0')}`;
}
