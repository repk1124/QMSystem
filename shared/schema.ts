/**
 * QuotationMaster — 統一資料庫 Schema
 *
 * 這份 schema 把報價／合約與人事兩個領域放在同一個 PostgreSQL 資料庫：
 *   - 報價、合約、客戶、品項、檔案
 *   - 員工、出勤、請假、特休
 *
 * ─────────────────────────────────────────────────────────
 * 設計原則（每一條都是為了修掉舊系統實際發生過的問題）
 * ─────────────────────────────────────────────────────────
 *
 * 1. 客戶是主檔，不是報價上的欄位。
 *    舊系統把客戶名稱、統編、地址、聯絡人直接存在每張報價上，
 *    結果「國防醫學大學」和「國防醫學院」變成兩個客戶（統編其實都是
 *    04189271），customerCode 每張報價各生一組（國防醫學大學有 12 組），
 *    三軍總醫院甚至掛到「康寧學-250753」這種別家單位的代號。
 *
 * 2. 報價分成「單據本體」與「版本」兩層。
 *    報價編號（QT-20260811-001）是不變的身分；每次修改產生新版本。
 *    版本一旦被接受就鎖定，不能再改，只能開新版本或作廢。
 *
 * 3. 金額一律 numeric，不用 float。
 *    浮點數算錢會有 0.1+0.2 這種誤差，稅額差 1 塊就對不上發票。
 *
 * 4. 檔案是獨立的實體，不是一個網址字串。
 *    舊系統把 `https://<舊主機>/uploads/xxx.pdf` 整串存進
 *    報價，結果換部署環境就全部失效；而且沒有人知道檔案是誰上傳的、
 *    什麼時候上傳、原始檔名是什麼。更嚴重的是沒有任何檢查，
 *    導致 11 筆簽回檔裡有 4 筆掛到別張報價上。
 *
 * 5. 所有異動都留痕。
 *    價格被改、狀態被跳、檔案被換，都要查得到是誰在什麼時候做的。
 */

import {
  pgTable, serial, text, integer, boolean, timestamp, numeric,
  jsonb, date, uniqueIndex, index, primaryKey, varchar, json,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

/* ═══════════════════════════════════════════════════════════
   一、核心：公司主體、使用者、權限
   ═══════════════════════════════════════════════════════════ */

/**
 * 公司主體（報價上的「我方」）。
 * 第一次啟動時會依 app_settings 的公司名稱自動建立一筆 is_default 公司；
 * 設定頁改公司名稱時也會同步更新那筆預設公司。
 */
export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  taxId: text("tax_id").notNull(),
  address: text("address"),
  phone: text("phone"),
  /** 負責人／代表人，合約的甲方代表 */
  principal: text("principal"),
  logoUrl: text("logo_url"),
  /** 公司印章圖檔（報價單自動用印） */
  stampDocumentId: integer("stamp_document_id"),
  isDefault: boolean("is_default").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  taxIdx: uniqueIndex("companies_tax_id_idx").on(t.taxId),
}));

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull(),
  /** bcrypt hash */
  password: text("password"),
  email: text("email").notNull(),
  displayName: text("display_name"),
  role: text("role").notNull().default("employee"),
  isActive: boolean("is_active").notNull().default(true),
  mustChangePassword: boolean("must_change_password").notNull().default(true),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  usernameIdx: uniqueIndex("users_username_idx").on(t.username),
  emailIdx: uniqueIndex("users_email_idx").on(t.email),
}));

/**
 * 系統設定（白牌化）。單列表：永遠只有 id = 1 那一筆。
 *
 * 品牌相關的東西（系統名稱、公司資料、logo、印章、編號前綴、主色）
 * 全部放這裡而不是寫死在程式碼或 localStorage，這樣同一份程式碼
 * 任何公司都能直接部署使用，設定也跟著資料庫一起備份。
 */
export const appSettings = pgTable("app_settings", {
  id: integer("id").primaryKey().default(1),
  appName: text("app_name").notNull().default("報價管理系統"),
  companyName: text("company_name").notNull().default("範例公司"),
  companyTaxId: text("company_tax_id").notNull().default("12345678"),
  companyAddress: text("company_address"),
  companyPhone: text("company_phone"),
  companyEmail: text("company_email"),
  /** 公司負責人／代表人（合約變數 principalName） */
  companyPrincipal: text("company_principal"),
  /** 相對於 UPLOAD_DIR 的路徑，例如 branding/logo-1700000000.png */
  logoPath: text("logo_path"),
  stampPath: text("stamp_path"),
  /** 報價編號前綴，例如 QT-20260811-001 */
  quotationPrefix: text("quotation_prefix").notNull().default("QT"),
  /** 合約編號前綴，例如 CNT-20260811-001 */
  contractPrefix: text("contract_prefix").notNull().default("CNT"),
  /** 主色（#rrggbb），選用；有值時套到前端的 Tailwind CSS 變數 */
  primaryColor: text("primary_color"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const roles = pgTable("roles", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  permissions: text("permissions").array().notNull().default([]),
  /** 內建角色不可刪除 */
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => ({
  nameIdx: uniqueIndex("roles_name_idx").on(t.name),
}));

/* ═══════════════════════════════════════════════════════════
   二、檔案管理
   取代舊系統的 signedQuotationUrl 字串
   ═══════════════════════════════════════════════════════════ */

/**
 * 每一個實體檔案一筆。
 *
 * storageKey 是「相對於儲存後端的路徑」，例如 `signed/2026/abc.pdf`，
 * 前面不帶主機名稱。要組出可下載的網址時由程式加上目前的 base URL，
 * 這樣換部署環境、換物件儲存都不會讓舊資料失效。
 */
export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  storageKey: text("storage_key").notNull(),
  /** local | s3（目前只實作 local） */
  storageBackend: text("storage_backend").notNull().default("local"),
  originalFilename: text("original_filename").notNull(),
  mimeType: text("mime_type").notNull(),
  byteSize: integer("byte_size").notNull(),
  /** 用來偵測「同一個檔案被重複上傳／掛到多張單據」 */
  sha256: text("sha256").notNull(),
  /** signed_quotation | contract | attachment | stamp | logo | invoice */
  kind: text("kind").notNull().default("attachment"),
  uploadedBy: integer("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  uploadedAt: timestamp("uploaded_at").notNull().defaultNow(),
  /** 軟刪除：檔案是證據，不真的刪掉 */
  deletedAt: timestamp("deleted_at"),
  deletedBy: integer("deleted_by").references(() => users.id, { onDelete: "set null" }),
  notes: text("notes"),
}, t => ({
  shaIdx: index("documents_sha256_idx").on(t.sha256),
  keyIdx: uniqueIndex("documents_storage_key_idx").on(t.storageKey),
}));

/**
 * 檔案與單據的關聯。
 *
 * 用獨立的關聯表而不是在報價上放 document_id，是因為：
 *   - 一張報價可能有多份附件（簽回單、驗收單、保固書）
 *   - 要能記錄「這份檔案宣稱屬於哪張單」以便偵測掛錯
 *
 * verificationStatus 就是為了舊資料那 4 筆掛錯的情況：
 *   verified   = 已確認這份檔案確實屬於這張單
 *   suspect    = 系統偵測到可能掛錯（例如同一個 sha256 掛到多張單）
 *   unverified = 還沒檢查
 */
export const documentLinks = pgTable("document_links", {
  id: serial("id").primaryKey(),
  documentId: integer("document_id").notNull().references(() => documents.id, { onDelete: "cascade" }),
  /** quotation | contract | order | invoice | employee */
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id").notNull(),
  /** signed_copy | attachment | acceptance | warranty */
  linkRole: text("link_role").notNull().default("attachment"),
  verificationStatus: text("verification_status").notNull().default("unverified"),
  verificationNote: text("verification_note"),
  linkedBy: integer("linked_by").references(() => users.id, { onDelete: "set null" }),
  linkedAt: timestamp("linked_at").notNull().defaultNow(),
}, t => ({
  entityIdx: index("document_links_entity_idx").on(t.entityType, t.entityId),
  docIdx: index("document_links_document_idx").on(t.documentId),
  uniq: uniqueIndex("document_links_uniq").on(t.documentId, t.entityType, t.entityId, t.linkRole),
}));

/* ═══════════════════════════════════════════════════════════
   三、客戶主檔
   ═══════════════════════════════════════════════════════════ */

export const clients = pgTable("clients", {
  id: serial("id").primaryKey(),
  /** 客戶代號，一個客戶一組（舊系統是每張報價一組，這是主要修正點） */
  code: text("code").notNull(),
  name: text("name").notNull(),
  /** 統一編號。政府機關與學校也有統編，是最可靠的識別依據。 */
  taxId: text("tax_id"),
  /**
   * 其他曾用名／簡稱，供搜尋與比對用。
   * 有時間性的更名（例如改制、升格）請用 client_name_history，
   * 這裡只放沒有時間意義的別名與俗稱。
   */
  aliases: text("aliases").array().notNull().default([]),
  address: text("address"),
  phone: text("phone"),
  /** government | school | hospital | company */
  category: text("category"),
  /** 政府採購相關：共同供應契約編號等 */
  procurementNotes: text("procurement_notes"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  codeIdx: uniqueIndex("clients_code_idx").on(t.code),
  taxIdx: index("clients_tax_id_idx").on(t.taxId),
  nameIdx: index("clients_name_idx").on(t.name),
}));

/**
 * 客戶名稱的時間軸。
 *
 * 為什麼需要這張表：
 *   「國防醫學院」在 2025 年升格為「國防醫學大學」。這代表同一個統編
 *   （04189271）在不同時間點有不同的正確名稱：
 *     - 2025-05 開的報價寫「國防醫學院」→ 當時正確，重印時不該被改掉
 *     - 2025-12 開的報價寫「國防醫學院」→ 已經升格了，是複製舊報價的筆誤
 *
 *   只用一個 aliases 陣列分不出這兩種情況。有了起訖日期，系統才能
 *   判斷「這張單當時用的名稱對不對」，也才能在開發票時自動用現行名稱
 *   （統一發票的買受人名稱必須與現行登記名稱一致）。
 *
 * validUntil 為 null 表示這是目前生效的名稱。
 */
export const clientNameHistory = pgTable("client_name_history", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  validFrom: date("valid_from"),
  validUntil: date("valid_until"),
  /** rename | upgrade | merge | correction */
  changeReason: text("change_reason"),
  note: text("note"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => ({
  clientIdx: index("client_name_history_client_idx").on(t.clientId),
  uniq: uniqueIndex("client_name_history_uniq").on(t.clientId, t.name),
}));

export const clientContacts = pgTable("client_contacts", {
  id: serial("id").primaryKey(),
  clientId: integer("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  title: text("title"),
  email: text("email"),
  phone: text("phone"),
  department: text("department"),
  isPrimary: boolean("is_primary").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, t => ({
  clientIdx: index("client_contacts_client_idx").on(t.clientId),
}));

/* ═══════════════════════════════════════════════════════════
   四、產品品項庫
   ═══════════════════════════════════════════════════════════ */

export const products = pgTable("products", {
  id: serial("id").primaryKey(),
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  /** 預設規格說明，報價時可覆寫 */
  specification: text("specification"),
  unit: text("unit").default("式"),
  /** 進貨成本。這是市售報價 SaaS 都沒有、而自建系統該有的欄位。 */
  costPrice: numeric("cost_price", { precision: 14, scale: 2 }),
  listPrice: numeric("list_price", { precision: 14, scale: 2 }),
  /** 毛利率低於此值時需要主管核准；null 表示沿用全域設定 */
  minMarginPercent: numeric("min_margin_percent", { precision: 5, scale: 2 }),
  /** sale | rental | service */
  productType: text("product_type").notNull().default("sale"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  skuIdx: uniqueIndex("products_sku_idx").on(t.sku),
}));

/* ═══════════════════════════════════════════════════════════
   五、報價：單據本體 + 版本 + 品項
   ═══════════════════════════════════════════════════════════ */

/**
 * 報價單據本體。一張報價從頭到尾只有一筆，報價編號不變。
 * 所有會被修改的內容都在 quotation_versions。
 */
export const quotations = pgTable("quotations", {
  id: serial("id").primaryKey(),
  quotationNumber: text("quotation_number").notNull(),
  companyId: integer("company_id").notNull().references(() => companies.id),
  clientId: integer("client_id").notNull().references(() => clients.id),
  /** 目前生效的版本 */
  currentVersionId: integer("current_version_id"),
  /** 業務負責人 */
  ownerUserId: integer("owner_user_id").references(() => users.id, { onDelete: "set null" }),

  /**
   * 履約進度 —— 跟報價狀態是兩件事，刻意分成兩個欄位。
   *
   * 報價狀態（在 quotation_versions.status）回答的是「這份報價談到哪」：
   *   草稿 → 寄出 → 客戶已讀 → 客戶接受
   * 履約進度回答的是「這個案子做到哪」：
   *   進行中 → 已交付 → 已驗收 → 已請款 → 已收款 → 結案
   *
   * 舊系統把 draft/sent/accepted/contract/completed/canceled 全部塞在
   * 同一個欄位，結果兩件事都表達不清楚 —— 看到 completed 不知道是
   * 「客戶簽了」還是「錢收到了」。
   *
   * 對公部門與學校客戶特別重要：從驗收到收款常常隔好幾個月，
   * 政府採購法 §73-1 規定驗收後 30 日內付款，
   * 沒有這幾個里程碑就沒辦法追帳齡，也算不出保固起算日。
   *
   * 未來有了訂單／發票／收款模組之後，這個欄位會改成自動推導；
   * 現在先由人工更新。
   */
  fulfillmentStatus: text("fulfillment_status").notNull().default("not_started"),

  /** 履約里程碑。驗收日是保固起算與請款的依據，所以獨立成欄位。 */
  deliveredAt: date("delivered_at"),
  /** 驗收合格日。保固期從這天起算。 */
  inspectedAt: date("inspected_at"),
  /** 請款送件日。應收帳齡從這天起算，不是開票日。 */
  invoicedAt: date("invoiced_at"),
  paidAt: date("paid_at"),
  closedAt: date("closed_at"),
  closeNote: text("close_note"),

  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  numberIdx: uniqueIndex("quotations_number_idx").on(t.quotationNumber),
  clientIdx: index("quotations_client_idx").on(t.clientId),
  fulfillmentIdx: index("quotations_fulfillment_idx").on(t.fulfillmentStatus),
}));

/**
 * 報價版本。每次實質修改就開一個新版本。
 *
 * 狀態機（每個版本自己走一條）：
 *   draft → pending_approval → approved → sent → viewed
 *         → accepted | declined | expired
 *   任何狀態都可以 → voided（作廢；不是刪除）
 *   被新版本取代時 → superseded
 *
 * lockedAt 有值就不能再改。accepted 之後一定會被鎖。
 */
export const quotationVersions = pgTable("quotation_versions", {
  id: serial("id").primaryKey(),
  quotationId: integer("quotation_id").notNull().references(() => quotations.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  status: text("status").notNull().default("draft"),

  quotationDate: date("quotation_date").notNull(),
  /** 報價有效期限。過期會自動轉 expired（除非已 accepted）。 */
  validUntil: date("valid_until"),
  subject: text("subject"),

  /** 客戶端的快照：報價寄出去之後，客戶主檔即使改了也不該影響已寄出的內容 */
  clientNameSnapshot: text("client_name_snapshot").notNull(),
  clientTaxIdSnapshot: text("client_tax_id_snapshot"),
  clientAddressSnapshot: text("client_address_snapshot"),
  clientContactId: integer("client_contact_id").references(() => clientContacts.id, { onDelete: "set null" }),
  clientContactNameSnapshot: text("client_contact_name_snapshot"),
  clientContactEmailSnapshot: text("client_contact_email_snapshot"),
  clientContactPhoneSnapshot: text("client_contact_phone_snapshot"),

  /** 我方聯絡窗口 */
  ourContactName: text("our_contact_name"),
  ourContactEmail: text("our_contact_email"),
  ourContactPhone: text("our_contact_phone"),

  /** 金額。全部由品項算出後寫回，避免每次讀取重算而產生不一致。 */
  subtotal: numeric("subtotal", { precision: 14, scale: 2 }).notNull().default("0"),
  taxRate: numeric("tax_rate", { precision: 5, scale: 4 }).notNull().default("0.05"),
  taxAmount: numeric("tax_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  /** 稅額人工調整（湊整數用），可正可負 */
  taxAdjustment: numeric("tax_adjustment", { precision: 14, scale: 2 }).notNull().default("0"),
  totalAmount: numeric("total_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  /** 成本合計與毛利，供內部檢視，不出現在給客戶的 PDF 上 */
  totalCost: numeric("total_cost", { precision: 14, scale: 2 }),
  marginPercent: numeric("margin_percent", { precision: 6, scale: 2 }),

  notes: text("notes"),
  /** 是否需要客戶簽回；false 時 PDF 用印在備註區右側 */
  requireSignature: boolean("require_signature").notNull().default(false),

  lockedAt: timestamp("locked_at"),
  lockedBy: integer("locked_by").references(() => users.id, { onDelete: "set null" }),
  voidedAt: timestamp("voided_at"),
  voidReason: text("void_reason"),

  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  versionIdx: uniqueIndex("quotation_versions_uniq").on(t.quotationId, t.versionNumber),
  statusIdx: index("quotation_versions_status_idx").on(t.status),
  validIdx: index("quotation_versions_valid_until_idx").on(t.validUntil),
}));

export const quotationItems = pgTable("quotation_items", {
  id: serial("id").primaryKey(),
  versionId: integer("version_id").notNull().references(() => quotationVersions.id, { onDelete: "cascade" }),
  sortOrder: integer("sort_order").notNull().default(0),
  /** 可以來自品項庫，也可以是臨時打的（productId 為 null） */
  productId: integer("product_id").references(() => products.id, { onDelete: "set null" }),
  productName: text("product_name").notNull(),
  specification: text("specification"),
  unit: text("unit"),
  quantity: numeric("quantity", { precision: 14, scale: 3 }).notNull().default("1"),
  unitPrice: numeric("unit_price", { precision: 14, scale: 2 }).notNull().default("0"),
  /** 折扣百分比，用來區分「系統折扣」與「業務手動殺價」 */
  discountPercent: numeric("discount_percent", { precision: 5, scale: 2 }).notNull().default("0"),
  amount: numeric("amount", { precision: 14, scale: 2 }).notNull().default("0"),
  /** 這一項的成本，用來算毛利 */
  unitCost: numeric("unit_cost", { precision: 14, scale: 2 }),
}, t => ({
  versionIdx: index("quotation_items_version_idx").on(t.versionId),
}));

/**
 * 狀態異動歷程。誰在什麼時候把狀態從什麼改成什麼、為什麼。
 *
 * 同時記錄兩種軌跡，用 scope 區分：
 *   scope='quote'       報價狀態（掛在某個版本上）
 *   scope='fulfillment' 履約進度（掛在報價本體上，跨版本）
 */
export const quotationStatusHistory = pgTable("quotation_status_history", {
  id: serial("id").primaryKey(),
  quotationId: integer("quotation_id").notNull().references(() => quotations.id, { onDelete: "cascade" }),
  /** scope='fulfillment' 時為 null，因為履約進度不屬於特定版本 */
  versionId: integer("version_id").references(() => quotationVersions.id, { onDelete: "cascade" }),
  scope: text("scope").notNull().default("quote"),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  reason: text("reason"),
  changedBy: integer("changed_by").references(() => users.id, { onDelete: "set null" }),
  changedAt: timestamp("changed_at").notNull().defaultNow(),
}, t => ({
  quotationIdx: index("quotation_status_history_quotation_idx").on(t.quotationId, t.scope),
  versionIdx: index("quotation_status_history_version_idx").on(t.versionId),
}));

/* ═══════════════════════════════════════════════════════════
   五之二、合約與範本
   ═══════════════════════════════════════════════════════════ */

/**
 * 文件範本（合約、條款）。
 *
 * 舊系統把範本寫死在程式碼裡，要改條款得改程式碼再部署。
 * 存進資料庫之後，法務條款可以在系統裡直接維護，而且改動有版本可查。
 *
 * body 裡用 {變數名} 當佔位符，套用時由 contracts 的資料填入。
 */
export const documentTemplates = pgTable("document_templates", {
  id: serial("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  /** development | rental | nda | custom */
  templateType: text("template_type").notNull().default("custom"),
  body: text("body").notNull(),
  /** 這份範本用到哪些變數，給編輯畫面提示用 */
  variables: text("variables").array().notNull().default([]),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  codeIdx: uniqueIndex("document_templates_code_idx").on(t.code),
}));

/**
 * 合約。
 *
 * 舊系統把合約內容塞在報價單的一個欄位裡 —— 等於合約根本沒有被當成
 * 一種單據管理：
 * 沒有編號、沒有起訖日、沒有狀態、查不到哪些合約還在期限內。
 *
 * 對租賃業務尤其重要：要知道「這台設備租給誰、租到什麼時候」，
 * 得先有合約主檔。
 */
export const contracts = pgTable("contracts", {
  id: serial("id").primaryKey(),
  contractNumber: text("contract_number").notNull(),
  companyId: integer("company_id").notNull().references(() => companies.id),
  clientId: integer("client_id").notNull().references(() => clients.id),
  /** 由哪張報價轉來的（可為 null，也有直接簽的合約） */
  quotationId: integer("quotation_id").references(() => quotations.id, { onDelete: "set null" }),
  templateId: integer("template_id").references(() => documentTemplates.id, { onDelete: "set null" }),

  /** development | rental | nda | custom */
  contractType: text("contract_type").notNull().default("development"),
  title: text("title").notNull(),
  /** 套用範本後的完整內容。存下來而不是每次重算，
      因為範本會改，但已簽的合約內容不能跟著變。 */
  content: text("content").notNull(),

  /** draft | sent | signed | active | expired | terminated | voided */
  status: text("status").notNull().default("draft"),

  startDate: date("start_date"),
  endDate: date("end_date"),
  totalAmount: numeric("total_amount", { precision: 14, scale: 2 }),

  signedAt: date("signed_at"),
  signedDocumentId: integer("signed_document_id").references(() => documents.id, { onDelete: "set null" }),

  /** 租賃專用：計費週期與每期金額 */
  billingCycle: text("billing_cycle"),
  billingAmount: numeric("billing_amount", { precision: 14, scale: 2 }),
  depositAmount: numeric("deposit_amount", { precision: 14, scale: 2 }),

  notes: text("notes"),
  lockedAt: timestamp("locked_at"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  numberIdx: uniqueIndex("contracts_number_idx").on(t.contractNumber),
  clientIdx: index("contracts_client_idx").on(t.clientId),
  statusIdx: index("contracts_status_idx").on(t.status),
  endDateIdx: index("contracts_end_date_idx").on(t.endDate),
}));

export const CONTRACT_STATUS = [
  "draft", "sent", "signed", "active", "expired", "terminated", "voided",
] as const;
export type ContractStatus = typeof CONTRACT_STATUS[number];

export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: "草稿", sent: "已寄出", signed: "已簽署", active: "履約中",
  expired: "已到期", terminated: "已終止", voided: "已作廢",
};

export const CONTRACT_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  draft: ["sent", "signed", "voided"],
  sent: ["signed", "draft", "voided"],
  signed: ["active", "terminated", "voided"],
  active: ["expired", "terminated"],
  expired: ["terminated"],
  terminated: [],
  voided: [],
};

export function canTransitionContract(from: ContractStatus, to: ContractStatus): boolean {
  return CONTRACT_TRANSITIONS[from]?.includes(to) ?? false;
}

/** 已簽署之後就鎖定，內容不能再改 */
export const LOCKED_CONTRACT_STATUSES: ContractStatus[] =
  ["signed", "active", "expired", "terminated", "voided"];

/* ═══════════════════════════════════════════════════════════
   六、稽核軌跡（全系統共用）
   ═══════════════════════════════════════════════════════════ */

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  at: timestamp("at").notNull().defaultNow(),
  actorUserId: integer("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  /** 即使使用者被刪除也要留下當時的身分 */
  actorLabel: text("actor_label"),
  entityType: text("entity_type").notNull(),
  entityId: integer("entity_id"),
  /** create | update | delete | status_change | login | export | import */
  action: text("action").notNull(),
  /** 只存有變動的欄位，不存整包 */
  changes: jsonb("changes"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
}, t => ({
  entityIdx: index("audit_log_entity_idx").on(t.entityType, t.entityId),
  atIdx: index("audit_log_at_idx").on(t.at),
}));

/* ═══════════════════════════════════════════════════════════
   七、人事（沿用原本的表，補上合規需要的欄位）
   ═══════════════════════════════════════════════════════════ */

export const departments = pgTable("departments", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  managerId: integer("manager_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  nameIdx: uniqueIndex("departments_name_idx").on(t.name),
}));

export const positions = pgTable("positions", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  departmentId: integer("department_id").references(() => departments.id, { onDelete: "set null" }),
  level: text("level").notNull().default("初級員工"),
  salaryRange: text("salary_range"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  titleIdx: uniqueIndex("positions_title_idx").on(t.title),
}));

export const employees = pgTable("employees", {
  id: serial("id").primaryKey(),
  employeeId: text("employee_id").notNull(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  phone: text("phone"),
  hireDate: date("hire_date").notNull(),
  /** 離職日。有值才能算離職特休結算。 */
  terminationDate: date("termination_date"),
  positionId: integer("position_id").references(() => positions.id, { onDelete: "set null" }),
  departmentId: integer("department_id").references(() => departments.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  /** 薪資改成數值，舊系統是 text（"30000" / "196" 混在一起） */
  salaryAmount: numeric("salary_amount", { precision: 12, scale: 2 }),
  /** monthly | hourly */
  salaryType: text("salary_type").notNull().default("monthly"),
  salarySource: text("salary_source"),
  partnerName: text("partner_name"),
  employmentType: text("employment_type").notNull().default("full_time"),
  monthlyWorkHours: numeric("monthly_work_hours", { precision: 6, scale: 2 }),
  contractEndDate: date("contract_end_date"),
  requiresClockIn: boolean("requires_clock_in").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  empIdx: uniqueIndex("employees_employee_id_idx").on(t.employeeId),
}));

/**
 * 出勤紀錄。
 * 勞基法 §30 要求逐日記載至分鐘、保存 5 年、勞工申請副本不得拒絕。
 * 時間欄位改成 timestamp（舊 schema.ts 宣告 text，但實際資料庫是
 * timestamp，兩邊從來沒對上）。
 */
export const attendance = pgTable("attendance", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employees.id, { onDelete: "restrict" }),
  workDate: date("work_date").notNull(),
  clockInAt: timestamp("clock_in_at"),
  clockOutAt: timestamp("clock_out_at"),
  /** 由打卡時間算出，單位為分鐘（不用小數避免累加誤差） */
  workMinutes: integer("work_minutes"),
  /** 延長工時分鐘數，用於月 46/54 小時上限累計 */
  overtimeMinutes: integer("overtime_minutes").notNull().default(0),
  status: text("status").notNull().default("present"),
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  uniq: uniqueIndex("attendance_employee_date_idx").on(t.employeeId, t.workDate),
}));

/**
 * 出勤修改留痕。
 * 這是勞檢最看重的一項：補打卡、改時間都必須保留原始值與修改原因。
 * 舊系統直接覆蓋 updatedAt，改過什麼完全查不到。
 */
export const attendanceAudit = pgTable("attendance_audit", {
  id: serial("id").primaryKey(),
  attendanceId: integer("attendance_id").notNull().references(() => attendance.id, { onDelete: "cascade" }),
  fieldName: text("field_name").notNull(),
  oldValue: text("old_value"),
  newValue: text("new_value"),
  reason: text("reason").notNull(),
  changedBy: integer("changed_by").references(() => users.id, { onDelete: "set null" }),
  changedByLabel: text("changed_by_label"),
  changedAt: timestamp("changed_at").notNull().defaultNow(),
}, t => ({
  attIdx: index("attendance_audit_attendance_idx").on(t.attendanceId),
}));

export const leaveRequests = pgTable("leave_requests", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employees.id, { onDelete: "restrict" }),
  leaveType: text("leave_type").notNull(),
  startDate: date("start_date").notNull(),
  endDate: date("end_date").notNull(),
  days: numeric("days", { precision: 5, scale: 2 }).notNull(),
  reason: text("reason").notNull(),
  tripLocation: text("trip_location"),
  tripType: text("trip_type"),
  status: text("status").notNull().default("pending"),
  approvedBy: integer("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  rejectionReason: text("rejection_reason"),
  /** 若為特休，扣除自哪一個年度的額度 */
  entitlementId: integer("entitlement_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  empIdx: index("leave_requests_employee_idx").on(t.employeeId),
}));

/**
 * 特別休假額度。舊系統完全沒有這張表 —— 有「年假」這個假別，
 * 但系統不知道每個人有幾天。
 *
 * 勞基法 §38 + 施行細則 §24-2、§24-3：
 *   - 依年資給假（6個月3天 / 1年7天 / 2年10天 / 3年14天 / 5年15天 / 10年起每年+1至30天）
 *   - 年度終結未休完得協商遞延一年，遞延期滿仍未休須發給工資
 *   - 契約終止時未休一律折發工資
 *   - 雇主應每年以書面通知勞工未休日數與應發工資
 */
export const leaveEntitlements = pgTable("leave_entitlements", {
  id: serial("id").primaryKey(),
  employeeId: integer("employee_id").notNull().references(() => employees.id, { onDelete: "cascade" }),
  /** 此額度所屬年度的起訖（週年制看到職日，曆年制看 1/1） */
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  /** 依年資計算出的法定天數 */
  entitledDays: numeric("entitled_days", { precision: 5, scale: 2 }).notNull(),
  /** 從上一年度遞延過來的天數 */
  carriedInDays: numeric("carried_in_days", { precision: 5, scale: 2 }).notNull().default("0"),
  usedDays: numeric("used_days", { precision: 5, scale: 2 }).notNull().default("0"),
  /** 遞延到下一年度的天數 */
  carriedOutDays: numeric("carried_out_days", { precision: 5, scale: 2 }).notNull().default("0"),
  /** 折發工資的天數與金額 */
  paidOutDays: numeric("paid_out_days", { precision: 5, scale: 2 }).notNull().default("0"),
  paidOutAmount: numeric("paid_out_amount", { precision: 12, scale: 2 }),
  /** 年度書面通知的寄送時間（這是稽查項目） */
  noticeSentAt: timestamp("notice_sent_at"),
  noticeDocumentId: integer("notice_document_id").references(() => documents.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, t => ({
  uniq: uniqueIndex("leave_entitlements_uniq").on(t.employeeId, t.periodStart),
}));

/* ═══════════════════════════════════════════════════════════
   關聯定義
   ═══════════════════════════════════════════════════════════ */

export const quotationsRelations = relations(quotations, ({ one, many }) => ({
  client: one(clients, { fields: [quotations.clientId], references: [clients.id] }),
  company: one(companies, { fields: [quotations.companyId], references: [companies.id] }),
  versions: many(quotationVersions),
}));

export const quotationVersionsRelations = relations(quotationVersions, ({ one, many }) => ({
  quotation: one(quotations, { fields: [quotationVersions.quotationId], references: [quotations.id] }),
  items: many(quotationItems),
  statusHistory: many(quotationStatusHistory),
}));

export const quotationItemsRelations = relations(quotationItems, ({ one }) => ({
  version: one(quotationVersions, { fields: [quotationItems.versionId], references: [quotationVersions.id] }),
  product: one(products, { fields: [quotationItems.productId], references: [products.id] }),
}));

export const clientsRelations = relations(clients, ({ many }) => ({
  contacts: many(clientContacts),
  quotations: many(quotations),
  nameHistory: many(clientNameHistory),
}));

export const clientNameHistoryRelations = relations(clientNameHistory, ({ one }) => ({
  client: one(clients, { fields: [clientNameHistory.clientId], references: [clients.id] }),
}));

/**
 * 查出某個日期當下，這個客戶的正確名稱。
 * 用途：重印歷史報價時顯示當時名稱；開發票時取現行名稱。
 */
export function nameAsOf(
  history: Pick<ClientNameHistory, "name" | "validFrom" | "validUntil">[],
  onDate: string,
): string | null {
  const match = history.find(h =>
    (!h.validFrom || h.validFrom <= onDate) &&
    (!h.validUntil || onDate <= h.validUntil));
  return match?.name ?? null;
}

export const clientContactsRelations = relations(clientContacts, ({ one }) => ({
  client: one(clients, { fields: [clientContacts.clientId], references: [clients.id] }),
}));

export const employeesRelations = relations(employees, ({ one, many }) => ({
  department: one(departments, { fields: [employees.departmentId], references: [departments.id] }),
  position: one(positions, { fields: [employees.positionId], references: [positions.id] }),
  user: one(users, { fields: [employees.userId], references: [users.id] }),
  attendance: many(attendance),
  leaveRequests: many(leaveRequests),
  entitlements: many(leaveEntitlements),
}));

/* ═══════════════════════════════════════════════════════════
   常數與狀態機定義
   ═══════════════════════════════════════════════════════════ */

export const QUOTATION_STATUS = [
  "draft", "pending_approval", "approved", "sent", "viewed",
  "accepted", "declined", "expired", "superseded", "voided",
] as const;
export type QuotationStatus = typeof QUOTATION_STATUS[number];

export const QUOTATION_STATUS_LABELS: Record<QuotationStatus, string> = {
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

/**
 * 允許的狀態轉移。舊系統的 status 可以任意跳，
 * 例如直接從 draft 變成 completed，中間發生什麼事完全沒紀錄。
 */
export const QUOTATION_TRANSITIONS: Record<QuotationStatus, QuotationStatus[]> = {
  draft: ["pending_approval", "approved", "sent", "voided"],
  pending_approval: ["approved", "draft", "voided"],
  approved: ["sent", "draft", "voided"],
  sent: ["viewed", "accepted", "declined", "expired", "superseded", "voided"],
  viewed: ["accepted", "declined", "expired", "superseded", "voided"],
  accepted: ["voided"],
  declined: ["superseded", "voided"],
  expired: ["superseded", "voided"],
  superseded: [],
  voided: [],
};

/** 到達這些狀態後版本鎖定，不得再編輯 */
export const LOCKED_STATUSES: QuotationStatus[] = ["accepted", "superseded", "voided", "expired"];

export function canTransition(from: QuotationStatus, to: QuotationStatus): boolean {
  return QUOTATION_TRANSITIONS[from]?.includes(to) ?? false;
}

/* ── 履約進度 ─────────────────────────────────────────── */

export const FULFILLMENT_STATUS = [
  "not_started", "in_progress", "delivered", "inspected",
  "invoiced", "paid", "closed", "on_hold", "canceled",
] as const;
export type FulfillmentStatus = typeof FULFILLMENT_STATUS[number];

export const FULFILLMENT_STATUS_LABELS: Record<FulfillmentStatus, string> = {
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

/**
 * 履約進度可以跳著走（有些案子不需要驗收、有些先收款才出貨），
 * 但不能倒退回已經完成的里程碑，也不能從終點回頭。
 */
export const FULFILLMENT_TRANSITIONS: Record<FulfillmentStatus, FulfillmentStatus[]> = {
  not_started: ["in_progress", "on_hold", "canceled"],
  in_progress: ["delivered", "inspected", "invoiced", "on_hold", "canceled"],
  delivered: ["inspected", "invoiced", "on_hold", "canceled"],
  inspected: ["invoiced", "on_hold", "canceled"],
  invoiced: ["paid", "on_hold", "canceled"],
  paid: ["closed", "on_hold"],
  closed: [],
  on_hold: ["in_progress", "delivered", "inspected", "invoiced", "canceled"],
  canceled: [],
};

export function canTransitionFulfillment(from: FulfillmentStatus, to: FulfillmentStatus): boolean {
  return FULFILLMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

/** 案子還在跑（列表上要跟催的） */
export const OPEN_FULFILLMENT: FulfillmentStatus[] =
  ["in_progress", "delivered", "inspected", "invoiced", "on_hold"];

/** 案子已經沒事了 */
export const FINISHED_FULFILLMENT: FulfillmentStatus[] = ["paid", "closed", "canceled"];

/** 已驗收但還沒收到錢 —— 這是最需要盯的一群 */
export const AWAITING_PAYMENT: FulfillmentStatus[] = ["inspected", "invoiced"];

export const PERMISSIONS = {
  // 報價
  QUOTATION_READ: "quotation:read",
  QUOTATION_WRITE: "quotation:write",
  QUOTATION_APPROVE: "quotation:approve",
  QUOTATION_VOID: "quotation:void",
  QUOTATION_VIEW_COST: "quotation:view_cost",
  // 客戶與品項
  CLIENT_READ: "client:read",
  CLIENT_WRITE: "client:write",
  PRODUCT_READ: "product:read",
  PRODUCT_WRITE: "product:write",
  // 人事
  EMPLOYEE_READ: "employee:read",
  EMPLOYEE_WRITE: "employee:write",
  EMPLOYEE_DELETE: "employee:delete",
  EMPLOYEE_VIEW_SALARY: "employee:view_salary",
  ATTENDANCE_READ: "attendance:read",
  ATTENDANCE_WRITE: "attendance:write",
  ATTENDANCE_MANAGE: "attendance:manage",
  LEAVE_READ: "leave:read",
  LEAVE_WRITE: "leave:write",
  LEAVE_APPROVE: "leave:approve",
  // 系統
  USER_READ: "user:read",
  USER_WRITE: "user:write",
  USER_DELETE: "user:delete",
  ROLE_READ: "role:read",
  ROLE_WRITE: "role:write",
  ROLE_DELETE: "role:delete",
  AUDIT_READ: "audit:read",
  SETTINGS_MANAGE: "settings:manage",
  SYSTEM_ADMIN: "system:admin",
} as const;

/* ═══════════════════════════════════════════════════════════
   Zod schemas
   ═══════════════════════════════════════════════════════════ */

export const insertClientSchema = createInsertSchema(clients).omit({
  id: true, createdAt: true, updatedAt: true,
}).extend({
  name: z.string().min(1, "客戶名稱為必填"),
  taxId: z.string().regex(/^\d{8}$/, "統一編號必須是 8 位數字").optional().or(z.literal("")),
});

export const insertProductSchema = createInsertSchema(products).omit({
  id: true, createdAt: true, updatedAt: true,
}).extend({
  name: z.string().min(1, "品項名稱為必填"),
  sku: z.string().min(1, "品項編號為必填"),
});

export type Company = typeof companies.$inferSelect;
export type AppSettings = typeof appSettings.$inferSelect;
export type User = typeof users.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type DocumentLink = typeof documentLinks.$inferSelect;
export type Client = typeof clients.$inferSelect;
export type ClientNameHistory = typeof clientNameHistory.$inferSelect;
export type ClientContact = typeof clientContacts.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Quotation = typeof quotations.$inferSelect;
export type QuotationVersion = typeof quotationVersions.$inferSelect;
export type QuotationItem = typeof quotationItems.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type Contract = typeof contracts.$inferSelect;
export type DocumentTemplate = typeof documentTemplates.$inferSelect;
export type Employee = typeof employees.$inferSelect;
export type Attendance = typeof attendance.$inferSelect;
export type LeaveRequest = typeof leaveRequests.$inferSelect;
export type LeaveEntitlement = typeof leaveEntitlements.$inferSelect;

/* ═══════════════════════════════════════════════════════════
   登入 Session 存放表（connect-pg-simple 使用）

   這張表由 connect-pg-simple 在執行時管理，本來不在 schema 裡，
   導致每次 drizzle-kit push／部署都想把它當成多餘的表刪掉。
   把它明確宣告出來，push 就不會再提議 DROP user_sessions。
   欄位與索引跟 connect-pg-simple 內建的建表語法一致。
   ═══════════════════════════════════════════════════════════ */
export const userSessions = pgTable("user_sessions", {
  sid: varchar("sid").primaryKey(),
  sess: json("sess").notNull(),
  expire: timestamp("expire", { precision: 6 }).notNull(),
}, (t) => ({
  expireIdx: index("IDX_session_expire").on(t.expire),
}));
