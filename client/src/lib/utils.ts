import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number): string {
  // 轉為整數，四捨五入，並使用千位分隔符格式化
  return `NT$ ${Math.round(amount).toLocaleString('zh-TW')}`;
}
