/**
 * REST API。
 *
 * 為什麼要有這一層：前端直連資料庫時，所有規則都只能寫在前端，
 * 而前端是使用者可以改的。價格校驗、狀態機、權限、稽核全都形同虛設。
 */

import express, { type Express, type Response, type NextFunction } from "express";
import multer from "multer";
import { writeFile, mkdir, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { pool, checkConnection } from "./db";
import { AppError, ForbiddenError, NotFoundError, ValidationError } from "./errors";
import {
  setupSession, requireAuth, requirePermission, actorFrom, canSeeCost,
  loadUser, verifyPassword, hashPassword, assertStrongPassword,
  isLockedOut, recordFailure, clearFailures, regenerateSession,
  isAccountLockedOut, accountKey,
  type AuthedRequest, type AuthUser,
} from "./auth";
import * as settingsRepo from "./repositories/settings";
import { PERMISSIONS } from "../shared/schema";
import * as quotations from "./repositories/quotations";
import * as clients from "./repositories/clients";
import * as documents from "./repositories/documents";
import { getDashboard } from "./repositories/dashboard";
import * as hr from "./repositories/hr";
import * as admin from "./repositories/admin";
import * as contractsRepo from "./repositories/contracts";

const UPLOAD_ROOT = process.env.UPLOAD_DIR || path.resolve("uploads");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: documents.MAX_BYTES, files: 1 },
});

/** logo / 印章：只收圖片、2 MB 以內 */
const BRANDING_MAX_BYTES = 2 * 1024 * 1024;
const BRANDING_MIME = new Map<string, string>([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/svg+xml", ".svg"],
]);
const brandingUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: BRANDING_MAX_BYTES, files: 1 },
});

/** 把 async handler 的例外導到錯誤中介層，不然會變成未處理的 rejection */
const wrap = <T extends AuthedRequest>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) => (req: T, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

/* ── 驗證 schema ──────────────────────────────────────── */

const lineItemSchema = z.object({
  productId: z.number().int().positive().nullish(),
  productName: z.string().min(1, "品項名稱為必填"),
  specification: z.string().nullish(),
  unit: z.string().nullish(),
  quantity: z.number().finite().nonnegative(),
  unitPrice: z.number().finite(),
  unitCost: z.number().finite().nullish(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必須是 YYYY-MM-DD");

const quotationDraftSchema = z.object({
  clientId: z.number().int().positive(),
  companyId: z.number().int().positive(),
  quotationDate: isoDate,
  validUntil: isoDate.nullish(),
  subject: z.string().nullish(),
  clientContactId: z.number().int().positive().nullish(),
  ourContactName: z.string().nullish(),
  ourContactEmail: z.string().nullish(),
  ourContactPhone: z.string().nullish(),
  notes: z.string().nullish(),
  requireSignature: z.boolean().optional(),
  taxAdjustment: z.number().finite().optional(),
  lineItems: z.array(lineItemSchema).min(1, "報價至少要有一個品項"),
});

/* ── 註冊路由 ─────────────────────────────────────────── */

export async function registerRoutes(app: Express) {
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "2mb" }));
  setupSession(app);

  const api = express.Router();

  /* ── 健康檢查 ── */
  api.get("/health", wrap(async (_req, res) => {
    const dbOk = await checkConnection();
    res.status(dbOk ? 200 : 503).json({ status: dbOk ? "ok" : "degraded", database: dbOk });
  }));

  /* ── 認證 ── */

  api.post("/auth/login", wrap(async (req: AuthedRequest, res) => {
    const { username, password } = z.object({
      username: z.string().min(1, "請輸入帳號"),
      password: z.string().min(1, "請輸入密碼"),
    }).parse(req.body);

    // 兩層鎖：
    //   IP+帳號：同一來源短時間內連續失敗（一般的鎖），8 次。
    //   帳號本身：不管來源 IP，累積失敗達上限就鎖。
    // 第二層是關鍵 —— 反向代理環境下 req.ip 可能來自用戶端可控的
    // X-Forwarded-For，只靠第一層的話換 IP 就能無限重試。第二層跟 IP 無關。
    const key = `${req.ip}|${username.toLowerCase()}`;
    if (isLockedOut(key) || isAccountLockedOut(username)) {
      return res.status(429).json({ message: "登入失敗次數過多，請於 15 分鐘後再試" });
    }

    const found = await pool.query(
      "SELECT id, password, is_active FROM users WHERE lower(username)=lower($1)",
      [username],
    );
    const row = found.rows[0];
    // 帳號不存在時也跑一次雜湊比對，避免用回應時間差判斷帳號是否存在
    const hash = row?.password ?? "$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid";
    const valid = await verifyPassword(password, hash);

    if (!row || !row.is_active || !valid) {
      recordFailure(key);
      recordFailure(accountKey(username));
      return res.status(401).json({ message: "帳號或密碼錯誤" });
    }

    clearFailures(key);
    clearFailures(accountKey(username));
    await regenerateSession(req);
    req.session.userId = row.id;
    await pool.query("UPDATE users SET last_login_at=now() WHERE id=$1", [row.id]);

    const user = await loadUser(row.id);
    await pool.query(
      `INSERT INTO audit_log (actor_user_id, actor_label, entity_type, entity_id, action, ip_address)
       VALUES ($1,$2,'user',$1,'login',$3)`,
      [row.id, user?.email ?? username, req.ip ?? null],
    );
    res.json({ user: publicUser(user!) });
  }));

  api.post("/auth/logout", (req, res) => {
    req.session.destroy(() => res.json({ message: "已登出" }));
  });

  api.get("/auth/me", requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: publicUser(req.user!) });
  });

  api.post("/auth/change-password", requireAuth, wrap(async (req: AuthedRequest, res) => {
    const { currentPassword, newPassword } = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string(),
    }).parse(req.body);
    assertStrongPassword(newPassword);
    if (currentPassword === newPassword) {
      throw new ValidationError("新密碼不可與目前密碼相同");
    }

    const row = await pool.query("SELECT password FROM users WHERE id=$1", [req.user!.id]);
    if (!row.rows[0]?.password || !await verifyPassword(currentPassword, row.rows[0].password)) {
      throw new ValidationError("目前密碼不正確");
    }
    await pool.query(
      "UPDATE users SET password=$1, must_change_password=false, updated_at=now() WHERE id=$2",
      [await hashPassword(newPassword), req.user!.id],
    );
    res.json({ message: "密碼已更新" });
  }));

  /* ── 系統設定（白牌化） ── */

  // 免登入：登入頁要顯示系統名稱與 logo
  api.get("/settings/public", wrap(async (_req, res) => {
    res.json(await settingsRepo.getPublicSettings());
  }));

  // logo 任何人都看得到（登入頁就會用）；印章只給登入後的人
  api.get("/settings/logo", wrap(async (_req, res) => {
    const s = await settingsRepo.getSettings();
    if (!s.logoPath) throw new NotFoundError("logo");
    sendBrandingFile(res, s.logoPath);
  }));
  api.get("/settings/stamp", requireAuth, wrap(async (_req, res) => {
    const s = await settingsRepo.getSettings();
    if (!s.stampPath) throw new NotFoundError("印章");
    sendBrandingFile(res, s.stampPath);
  }));

  // 品牌與我方公司資料：登入後任何人都可以讀（側欄、PDF 要用）
  api.get("/settings/branding", requireAuth, wrap(async (_req, res) => {
    res.json(settingsRepo.toClientSettings(await settingsRepo.getSettings()));
  }));

  // 設定頁用的完整設定：讀與改都要有權限
  api.get("/settings", requireAuth, requirePermission(PERMISSIONS.SETTINGS_MANAGE),
    wrap(async (_req, res) => {
      res.json(settingsRepo.toClientSettings(await settingsRepo.getSettings()));
    }));

  api.put("/settings", requireAuth, requirePermission(PERMISSIONS.SETTINGS_MANAGE),
    wrap(async (req: AuthedRequest, res) => {
      const updated = await settingsRepo.updateSettings(req.body ?? {}, actorFrom(req));
      res.json(settingsRepo.toClientSettings(updated));
    }));

  for (const kind of ["logo", "stamp"] as const) {
    api.post(`/settings/${kind}`, requireAuth, requirePermission(PERMISSIONS.SETTINGS_MANAGE),
      brandingUpload.single("file"),
      wrap(async (req: AuthedRequest, res) => {
        if (!req.file) throw new ValidationError("沒有收到檔案");
        const ext = BRANDING_MIME.get(req.file.mimetype);
        if (!ext) throw new ValidationError("只接受 PNG、JPG 或 SVG");
        if (req.file.buffer.length > BRANDING_MAX_BYTES) throw new ValidationError("檔案不能超過 2 MB");
        // SVG 可以夾帶 script；這裡只做最基本的拒絕，前端顯示時也是用 <img>，不會執行
        if (ext === ".svg" && /<script[\s>]/i.test(req.file.buffer.toString("utf8"))) {
          throw new ValidationError("SVG 不可含有 script");
        }

        const relPath = `branding/${kind}-${Date.now()}${ext}`;
        const target = path.join(UPLOAD_ROOT, relPath);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, req.file.buffer);

        const before = await settingsRepo.getSettings();
        const updated = await settingsRepo.setBrandingPath(kind, relPath, actorFrom(req));

        // 舊檔案不留著佔空間（刪不掉也不影響功能）
        const old = kind === "logo" ? before.logoPath : before.stampPath;
        if (old && old !== relPath) await unlink(path.join(UPLOAD_ROOT, old)).catch(() => {});

        res.status(201).json(settingsRepo.toClientSettings(updated));
      }));

    api.delete(`/settings/${kind}`, requireAuth, requirePermission(PERMISSIONS.SETTINGS_MANAGE),
      wrap(async (req: AuthedRequest, res) => {
        const before = await settingsRepo.getSettings();
        const old = kind === "logo" ? before.logoPath : before.stampPath;
        const updated = await settingsRepo.setBrandingPath(kind, null, actorFrom(req));
        if (old) await unlink(path.join(UPLOAD_ROOT, old)).catch(() => {});
        res.json(settingsRepo.toClientSettings(updated));
      }));
  }

  /* ── 公司主體（報價上的「我方」） ── */

  api.get("/companies", requireAuth, wrap(async (_req, res) => {
    const rows = await pool.query(
      `SELECT id, name, tax_id AS "taxId", address, phone, is_default AS "isDefault"
       FROM companies WHERE is_active = true ORDER BY is_default DESC, id`);
    res.json(rows.rows);
  }));

  /* ── 首頁彙總 ── */

  api.get("/dashboard", requireAuth, wrap(async (req: AuthedRequest, res) => {
    // 沒有報價檢視權限的人（例如純人事角色）只看得到人事那一區
    const canSeeQuotations = req.user!.permissions.has(PERMISSIONS.QUOTATION_READ)
      || req.user!.permissions.has(PERMISSIONS.SYSTEM_ADMIN);
    const data = await getDashboard(canSeeCost(req.user));
    if (!canSeeQuotations) {
      res.json({ ...data, todos: [], openDeals: { count: 0, amount: "0", oldest: null } });
      return;
    }
    res.json(data);
  }));

  /* ── 客戶 ── */

  api.get("/clients", requireAuth, requirePermission(PERMISSIONS.CLIENT_READ),
    wrap(async (req, res) => {
      res.json(await clients.listClients(req.query.search as string | undefined));
    }));

  api.get("/clients/:id", requireAuth, requirePermission(PERMISSIONS.CLIENT_READ),
    wrap(async (req, res) => {
      res.json(await clients.getClient(intParam(req.params.id, "客戶編號")));
    }));

  api.post("/clients", requireAuth, requirePermission(PERMISSIONS.CLIENT_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      res.status(201).json(await clients.createClient(req.body, actorFrom(req)));
    }));

  api.post("/clients/:id/rename", requireAuth, requirePermission(PERMISSIONS.CLIENT_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      const { name, effectiveFrom, reason } = z.object({
        name: z.string().min(1),
        effectiveFrom: isoDate.optional(),
        reason: z.string().optional(),
      }).parse(req.body);
      res.json(await clients.renameClient(
        intParam(req.params.id, "客戶編號"), name, actorFrom(req), { effectiveFrom, reason }));
    }));

  api.post("/clients/:id/contacts", requireAuth, requirePermission(PERMISSIONS.CLIENT_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      res.status(201).json(await clients.addContact(
        intParam(req.params.id, "客戶編號"), req.body, actorFrom(req)));
    }));

  /* ── 報價 ── */

  api.get("/quotations", requireAuth, requirePermission(PERMISSIONS.QUOTATION_READ),
    wrap(async (req: AuthedRequest, res) => {
      res.json(await quotations.listQuotations({
        search: req.query.search as string | undefined,
        status: req.query.status as string | undefined,
        fulfillmentStatus: req.query.fulfillmentStatus as string | undefined,
        clientId: req.query.clientId ? Number(req.query.clientId) : undefined,
        openOnly: req.query.openOnly === "true",
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      }, canSeeCost(req.user)));
    }));

  api.get("/quotations/:id", requireAuth, requirePermission(PERMISSIONS.QUOTATION_READ),
    wrap(async (req: AuthedRequest, res) => {
      res.json(await quotations.getQuotation(
        intParam(req.params.id, "報價編號"), canSeeCost(req.user)));
    }));

  api.post("/quotations", requireAuth, requirePermission(PERMISSIONS.QUOTATION_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      const draft = quotationDraftSchema.parse(req.body);
      // 沒有成本檢視權限的人，傳上來的成本一律忽略
      if (!canSeeCost(req.user)) {
        draft.lineItems = draft.lineItems.map(i => ({ ...i, unitCost: null }));
      }
      res.status(201).json(await quotations.createQuotation(draft, actorFrom(req)));
    }));

  api.patch("/quotations/versions/:versionId", requireAuth,
    requirePermission(PERMISSIONS.QUOTATION_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      const patch = quotationDraftSchema.partial().parse(req.body);
      if (patch.lineItems && !canSeeCost(req.user)) {
        patch.lineItems = patch.lineItems.map(i => ({ ...i, unitCost: null }));
      }
      res.json(await quotations.updateVersion(
        intParam(req.params.versionId, "版本編號"), patch, actorFrom(req)));
    }));

  api.post("/quotations/:id/versions", requireAuth,
    requirePermission(PERMISSIONS.QUOTATION_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      const patch = quotationDraftSchema.partial().parse(req.body);
      // 跟上面兩支寫入端一樣：沒有成本檢視權限的人傳來的成本一律忽略。
      // 少了這一段，沒權限的人雖然看不到成本，卻能盲改成本、把毛利數字弄髒。
      if (patch.lineItems && !canSeeCost(req.user)) {
        patch.lineItems = patch.lineItems.map(i => ({ ...i, unitCost: null }));
      }
      res.status(201).json(await quotations.createNewVersion(
        intParam(req.params.id, "報價編號"), patch, actorFrom(req)));
    }));

  api.post("/quotations/versions/:versionId/status", requireAuth,
    wrap(async (req: AuthedRequest, res) => {
      const { status, reason } = z.object({
        status: z.string(),
        reason: z.string().optional(),
      }).parse(req.body);

      // 作廢與核准是分開的權限：能編輯不代表能核准
      const needed = status === "voided" ? PERMISSIONS.QUOTATION_VOID
        : status === "approved" ? PERMISSIONS.QUOTATION_APPROVE
        : PERMISSIONS.QUOTATION_WRITE;
      requirePermission(needed)(req, res, err => {
        if (err) throw err;
      });

      res.json(await quotations.changeQuoteStatus(
        intParam(req.params.versionId, "版本編號"),
        status as never, actorFrom(req), reason));
    }));

  api.post("/quotations/:id/fulfillment", requireAuth,
    requirePermission(PERMISSIONS.QUOTATION_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      const { status, reason, milestoneDate } = z.object({
        status: z.string(),
        reason: z.string().optional(),
        milestoneDate: isoDate.optional(),
      }).parse(req.body);
      res.json(await quotations.changeFulfillmentStatus(
        intParam(req.params.id, "報價編號"),
        status as never, actorFrom(req), { reason, milestoneDate }));
    }));

  api.delete("/quotations/:id", requireAuth, requirePermission(PERMISSIONS.QUOTATION_VOID),
    wrap(async (req: AuthedRequest, res) => {
      res.json(await quotations.deleteQuotation(
        intParam(req.params.id, "報價編號"), actorFrom(req)));
    }));

  /* ── 檔案 ── */

  api.post("/quotations/:id/documents", requireAuth,
    requirePermission(PERMISSIONS.QUOTATION_WRITE),
    upload.single("file"),
    wrap(async (req: AuthedRequest, res) => {
      if (!req.file) throw new ValidationError("沒有收到檔案");
      const quotationId = intParam(req.params.id, "報價編號");
      const actor = actorFrom(req);

      const stored = await documents.storeDocument({
        buffer: req.file.buffer,
        originalFilename: req.file.originalname,
        mimeType: req.file.mimetype,
        kind: (req.body.kind as string) || "signed_quotation",
      }, actor);

      // 寫入磁碟。之後換成物件儲存時只要改這一段。
      const target = path.join(UPLOAD_ROOT, stored.storageKey);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, req.file.buffer);

      const linked = await documents.linkDocument(stored.document.id, {
        entityType: "quotation",
        entityId: quotationId,
        linkRole: (req.body.linkRole as string) || "signed_copy",
      }, actor);

      res.status(201).json({
        document: stored.document,
        deduplicated: stored.deduplicated,
        suspect: linked.suspect,
        conflictsWith: linked.conflictsWith,
        // 只回相對路徑，不回絕對網址 —— 舊系統存絕對網址是災難的起點
        url: `/api/documents/${stored.document.id}/download`,
      });
    }));

  api.get("/documents/:id/download", requireAuth,
    requirePermission(PERMISSIONS.QUOTATION_READ),
    wrap(async (req: AuthedRequest, res) => {
      const doc = await documents.getDocument(intParam(req.params.id, "檔案編號"));

      // 逐一比對這份檔案掛在什麼實體上，確認呼叫者對「那種實體」有讀取權。
      // 只靠路由上的 quotation:read 還不夠：孤兒檔案（沒有任何關聯）不該被下載，
      // 未來若新增其他類型（例如人事文件）也不能靠這支路由外洩。
      const linkTypes = await documents.getDocumentLinkTypes(doc.id);
      const READABLE_BY: Record<string, string> = {
        quotation: PERMISSIONS.QUOTATION_READ,
        contract: PERMISSIONS.QUOTATION_READ,
      };
      const allowed = linkTypes.length > 0 && linkTypes.every(t => {
        const needed = READABLE_BY[t];
        return needed && req.user!.permissions.has(needed);
      });
      if (!allowed) {
        throw new ForbiddenError("你沒有權限下載這份檔案，或這份檔案沒有有效的關聯。");
      }

      // storage_key 是系統產生的（sha256 + 副檔名），不是使用者輸入，
      // 但還是解析後檢查一次是否落在允許的目錄內
      const resolved = path.resolve(UPLOAD_ROOT, doc.storage_key);
      if (!resolved.startsWith(path.resolve(UPLOAD_ROOT) + path.sep)) {
        throw new ValidationError("檔案路徑不合法");
      }

      let buffer: Buffer;
      try {
        buffer = await readFile(resolved);
      } catch {
        throw new NotFoundError("檔案內容（資料庫有紀錄，但磁碟上找不到）");
      }

      // 瀏覽器不要自作聰明去嗅探內容型別（避免把偽裝成圖片的檔案當 HTML 執行）
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Type", doc.mime_type);
      res.setHeader("Content-Length", String(buffer.length));
      // PDF 可以內嵌預覽；其餘一律當附件下載，不在瀏覽器內就地開啟
      const disposition = doc.mime_type === "application/pdf" ? "inline" : "attachment";
      res.setHeader(
        "Content-Disposition",
        `${disposition}; filename*=UTF-8''${encodeURIComponent(doc.original_filename)}`,
      );
      res.send(buffer);
    }));

  api.get("/documents/suspect-links", requireAuth,
    requirePermission(PERMISSIONS.QUOTATION_READ),
    wrap(async (_req, res) => res.json(await documents.listSuspectLinks())));

  api.post("/documents/links/:linkId/verify", requireAuth,
    requirePermission(PERMISSIONS.QUOTATION_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      res.json(await documents.verifyLink(
        intParam(req.params.linkId, "關聯編號"), actorFrom(req), req.body?.note));
    }));

  api.delete("/documents/links/:linkId", requireAuth,
    requirePermission(PERMISSIONS.QUOTATION_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      res.json(await documents.unlinkDocument(
        intParam(req.params.linkId, "關聯編號"), actorFrom(req)));
    }));

  /* ── 合約與範本 ── */

  api.get("/templates", requireAuth, requirePermission(PERMISSIONS.QUOTATION_READ),
    wrap(async (_req, res) => res.json(await contractsRepo.listTemplates())));

  api.post("/templates", requireAuth, requirePermission(PERMISSIONS.SYSTEM_ADMIN),
    wrap(async (req: AuthedRequest, res) => {
      res.status(201).json(await contractsRepo.upsertTemplate(req.body, actorFrom(req)));
    }));

  api.patch("/templates/:id", requireAuth, requirePermission(PERMISSIONS.SYSTEM_ADMIN),
    wrap(async (req: AuthedRequest, res) => {
      res.json(await contractsRepo.upsertTemplate(
        { ...req.body, id: intParam(req.params.id, "範本編號") }, actorFrom(req)));
    }));

  /** 預覽套用結果，並列出還沒填到的變數 */
  api.get("/quotations/:id/contract-preview", requireAuth,
    requirePermission(PERMISSIONS.QUOTATION_READ),
    wrap(async (req, res) => {
      const quotationId = intParam(req.params.id, "報價編號");
      const templateId = Number(req.query.templateId);
      if (!Number.isInteger(templateId)) throw new ValidationError("請指定範本");

      const templates = await contractsRepo.listTemplates();
      const template = templates.find(t => t.id === templateId);
      if (!template) throw new NotFoundError("範本");

      const values = await contractsRepo.templateValuesFromQuotation(quotationId);
      res.json({
        content: contractsRepo.renderTemplate(template.body, values),
        values,
        missing: contractsRepo.missingVariables(template.body, values),
        templateName: template.name,
      });
    }));

  api.get("/contracts", requireAuth, requirePermission(PERMISSIONS.QUOTATION_READ),
    wrap(async (req, res) => {
      res.json(await contractsRepo.listContracts({
        status: req.query.status as string | undefined,
        clientId: req.query.clientId ? Number(req.query.clientId) : undefined,
        expiringDays: req.query.expiringDays ? Number(req.query.expiringDays) : undefined,
      }));
    }));

  api.get("/contracts/:id", requireAuth, requirePermission(PERMISSIONS.QUOTATION_READ),
    wrap(async (req, res) => {
      res.json(await contractsRepo.getContract(intParam(req.params.id, "合約編號")));
    }));

  api.post("/contracts", requireAuth, requirePermission(PERMISSIONS.QUOTATION_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      res.status(201).json(await contractsRepo.createContract(req.body, actorFrom(req)));
    }));

  api.patch("/contracts/:id", requireAuth, requirePermission(PERMISSIONS.QUOTATION_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      res.json(await contractsRepo.updateContract(
        intParam(req.params.id, "合約編號"), req.body, actorFrom(req)));
    }));

  api.post("/contracts/:id/status", requireAuth, requirePermission(PERMISSIONS.QUOTATION_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      const { status, signedAt, reason } = z.object({
        status: z.string(), signedAt: isoDate.optional(), reason: z.string().optional(),
      }).parse(req.body);
      res.json(await contractsRepo.changeContractStatus(
        intParam(req.params.id, "合約編號"), status as never, actorFrom(req), { signedAt, reason }));
    }));

  api.post("/contracts/:id/documents", requireAuth,
    requirePermission(PERMISSIONS.QUOTATION_WRITE), upload.single("file"),
    wrap(async (req: AuthedRequest, res) => {
      if (!req.file) throw new ValidationError("沒有收到檔案");
      const contractId = intParam(req.params.id, "合約編號");
      const actor = actorFrom(req);

      const stored = await documents.storeDocument({
        buffer: req.file.buffer, originalFilename: req.file.originalname,
        mimeType: req.file.mimetype, kind: "contract",
      }, actor);

      const target = path.join(UPLOAD_ROOT, stored.storageKey);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, req.file.buffer);

      const linked = await documents.linkDocument(stored.document.id, {
        entityType: "contract", entityId: contractId, linkRole: "signed_copy",
      }, actor);

      res.status(201).json({
        document: stored.document, suspect: linked.suspect,
        conflictsWith: linked.conflictsWith,
        url: `/api/documents/${stored.document.id}/download`,
      });
    }));

  /* ── 檔案總覽 ── */

  api.get("/documents", requireAuth, requirePermission(PERMISSIONS.QUOTATION_READ),
    wrap(async (req, res) => {
      const limit = Math.min(Number(req.query.limit) || 200, 500);
      const rows = await pool.query(
        `SELECT d.id, d.original_filename AS "filename", d.mime_type AS "mimeType",
                d.byte_size AS "byteSize", d.sha256, d.kind,
                d.uploaded_at AS "uploadedAt", u.username AS "uploadedBy",
                COALESCE(json_agg(json_build_object(
                  'linkId', l.id, 'entityType', l.entity_type, 'entityId', l.entity_id,
                  'role', l.link_role, 'status', l.verification_status,
                  'label', COALESCE(q.quotation_number, c.contract_number)
                ) ORDER BY l.id) FILTER (WHERE l.id IS NOT NULL), '[]') AS links
         FROM documents d
         LEFT JOIN users u ON u.id = d.uploaded_by
         LEFT JOIN document_links l ON l.document_id = d.id
         LEFT JOIN quotations q ON q.id = l.entity_id AND l.entity_type='quotation'
         LEFT JOIN contracts c ON c.id = l.entity_id AND l.entity_type='contract'
         WHERE d.deleted_at IS NULL
         GROUP BY d.id, u.username
         ORDER BY d.uploaded_at DESC LIMIT $1`, [limit]);
      res.json(rows.rows);
    }));

  /* ── 人事：員工 ── */

  api.get("/employees", requireAuth, requirePermission(PERMISSIONS.EMPLOYEE_READ),
    wrap(async (req, res) => {
      res.json(await hr.listEmployees(req.query.includeInactive === "true"));
    }));

  api.get("/employees/:id", requireAuth, wrap(async (req: AuthedRequest, res) => {
    const id = intParam(req.params.id, "員工編號");
    const canRead = req.user!.permissions.has(PERMISSIONS.EMPLOYEE_READ)
      || req.user!.permissions.has(PERMISSIONS.SYSTEM_ADMIN);

    if (!canRead) {
      // 沒有權限時只能看自己
      const own = await pool.query("SELECT 1 FROM employees WHERE id=$1 AND user_id=$2",
        [id, req.user!.id]);
      if (!own.rowCount) throw new ForbiddenError();
    }
    const canSeeSalary = req.user!.permissions.has(PERMISSIONS.EMPLOYEE_VIEW_SALARY)
      || req.user!.permissions.has(PERMISSIONS.SYSTEM_ADMIN);
    res.json(await hr.getEmployee(id, canSeeSalary));
  }));

  api.get("/employees/:id/salary", requireAuth,
    requirePermission(PERMISSIONS.EMPLOYEE_VIEW_SALARY),
    wrap(async (req, res) => {
      res.json(await hr.getEmployeeSalary(intParam(req.params.id, "員工編號")));
    }));

  // 部門與職位清單（員工表單的下拉來源）
  api.get("/departments", requireAuth, requirePermission(PERMISSIONS.EMPLOYEE_READ),
    wrap(async (_req, res) => res.json(await hr.listDepartments())));
  api.get("/positions", requireAuth, requirePermission(PERMISSIONS.EMPLOYEE_READ),
    wrap(async (_req, res) => res.json(await hr.listPositions())));

  // 新增員工
  api.post("/employees", requireAuth, requirePermission(PERMISSIONS.EMPLOYEE_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      const allowSalary = req.user!.permissions.has(PERMISSIONS.EMPLOYEE_VIEW_SALARY)
        || req.user!.permissions.has(PERMISSIONS.SYSTEM_ADMIN);
      res.status(201).json(await hr.createEmployee(req.body, actorFrom(req), allowSalary));
    }));

  // 編輯員工
  api.patch("/employees/:id", requireAuth, requirePermission(PERMISSIONS.EMPLOYEE_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      const allowSalary = req.user!.permissions.has(PERMISSIONS.EMPLOYEE_VIEW_SALARY)
        || req.user!.permissions.has(PERMISSIONS.SYSTEM_ADMIN);
      res.json(await hr.updateEmployee(
        intParam(req.params.id, "員工編號"), req.body, actorFrom(req), allowSalary));
    }));

  /* ── 人事：請假 ── */

  api.get("/leave-requests", requireAuth, wrap(async (req: AuthedRequest, res) => {
    const canReadAll = req.user!.permissions.has(PERMISSIONS.LEAVE_APPROVE)
      || req.user!.permissions.has(PERMISSIONS.SYSTEM_ADMIN);

    let employeeId = req.query.employeeId ? Number(req.query.employeeId) : undefined;
    if (!canReadAll) {
      // 只能看自己的
      const own = await pool.query("SELECT id FROM employees WHERE user_id=$1", [req.user!.id]);
      if (!own.rowCount) return res.json([]);
      employeeId = own.rows[0].id;
    }
    res.json(await hr.listLeaveRequests({
      employeeId, status: req.query.status as string | undefined,
    }));
  }));

  api.post("/leave-requests", requireAuth, requirePermission(PERMISSIONS.LEAVE_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      const body = z.object({
        employeeId: z.number().int().positive().optional(),
        leaveType: z.string(),
        startDate: isoDate, endDate: isoDate,
        days: z.number().positive(),
        reason: z.string().min(1, "請填寫請假事由"),
        tripLocation: z.string().optional(),
        tripType: z.enum(["domestic", "international"]).optional(),
      }).parse(req.body);

      // 沒有審核權限的人只能幫自己請假
      let employeeId = body.employeeId;
      const canActForOthers = req.user!.permissions.has(PERMISSIONS.LEAVE_APPROVE)
        || req.user!.permissions.has(PERMISSIONS.SYSTEM_ADMIN);
      if (!canActForOthers || !employeeId) {
        const own = await pool.query("SELECT id FROM employees WHERE user_id=$1", [req.user!.id]);
        if (!own.rowCount) throw new ValidationError("你的帳號還沒有對應的員工資料");
        employeeId = own.rows[0].id;
      }

      res.status(201).json(await hr.createLeaveRequest(
        { ...body, employeeId: employeeId! }, actorFrom(req)));
    }));

  api.post("/leave-requests/:id/decide", requireAuth,
    requirePermission(PERMISSIONS.LEAVE_APPROVE),
    wrap(async (req: AuthedRequest, res) => {
      const { decision, reason } = z.object({
        decision: z.enum(["approved", "rejected"]),
        reason: z.string().optional(),
      }).parse(req.body);
      res.json(await hr.decideLeaveRequest(
        intParam(req.params.id, "申請編號"), decision, actorFrom(req), reason));
    }));

  /* ── 人事：出勤 ── */

  api.get("/attendance", requireAuth, wrap(async (req: AuthedRequest, res) => {
    const canReadAll = req.user!.permissions.has(PERMISSIONS.ATTENDANCE_MANAGE)
      || req.user!.permissions.has(PERMISSIONS.SYSTEM_ADMIN);
    let employeeId = req.query.employeeId ? Number(req.query.employeeId) : undefined;
    if (!canReadAll) {
      const own = await pool.query("SELECT id FROM employees WHERE user_id=$1", [req.user!.id]);
      if (!own.rowCount) return res.json([]);
      employeeId = own.rows[0].id;
    }
    res.json(await hr.listAttendance({
      employeeId,
      from: req.query.from as string | undefined,
      to: req.query.to as string | undefined,
    }));
  }));

  api.post("/attendance/clock-in", requireAuth, requirePermission(PERMISSIONS.ATTENDANCE_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      const own = await pool.query("SELECT id FROM employees WHERE user_id=$1", [req.user!.id]);
      if (!own.rowCount) throw new ValidationError("你的帳號還沒有對應的員工資料");
      res.json(await hr.clockIn(own.rows[0].id, actorFrom(req)));
    }));

  api.post("/attendance/clock-out", requireAuth, requirePermission(PERMISSIONS.ATTENDANCE_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      const own = await pool.query("SELECT id FROM employees WHERE user_id=$1", [req.user!.id]);
      if (!own.rowCount) throw new ValidationError("你的帳號還沒有對應的員工資料");
      res.json(await hr.clockOut(own.rows[0].id, actorFrom(req)));
    }));

  api.patch("/attendance/:id", requireAuth, requirePermission(PERMISSIONS.ATTENDANCE_MANAGE),
    wrap(async (req: AuthedRequest, res) => {
      const { reason, ...changes } = z.object({
        reason: z.string().min(1, "修改出勤紀錄必須填寫事由"),
        clockInAt: z.string().nullish(),
        clockOutAt: z.string().nullish(),
        status: z.string().optional(),
        notes: z.string().optional(),
      }).parse(req.body);
      res.json(await hr.amendAttendance(
        intParam(req.params.id, "出勤編號"), changes, reason, actorFrom(req)));
    }));

  api.get("/attendance/:id/history", requireAuth,
    requirePermission(PERMISSIONS.ATTENDANCE_READ),
    wrap(async (req, res) => {
      res.json(await hr.getAttendanceHistory(intParam(req.params.id, "出勤編號")));
    }));

  /* ── 產品品項 ── */

  api.get("/products", requireAuth, requirePermission(PERMISSIONS.PRODUCT_READ),
    wrap(async (req, res) => {
      res.json(await admin.listProducts(req.query.search as string | undefined));
    }));

  api.post("/products", requireAuth, requirePermission(PERMISSIONS.PRODUCT_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      res.status(201).json(await admin.upsertProduct(req.body, actorFrom(req)));
    }));

  api.patch("/products/:id", requireAuth, requirePermission(PERMISSIONS.PRODUCT_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      res.json(await admin.upsertProduct(
        { ...req.body, id: intParam(req.params.id, "品項編號") }, actorFrom(req)));
    }));

  /* ── 使用者與角色 ── */

  api.get("/users", requireAuth, requirePermission(PERMISSIONS.USER_READ),
    wrap(async (_req, res) => res.json(await admin.listUsers())));

  api.get("/roles", requireAuth, requirePermission(PERMISSIONS.USER_READ),
    wrap(async (_req, res) => res.json(await admin.listRoles())));

  api.post("/users", requireAuth, requirePermission(PERMISSIONS.USER_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      res.status(201).json(await admin.createUser(req.body, actorFrom(req)));
    }));

  api.patch("/users/:id", requireAuth, requirePermission(PERMISSIONS.USER_WRITE),
    wrap(async (req: AuthedRequest, res) => {
      res.json(await admin.updateUser(
        intParam(req.params.id, "使用者編號"), req.body, actorFrom(req)));
    }));

  /* ── 稽核 ── */

  api.get("/audit", requireAuth, requirePermission(PERMISSIONS.AUDIT_READ),
    wrap(async (req, res) => {
      const limit = Math.min(Number(req.query.limit) || 100, 500);
      const rows = await pool.query(
        `SELECT id, at, actor_label AS "actor", entity_type AS "entityType",
                entity_id AS "entityId", action, changes
         FROM audit_log
         ${req.query.entityType ? "WHERE entity_type = $2" : ""}
         ORDER BY at DESC LIMIT $1`,
        req.query.entityType ? [limit, req.query.entityType] : [limit],
      );
      res.json(rows.rows);
    }));

  app.use("/api", api);

  /* ── 錯誤處理 ── */

  app.use((err: unknown, req: AuthedRequest, res: Response, _next: NextFunction) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({
        message: err.errors[0]?.message ?? "資料格式錯誤",
        code: "validation_error",
        errors: err.errors,
      });
    }
    if (err instanceof AppError) {
      return res.status(err.status).json({
        message: err.message, code: err.code, details: err.details,
      });
    }
    if ((err as { code?: string })?.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ message: "檔案太大", code: "file_too_large" });
    }
    // body-parser 的 JSON 解析錯誤是客戶端的問題，不是伺服器壞掉
    if ((err as { type?: string })?.type === "entity.parse.failed") {
      return res.status(400).json({ message: "請求內容不是合法的 JSON", code: "bad_json" });
    }

    // 沒預期到的錯誤只在伺服器留下細節，不回給前端
    console.error("未處理的錯誤:", err);
    res.status(500).json({ message: "伺服器發生錯誤", code: "internal_error" });
  });
}

function publicUser(user: AuthUser) {
  return {
    id: user.id, username: user.username, email: user.email,
    displayName: user.displayName, role: user.role,
    mustChangePassword: user.mustChangePassword,
    permissions: [...user.permissions],
  };
}

/** 送出 logo / 印章檔案。路徑是系統自己產生的，仍檢查落在 uploads 內。 */
function sendBrandingFile(res: Response, relPath: string) {
  const resolved = path.resolve(UPLOAD_ROOT, relPath);
  if (!resolved.startsWith(path.resolve(UPLOAD_ROOT) + path.sep)) {
    throw new ValidationError("檔案路徑不合法");
  }
  const type = resolved.endsWith(".svg") ? "image/svg+xml"
    : resolved.endsWith(".jpg") ? "image/jpeg" : "image/png";
  res.setHeader("Content-Type", type);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // SVG 用 sandbox 的 CSP：就算夾了 script 也不會執行
  if (type === "image/svg+xml") res.setHeader("Content-Security-Policy", "script-src 'none'; sandbox");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.sendFile(resolved, err => {
    if (err && !res.headersSent) res.status(404).json({ message: "找不到檔案", code: "not_found" });
  });
}

function intParam(value: string, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ValidationError(`${label}格式錯誤`);
  return n;
}
