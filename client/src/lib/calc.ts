/**
 * 金額計算 —— 全系統唯一的計算來源。
 *
 * 修復背景：原本同一套邏輯被複製在四個地方，而且語意互相不同：
 *   - QuotationContext  → 小計 + 5% + 稅額調整（含稅）
 *   - pdfService        → 同上（重複實作）
 *   - ContractForm      → 只有小計（未稅）← 導致合約金額少 5%
 *   - QuotationList     → 只有小計（未稅）← 導致列表金額對不上 PDF
 *
 * 任何需要金額的地方都必須呼叫這裡，不要再自己 reduce。
 */

export const TAX_RATE = 0.05;

export interface CalcLineItem {
  quantity?: number | null;
  price?: number | null;
}

export interface QuotationTotals {
  /** 未稅小計（各行小計四捨五入後加總，確保明細相加 = 小計） */
  subtotal: number;
  /** 依稅率計算的基本稅額（不含人工調整） */
  baseTax: number;
  /** 使用者手動填入的稅額調整（可正可負） */
  taxAdjustment: number;
  /** 實際稅額 = baseTax + taxAdjustment */
  tax: number;
  /** 含稅總計 */
  total: number;
}

/** 把任何可能是 NaN / null / undefined / Infinity 的輸入轉成安全數字 */
export function toSafeNumber(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : fallback;
}

/** 單一行項目的未稅金額（已四捨五入到元） */
export function lineItemAmount(item: CalcLineItem | null | undefined): number {
  if (!item) return 0;
  const quantity = toSafeNumber(item.quantity);
  const price = toSafeNumber(item.price);
  return Math.round(quantity * price);
}

/**
 * 計算一張報價單的所有金額。
 *
 * 重要：小計是「各行四捨五入後」加總，而不是先加總再四捨五入。
 * 這樣 PDF 上明細欄位相加才會等於小計欄位（原本兩者會差 1~2 元）。
 */
export function calculateQuotationTotals(
  lineItems: CalcLineItem[] | null | undefined,
  taxAdjustment?: number | null,
): QuotationTotals {
  const items = Array.isArray(lineItems) ? lineItems : [];

  const subtotal = items.reduce((sum, item) => sum + lineItemAmount(item), 0);
  const baseTax = Math.round(subtotal * TAX_RATE);
  const adjustment = Math.round(toSafeNumber(taxAdjustment));
  const tax = baseTax + adjustment;

  return {
    subtotal,
    baseTax,
    taxAdjustment: adjustment,
    tax,
    total: subtotal + tax,
  };
}

/**
 * 由目標「含稅總金額」反推某一行的單價。
 *
 * 修復：原本的實作有三個錯誤 ——
 *   1. 忽略其他行項目，把整張單的目標塞給單一行 → 多行時總計對不上目標
 *   2. 忽略 taxAdjustment
 *   3. 數量為 0 時直接除以 0 產生 Infinity → 畫面 NT$ NaN、資料庫拒寫
 *
 * @returns 新單價；若無法計算（找不到項目 / 數量 <= 0 / 目標不合理）回傳 null
 */
export function solveUnitPriceForTarget(
  lineItems: CalcLineItem[] | null | undefined,
  targetItemIndex: number,
  targetTotalIncludingTax: number,
  taxAdjustment?: number | null,
): number | null {
  const items = Array.isArray(lineItems) ? lineItems : [];
  const target = items[targetItemIndex];
  if (!target) return null;

  const quantity = toSafeNumber(target.quantity);
  if (quantity <= 0) return null;

  const goal = toSafeNumber(targetTotalIncludingTax);
  if (!(goal > 0)) return null;

  // 其他行項目的未稅小計（維持不變）
  const othersSubtotal = items.reduce(
    (sum, item, index) => (index === targetItemIndex ? sum : sum + lineItemAmount(item)),
    0,
  );

  // 目標總計 = (小計 + 本行金額) * (1 + 稅率) + 稅額調整
  //  ⇒ 本行金額 = (目標總計 - 稅額調整) / (1 + 稅率) - 其他行小計
  const adjustment = Math.round(toSafeNumber(taxAdjustment));
  const requiredSubtotal = (goal - adjustment) / (1 + TAX_RATE);
  const requiredLineAmount = requiredSubtotal - othersSubtotal;

  if (!Number.isFinite(requiredLineAmount) || requiredLineAmount < 0) return null;

  const price = requiredLineAmount / quantity;
  if (!Number.isFinite(price)) return null;

  // 保留兩位小數，避免產生 47619.047619047617 這種單價
  return Math.round(price * 100) / 100;
}

/** 統一的金額顯示格式（新台幣、無小數） */
export function formatAmount(amount: number | null | undefined): string {
  return Math.round(toSafeNumber(amount)).toLocaleString('zh-TW');
}

/** 含 NT$ 前綴的金額顯示格式 */
export function formatCurrencyTWD(amount: number | null | undefined): string {
  return `NT$ ${formatAmount(amount)}`;
}
