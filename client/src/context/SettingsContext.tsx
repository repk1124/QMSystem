/**
 * 系統設定（白牌化）的前端狀態。
 *
 * 兩層：
 *   - public：免登入就拿得到的系統名稱、logo、主色，登入頁與 <title> 用
 *   - full：登入後才有的完整設定（公司資料、印章、編號前綴），PDF 與設定頁用
 *
 * 讀到設定後順手把 document.title、favicon 與 CSS 變數（主色）套上去，
 * 所以畫面上任何地方都不需要再寫死品牌。
 */
import React, { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { settings as settingsApi, type PublicSettings, type AppSettings } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";

const FALLBACK: PublicSettings = { appName: "報價管理系統", logoUrl: null, primaryColor: null };
const DEFAULT_FAVICON = "/logo-default.svg";

interface SettingsContextValue {
  /** 永遠有值（讀不到時用預設） */
  publicSettings: PublicSettings;
  /** 登入後才有 */
  settings: AppSettings | null;
  appName: string;
  logoUrl: string;
  /** 設定頁存檔後呼叫，讓所有地方立刻更新 */
  refresh: () => void;
}

const SettingsContext = createContext<SettingsContextValue>({
  publicSettings: FALLBACK, settings: null, appName: FALLBACK.appName,
  logoUrl: DEFAULT_FAVICON, refresh: () => {},
});

export const useSettings = () => useContext(SettingsContext);

/** #rrggbb → Tailwind/shadcn 用的「h s% l%」 */
export function hexToHslTriple(hex: string): string | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / d + 2) * 60;
    else h = ((r - g) / d + 4) * 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

function applyBranding(pub: PublicSettings) {
  document.title = pub.appName;

  const link = document.getElementById("app-favicon") as HTMLLinkElement | null;
  if (link) {
    link.href = pub.logoUrl ?? DEFAULT_FAVICON;
    link.type = pub.logoUrl ? "" : "image/svg+xml";
  }

  const root = document.documentElement;
  const triple = pub.primaryColor ? hexToHslTriple(pub.primaryColor) : null;
  if (triple) {
    const [h, s, l] = triple.split(" ");
    const lum = parseInt(l, 10);
    root.style.setProperty("--primary", triple);
    root.style.setProperty("--ring", triple);
    root.style.setProperty("--accent", `${h} ${s} ${Math.max(lum - 10, 10)}%`);
    // 主色太亮時白字會看不清楚，改用深色前景
    root.style.setProperty("--primary-foreground", lum > 65 ? "0 0% 10%" : "0 0% 100%");
  } else {
    for (const v of ["--primary", "--ring", "--accent", "--primary-foreground"]) root.style.removeProperty(v);
  }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { currentUser } = useAuth();
  const queryClient = useQueryClient();
  const [publicSettings, setPublicSettings] = useState<PublicSettings>(FALLBACK);

  const { data: pub } = useQuery({
    queryKey: ["settings", "public"],
    queryFn: () => settingsApi.public(),
    staleTime: 5 * 60_000,
    retry: 1,
  });

  const { data: full } = useQuery({
    queryKey: ["settings", "branding"],
    queryFn: () => settingsApi.branding(),
    enabled: Boolean(currentUser),
    staleTime: 5 * 60_000,
  });

  // 登入後的完整設定比較新（設定頁剛存檔），以它為準
  useEffect(() => {
    const next: PublicSettings = full
      ? { appName: full.appName, logoUrl: full.logoUrl, primaryColor: full.primaryColor }
      : pub ?? FALLBACK;
    setPublicSettings(next);
    applyBranding(next);
  }, [pub, full]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["settings"] });
  };

  return (
    <SettingsContext.Provider value={{
      publicSettings,
      settings: full ?? null,
      appName: publicSettings.appName,
      logoUrl: publicSettings.logoUrl ?? DEFAULT_FAVICON,
      refresh,
    }}>
      {children}
    </SettingsContext.Provider>
  );
}
