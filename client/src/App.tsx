/**
 * 應用進入點與路由。
 *
 * 導覽分成三大類：銷售 / 人事 / 系統。
 * 沒有權限的項目不會出現在選單上（實際把關仍在伺服器）。
 */

import { useState } from "react";
import { Switch, Route, Link, useLocation, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  LayoutDashboard, FileText, FileSignature, Building2, Package,
  FileWarning, FolderOpen, Users as UsersIcon, CalendarDays, Clock,
  ShieldCheck, ScrollText, Settings as SettingsIcon, Menu, LogOut, KeyRound, type LucideIcon,
} from "lucide-react";
import { AuthProvider, useAuth } from "@/context/AuthContext";
import { SettingsProvider, useSettings } from "@/context/SettingsContext";
import { PERMISSION } from "@/lib/api";
import { Toaster } from "@/components/ui/toaster";
import { Button } from "@/components/ui/button";

import LoginPage from "@/pages/LoginPage";
import Dashboard from "@/pages/Dashboard";
import QuotationList from "@/pages/QuotationList";
import QuotationForm from "@/pages/QuotationForm";
import Clients from "@/pages/Clients";
import Products from "@/pages/Products";
import Contracts from "@/pages/Contracts";
import DocumentList from "@/pages/DocumentList";
import SuspectDocuments from "@/pages/SuspectDocuments";
import Employees from "@/pages/Employees";
import Leave from "@/pages/Leave";
import Attendance from "@/pages/Attendance";
import Users from "@/pages/Users";
import AuditLog from "@/pages/AuditLog";
import SettingsPage from "@/pages/Settings";
import ChangePassword from "@/pages/ChangePassword";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 401/403 不重試，重試只會延後導回登入頁
      retry: (failureCount, error: unknown) => {
        const status = (error as { status?: number })?.status;
        if (status === 401 || status === 403) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  permission?: string;
  /** 尚未接上的功能，顯示但停用，避免使用者以為壞掉 */
  comingSoon?: boolean;
}

const NAV_GROUPS: Array<{ title: string; items: NavItem[] }> = [
  {
    title: "銷售",
    items: [
      { href: "/quotations", label: "報價單", icon: FileText, permission: PERMISSION.QUOTATION_READ },
      { href: "/contracts", label: "合約", icon: FileSignature, permission: PERMISSION.QUOTATION_READ },
      { href: "/clients", label: "客戶主檔", icon: Building2, permission: PERMISSION.CLIENT_READ },
      { href: "/products", label: "產品品項", icon: Package, permission: PERMISSION.PRODUCT_READ },
      { href: "/documents/suspect", label: "待確認簽回檔", icon: FileWarning, permission: PERMISSION.QUOTATION_READ },
      { href: "/documents", label: "檔案總覽", icon: FolderOpen, permission: PERMISSION.QUOTATION_READ },
    ],
  },
  {
    title: "人事",
    items: [
      { href: "/employees", label: "員工", icon: UsersIcon, permission: PERMISSION.EMPLOYEE_READ },
      { href: "/leave", label: "請假", icon: CalendarDays },
      { href: "/attendance", label: "出勤", icon: Clock },
    ],
  },
  {
    title: "系統",
    items: [
      { href: "/users", label: "使用者與權限", icon: ShieldCheck, permission: PERMISSION.USER_READ },
      { href: "/audit", label: "稽核紀錄", icon: ScrollText, permission: PERMISSION.AUDIT_READ },
      { href: "/settings", label: "系統設定", icon: SettingsIcon, permission: PERMISSION.SETTINGS_MANAGE },
    ],
  },
];

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  const { can } = useAuth();
  const { appName, logoUrl, settings } = useSettings();

  // 目前位置對應到哪個選單項：取「符合的項目中路徑最長的那個」。
  // 不這樣做的話 /documents/suspect 會同時點亮「待確認簽回檔」和「檔案總覽」。
  const allHrefs = NAV_GROUPS.flatMap(g => g.items.map(i => i.href));
  const activeHref = allHrefs
    .filter(href => location === href || location.startsWith(href + "/"))
    .sort((a, b) => b.length - a.length)[0]
    ?? (allHrefs.find(href => location.startsWith(href)) ?? null);

  return (
    <nav className="space-y-6 p-4">
      <Link href="/" onClick={onNavigate}>
        <div className="flex items-center gap-2 px-2">
          <img src={logoUrl} alt="" className="h-8 w-8 rounded object-contain" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{appName}</div>
            {settings?.companyName && (
              <div className="truncate text-xs text-muted-foreground">{settings.companyName}</div>
            )}
          </div>
        </div>
      </Link>

      <div>
        <Link href="/" onClick={onNavigate}>
          <Button
            variant={location === "/" ? "secondary" : "ghost"}
            className="w-full justify-start gap-2"
            size="sm"
          >
            <LayoutDashboard className="h-4 w-4 shrink-0 text-muted-foreground" />
            首頁
          </Button>
        </Link>
      </div>

      {NAV_GROUPS.map(group => {
        const visible = group.items.filter(item => !item.permission || can(item.permission));
        if (visible.length === 0) return null;

        return (
          <div key={group.title}>
            <div className="px-3 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {group.title}
            </div>
            <div className="space-y-0.5">
              {visible.map(item => (
                item.comingSoon ? (
                  <div
                    key={item.href}
                    className="flex items-center justify-between rounded-md px-3 py-1.5 text-sm text-muted-foreground/60"
                    title="尚未開放"
                  >
                    {item.label}
                    <span className="text-[10px]">未開放</span>
                  </div>
                ) : (
                  <Link key={item.href} href={item.href} onClick={onNavigate}>
                    <Button
                      variant={item.href === activeHref ? "secondary" : "ghost"}
                      className="w-full justify-start gap-2"
                      size="sm"
                    >
                      <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                      {item.label}
                    </Button>
                  </Link>
                )
              ))}
            </div>
          </div>
        );
      })}
    </nav>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  const { currentUser, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-screen bg-muted/20">
      {/* 桌機側邊欄 */}
      <aside className="fixed inset-y-0 left-0 hidden w-56 border-r bg-background lg:block">
        <Sidebar />
      </aside>

      {/* 手機側邊欄 */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/40 lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="fixed inset-y-0 left-0 z-50 w-56 border-r bg-background lg:hidden">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </>
      )}

      <div className="lg:pl-56">
        <header className="border-b bg-background">
          <div className="flex items-center gap-3 px-4 py-3">
            <Button
              variant="ghost" size="sm" className="gap-1.5 lg:hidden"
              onClick={() => setMobileOpen(true)}
            >
              <Menu className="h-4 w-4" />
              選單
            </Button>
            <div className="ml-auto flex items-center gap-3 text-sm">
              <span className="text-muted-foreground">
                {currentUser?.displayName || currentUser?.username}
                <span className="ml-1 text-xs">（{currentUser?.role}）</span>
              </span>
              <Link href="/change-password">
                <Button variant="ghost" size="sm" className="gap-1.5" title="修改密碼">
                  <KeyRound className="h-4 w-4" />
                  <span className="hidden sm:inline">修改密碼</span>
                </Button>
              </Link>
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => void logout()}>
                <LogOut className="h-4 w-4" />
                登出
              </Button>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-6xl p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}

function ProtectedRoutes() {
  const { currentUser, isLoading, mustChangePassword } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        載入中…
      </div>
    );
  }

  // 未登入就整組不掛載，避免每支 API 各自失敗、畫面先閃一下才變錯誤
  if (!currentUser) return <Redirect to="/login" />;

  // 首次登入（或被重設密碼）先改密碼，改完才進系統
  if (mustChangePassword) return <ChangePassword forced />;

  return (
    <Shell>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/quotations" component={QuotationList} />
        <Route path="/quotations/new" component={QuotationForm} />
        <Route path="/quotations/:id" component={QuotationForm} />
        <Route path="/clients" component={Clients} />
        <Route path="/products" component={Products} />
        <Route path="/contracts" component={Contracts} />
        {/* 這一條必須排在 /documents 前面，否則會被前綴吃掉 */}
        <Route path="/documents/suspect" component={SuspectDocuments} />
        <Route path="/documents" component={DocumentList} />
        <Route path="/employees" component={Employees} />
        <Route path="/leave" component={Leave} />
        <Route path="/attendance" component={Attendance} />
        <Route path="/users" component={Users} />
        <Route path="/audit" component={AuditLog} />
        <Route path="/settings" component={SettingsPage} />
        <Route path="/change-password"><ChangePassword /></Route>
        {/* 舊網址相容 */}
        <Route path="/list"><Redirect to="/quotations" /></Route>
        <Route path="/new"><Redirect to="/quotations/new" /></Route>
        <Route component={NotFound} />
      </Switch>
    </Shell>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <SettingsProvider>
          <Switch>
            <Route path="/login" component={LoginPage} />
            <Route><ProtectedRoutes /></Route>
          </Switch>
          <Toaster />
        </SettingsProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
