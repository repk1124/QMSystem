/**
 * 日期處理 —— 全系統唯一來源。
 *
 * 問題背景：`new Date("2026-08-11")` 依規格會被當成 **UTC 午夜** 解析，
 * 之後用 `toLocaleDateString()` 以本地時區格式化，就會差一天。
 * 同理 `new Date().toISOString().split('T')[0]` 拿到的是 UTC 日期，
 * 台北（UTC+8）在早上 8 點前執行會少一天。
 *
 * 這裡提供以「本地時區」為準的解析與格式化，所有畫面與 PDF 共用。
 */

/** 取得本地時區的 YYYY-MM-DD（不要用 toISOString，那是 UTC 日期） */
export function localDateKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 以本地時區格式化日期字串。
 *
 * @param dateStr YYYY-MM-DD 或 ISO 時間字串
 * @param fallback 無法解析時回傳的內容，預設回傳原字串
 */
export function formatLocalDate(
  dateStr?: string | null,
  fallback?: string,
): string {
  if (!dateStr) return fallback ?? '';

  // 純日期（YYYY-MM-DD）：明確用本地時區建構，避免被當成 UTC 午夜
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (match) {
    const [, y, m, d] = match;
    return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('zh-TW');
  }

  // 帶時間的 ISO 字串本來就含時區資訊，直接交給 Date 解析即可
  const parsed = new Date(dateStr);
  if (Number.isNaN(parsed.getTime())) {
    return fallback ?? dateStr;
  }
  return parsed.toLocaleDateString('zh-TW');
}

/** 供排序使用：把日期字串轉成可比較的時間戳，無法解析時回傳 0 */
export function toSortableTime(dateStr?: string | null): number {
  if (!dateStr) return 0;

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (match) {
    const [, y, m, d] = match;
    return new Date(Number(y), Number(m) - 1, Number(d)).getTime();
  }

  const parsed = new Date(dateStr);
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getTime();
}
