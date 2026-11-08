/**
 * 客戶通訊錄。
 *
 * 問題背景：原本的「現有客戶」是直接用 clientCompany 去重，
 * 同一個單位只會保留第一筆遇到的聯絡人。但實務上同一個單位
 * （例如一所學校）會有很多不同的窗口老師，舊做法讓第二位之後
 * 的聯絡人完全無法被帶入。
 *
 * 這裡把歷史報價單整理成兩層結構：
 *   單位（公司／學校）→ 多位聯絡人
 * 單位層級的欄位（統編、地址）取自該單位「最近一次」有填值的報價單；
 * 聯絡人層級的欄位（姓名、電話、Email）則各自獨立保存。
 */

export interface ClientContactEntry {
  /** 聯絡人姓名（去除前後空白後的原始字串） */
  contact: string;
  email: string;
  phone: string;
  /** 此聯絡人最後一次出現在報價單上的時間，用於排序 */
  lastUsedAt: string;
  /** 這位聯絡人出現過幾張報價單 */
  quotationCount: number;
}

export interface ClientOrganization {
  /** 單位名稱（公司／學校） */
  company: string;
  taxId: string;
  address: string;
  contacts: ClientContactEntry[];
  lastUsedAt: string;
  /** 這個單位總共出現過幾張報價單 */
  quotationCount: number;
}

/** 從報價單記錄取出一個可比較的時間字串，用來判斷哪筆比較新 */
function recordTimestamp(data: any): string {
  return (
    data?.updatedAt ||
    data?.statusUpdatedAt ||
    data?.createdAt ||
    data?.quotationDate ||
    ''
  );
}

function isNewer(a: string, b: string): boolean {
  // 空字串一律視為最舊
  if (!a) return false;
  if (!b) return true;
  return a > b;
}

function normalizeKey(value: unknown): string {
  return String(value ?? '').trim();
}

/**
 * 把所有報價單整理成「單位 → 聯絡人」的通訊錄。
 *
 * @param quotations getAllQuotations() 的回傳值
 */
export function buildClientDirectory(
  quotations: Array<{ id: string; data: any }>,
): ClientOrganization[] {
  const orgMap = new Map<string, ClientOrganization>();

  for (const item of quotations) {
    const data = item?.data;
    const company = normalizeKey(data?.clientCompany);
    if (!company) continue;

    const timestamp = recordTimestamp(data);

    let org = orgMap.get(company);
    if (!org) {
      org = {
        company,
        taxId: normalizeKey(data?.buyerTaxId),
        address: normalizeKey(data?.clientAddress),
        contacts: [],
        lastUsedAt: timestamp,
        quotationCount: 0,
      };
      orgMap.set(company, org);
    }

    org.quotationCount += 1;

    // 單位層級欄位：採用最新一筆「有填值」的資料，
    // 避免被後來某張沒填統編的報價單清空
    if (isNewer(timestamp, org.lastUsedAt)) {
      org.lastUsedAt = timestamp;
    }
    const taxId = normalizeKey(data?.buyerTaxId);
    if (taxId && (!org.taxId || isNewer(timestamp, org.lastUsedAt))) {
      org.taxId = taxId;
    }
    const address = normalizeKey(data?.clientAddress);
    if (address && (!org.address || isNewer(timestamp, org.lastUsedAt))) {
      org.address = address;
    }

    // 聯絡人層級：同一個單位可以有多位窗口
    const contactName = normalizeKey(data?.clientContact);
    if (!contactName) continue;

    let contact = org.contacts.find(c => c.contact === contactName);
    if (!contact) {
      contact = {
        contact: contactName,
        email: normalizeKey(data?.clientEmail),
        phone: normalizeKey(data?.clientPhone),
        lastUsedAt: timestamp,
        quotationCount: 0,
      };
      org.contacts.push(contact);
    } else if (isNewer(timestamp, contact.lastUsedAt)) {
      // 同一位聯絡人以最新一筆的電話／Email 為準
      contact.lastUsedAt = timestamp;
      if (normalizeKey(data?.clientEmail)) contact.email = normalizeKey(data?.clientEmail);
      if (normalizeKey(data?.clientPhone)) contact.phone = normalizeKey(data?.clientPhone);
    }

    contact.quotationCount += 1;
  }

  const orgs = Array.from(orgMap.values());

  // 最近使用過的排前面，其次是往來次數多的
  const byRecency = (a: { lastUsedAt: string; quotationCount: number }, b: typeof a) => {
    if (a.lastUsedAt !== b.lastUsedAt) return isNewer(a.lastUsedAt, b.lastUsedAt) ? -1 : 1;
    return b.quotationCount - a.quotationCount;
  };

  for (const org of orgs) org.contacts.sort(byRecency);
  orgs.sort(byRecency);

  return orgs;
}

/** 依關鍵字篩選通訊錄（比對單位名稱、聯絡人、統編） */
export function filterDirectory(
  orgs: ClientOrganization[],
  keyword: string,
): ClientOrganization[] {
  const q = keyword.trim().toLowerCase();
  if (!q) return orgs;

  return orgs
    .map(org => {
      const orgMatches =
        org.company.toLowerCase().includes(q) || org.taxId.toLowerCase().includes(q);

      // 單位本身命中就整個保留；否則只留下命中的聯絡人
      if (orgMatches) return org;

      const contacts = org.contacts.filter(
        c =>
          c.contact.toLowerCase().includes(q) ||
          c.email.toLowerCase().includes(q) ||
          c.phone.toLowerCase().includes(q),
      );
      return contacts.length > 0 ? { ...org, contacts } : null;
    })
    .filter((org): org is ClientOrganization => org !== null);
}

/** 找出與指定名稱完全相同的單位（去空白、忽略大小寫） */
export function findOrganization(
  orgs: ClientOrganization[],
  company: string,
): ClientOrganization | undefined {
  const target = normalizeKey(company).toLowerCase();
  if (!target) return undefined;
  return orgs.find(org => org.company.toLowerCase() === target);
}


/**
 * 通訊錄快取。
 *
 * 通訊錄是從「全部報價單」即時計算出來的，好處是零建檔、歷史聯絡人立刻可用，
 * 代價是每次進編輯頁都要下載整份資料。這裡用 sessionStorage 做短期快取：
 * 同一個分頁工作階段內不重複下載，關掉分頁就失效（不會拿到過期太久的資料）。
 */
const CACHE_KEY = 'qm_client_directory_cache';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 分鐘

interface CachePayload {
  savedAt: number;
  orgs: ClientOrganization[];
}

export function readDirectoryCache(now: number = Date.now()): ClientOrganization[] | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const payload = JSON.parse(raw) as CachePayload;
    if (!payload || !Array.isArray(payload.orgs)) return null;
    if (now - payload.savedAt > CACHE_TTL_MS) return null;
    return payload.orgs;
  } catch {
    return null;
  }
}

export function writeDirectoryCache(
  orgs: ClientOrganization[],
  now: number = Date.now(),
): void {
  try {
    const payload: CachePayload = { savedAt: now, orgs };
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    // 空間不足或隱私模式：快取失敗不影響功能，略過即可
  }
}

/** 資料有變動時清掉快取（例如儲存了新的報價單） */
export function invalidateDirectoryCache(): void {
  try { sessionStorage.removeItem(CACHE_KEY); } catch { /* 略過 */ }
}
