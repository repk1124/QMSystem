/**
 * 後端 API 客戶端。
 *
 *   - 前端不直接寫資料庫，所有規則由伺服器把關
 *   - 金額由伺服器算，前端算的只是即時預覽
 *   - 錯誤訊息由伺服器提供，可以直接顯示給使用者
 *   - 沒有 localStorage 假備援：伺服器掛掉就是失敗，不假裝存檔成功
 */

/* ── 型別 ─────────────────────────────────────────────── */

export type QuotationStatus =
  | "draft" | "pending_approval" | "approved" | "sent" | "viewed"
  | "accepted" | "declined" | "expired" | "superseded" | "voided";

export type FulfillmentStatus =
  | "not_started" | "in_progress" | "delivered" | "inspected"
  | "invoiced" | "paid" | "closed" | "on_hold" | "canceled";

export interface ApiLineItem {
  id?: number;
  product_id?: number | null;
  product_name: string;
  specification?: string | null;
  unit?: string | null;
  quantity: string | number;
  unit_price: string | number;
  amount: string | number;
  unit_cost?: string | number | null;
  sort_order?: number;
}

export interface ApiVersion {
  id: number;
  versionNumber: number;
  status: QuotationStatus;
  quotationDate: string;
  validUntil: string | null;
  subject: string | null;
  clientName: string;
  clientTaxId: string | null;
  clientAddress: string | null;
  clientContactId: number | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  ourContactName: string | null;
  ourContactEmail: string | null;
  ourContactPhone: string | null;
  subtotal: string;
  taxRate: string;
  taxAmount: string;
  taxAdjustment: string;
  totalAmount: string;
  totalCost?: string | null;
  marginPercent?: string | null;
  notes: string | null;
  requireSignature: boolean;
  lockedAt: string | null;
  voidReason: string | null;
  createdAt: string;
  items: ApiLineItem[];
}

export interface ApiQuotation {
  id: number;
  quotation_number: string;
  company_id: number;
  client_id: number;
  current_version_id: number;
  fulfillment_status: FulfillmentStatus;
  delivered_at: string | null;
  inspected_at: string | null;
  invoiced_at: string | null;
  paid_at: string | null;
  closed_at: string | null;
  client_current_name: string;
  client_tax_id: string | null;
  client_code: string;
  client_address: string | null;
  client_phone: string | null;
  versions: ApiVersion[];
  history: Array<{
    scope: "quote" | "fulfillment";
    fromStatus: string | null;
    toStatus: string;
    reason: string | null;
    changedAt: string;
    versionId: number | null;
  }>;
  documents: Array<{
    id: number;
    filename: string;
    byteSize: number;
    sha256: string;
    uploadedAt: string;
    role: string;
    verificationStatus: "unverified" | "verified" | "suspect";
    verificationNote: string | null;
  }>;
}

export interface ApiUser {
  id: number;
  username: string;
  email: string;
  displayName: string | null;
  role: string;
  /** 首次登入（或管理員重設密碼後）必須先改密碼 */
  mustChangePassword: boolean;
  permissions: string[];
}

/* ── 錯誤 ─────────────────────────────────────────────── */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** 業務規則衝突（例如想改一張已鎖定的報價）—— 訊息可以直接顯示 */
  get isConflict() { return this.status === 409; }
  get isForbidden() { return this.status === 403; }
  get isUnauthorized() { return this.status === 401; }
}

/* ── 底層請求 ─────────────────────────────────────────── */

const TIMEOUT_MS = 20_000;

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS);

  const init: RequestInit = {
    method,
    // cookie session 需要這個，否則跨頁面請求不會帶認證
    credentials: "same-origin",
    signal: controller.signal,
  };

  if (body instanceof FormData) {
    init.body = body;
    // 不要自己設 Content-Type，瀏覽器要自己加 boundary
  } else if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch (error) {
    clearTimeout(timer);
    if ((error as Error).name === "AbortError") {
      throw new ApiError("伺服器沒有回應，請檢查網路連線後再試一次", 0, "timeout");
    }
    throw new ApiError("無法連線到伺服器", 0, "network_error");
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* 非 JSON */ }

  if (!response.ok) {
    const p = payload as { message?: string; code?: string; details?: unknown } | null;
    // session 過期時集中處理一次，而不是在每個呼叫點各寫一遍。
    // 用動態 import 避免 api.ts 與 AuthContext 互相 import 造成循環相依。
    if (response.status === 401 && !path.startsWith("/auth/")) {
      void import("../context/AuthContext")
        .then(m => m.notifyUnauthorized())
        .catch(() => { /* 測試環境沒有這個模組，忽略 */ });
    }
    throw new ApiError(
      p?.message || `請求失敗（HTTP ${response.status}）`,
      response.status,
      p?.code || "unknown",
      p?.details,
    );
  }
  return payload as T;
}

const get = <T>(path: string) => request<T>("GET", path);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body);
const patch = <T>(path: string, body?: unknown) => request<T>("PATCH", path, body);
const del = <T>(path: string) => request<T>("DELETE", path);

/* ── 認證 ─────────────────────────────────────────────── */

export const auth = {
  login: (username: string, password: string) =>
    post<{ user: ApiUser }>("/auth/login", { username, password }),

  logout: () => post<{ message: string }>("/auth/logout"),

  me: () => get<{ user: ApiUser }>("/auth/me"),

  changePassword: (currentPassword: string, newPassword: string) =>
    post<{ message: string }>("/auth/change-password", { currentPassword, newPassword }),
};

/* ── 客戶 ─────────────────────────────────────────────── */

export interface ClientSummary {
  id: number;
  code: string;
  name: string;
  taxId: string | null;
  aliases: string[];
  address: string | null;
  phone: string | null;
  category: string | null;
  quotationCount: number;
  contactCount: number;
  wonAmount: string;
}

export const clients = {
  list: (search?: string) =>
    get<ClientSummary[]>(`/clients${search ? `?search=${encodeURIComponent(search)}` : ""}`),

  get: (id: number) => get<ClientSummary & {
    contacts: Array<{ id: number; name: string; title: string | null; email: string | null; phone: string | null; isPrimary: boolean }>;
    nameHistory: Array<{ name: string; validFrom: string | null; validUntil: string | null; changeReason: string | null; note: string | null }>;
  }>(`/clients/${id}`),

  create: (input: { name: string; taxId?: string; address?: string; phone?: string; category?: string }) =>
    post<ClientSummary>("/clients", input),

  rename: (id: number, name: string, options: { effectiveFrom?: string; reason?: string } = {}) =>
    post<{ from: string; to: string; effectiveFrom: string }>(`/clients/${id}/rename`, { name, ...options }),

  addContact: (id: number, input: { name: string; title?: string; email?: string; phone?: string; isPrimary?: boolean }) =>
    post<{ id: number; name: string }>(`/clients/${id}/contacts`, input),
};

/* ── 報價 ─────────────────────────────────────────────── */

export interface QuotationDraftInput {
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
  lineItems: Array<{
    productId?: number | null;
    productName: string;
    specification?: string | null;
    unit?: string | null;
    quantity: number;
    unitPrice: number;
    unitCost?: number | null;
  }>;
}

export interface QuotationListItem {
  id: number;
  quotationNumber: string;
  fulfillmentStatus: FulfillmentStatus;
  deliveredAt: string | null;
  inspectedAt: string | null;
  invoicedAt: string | null;
  paidAt: string | null;
  closedAt: string | null;
  versionId: number;
  versionNumber: number;
  status: QuotationStatus;
  quotationDate: string;
  validUntil: string | null;
  subject: string | null;
  clientName: string;
  clientId: number;
  clientCurrentName: string;
  subtotal: string;
  taxAmount: string;
  totalAmount: string;
  totalCost?: string | null;
  marginPercent?: string | null;
  locked: boolean;
  itemCount: number;
  suspectDocuments: number;
}

export const quotations = {
  list: (filters: {
    search?: string; status?: string; fulfillmentStatus?: string;
    clientId?: number; openOnly?: boolean; limit?: number; offset?: number;
  } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
    }
    const qs = params.toString();
    return get<{ items: QuotationListItem[]; total: number; limit: number; offset: number }>(
      `/quotations${qs ? `?${qs}` : ""}`);
  },

  get: (id: number) => get<ApiQuotation>(`/quotations/${id}`),

  create: (draft: QuotationDraftInput) =>
    post<{ id: number; quotationNumber: string; versionId: number }>("/quotations", draft),

  /** 修改現有版本。已鎖定會拋 ApiError（409），訊息可直接顯示。 */
  updateVersion: (versionId: number, patchBody: Partial<QuotationDraftInput>) =>
    patch<{ versionId: number }>(`/quotations/versions/${versionId}`, patchBody),

  /** 建立新版本。舊版本自動轉 superseded 並鎖定。 */
  createVersion: (id: number, patchBody: Partial<QuotationDraftInput> = {}) =>
    post<{ versionId: number; versionNumber: number }>(`/quotations/${id}/versions`, patchBody),

  setStatus: (versionId: number, status: QuotationStatus, reason?: string) =>
    post<{ versionId: number; status: QuotationStatus; locked?: boolean }>(
      `/quotations/versions/${versionId}/status`, { status, reason }),

  setFulfillment: (id: number, status: FulfillmentStatus, options: { reason?: string; milestoneDate?: string } = {}) =>
    post<{ quotationId: number; fulfillmentStatus: FulfillmentStatus }>(
      `/quotations/${id}/fulfillment`, { status, ...options }),

  remove: (id: number) => del<{ deleted: boolean }>(`/quotations/${id}`),

  uploadDocument: (id: number, file: File, options: { kind?: string; linkRole?: string } = {}) => {
    const form = new FormData();
    form.append("file", file);
    if (options.kind) form.append("kind", options.kind);
    if (options.linkRole) form.append("linkRole", options.linkRole);
    return request<{
      document: { id: number; original_filename: string; byte_size: number };
      deduplicated: boolean;
      suspect: boolean;
      conflictsWith: string[];
      url: string;
    }>("POST", `/quotations/${id}/documents`, form, { timeoutMs: 120_000 });
  },
};

/* ── 檔案 ─────────────────────────────────────────────── */

export const documents = {
  /** 只組相對路徑。絕對不要把 window.location.origin 存進資料庫。 */
  downloadUrl: (documentId: number) => `/api/documents/${documentId}/download`,

  suspectLinks: () => get<Array<{
    id: number; note: string; filename: string; sha256: string;
    quotationId: number; quotationNumber: string;
    clientName: string; quotationDate: string;
  }>>("/documents/suspect-links"),

  verifyLink: (linkId: number, note?: string) =>
    post<{ id: number }>(`/documents/links/${linkId}/verify`, { note }),

  unlink: (linkId: number) => del<{ id: number }>(`/documents/links/${linkId}`),
};

/* ── 首頁 ─────────────────────────────────────────────── */

export interface TodoItem {
  kind: "suspect_document" | "expiring_quote" | "ready_to_invoice" | "awaiting_payment" | "stale_deal";
  severity: "high" | "medium" | "low";
  label: string;
  detail: string;
  quotationId: number | null;
  quotationNumber: string | null;
  amount: string | null;
}

export interface HrAlert {
  kind: "contract_expiring" | "no_user_account";
  severity: "high" | "medium";
  label: string;
  detail: string;
  employeeId: number | null;
}

export interface DashboardData {
  todos: TodoItem[];
  openDeals: {
    count: number; amount: string;
    oldest: { number: string; date: string; days: number } | null;
  };
  performance: {
    period: string;
    quoted: { count: number; amount: string };
    won: { count: number; amount: string };
    lost: { count: number };
    winRate: number | null;
    avgDaysToClose: number | null;
  };
  hrAlerts: HrAlert[];
}

export const dashboard = {
  get: () => get<DashboardData>("/dashboard"),
};

/* ── 人事 ─────────────────────────────────────────────── */

export interface EmployeeRow {
  id: number; employeeId: string; name: string; email: string; phone: string | null;
  hireDate: string; terminationDate: string | null;
  employmentType: string; contractEndDate: string | null;
  monthlyWorkHours: string | null; requiresClockIn: boolean;
  partnerName: string | null;
  departmentName: string | null; positionTitle: string | null;
  userId: number | null; userRole: string | null; pendingLeaves: number;
}

export interface EmployeeInput {
  employeeId: string;
  name: string;
  email: string;
  phone?: string | null;
  hireDate: string;
  terminationDate?: string | null;
  departmentName?: string | null;
  positionName?: string | null;
  employmentType?: string;
  monthlyWorkHours?: number | null;
  contractEndDate?: string | null;
  partnerName?: string | null;
  requiresClockIn?: boolean;
  salaryAmount?: number | null;
  salaryType?: string;
}

export interface Entitlement {
  id: number; period_start: string; period_end: string;
  entitled_days: string; carried_in_days: string; used_days: string;
  carried_out_days: string; paid_out_days: string;
  available: number; remaining: number; mustPayOut: number; isCurrent: boolean;
}

export interface LeaveRow {
  id: number; leaveType: string; startDate: string; endDate: string;
  days: string; reason: string; tripLocation: string | null; tripType: string | null;
  status: string; rejectionReason: string | null; approvedAt: string | null;
  createdAt: string; employeeId: number; employeeName: string;
  employeeCode: string; approverName: string | null;
}

export interface AttendanceRow {
  id: number; workDate: string; clockInAt: string | null; clockOutAt: string | null;
  workMinutes: number | null; overtimeMinutes: number; status: string; notes: string | null;
  employeeId: number; employeeName: string; employeeCode: string; editCount: number;
}

export const hr = {
  employees: (includeInactive = false) =>
    get<EmployeeRow[]>(`/employees${includeInactive ? "?includeInactive=true" : ""}`),

  employee: (id: number) => get<Record<string, any> & { entitlements: Entitlement[] }>(`/employees/${id}`),

  salary: (id: number) =>
    get<{ salaryAmount: string | null; salaryType: string; salarySource: string | null }>(`/employees/${id}/salary`),

  departments: () => get<Array<{ id: number; name: string }>>(`/departments`),
  positions: () => get<Array<{ id: number; title: string; departmentId: number | null }>>(`/positions`),

  createEmployee: (input: EmployeeInput) => post<EmployeeRow>("/employees", input),
  updateEmployee: (id: number, body: Partial<EmployeeInput>) =>
    patch<EmployeeRow>(`/employees/${id}`, body),

  leaveRequests: (filters: { employeeId?: number; status?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.employeeId) params.set("employeeId", String(filters.employeeId));
    if (filters.status) params.set("status", filters.status);
    const qs = params.toString();
    return get<LeaveRow[]>(`/leave-requests${qs ? `?${qs}` : ""}`);
  },

  createLeave: (input: {
    employeeId?: number; leaveType: string; startDate: string; endDate: string;
    days: number; reason: string; tripLocation?: string; tripType?: string;
  }) => post<LeaveRow>("/leave-requests", input),

  decideLeave: (id: number, decision: "approved" | "rejected", reason?: string) =>
    post<{ id: number; status: string }>(`/leave-requests/${id}/decide`, { decision, reason }),

  attendance: (filters: { employeeId?: number; from?: string; to?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v) params.set(k, String(v));
    const qs = params.toString();
    return get<AttendanceRow[]>(`/attendance${qs ? `?${qs}` : ""}`);
  },

  clockIn: () => post<AttendanceRow>("/attendance/clock-in"),
  clockOut: () => post<AttendanceRow>("/attendance/clock-out"),

  amendAttendance: (id: number, input: {
    reason: string; clockInAt?: string | null; clockOutAt?: string | null;
    status?: string; notes?: string;
  }) => patch<{ attendanceId: number; changed: string[] }>(`/attendance/${id}`, input),

  attendanceHistory: (id: number) => get<Array<{
    field: string; oldValue: string | null; newValue: string | null;
    reason: string; changedBy: string | null; changedAt: string;
  }>>(`/attendance/${id}/history`),
};

export const LEAVE_TYPE_LABEL: Record<string, string> = {
  annual: "特別休假", sick: "病假", personal: "事假", official: "公假",
  maternity: "產假", paternity: "陪產假", compassionate: "喪假", unpaid: "無薪假",
};

/* ── 產品品項 ─────────────────────────────────────────── */

export interface ProductRow {
  id: number; sku: string; name: string; specification: string | null;
  unit: string | null; costPrice: string | null; listPrice: string | null;
  productType: string; usageCount: number;
}

export const products = {
  list: (search?: string) =>
    get<ProductRow[]>(`/products${search ? `?search=${encodeURIComponent(search)}` : ""}`),
  create: (input: Partial<ProductRow> & { name: string }) => post<ProductRow>("/products", input),
  update: (id: number, input: Partial<ProductRow>) => patch<ProductRow>(`/products/${id}`, input),
};

/* ── 使用者與角色 ─────────────────────────────────────── */

export interface UserRow {
  id: number; username: string; email: string; displayName: string | null;
  role: string; isActive: boolean; mustChangePassword: boolean;
  lastLoginAt: string | null;
  employeeName: string | null; employeeCode: string | null;
}

export const users = {
  list: () => get<UserRow[]>("/users"),
  roles: () => get<Array<{
    name: string; description: string | null; permissions: string[];
    isSystem: boolean; userCount: number;
  }>>("/roles"),
  create: (input: { username: string; email: string; displayName?: string; role: string; password: string }) =>
    post<UserRow>("/users", input),
  update: (id: number, input: { role?: string; isActive?: boolean; displayName?: string }) =>
    patch<UserRow>(`/users/${id}`, input),
};

/* ── 合約與範本 ─────────────────────────────────────── */

export interface TemplateRow {
  id: number; code: string; name: string; templateType: string;
  body: string; variables: string[]; description: string | null;
  isActive: boolean; updatedAt: string;
}

export interface ContractRow {
  id: number; contractNumber: string; contractType: string; title: string;
  status: string; startDate: string | null; endDate: string | null;
  totalAmount: string | null; signedAt: string | null;
  billingCycle: string | null; billingAmount: string | null;
  locked: boolean; clientId: number; clientName: string;
  quotationNumber: string | null; pastDue: boolean; documentCount: number;
}

export const CONTRACT_STATUS_LABEL: Record<string, string> = {
  draft: "草稿", sent: "已寄出", signed: "已簽署", active: "履約中",
  expired: "已到期", terminated: "已終止", voided: "已作廢",
};

export const CONTRACT_TYPE_LABEL: Record<string, string> = {
  development: "開發合約", rental: "租賃合約", nda: "保密合約", custom: "其他",
};

export const contracts = {
  list: (filters: { status?: string; clientId?: number; expiringDays?: number } = {}) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v != null && v !== "") params.set(k, String(v));
    const qs = params.toString();
    return get<ContractRow[]>(`/contracts${qs ? `?${qs}` : ""}`);
  },
  get: (id: number) => get<Record<string, any> & {
    documents: Array<{ id: number; filename: string; byteSize: number; uploadedAt: string; linkId: number; role: string }>;
  }>(`/contracts/${id}`),
  create: (input: Record<string, unknown>) => post<{ id: number; contract_number: string }>("/contracts", input),
  update: (id: number, patch: Record<string, unknown>) => patch_(`/contracts/${id}`, patch),
  setStatus: (id: number, status: string, options: { signedAt?: string; reason?: string } = {}) =>
    post<{ id: number; status: string }>(`/contracts/${id}/status`, { status, ...options }),
  uploadDocument: (id: number, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return request<{ document: { id: number }; suspect: boolean; conflictsWith: string[]; url: string }>(
      "POST", `/contracts/${id}/documents`, form, { timeoutMs: 120_000 });
  },
  preview: (quotationId: number, templateId: number) =>
    get<{ content: string; values: Record<string, string>; missing: string[]; templateName: string }>(
      `/quotations/${quotationId}/contract-preview?templateId=${templateId}`),
};

const patch_ = <T = unknown>(path: string, body: unknown) => patch<T>(path, body);

export const templates = {
  list: () => get<TemplateRow[]>("/templates"),
  create: (input: Partial<TemplateRow> & { name: string; body: string; templateType: string }) =>
    post<TemplateRow>("/templates", input),
  update: (id: number, input: Partial<TemplateRow>) => patch<TemplateRow>(`/templates/${id}`, input),
};

/* ── 檔案總覽 ─────────────────────────────────────────── */

export interface DocumentRow {
  id: number; filename: string; mimeType: string; byteSize: number;
  sha256: string; kind: string; uploadedAt: string; uploadedBy: string | null;
  links: Array<{
    linkId: number; entityType: string; entityId: number;
    role: string; status: string; label: string | null;
  }>;
}

export const documentLibrary = {
  list: (limit = 200) => get<DocumentRow[]>(`/documents?limit=${limit}`),
};

export const audit = {
  list: (options: { limit?: number; entityType?: string } = {}) => {
    const params = new URLSearchParams();
    if (options.limit) params.set("limit", String(options.limit));
    if (options.entityType) params.set("entityType", options.entityType);
    const qs = params.toString();
    return get<Array<{
      id: number; at: string; actor: string | null;
      entityType: string; entityId: number | null;
      action: string; changes: unknown;
    }>>(`/audit${qs ? `?${qs}` : ""}`);
  },
};

/* ── 系統設定（白牌化）與公司主體 ─────────────────────── */

export interface PublicSettings {
  appName: string;
  logoUrl: string | null;
  primaryColor: string | null;
}

export interface AppSettings extends PublicSettings {
  companyName: string;
  companyTaxId: string;
  companyAddress: string | null;
  companyPhone: string | null;
  companyEmail: string | null;
  companyPrincipal: string | null;
  stampUrl: string | null;
  quotationPrefix: string;
  contractPrefix: string;
  updatedAt: string;
}

export type SettingsPatch = Partial<Pick<AppSettings,
 "appName" | "companyName" | "companyTaxId" | "companyAddress" | "companyPhone"
  | "companyEmail" | "companyPrincipal" | "quotationPrefix" | "contractPrefix" | "primaryColor">>;

export const settings = {
  /** 免登入 */
  public: () => get<PublicSettings>("/settings/public"),
  /** 登入後任何人：側欄與 PDF 用 */
  branding: () => get<AppSettings>("/settings/branding"),
  /** 需要 settings:manage */
  get: () => get<AppSettings>("/settings"),
  update: (input: SettingsPatch) => request<AppSettings>("PUT", "/settings", input),
  uploadImage: (kind: "logo" | "stamp", file: File | Blob, filename = "image.png") => {
    const form = new FormData();
    form.append("file", file, filename);
    return request<AppSettings>("POST", `/settings/${kind}`, form, { timeoutMs: 60_000 });
  },
  removeImage: (kind: "logo" | "stamp") => del<AppSettings>(`/settings/${kind}`),
};

export interface CompanyRow {
  id: number; name: string; taxId: string; address: string | null;
  phone: string | null; isDefault: boolean;
}

export const companies = {
  list: () => get<CompanyRow[]>("/companies"),
};

/* ── 權限判斷（前端只用來決定顯示什麼，實際把關在伺服器）── */

export const PERMISSION = {
  QUOTATION_READ: "quotation:read",
  QUOTATION_WRITE: "quotation:write",
  QUOTATION_APPROVE: "quotation:approve",
  QUOTATION_VOID: "quotation:void",
  QUOTATION_VIEW_COST: "quotation:view_cost",
  CLIENT_READ: "client:read",
  CLIENT_WRITE: "client:write",
  PRODUCT_READ: "product:read",
  EMPLOYEE_READ: "employee:read",
  USER_READ: "user:read",
  AUDIT_READ: "audit:read",
  SETTINGS_MANAGE: "settings:manage",
  SYSTEM_ADMIN: "system:admin",
} as const;

export function hasPermission(user: ApiUser | null, permission: string): boolean {
  if (!user) return false;
  return user.permissions.includes(PERMISSION.SYSTEM_ADMIN)
    || user.permissions.includes(permission);
}
