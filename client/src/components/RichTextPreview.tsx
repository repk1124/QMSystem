import { useMemo } from "react";
import { parseNotes, parseSpecification, type RichNode } from "@/lib/richText";

interface Props {
  /** 原始文字 */
  text: string;
  /** notes = 自動編號；spec = 分類標題 + 鍵值 + 項目 */
  mode: "notes" | "spec";
  className?: string;
}

/**
 * 備註／規格的即時預覽。
 *
 * 背景：備註與規格在匯出 PDF 時會由 `lib/richText.ts` 自動編號、分階層，
 * 但編輯頁只是一個純 textarea —— 使用者要匯出 PDF 才知道長什麼樣。
 * 這個元件重用**與 PDF 完全相同的解析器**，做到所見即所得。
 */
export default function RichTextPreview({ text, mode, className = "" }: Props) {
  const nodes = useMemo<RichNode[]>(
    () => (mode === "notes" ? parseNotes(text) : parseSpecification(text)),
    [text, mode],
  );

  if (nodes.length === 0) {
    return (
      <div className={`text-xs text-gray-400 italic ${className}`}>
        （尚無內容，輸入後這裡會顯示排版後的樣子）
      </div>
    );
  }

  return (
    <div className={`text-xs leading-relaxed ${className}`} data-testid={`preview-${mode}`}>
      {nodes.map((node, i) => {
        if (node.kind === "heading") {
          return (
            <div key={i} className="font-semibold text-gray-800 mt-1.5 first:mt-0">
              {node.text}
            </div>
          );
        }

        if (node.kind === "field") {
          return (
            <div key={i} className="flex gap-1" style={{ marginLeft: node.depth * 10 }}>
              <span className="text-gray-500 whitespace-nowrap">{node.label}：</span>
              <span className="flex-1 min-w-0 break-words">{node.value}</span>
            </div>
          );
        }

        if (node.kind === "item") {
          const isNumbered = node.index > 0;
          return (
            <div
              key={i}
              className="flex gap-1"
              style={{ marginLeft: (isNumbered ? 0 : Math.max(1, node.depth)) * 10 }}
            >
              <span className={`shrink-0 ${isNumbered ? "text-gray-700" : "text-gray-400"}`}>
                {isNumbered ? `${node.index}.` : "・"}
              </span>
              <span className="flex-1 min-w-0 break-words">{node.text}</span>
            </div>
          );
        }

        return (
          <div key={i} className="break-words">
            {(node as { text: string }).text}
          </div>
        );
      })}
    </div>
  );
}
