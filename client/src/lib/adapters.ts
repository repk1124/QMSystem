/**
 * 新 API 資料 ↔ 舊 QuotationData 形狀的轉換。
 *
 * 為什麼要有這一層而不是直接改 pdfService：
 *   pdfService.ts 有 686 行，裡面是一頁自動縮排、蓋章定位、備註與規格
 *   自動編號、避免空白末頁這些反覆調校過的邏輯。那些是靠實際比對 PDF
 *   輸出調出來的，重寫的風險遠大於好處。
 *
 *   所以資料層換掉，但餵給 pdfService 的形狀維持不變。等哪天真的要改
 *   PDF 邏輯，這層再拿掉就好。
 */

import type { ApiQuotation, ApiVersion, ApiLineItem } from "./api";

/** pdfService 期望的形狀（沿用舊的 QuotationData） */
export interface LegacyLineItem {
  id: string;
  productName: string;
  specification: string;
  quantity: number;
  price: number;
}

export interface LegacyQuotationData {
  id?: string;
  status?: string;
  companyName: string;
  companyAddress: string;
  companyTaxId: string;
  quotationNumber: string;
  quotationDate: string;
  clientCompany: string;
  clientContact: string;
  clientEmail: string;
  clientPhone: string;
  clientAddress: string;
  buyerTaxId: string;
  customerCode: string;
  ourContact: string;
  ourPhone: string;
  ourEmail: string;
  quotationSubject: string;
  lineItems: LegacyLineItem[];
  taxAdjustment?: number;
  requireSignature?: boolean;
  notes: string;
  signedQuotationUrl?: string;
}

export interface CompanyProfile {
  name: string;
  address: string;
  taxId: string;
}

/** numeric 欄位從資料庫回來是字串，這裡統一轉數字 */
function num(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function toLegacyItem(item: ApiLineItem, index: number): LegacyLineItem {
  return {
    // pdfService 用 id 當 React key，字串即可
    id: String(item.id ?? `item-${index}`),
    productName: item.product_name ?? "",
    specification: item.specification ?? "",
    quantity: num(item.quantity),
    price: num(item.unit_price),
  };
}

/**
 * 把 API 回來的報價轉成 pdfService 吃的形狀。
 *
 * 重點：客戶名稱用的是**版本快照** `clientName`，不是客戶主檔的現行名稱。
 * 2025 年 5 月開的報價要印「國防醫學院」，不能因為單位後來升格就
 * 變成「國防醫學大學」—— 那張單就跟客戶手上的正本不一致了。
 */
export function toLegacyQuotation(
  quotation: ApiQuotation,
  company: CompanyProfile,
  versionId?: number,
): LegacyQuotationData {
  const version = pickVersion(quotation, versionId);

  return {
    id: String(quotation.id),
    status: version.status,
    companyName: company.name,
    companyAddress: company.address,
    companyTaxId: company.taxId,

    quotationNumber: quotation.quotation_number,
    quotationDate: version.quotationDate,

    // 快照優先。歷史報價要顯示當時的名稱。
    clientCompany: version.clientName ?? quotation.client_current_name ?? "",
    clientContact: version.contactName ?? "",
    clientEmail: version.contactEmail ?? "",
    clientPhone: version.contactPhone ?? "",
    // 地址優先用版本快照；舊資料沒有快照時退回客戶主檔
    clientAddress: version.clientAddress ?? quotation.client_address ?? "",
    buyerTaxId: version.clientTaxId ?? quotation.client_tax_id ?? "",

    customerCode: quotation.client_code ?? "",
    ourContact: version.ourContactName ?? "",
    ourPhone: version.ourContactPhone ?? "",
    ourEmail: version.ourContactEmail ?? "",
    quotationSubject: version.subject ?? "",

    lineItems: (version.items ?? []).map(toLegacyItem),
    taxAdjustment: num(version.taxAdjustment),
    requireSignature: version.requireSignature ?? false,
    notes: version.notes ?? "",

    signedQuotationUrl: quotation.documents?.find(d => d.role === "signed_copy")
      ? `/api/documents/${quotation.documents.find(d => d.role === "signed_copy")!.id}/download`
      : undefined,
  };
}

/** 沒指定就取目前生效的版本 */
export function pickVersion(quotation: ApiQuotation, versionId?: number): ApiVersion {
  if (versionId) {
    const found = quotation.versions.find(v => v.id === versionId);
    if (found) return found;
  }
  const current = quotation.versions.find(v => v.id === quotation.current_version_id);
  if (current) return current;
  if (!quotation.versions.length) {
    throw new Error(`報價 ${quotation.quotation_number} 沒有任何版本`);
  }
  // 版本清單是由新到舊排序的
  return quotation.versions[0];
}

/**
 * 反向：把編輯表單的資料轉成 API 要的格式。
 *
 * 注意這裡**不送金額**。舊系統把前端算好的 subtotal / total 一起存進
 * 資料庫，等於相信瀏覽器算的數字。現在只送品項，金額由伺服器重算。
 */
export function toApiDraft(
  data: LegacyQuotationData,
  ids: { clientId: number; companyId: number; clientContactId?: number | null },
) {
  return {
    clientId: ids.clientId,
    companyId: ids.companyId,
    clientContactId: ids.clientContactId ?? null,
    quotationDate: data.quotationDate,
    subject: data.quotationSubject || null,
    notes: data.notes || null,
    requireSignature: data.requireSignature ?? false,
    taxAdjustment: data.taxAdjustment ?? 0,
    ourContactName: data.ourContact || null,
    ourContactEmail: data.ourEmail || null,
    ourContactPhone: data.ourPhone || null,
    lineItems: data.lineItems
      // 完全空白的列不送出，避免產生「(未命名) 0 元」的品項
      .filter(item => item.productName?.trim() || item.quantity > 0 || item.price > 0)
      .map(item => ({
        productName: item.productName?.trim() || "(未命名)",
        specification: item.specification || null,
        quantity: Number(item.quantity) || 0,
        unitPrice: Number(item.price) || 0,
      })),
  };
}

/* ── 顯示用的小工具 ───────────────────────────────────── */

export const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  pending_approval: "待核准",
  approved: "已核准",
  sent: "已寄出",
  viewed: "客戶已讀",
  accepted: "客戶已接受",
  declined: "客戶已拒絕",
  expired: "已過期",
  superseded: "已被新版本取代",
  voided: "已作廢",
};

export const FULFILLMENT_LABEL: Record<string, string> = {
  not_started: "尚未開始",
  in_progress: "進行中",
  delivered: "已交付",
  inspected: "已驗收",
  invoiced: "已請款",
  paid: "已收款",
  closed: "已結案",
  on_hold: "暫停",
  canceled: "已取消",
};

/** 台幣顯示，不帶小數 */
export function formatMoney(value: string | number | null | undefined): string {
  return `NT$ ${Math.round(num(value)).toLocaleString("zh-TW")}`;
}

/**
 * 這張報價現在該做什麼 —— 列表上直接顯示行動建議，
 * 而不是讓使用者自己從一堆狀態裡推斷。
 */
export function nextAction(item: {
  status: string;
  fulfillmentStatus: string;
  validUntil: string | null;
  suspectDocuments: number;
}, today = new Date().toISOString().slice(0, 10)): string | null {
  if (item.suspectDocuments > 0) return "簽回檔可能掛錯，待確認";
  if (item.status === "draft") return "尚未寄出";
  if (item.status === "sent") {
    if (item.validUntil && item.validUntil < today) return "已過期，需重新報價或延期";
    return "等待客戶回覆";
  }
  if (item.status === "viewed") return "客戶已讀，可以跟進";
  if (item.status === "accepted") {
    switch (item.fulfillmentStatus) {
      case "in_progress": return "執行中";
      case "delivered": return "待驗收";
      case "inspected": return "可以請款";
      case "invoiced": return "待收款";
      case "paid": return "可以結案";
      case "on_hold": return "暫停中";
      default: return null;
    }
  }
  return null;
}
