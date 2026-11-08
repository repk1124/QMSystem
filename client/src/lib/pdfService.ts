import html2pdf from 'html2pdf.js';
import { QuotationData } from '@/context/QuotationContext';
import { calculateQuotationTotals, lineItemAmount, formatAmount } from '@/lib/calc';
import { parseNotes, parseSpecification, type RichNode } from '@/lib/richText';

/** PDF 匯出的額外選項（印章、負責人等，由呼叫端從設定帶入） */
export interface PdfExportOptions {
  /** 公司印章圖片（data URL）。有值且 applyStamp 不為 false 時會蓋在簽章欄。 */
  stampImage?: string;
  /** 是否蓋章，預設 true（有 stampImage 才會實際生效） */
  applyStamp?: boolean;
  /** 合約上的負責人姓名；未提供時退回使用聯絡人 */
  principalName?: string;
  /** 印章列印寬度（mm），未指定時使用標準發票章尺寸 40mm */
  stampWidthMm?: number;
}

/**
 * HTML 逸出。
 *
 * 整份 PDF 是用 innerHTML 組出來的，任何欄位若含有 < > & " 都會破壞版面，
 * 而備註／規格這類自由輸入欄位更是儲存型 XSS 的入口
 * （html2pdf.js < 0.14 亦有對應的 XSS 公告）。所有插值都必須經過這裡。
 */
function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 以「本地時區」格式化日期。
 *
 * 修復：原本用 new Date('YYYY-MM-DD') 會被當成 UTC 午夜解析，
 * 台北（UTC+8）以外的時區顯示會差一天。
 */
function formatLocalDate(dateStr?: string): string {
  if (!dateStr) return new Date().toLocaleDateString('zh-TW');

  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr);
  if (match) {
    const [, y, m, d] = match;
    return new Date(Number(y), Number(m) - 1, Number(d)).toLocaleDateString('zh-TW');
  }

  const parsed = new Date(dateStr);
  return Number.isNaN(parsed.getTime()) ? dateStr : parsed.toLocaleDateString('zh-TW');
}

/** 取得本地時區的 YYYY-MM-DD（不要用 toISOString，那是 UTC 日期） */
function localDateKey(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 印章預設寬度（mm）。
 *
 * 台灣市售統一發票專用章常見尺寸約為 4×3.5cm ~ 4.5×3.5cm，
 * 因此預設 40mm 寬（本專案的章圖長寬比約 1.14，換算高度約 35mm，
 * 相當於實體 4.0 × 3.5 公分），與真章大小一致。
 */
const DEFAULT_STAMP_WIDTH_MM = 40;

/** 簽章欄高度（mm）—— 必須容納得下一顆真實大小的印章 */
const SIGNATURE_BOX_HEIGHT_MM = 40;

/** A4 頁高（mm） */
const A4_HEIGHT_MM = 297;
/** CSS 像素與公釐的換算（96dpi） */
const PX_PER_MM = 96 / 25.4;
/**
 * 自動縮放的下限。
 * 0.85 是可讀性與「盡量一頁」之間的平衡點：
 * 內文 10px × 0.85 ≈ 8.5px，列印出來仍清晰。
 */
const MIN_FIT_SCALE = 0.85;

/**
 * 產生印章圖層的 HTML。
 *
 * 以絕對定位置中疊在簽章線上方，並帶一點旋轉，看起來像實際蓋上去的章。
 * 圖片必須是 data URL —— 若使用一般的檔案 URL，html2canvas 在某些
 * 情境下會因為跨來源而汙染 canvas，導致整份 PDF 匯出失敗。
 *
 * @param placement 'center' = 水平置中於簽章欄（報價單用）
 *                  'inline' = 靠右垂直置中（合約甲方欄用，避免蓋住條文）
 */
function renderStampHtml(
  options?: PdfExportOptions,
  placement: 'center' | 'inline' = 'center',
): string {
  if (!options?.stampImage) return '';
  if (options.applyStamp === false) return '';

  const widthMm = options.stampWidthMm && options.stampWidthMm > 0
    ? options.stampWidthMm
    : DEFAULT_STAMP_WIDTH_MM;

  // center：水平置中、底部貼齊簽章線上方 2mm
  // inline：靠右、垂直置中
  const position = placement === 'center'
    ? `left: 50%; bottom: 2mm; transform: translateX(-50%) rotate(-4deg);`
    : `right: 6%; top: 50%; transform: translateY(-50%) rotate(-4deg);`;

  return `
    <img src="${escapeHtml(options.stampImage)}"
         alt="公司印章"
         style="position: absolute; ${position} width: ${widthMm}mm; height: auto;
                opacity: 0.9; pointer-events: none; mix-blend-mode: multiply;" />
  `;
}

/**
 * 產生「非絕對定位」的印章區塊，直接排在版面流中。
 * 用於免簽回的報價單：印章蓋在備註區右側的空白處，不另外佔用簽章欄。
 */
function renderStampBlockHtml(options?: PdfExportOptions): string {
  if (!options?.stampImage) return '';
  if (options.applyStamp === false) return '';

  const widthMm = options.stampWidthMm && options.stampWidthMm > 0
    ? options.stampWidthMm
    : DEFAULT_STAMP_WIDTH_MM;

  return `
    <img src="${escapeHtml(options.stampImage)}"
         alt="公司印章"
         style="display: block; width: ${widthMm}mm; height: auto; opacity: 0.9;
                transform: rotate(-4deg); mix-blend-mode: multiply;" />
  `;
}

// 註：舊的 formatSpecificationWithBullets / buildSectionHtml 已移除。
// 它們把規格的每一行無差別加上項目符號，連「1. 雲端伺服器規格」這種小標
// 也被當成項目，階層完全消失。改由 lib/richText.ts 解析成有階層的節點，
// 再交給 renderSpecNodes() 排版。

/**
 * 自動縮放到一頁。
 *
 * 使用情境：一張只有一兩個報價項目的單，內容常常只超出一頁一點點，
 * 卻讓備註與印章整塊被推到第二頁，第一頁下方留一大片空白 —— 這是使用者
 * 最常抱怨的「跑版」。
 *
 * 做法：量測內容實際高度，如果超出一頁但在可接受範圍內，就整體等比微縮
 * （縮字級、行距、間距一起縮），把它塞回一頁。縮放有下限，避免縮到看不清楚；
 * 真的放不下（例如報價項目很多）就維持原樣正常分頁。
 *
 * @param element 已掛載到 DOM 的渲染容器
 * @param minScale 最小縮放比例，預設 0.85（再小就影響閱讀）
 */
function applyFitToOnePage(element: HTMLElement, minScale = MIN_FIT_SCALE): void {
  const inner = element.firstElementChild as HTMLElement | null;
  if (!inner) return;

  // html2pdf 會把內容放進「A4 內容寬」的容器；A4 內容高同理是
  // 297mm 減掉上下邊距。換算成 px（96dpi：1mm ≈ 3.7795px）。
  const pageContentHeightPx =
    (A4_HEIGHT_MM - pdfOptions.margin[0] - pdfOptions.margin[2]) * PX_PER_MM;

  const actualHeight = inner.scrollHeight;
  if (actualHeight <= pageContentHeightPx) return; // 本來就放得下

  const requiredScale = pageContentHeightPx / actualHeight;
  if (requiredScale < minScale) {
    // 超出太多，縮到會看不清楚；讓它正常分頁
    console.info(
      `[PDF] 內容高度 ${Math.round(actualHeight)}px 超過單頁 ${Math.round(pageContentHeightPx)}px 過多` +
      `（需縮至 ${(requiredScale * 100).toFixed(0)}%），改為正常分頁`,
    );
    return;
  }

  // 留一點餘裕，避免量測誤差造成剛好溢出一兩個像素就多一頁
  const scale = Math.max(minScale, requiredScale * 0.985);

  inner.style.transformOrigin = 'top left';
  inner.style.transform = `scale(${scale})`;
  // transform 不會改變版面配置高度，必須自己把外框高度收回來，
  // 否則 html2pdf 仍會以原始高度判斷而多切一頁。
  inner.style.width = `${100 / scale}%`;
  element.style.height = `${actualHeight * scale}px`;
  element.style.overflow = 'hidden';

  console.info(`[PDF] 內容微縮至 ${(scale * 100).toFixed(0)}% 以維持單頁`);
}


// ---------------------------------------------------------------------------
// 已知限制：跨頁不重複表格標頭
//
// 曾嘗試在分頁處插入複製的 <tr> 標頭，但無法可靠達成：
// 整份文件是被 html2canvas 轉成一張長圖後才切頁的，插入標頭會改變版面高度，
// 進而改變 html2pdf 實際的分頁位置 —— 也就是「插入位置取決於分頁結果，
// 分頁結果又取決於插入位置」的循環相依。實測結果是標頭落在頁面中間，
// 比完全沒有標頭更容易誤導閱讀，因此移除。
//
// 要真正解決必須換渲染方式（例如伺服器端 Puppeteer 直接輸出 PDF，
// 讓瀏覽器原生的 `thead { display: table-header-group }` 生效），
// 屬於較大的架構調整，已記錄在 TODO.md 的 E1。
// ---------------------------------------------------------------------------

/**
 * 去掉尾端空白，避免產生完全空白的最後一頁。
 *
 * html2pdf 依「容器高度」決定頁數，而容器高度包含尾端的 padding／margin。
 * 只要內容比整數頁多出一點點（哪怕只是 20px 的邊距），就會多切出一頁，
 * 而那一頁上什麼都沒有 —— 使用者列印時會多印一張白紙。
 *
 * 這裡量出「最後一個有內容的元素」底部在哪，把容器高度收到那裡。
 */
function trimTrailingBlankPage(element: HTMLElement): void {
  const inner = element.firstElementChild as HTMLElement | null;
  if (!inner) return;

  const containerTop = element.getBoundingClientRect().top;

  // 找出所有後代元素中最底部的一個
  let contentBottom = 0;
  for (const node of Array.from(inner.querySelectorAll('*'))) {
    const rect = (node as HTMLElement).getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) continue; // 隱藏元素不計
    const bottom = rect.bottom - containerTop;
    if (bottom > contentBottom) contentBottom = bottom;
  }

  if (contentBottom <= 0) return;

  const pageContentHeightPx =
    (A4_HEIGHT_MM - pdfOptions.margin[0] - pdfOptions.margin[2]) * PX_PER_MM;

  // 留一點下邊距，但不要多到擠出新的一頁
  const desired = contentBottom + 8;
  const currentHeight = element.getBoundingClientRect().height || inner.scrollHeight;

  if (desired >= currentHeight) return; // 本來就沒有多餘空白

  const pagesBefore = Math.ceil(currentHeight / pageContentHeightPx);
  const pagesAfter = Math.ceil(desired / pageContentHeightPx);

  element.style.height = `${desired}px`;
  element.style.overflow = 'hidden';

  if (pagesAfter < pagesBefore) {
    console.info(`[PDF] 移除尾端空白，頁數由 ${pagesBefore} 頁收斂為 ${pagesAfter} 頁`);
  }
}

// PDF 導出選項
const pdfOptions = {
  // as const 元組：html2pdf 0.14 起提供 TypeScript 型別，
  // margin 必須是 [上,右,下,左] 四元組而非一般 number[]
  margin: [10, 10, 10, 10] as [number, number, number, number], // 上下左右邊距
  filename: 'quotation.pdf',
  image: { type: 'jpeg' as const, quality: 0.98 }, // 圖片品質
  html2canvas: {
    // scale 從 3 降到 2：A4 在 scale 3 下每頁約 3366px，超過約 5 頁就會
    // 撞到瀏覽器 16384px 的 canvas 高度上限，結果匯出一張全白的 PDF。
    scale: 2,
    useCORS: true,
    letterRendering: true,
    // allowTaint 與 useCORS 同時開啟時，一旦真的載入跨來源圖片，
    // canvas 會被汙染而讓 toDataURL 拋 SecurityError。印章改用 data URL，
    // 這裡就能安全地關掉 allowTaint，讓問題早點浮現而不是產出壞檔案。
    allowTaint: false,
    backgroundColor: '#ffffff',
  },
  jsPDF: {
    unit: 'mm' as const,
    format: 'a4' as const,
    orientation: 'portrait' as const, // 'portrait' 或 'landscape'
    compress: false, // 不壓縮內容，避免格式問題
    precision: 16 // 提高精確度
  },
  // 讓 html2pdf 依 CSS 規則斷頁，表格列不會被從中間切開
  pagebreak: { mode: ['css', 'legacy'] as ('css' | 'legacy')[], avoid: ['tr', '.avoid-break'] },
};
// ---------------------------------------------------------------------------
// 報價單版面
//
// 設計目標：單一報價項目的報價單，必須「報價 + 備註 + 用印」全部落在同一頁。
// 舊版的問題：
//   1. 備註區被 `page-break-inside: avoid` 保護，一旦第一頁剩餘空間不足，
//      整塊被推到第二頁 → 第一頁下方留一大片空白，第二頁只用了 1/5
//   2. 每個區塊的 margin/padding 都偏大，白白吃掉垂直空間
//   3. 規格欄只有 33% 寬，長內容被擠成細長條，行數暴增
//   4. 規格每一行無差別加上項目符號，連小標也被當成項目，階層消失
// ---------------------------------------------------------------------------

/** 把解析後的節點渲染成規格欄的 HTML（表格內，字級小、行距緊） */
function renderSpecNodes(nodes: RichNode[]): string {
  if (nodes.length === 0) return '';

  return nodes
    .map(node => {
      switch (node.kind) {
        case 'heading':
          // 小標：不加項目符號，用底色與粗體區隔
          return `<div style="font-weight: 700; color: #1f2937; margin: 4px 0 2px 0; line-height: 1.35;">${escapeHtml(node.text)}</div>`;

        case 'field': {
          // 鍵：值 → 用 flex 對齊，值換行時會靠著值欄縮排，不會跑回最左邊
          const indent = node.depth * 8;
          return `<div style="display: flex; gap: 4px; margin: 1px 0 1px ${indent}px; line-height: 1.35;">
            <span style="color: #6b7280; white-space: nowrap;">${escapeHtml(node.label)}：</span>
            <span style="flex: 1; min-width: 0;">${escapeHtml(node.value)}</span>
          </div>`;
        }

        case 'item': {
          const indent = node.depth * 8;
          return `<div style="display: flex; gap: 4px; margin: 1px 0 1px ${indent}px; line-height: 1.35;">
            <span style="color: #9ca3af; flex-shrink: 0;">・</span>
            <span style="flex: 1; min-width: 0;">${escapeHtml(node.text)}</span>
          </div>`;
        }

        case 'paragraph':
        default:
          return `<div style="line-height: 1.35;">${escapeHtml((node as { text: string }).text)}</div>`;
      }
    })
    .join('');
}

/**
 * 把解析後的節點渲染成備註區的 HTML。
 *
 * 重點：編號由系統產生並固定寬度，續行會對齊到文字起點，
 * 不會像舊版那樣掉回最左邊。
 */
function renderNoteNodes(nodes: RichNode[]): string {
  if (nodes.length === 0) return '';

  return nodes
    .map(node => {
      if (node.kind !== 'item') {
        const text = (node as { text?: string }).text ?? '';
        return `<div style="line-height: 1.45; margin: 1px 0;">${escapeHtml(text)}</div>`;
      }

      const isSub = node.index === 0;
      const marker = isSub ? '・' : `${node.index}.`;
      // 子項目依縮排層級再往內排，讓「條件 → 細項」的層次看得出來
      const indent = isSub ? Math.max(1, node.depth) * 12 : 0;

      return `<div style="display: flex; gap: 4px; margin: 1.5px 0 1.5px ${indent}px; line-height: 1.45;">
        <span style="flex-shrink: 0; min-width: ${isSub ? 8 : 14}px; color: ${isSub ? '#9ca3af' : '#374151'};">${escapeHtml(marker)}</span>
        <span style="flex: 1; min-width: 0;">${escapeHtml(node.text)}</span>
      </div>`;
    })
    .join('');
}

/** 客戶／我方資訊的單列（label 固定寬，值可換行且靠齊值欄） */
function infoRow(label: string, value: unknown): string {
  return `<div style="display: flex; gap: 4px; margin-bottom: 2px; line-height: 1.4;">
    <span style="width: 52px; flex-shrink: 0; color: #6b7280;">${escapeHtml(label)}</span>
    <span style="flex: 1; min-width: 0; word-break: break-word;">${escapeHtml(value)}</span>
  </div>`;
}

// 創建一個只包含報價單顯示所需元素的 HTML
function createPrintableHTML(quotationData: QuotationData, exportOptions?: PdfExportOptions) {
  // 獲取報價單日期（本地時區）
  const quotationDate = formatLocalDate(quotationData.quotationDate);

  const formatCurrency = formatAmount;

  // 金額一律由 lib/calc.ts 計算，與畫面、列表、合約完全一致
  const { subtotal, tax, total, taxAdjustment } = calculateQuotationTotals(
    quotationData.lineItems,
    quotationData.taxAdjustment,
  );

  // 稅額欄位的標籤：有人工調整時就不能再宣稱它是 5%
  const taxLabel = taxAdjustment !== 0
    ? `營業稅 (5% ${taxAdjustment > 0 ? '+' : '−'} ${formatCurrency(Math.abs(taxAdjustment))})`
    : '營業稅 (5%)';

  const lineItems = Array.isArray(quotationData.lineItems) ? quotationData.lineItems : [];

  // 免簽回的報價單不需要簽章欄：直接把印章蓋在備註區右側的空白處，節省版面
  const noSignatureRequired = quotationData.requireSignature === false;
  const stampBlockHtml = renderStampBlockHtml(exportOptions);
  const notesHtml = renderNoteNodes(parseNotes(quotationData.notes));

  return `
    <div class="pdf-container" style="font-family: Arial, 'Noto Sans TC', sans-serif; color: #1f2937; width: 100%; margin: 0; padding: 8mm 10mm; box-sizing: border-box; overflow-wrap: break-word; font-size: 11px;">

      <!-- 公司抬頭 -->
      <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
        <div>
          <h1 style="color: #c47b00; font-size: 21px; margin: 0 0 3px 0; line-height: 1.2;">${escapeHtml(quotationData.companyName)}</h1>
          <p style="font-size: 10px; margin: 0; color: #6b7280;">統一編號：${escapeHtml(quotationData.companyTaxId)}</p>
          <p style="font-size: 10px; margin: 0; color: #6b7280;">${escapeHtml(quotationData.companyAddress)}</p>
        </div>
        <div style="text-align: right;">
          <h2 style="color: #c47b00; font-size: 24px; margin: 0 0 3px 0; letter-spacing: 4px; line-height: 1.2;">報價單</h2>
          <p style="font-size: 10px; margin: 0;">報價單號：${escapeHtml(quotationData.quotationNumber || '待生成')}</p>
          <p style="font-size: 10px; margin: 0;">報價日期：${escapeHtml(quotationDate)}</p>
        </div>
      </div>

      <div style="height: 2px; background-color: #c47b00; margin-bottom: 8px;"></div>

      <!-- 客戶／我方資訊 -->
      <div style="display: flex; gap: 10mm; margin-bottom: 8px;">
        <div style="flex: 1; min-width: 0;">
          <h3 style="font-size: 12px; margin: 0 0 4px 0; color: #c47b00;">客戶資訊</h3>
          ${infoRow('公司名稱', quotationData.clientCompany)}
          ${infoRow('統一編號', quotationData.buyerTaxId)}
          ${infoRow('聯絡人', quotationData.clientContact)}
          ${infoRow('電話', quotationData.clientPhone)}
          ${infoRow('Email', quotationData.clientEmail)}
          ${infoRow('地址', quotationData.clientAddress)}
        </div>
        <div style="flex: 1; min-width: 0;">
          <h3 style="font-size: 12px; margin: 0 0 4px 0; color: #c47b00;">我方資訊</h3>
          ${infoRow('客戶代碼', quotationData.customerCode)}
          ${infoRow('聯絡人', quotationData.ourContact)}
          ${infoRow('電話', quotationData.ourPhone)}
          ${infoRow('Email', quotationData.ourEmail)}
          ${infoRow('報價主旨', quotationData.quotationSubject)}
        </div>
      </div>

      <!-- 報價項目 -->
      <div style="margin-bottom: 6px;">
        <h3 style="font-size: 12px; margin: 0 0 4px 0; color: #c47b00;">報價項目</h3>
        <table style="width: 100%; table-layout: fixed; border-collapse: collapse; font-size: 10px; word-wrap: break-word; overflow-wrap: break-word;">
          <colgroup>
            <col style="width: 6%;" />
            <col style="width: 24%;" />
            <col style="width: 40%;" />
            <col style="width: 7%;" />
            <col style="width: 11.5%;" />
            <col style="width: 11.5%;" />
          </colgroup>
          <thead>
            <tr style="background-color: #f3f4f6;">
              <th style="border: 1px solid #d1d5db; padding: 4px 3px; text-align: center;">項次</th>
              <th style="border: 1px solid #d1d5db; padding: 4px 3px; text-align: center;">產品名稱</th>
              <th style="border: 1px solid #d1d5db; padding: 4px 3px; text-align: center;">產品規格</th>
              <th style="border: 1px solid #d1d5db; padding: 4px 3px; text-align: center;">數量</th>
              <th style="border: 1px solid #d1d5db; padding: 4px 3px; text-align: center;">單價</th>
              <th style="border: 1px solid #d1d5db; padding: 4px 3px; text-align: center;">總價</th>
            </tr>
          </thead>
          <tbody>
            ${lineItems.map((item, index) => `
              <tr style="page-break-inside: avoid; break-inside: avoid;">
                <td style="border: 1px solid #d1d5db; padding: 4px 3px; text-align: center; vertical-align: top;">${index + 1}</td>
                <td style="border: 1px solid #d1d5db; padding: 4px 5px; text-align: left; vertical-align: top; word-break: break-word;">${escapeHtml(item.productName)}</td>
                <td style="border: 1px solid #d1d5db; padding: 4px 5px; text-align: left; vertical-align: top; word-break: break-word;">
                  ${renderSpecNodes(parseSpecification(item.specification))}
                </td>
                <td style="border: 1px solid #d1d5db; padding: 4px 3px; text-align: center; vertical-align: top;">${escapeHtml(item.quantity)}</td>
                <td style="border: 1px solid #d1d5db; padding: 4px 5px; text-align: right; vertical-align: top;">${formatCurrency(item.price)}</td>
                <td style="border: 1px solid #d1d5db; padding: 4px 5px; text-align: right; vertical-align: top;">${formatCurrency(lineItemAmount(item))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- 金額摘要 -->
      <div style="display: flex; justify-content: flex-end; margin-bottom: 8px;">
        <table style="width: 44%; border-collapse: collapse; font-size: 11px;">
          <tr>
            <td style="padding: 2px 6px; text-align: right; color: #6b7280;">小計</td>
            <td style="padding: 2px 6px; text-align: right; width: 42%;">${formatCurrency(subtotal)}</td>
          </tr>
          <tr>
            <td style="padding: 2px 6px; text-align: right; color: #6b7280;">${escapeHtml(taxLabel)}</td>
            <td style="padding: 2px 6px; text-align: right;">${formatCurrency(tax)}</td>
          </tr>
          <tr style="font-weight: bold; font-size: 12px;">
            <td style="padding: 3px 6px; text-align: right; border-top: 1.5px solid #c47b00;">總計</td>
            <td style="padding: 3px 6px; text-align: right; border-top: 1.5px solid #c47b00;">${formatCurrency(total)}</td>
          </tr>
        </table>
      </div>

      ${noSignatureRequired ? `
      <!-- 免簽回：備註與印章併排，章蓋在備註區右側空白處，不另留簽章欄 -->
      <div style="display: flex; gap: 5mm; align-items: stretch;">
        <div style="flex: 1; min-width: 0;">
          <h3 style="font-size: 12px; margin: 0 0 4px 0; color: #c47b00;">備註說明</h3>
          <div style="font-size: 10px; border: 1px solid #e5e7eb; border-radius: 2px; padding: 6px 8px; background-color: #fafafa;">
            ${notesHtml}
          </div>
        </div>
        <div style="width: 44mm; flex: 0 0 44mm; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; padding-bottom: 1mm;">
          ${stampBlockHtml}
          <p style="font-size: 10px; margin: 2px 0 0 0; color: #6b7280; text-align: center;">本報價單免簽回</p>
        </div>
      </div>
      ` : `
      <!-- 需簽回：備註在上，簽章欄在下 -->
      <div style="margin-bottom: 8px;">
        <h3 style="font-size: 12px; margin: 0 0 4px 0; color: #c47b00;">備註說明</h3>
        <div style="font-size: 10px; border: 1px solid #e5e7eb; border-radius: 2px; padding: 6px 8px; background-color: #fafafa;">
          ${notesHtml}
        </div>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: flex-end; margin-top: 6mm;">
        <div style="width: 48%; text-align: center;">
          <div style="border-bottom: 1.5px solid #6b7280; margin-bottom: 4px; height: ${SIGNATURE_BOX_HEIGHT_MM}mm; width: 100%;"></div>
          <p style="font-size: 10px; margin: 0; color: #6b7280;">客戶簽章</p>
        </div>
        <div style="width: 48%; text-align: center;">
          <div style="position: relative; border-bottom: 1.5px solid #6b7280; margin-bottom: 4px; height: ${SIGNATURE_BOX_HEIGHT_MM}mm; width: 100%;">
            ${renderStampHtml(exportOptions, 'center')}
          </div>
          <p style="font-size: 10px; margin: 0; color: #6b7280;">公司簽章</p>
        </div>
      </div>
      `}
    </div>
  `;
}

// 創建合約的HTML
function createContractHTML(quotationData: QuotationData, exportOptions?: PdfExportOptions) {

  const lineItems = Array.isArray(quotationData.lineItems) ? quotationData.lineItems : [];

  // 合約類型以「使用者明確選擇的」為準。
  // 只有在完全沒有設定時，才用關鍵字推測，避免報價內容剛好提到「租賃」
  // 就把一份開發合約靜默套成租賃格式。
  const isRental = quotationData.contractType
    ? quotationData.contractType === 'rental'
    : lineItems.some(item =>
        (item.productName || '').includes('租賃') ||
        (item.specification || '').includes('租賃') ||
        (item.specification || '').includes('租期'));

  // 合約上的甲方一律採用這份報價單所選的公司，不再寫死某一家公司。
  // （原本頁首用選定公司、簽章欄卻寫死，會產出甲方與抬頭不一致的合約。）
  const partyAName = quotationData.companyName || '';
  const partyAPrincipal = exportOptions?.principalName || quotationData.ourContact || '';

  // 使用合約內容
  const contractContent = quotationData.contractContent || '';
  
  // 處理標題，標題會在HTML模板中顯示，不需要在內容中重複
  let title = isRental ? '動產租賃契約書' : '軟體開發合約書';
  
  // 創建排版正確的合約內容
  let formattedContent = '';
  
  // 針對租賃合約，標準化立約人部分 - 使用特殊分隔符確保換行
  if (isRental) {
    // 標題交由下方 HTML 的 ${title} 呈現，這裡不再重複輸出「# 動產租賃契約書」，
    // 否則每份租賃合約都會出現兩次標題。
    formattedContent = `立契約書人：@@BREAK@@

出租人：${escapeHtml(partyAName)}(以下簡稱為甲方)。@@BREAK@@

承租人(機關/個人)：${escapeHtml(quotationData.clientCompany)} ${escapeHtml(quotationData.clientContact || '')}(以下簡稱為乙方)。@@BREAK@@

雙方合意訂立本契約，約定條款如下：@@BREAK@@

`;

    // 添加主體內容（從第一條開始）
    const lines = contractContent.split('\n');
    // 支援 第一條 / 第 一 條 / 第1條 / 第１條 / 第壹條 等寫法
    const firstClausePattern = /第\s*(一|1|１|壹)\s*條/;
    const startIndex = lines.findIndex(line => firstClausePattern.test(line));

    if (startIndex >= 0) {
      formattedContent += lines.slice(startIndex).join('\n') + '\n';
    } else {
      // 修復：找不到「第一條」時，原本會把整份條文全部丟掉，產出只剩前言與
      // 簽章欄的空合約，而且完全沒有任何警告。改為保留完整內容。
      console.warn('合約內容找不到「第一條」，改為輸出完整內容');
      formattedContent += contractContent;
    }
  } else {
    // 開發合約使用原合約內容
    formattedContent = contractContent;
  }
  
  // 將Markdown轉換為HTML
  const contentHtml = markdownToHTML(formattedContent);
  
  return `
    <div class="pdf-container" style="font-family: Arial, 'Noto Sans TC', sans-serif; color: #333; width: 100%; margin: 0; padding: 10mm; box-sizing: border-box; overflow-wrap: break-word;">
      <!-- 公司抬頭 -->
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 15px;">
        <div>
          <h1 style="color: #c47b00; font-size: 24px; margin: 0 0 5px 0;">${escapeHtml(quotationData.companyName)}</h1>
          <p style="font-size: 12px; margin: 0;">統一編號: ${escapeHtml(quotationData.companyTaxId)}</p>
          <p style="font-size: 12px; margin: 0;">${escapeHtml(quotationData.companyAddress)}</p>
        </div>
        <div style="text-align: right;">
          <h2 style="color: #c47b00; font-size: 28px; margin: 0 0 5px 0;">${escapeHtml(title)}</h2>
          <p style="font-size: 12px; margin: 0;">合約編號: ${escapeHtml(quotationData.contractId || '未定義')}</p>
          <p style="font-size: 12px; margin: 0;">報價單號: ${escapeHtml(quotationData.quotationNumber)}</p>
          <p style="font-size: 12px; margin: 0;">日期: ${escapeHtml(new Date().toLocaleDateString('zh-TW'))}</p>
        </div>
      </div>
      
      <!-- 分隔線 -->
      <div style="height: 2px; background-color: #c47b00; margin-bottom: 15px;"></div>
      
      <!-- 合約內容 -->
      <div style="color: #000000; margin-top: 10px;">
        ${contentHtml}
      </div>
      
      <!-- 簽章欄 -->
      <div class="avoid-break" style="margin-top: 40px; page-break-inside: avoid; break-inside: avoid;">
        <div style="margin: 30px 0 20px 0; font-size: 14px; color: #000000; text-align: left;">立契約人：</div>

        <!-- 甲方：一律使用本次匯出所選定的公司，不再寫死。
             印章靠右垂直置中，避免蓋住地址與統編文字。 -->
        <div style="position: relative; margin: 10px 0 30px 20px; font-size: 14px; color: #000000; text-align: left; min-height: ${SIGNATURE_BOX_HEIGHT_MM}mm;">
          甲方：${escapeHtml(partyAName)}<br/>
          負責人：${escapeHtml(partyAPrincipal)}<br/>
          地址：${escapeHtml(quotationData.companyAddress || '')}<br/>
          統一編號：${escapeHtml(quotationData.companyTaxId || '')}<br/>
          ${renderStampHtml(exportOptions, 'inline')}
        </div>

        <div style="margin: 10px 0 10px 20px; font-size: 14px; color: #000000; text-align: left;">
          乙方：${escapeHtml(quotationData.clientCompany || '')}<br/>
          負責人：<br/>
          地址：${escapeHtml(quotationData.clientAddress || '')}<br/>
          聯絡人：${escapeHtml(quotationData.clientContact || '')}<br/>
          電話：${escapeHtml(quotationData.clientPhone || '')}<br/>
        </div>
      </div>

      <!-- 日期 -->
      <div style="margin-top: 40px; text-align: center; font-size: 14px; color: #000000;">
        中華民國 ${new Date().getFullYear() - 1911} 年 ${new Date().getMonth() + 1} 月 ${new Date().getDate()} 日
      </div>
    </div>
  `;
}

// 簡單的Markdown轉HTML函數，根據參考文件調整
function markdownToHTML(markdown: string): string {
  if (!markdown) return '';
  
  // 參考文件格式處理 - 直接將Markdown轉換為特定格式的HTML
  // 處理標題
  let html = markdown;
  
  // 基本格式化 - 只保留核心功能
  
  // 處理合約標題，只有合約表頭應該居中
  html = html.replace(/^# (.*)$/gm, '<h1 style="text-align: center; font-size: 18px; margin: 20px 0; color: #000000;">$1</h1>');
  
  // 處理二級標題
  html = html.replace(/^## (.*)$/gm, '<h2 style="font-size: 16px; margin: 16px 0; color: #000000; text-align: left;">$1</h2>');
  
  // 處理三級標題
  html = html.replace(/^### (.*)$/gm, '<h3 style="font-size: 15px; margin: 14px 0; color: #000000; text-align: left;">$1</h3>');
  
  // 處理粗體文字 - 全部移除粗體
  html = html.replace(/\*\*([^*]+)\*\*/g, '$1');
  
  // 先用特殊標記處理立契約書人部分，防止被其他規則處理
  html = html.replace(/立契約書人：(@@BREAK@@)?/g, 
    '<div style="margin: 15px 0; height: 30px; color: #000000; font-size: 14px; text-align: left;">立契約書人：</div>');
    
  // 修復：原本這條規則寫死比對某一家公司的全名，換成其他公司時
  // 這行永遠不會被套用格式，@@BREAK@@ 標記還會原封不動印在合約上。
  html = html.replace(/出租人：(.+?)\(以下簡稱為甲方\)。(@@BREAK@@)?/g,
    '<div style="margin: 15px 0; height: 30px; color: #000000; font-size: 14px; text-align: left;">出租人：$1(以下簡稱為甲方)。</div>');


  html = html.replace(/承租人\(機關\/個人\)：(.+?)\(以下簡稱為乙方\)。(@@BREAK@@)?/g, 
    '<div style="margin: 15px 0; height: 30px; color: #000000; font-size: 14px; text-align: left;">承租人(機關/個人)：$1(以下簡稱為乙方)。</div>');
    
  html = html.replace(/雙方合意訂立本契約，約定條款如下：(@@BREAK@@)?/g,
    '<div style="margin: 15px 0; height: 30px; color: #000000; font-size: 14px; text-align: left;">雙方合意訂立本契約，約定條款如下：</div>');
  
  // 處理第X條格式
  html = html.replace(/(第[一二三四五六七八九十零兩三四五六七八九百千]+條[\s]*)(.*)/g, 
    '<div style="margin: 15px 0; color: #000000; font-size: 14px; text-align: left;">$1$2</div>');
  
  // 處理數字列表項
  html = html.replace(/([一二三四五六七八九十]、)(.*)/g, 
    '<div style="margin: 10px 0 10px 20px; color: #000000; font-size: 14px; text-align: left;">$1$2</div>');
  
  // 處理星號列表項
  html = html.replace(/^\s*\*\s+(.*)$/gm, 
    '<div style="margin: 8px 0 8px 20px; color: #000000; font-size: 14px; text-align: left;">• $1</div>');
    
  // 處理其他普通段落（確保只處理尚未處理的行）
  html = html.replace(/^(.+)$/gm, (match, p1) => {
    // 如果該行已經被處理為特殊格式，則跳過
    if (p1.includes('<div') || p1.includes('<h1') || p1.includes('<h2') || p1.includes('<h3')) {
      return match;
    }
    // 如果包含這些關鍵字，也跳過（因為上面已經處理過）
    if (p1.includes('第') || p1.includes('一、') || p1.includes('•') || 
        p1.includes('立契約書人') || p1.includes('出租人') || p1.includes('承租人') || 
        p1.includes('雙方合意')) {
      return match;
    }
    return `<div style="margin: 10px 0; color: #000000; font-size: 14px; text-align: left;">${p1}</div>`;
  });
  
  // 立約人部分特殊處理 (無粗體)
  html = html.replace(/立契約人：/g, 
    '<div style="margin-top: 40px; color: #000000; font-size: 14px; text-align: left;">立契約人：</div>');
  
  // 甲方乙方簽署處 (無粗體)
  html = html.replace(/(甲方|乙方)：(.*)$/gm, 
    '<div style="margin: 10px 0 10px 20px; color: #000000; font-size: 14px; text-align: left;">$1：$2</div>');
  
  // 處理日期行
  html = html.replace(/中\s*華\s*民\s*國(.*)/g, 
    '<div style="margin-top: 30px; text-align: center; color: #000000; font-size: 14px;">中華民國$1</div>');
  
  return html;
}

export interface PdfGenerationResult {
  success: boolean;
  message: string;
  filename?: string;
  /** 這次匯出實際使用的報價單號／日期，呼叫端應寫回並保存 */
  quotationNumber: string;
  quotationDate: string;
}

/**
 * 生成 PDF 並下載。
 *
 * 注意：此函式在失敗時會 **throw**，不再回傳 { success: false }。
 * 原本的寫法把所有錯誤吞掉並回傳失敗物件，但有兩個呼叫端根本不看回傳值，
 * 結果 PDF 沒產生卻照樣跳出「PDF已生成」的成功提示。
 */
/**
 * 直接列印報價單／合約。
 *
 * 修復背景：編輯頁的「列印」原本直接呼叫 `window.print()`，但專案完全沒有
 * `@media print` 樣式，印出來的是含導覽列、按鈕、輸入框的網頁畫面，
 * 和這裡精心排版的 A4 版面是兩回事。
 *
 * 這裡改成把「跟 PDF 完全同一份 HTML」塞進隱藏的 iframe 再列印，
 * 版面只有一個來源。用 iframe 而非 window.open 是為了避開彈出視窗封鎖。
 */
export async function printQuotation(
  quotationData: QuotationData,
  isContract: boolean = false,
  exportOptions?: PdfExportOptions,
): Promise<void> {
  if (!quotationData) throw new Error('沒有可列印的報價單資料');

  const dataForRender: QuotationData = {
    ...quotationData,
    quotationNumber: quotationData.quotationNumber || '',
    quotationDate: quotationData.quotationDate || localDateKey(),
  };

  const bodyHtml = isContract
    ? createContractHTML(dataForRender, exportOptions)
    : createPrintableHTML(dataForRender, exportOptions);

  const iframe = document.createElement('iframe');
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
  document.body.appendChild(iframe);

  try {
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) throw new Error('無法建立列印畫面');

    doc.open();
    doc.write(`<!DOCTYPE html><html lang="zh-TW"><head><meta charset="UTF-8">
      <title>${escapeHtml(isContract ? '合約書' : '報價單')}</title>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Sans+TC:wght@400;500;700&display=swap">
      <style>
        @page { size: A4; margin: 10mm; }
        html, body { margin: 0; padding: 0; background: #fff; }
        * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      </style></head><body>${bodyHtml}</body></html>`);
    doc.close();

    // 等字型與圖片（印章是 data URL，仍需要一次 decode）載入完成再列印，
    // 否則可能印出還沒套用字型或缺圖的版面
    await new Promise<void>(resolve => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      if (doc.readyState === 'complete') { setTimeout(done, 300); }
      else { iframe.onload = () => setTimeout(done, 300); }
      setTimeout(done, 3000); // 保險：字型抓不到也不要卡住
    });

    try { await (doc as any).fonts?.ready; } catch { /* 字型 API 不支援時略過 */ }

    win.focus();
    win.print();
  } finally {
    // 給列印對話框一點時間讀取內容再移除 iframe
    setTimeout(() => iframe.remove(), 1000);
  }
}

export async function generateQuotationPDF(
  quotationData: QuotationData,
  isContract: boolean = false,
  exportOptions?: PdfExportOptions,
): Promise<PdfGenerationResult> {
  if (!quotationData) {
    throw new Error('沒有可匯出的報價單資料');
  }

  // 如果沒有報價單編號，生成一個。
  // 注意：不再直接改寫傳入的物件（呼叫端多半傳的是臨時複本，改了也存不回去，
  // 反而造成同一張單每次匯出都拿到不同單號）。改為回傳給呼叫端保存。
  // 呼叫端（QuotationForm / QuotationList）都會先產生序號制的編號，
  // 這裡只是最後的保險：真的沒有編號時才用時間戳產生一個可辨識的暫時號。
  // 用時間戳而非亂數，至少同一毫秒內才可能重複。
  let quotationNumber = quotationData.quotationNumber;
  if (!quotationNumber) {
    const date = new Date();
    const stamp = localDateKey(date).replace(/-/g, '');
    const seconds = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
    quotationNumber = `Q${stamp}-T${String(seconds).padStart(5, '0')}`;
    console.warn('[PDF] 報價單沒有編號，已產生暫時編號:', quotationNumber);
  }

  // 如果沒有日期，設置為今天（本地時區，不是 UTC）
  const quotationDate = quotationData.quotationDate || localDateKey();

  const dataForRender: QuotationData = { ...quotationData, quotationNumber, quotationDate };

  // 設定檔案名稱（檔名不能含路徑分隔符等字元）
  const safeClient = sanitizeFilenamePart(dataForRender.clientCompany || '客戶');
  const filename = isContract
    ? `合約書_${safeClient}_${sanitizeFilenamePart(dataForRender.contractId || quotationNumber)}.pdf`
    : `報價單_${safeClient}_${sanitizeFilenamePart(quotationNumber)}.pdf`;

  // 創建一個臨時的 HTML 元素。
  //
  // 注意：html2canvas 無法擷取被移到畫面外（position:fixed/absolute + left:-10000px）
  // 的元素 —— 實測會產出一張全白的 PDF。因此渲染用的元素必須維持在正常文件流中，
  // 改由外層容器把它「佔位 0、裁切掉」，達到不閃現又能正常擷取的效果。
  const wrapper = document.createElement('div');
  wrapper.setAttribute('aria-hidden', 'true');
  wrapper.style.cssText =
    'position:absolute;top:0;left:0;width:794px;height:0;overflow:hidden;clip-path:inset(100%);';

  // 不要在這個元素上設定固定 px 寬度：html2pdf 會把內容複製進一個寬度等於
  // 「A4 內容寬（頁寬 - 左右邊距）」的容器，若這裡硬設 794px（=210mm）就會比
  // 容器寬，右側的「總價」欄與標題會被裁掉。寬度交給 html2pdf 決定。
  const element = document.createElement('div');
  element.style.backgroundColor = '#ffffff';
  element.innerHTML = isContract
    ? createContractHTML(dataForRender, exportOptions)
    : createPrintableHTML(dataForRender, exportOptions);

  wrapper.appendChild(element);
  document.body.appendChild(wrapper);

  try {
    // 報價單盡量壓在一頁：量測實際高度，只差一點點就整體微縮
    if (!isContract) {
      applyFitToOnePage(element);
      // 收掉尾端空白，避免多印一張白紙
      trimTrailingBlankPage(element);
    }

    await html2pdf()
      .set({ ...pdfOptions, filename })
      .from(element)
      .save();

    return {
      success: true,
      message: isContract ? '合約書 PDF 生成成功' : '報價單 PDF 生成成功',
      filename,
      quotationNumber,
      quotationDate,
    };
  } catch (error) {
    console.error('生成 PDF 失敗:', error);
    throw error instanceof Error ? error : new Error('生成 PDF 時發生錯誤');
  } finally {
    // 修復：原本只在成功路徑移除元素，任何一次失敗都會把整份未套版的
    // 報價單永久留在頁面上（React 不擁有它，不會被卸載）。
    wrapper.remove();
  }
}

/** 移除檔名中不合法或容易造成問題的字元 */
function sanitizeFilenamePart(value: string): string {
  return String(value)
    .replace(/[\\/:*?"<>|]/g, '_')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || '未命名';
}