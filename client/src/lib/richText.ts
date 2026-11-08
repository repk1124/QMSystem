/**
 * 結構化文字解析。
 *
 * 問題背景：備註與產品規格都是自由輸入的多行文字，過去的處理方式是
 *   - 備註：`white-space: pre-line` 原樣輸出 → 換行後的續行貼齊最左邊，
 *           編號和內容對不齊，看起來像沒排版
 *   - 規格：每一行都無差別加上一個 bullet → 連「1. 雲端伺服器規格」這種
 *           小標也被當成項目，階層完全消失
 * 而且編號一律要使用者自己手打 1. 2. 3.，漏打或順序錯了也沒人檢查。
 *
 * 這裡把純文字解析成有階層的節點，讓 PDF 端可以正確排版：
 *   - 自動辨識既有的編號／項目符號並「剝除」，避免輸出時變成「1. 1.」
 *   - 區分「小標」與「項目」，小標不加項目符號
 *   - 辨識「鍵：值」形式，排成對齊的定義列表
 *   - 由系統統一重新編號，使用者只要一行打一項即可
 */

export type RichNode =
  | { kind: 'heading'; text: string; index: number }
  | { kind: 'item'; text: string; index: number; depth: number }
  | { kind: 'field'; label: string; value: string; depth: number }
  | { kind: 'paragraph'; text: string };

/** 阿拉伯數字編號：1. / 1) / (1) / 1、 */
const RE_NUMBER = /^\(?(\d{1,2})\)?\s*[.、)]\s*/;
/** 英文字母編號：A. / a) / (A) */
const RE_ALPHA = /^\(?([A-Za-z])\)?\s*[.、)]\s*/;
/** 中文數字編號：一、 / （一） */
const RE_CJK = /^[（(]?([一二三四五六七八九十]{1,3})[）)]?\s*[.、]\s*/;
/** 項目符號：- * • ‧ ・ ● ▪ */
const RE_BULLET = /^[-*•‧・●▪◦]\s+/;
/** 鍵：值（全形或半形冒號），鍵不能太長，否則整句話會被誤判 */
const RE_FIELD = /^([^：:]{1,14})\s*[：:]\s*(.+)$/;

/** 縮排深度：每 2 個空白或 1 個 Tab 算一層，最多 2 層 */
function indentDepth(rawLine: string): number {
  const match = /^[\t 　]+/.exec(rawLine);
  if (!match) return 0;
  const spaces = match[0].replace(/\t/g, '  ').replace(/　/g, '  ').length;
  return Math.min(2, Math.floor(spaces / 2));
}

/**
 * 剝除行首既有的編號／項目符號。
 * @returns [剝除後的文字, 是否原本就帶編號, 編號種類]
 */
function stripMarker(text: string): {
  text: string;
  hadNumber: boolean;
  hadBullet: boolean;
  hadAlpha: boolean;
  /** 英文字母編號是大寫（A. B.）還是小寫（a. b.）—— 兩者慣例不同 */
  alphaWasUpper: boolean;
} {
  let out = text;
  let hadNumber = false;
  let hadBullet = false;
  let hadAlpha = false;
  let alphaWasUpper = false;

  if (RE_BULLET.test(out)) {
    out = out.replace(RE_BULLET, '');
    hadBullet = true;
  } else if (RE_NUMBER.test(out)) {
    out = out.replace(RE_NUMBER, '');
    hadNumber = true;
  } else if (RE_CJK.test(out)) {
    out = out.replace(RE_CJK, '');
    hadNumber = true;
  } else {
    const alpha = RE_ALPHA.exec(out);
    if (alpha) {
      alphaWasUpper = alpha[1] === alpha[1].toUpperCase();
      out = out.replace(RE_ALPHA, '');
      hadAlpha = true;
    }
  }

  return { text: out.trim(), hadNumber, hadBullet, hadAlpha, alphaWasUpper };
}

/**
 * 解析備註文字。
 *
 * 規則：
 *  - 每個非空行是一個項目，由系統統一編號（1. 2. 3. …）
 *  - 使用者若已經手打編號，會被剝除後重新編號，不會出現「1. 1.」
 *  - 以項目符號（- * •）開頭或有縮排的行，視為上一項的子項目，不參與主編號
 */
export function parseNotes(input: string | null | undefined): RichNode[] {
  const raw = String(input ?? '');
  if (!raw.trim()) return [];

  const nodes: RichNode[] = [];
  let counter = 0;

  for (const rawLine of raw.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;

    const depth = indentDepth(rawLine);
    const stripped = stripMarker(rawLine.trim());
    if (!stripped.text) continue;

    // 子項目：有縮排、或用項目符號、或用英文字母編號
    const isSub = depth > 0 || stripped.hadBullet || stripped.hadAlpha;

    if (isSub && nodes.length > 0) {
      nodes.push({
        kind: 'item',
        text: stripped.text,
        index: 0, // 0 = 不顯示數字，改用項目符號
        depth: Math.max(1, depth),
      });
    } else {
      counter += 1;
      nodes.push({ kind: 'item', text: stripped.text, index: counter, depth: 0 });
    }
  }

  return nodes;
}

/**
 * 解析產品規格文字。
 *
 * 規則：
 *  - 「數字編號 + 短標題」且不含冒號 → 視為小標（heading），不加項目符號
 *  - 「鍵：值」→ 排成對齊的定義列表（field）
 *  - 其餘 → 一般項目（item），加項目符號
 *  - 縮排或項目符號會提升 depth
 */
export function parseSpecification(input: string | null | undefined): RichNode[] {
  const raw = String(input ?? '');
  if (!raw.trim()) return [];

  const lines = raw.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) return [];

  // 只有一行且沒有任何標記 → 當成單純段落，不要硬加項目符號
  if (lines.length === 1) {
    const only = stripMarker(lines[0].trim());
    const field = RE_FIELD.exec(only.text);
    if (field) {
      return [{ kind: 'field', label: field[1].trim(), value: field[2].trim(), depth: 0 }];
    }
    return [{ kind: 'paragraph', text: only.text }];
  }

  const nodes: RichNode[] = [];
  let headingCounter = 0;

  for (const rawLine of lines) {
    const depth = indentDepth(rawLine);
    const trimmed = rawLine.trim();
    const stripped = stripMarker(trimmed);
    if (!stripped.text) continue;

    // 分號分隔：編輯頁的說明文字有承諾這個行為，必須保留。
    // 只在該行不是「鍵：值」時才拆，避免把 "規格：2 vCPU; 8GB" 的值切開。
    if (stripped.text.includes(';') && !RE_FIELD.test(stripped.text)) {
      const parts = stripped.text.split(';').map(x => x.trim()).filter(Boolean);
      if (parts.length > 1) {
        const subDepth = depth > 0 ? depth : (headingCounter > 0 ? 1 : 0);
        for (const part of parts) {
          nodes.push({ kind: 'item', text: part, index: 0, depth: subDepth });
        }
        continue;
      }
    }

    const field = RE_FIELD.exec(stripped.text);

    // 判定小標：原本就帶「數字」或「大寫字母」編號、沒有縮排、
    // 不是鍵值對、且長度像標題。
    // 大寫 A. B. 在規格裡是分類標題（舊資料慣用），
    // 小寫 a. b. 則多半是子項目，故只認大寫。
    const looksLikeHeading =
      (stripped.hadNumber || (stripped.hadAlpha && stripped.alphaWasUpper)) &&
      depth === 0 &&
      !field &&
      stripped.text.length <= 24;

    if (looksLikeHeading) {
      headingCounter += 1;
      nodes.push({ kind: 'heading', text: stripped.text, index: headingCounter });
      continue;
    }

    // 小標底下的內容自動縮一層
    const effectiveDepth = depth > 0 ? depth : (headingCounter > 0 ? 1 : 0);

    if (field) {
      nodes.push({
        kind: 'field',
        label: field[1].trim(),
        value: field[2].trim(),
        depth: effectiveDepth,
      });
      continue;
    }

    nodes.push({
      kind: 'item',
      text: stripped.text,
      index: 0,
      depth: effectiveDepth,
    });
  }

  return nodes;
}

/** 粗略估算節點渲染後會佔多少「行」，用於自動縮放前的預估 */
export function estimateLineCount(nodes: RichNode[], charsPerLine = 30): number {
  return nodes.reduce((sum, node) => {
    const text =
      node.kind === 'field'
        ? `${node.label}${node.value}`
        : node.kind === 'heading' || node.kind === 'item' || node.kind === 'paragraph'
          ? node.text
          : '';
    return sum + Math.max(1, Math.ceil(text.length / charsPerLine));
  }, 0);
}
