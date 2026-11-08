/**
 * 型別橋接檔：pdfService.ts 需要 QuotationData / LineItem 型別。
 * 舊系統的 QuotationContext 整套狀態管理已由 SQL 版 API + adapters 取代，
 * 這裡只保留 pdfService 依賴的資料形狀，避免拖進舊版前端直連資料庫時代的程式。
 */

export interface LineItem {
  id: string;
  productName: string;   // 產品名稱
  specification: string; // 產品規格
  quantity: number;      // 數量
  price: number;         // 單價
}

export interface QuotationData {
  id?: string;
  status?: 'draft' | 'sent' | 'accepted' | 'contract' | 'completed' | 'canceled';
  statusUpdatedAt?: string;
  signedQuotationUrl?: string;
  contractId?: string;
  contractContent?: string;
  contractType?: 'development' | 'rental';
  contractDocumentUrl?: string;

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

  lineItems: LineItem[];
  taxAdjustment?: number;
  requireSignature?: boolean;
  notes: string;

  orderNumber?: string;
  orderDate?: string;
  orderStatus?: string;

  buyerCompany?: string;
  receiverContact?: string;
  receiverPhone?: string;
  shippingAddress?: string;
  shippingDate?: string;
  buyerConfirmation?: string;
}
