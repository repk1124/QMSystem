/**
 * 首頁。
 *
 * 設計原則：這一頁要回答「今天該做什麼」，不是「公司有多少數字」。
 * 所以待辦清單放最上面而且每一項都點得進去，數字放後面當背景資訊。
 *
 * 一家 20 人的公司不需要儀表板美學，需要的是「別漏掉事情」。
 */

import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { dashboard, PERMISSION, type TodoItem, type HrAlert } from "@/lib/api";
import { formatMoney } from "@/lib/adapters";
import { useAuth } from "@/context/AuthContext";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function severityStyle(severity: string) {
  if (severity === "high") return "border-l-4 border-l-destructive";
  if (severity === "medium") return "border-l-4 border-l-amber-500";
  return "border-l-4 border-l-muted";
}

function TodoRow({ todo, onOpen }: { todo: TodoItem; onOpen: (id: number) => void }) {
  return (
    <button
      className={`flex w-full items-start gap-3 rounded-md bg-card p-3 text-left transition hover:bg-accent ${severityStyle(todo.severity)}`}
      onClick={() => todo.quotationId && onOpen(todo.quotationId)}
      disabled={!todo.quotationId}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{todo.label}</span>
          {todo.quotationNumber && (
            <span className="font-mono text-xs text-muted-foreground">
              {todo.quotationNumber}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-sm text-muted-foreground">{todo.detail}</p>
      </div>
      {todo.amount && (
        <span className="shrink-0 tabular-nums text-sm">{formatMoney(todo.amount)}</span>
      )}
    </button>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

export default function Dashboard() {
  const [, navigate] = useLocation();
  const { currentUser, can } = useAuth();
  const showAmounts = can(PERMISSION.QUOTATION_VIEW_COST);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => dashboard.get(),
    staleTime: 60_000,
  });

  const openQuotation = (id: number) => navigate(`/quotations/${id}`);

  if (isLoading) {
    return <div className="py-16 text-center text-muted-foreground">載入中…</div>;
  }
  if (isError || !data) {
    return <div className="py-16 text-center text-destructive">首頁資料讀取失敗</div>;
  }

  const { todos, openDeals, performance, hrAlerts } = data;
  const highCount = todos.filter(t => t.severity === "high").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">
          {greeting()}，{currentUser?.displayName || currentUser?.username}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {todos.length === 0
            ? "目前沒有待辦事項。"
            : `有 ${todos.length} 件事需要處理${highCount > 0 ? `，其中 ${highCount} 件較急` : ""}。`}
        </p>
      </div>

      {/* 待辦事項 —— 最重要，放最上面 */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="text-base">待辦事項</CardTitle>
          {highCount > 0 && <Badge variant="destructive">{highCount} 件較急</Badge>}
        </CardHeader>
        <CardContent className="space-y-2">
          {todos.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              沒有待處理的事項。
            </p>
          )}
          {todos.map((todo, index) => (
            <TodoRow key={`${todo.kind}-${todo.quotationId}-${index}`} todo={todo} onOpen={openQuotation} />
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 進行中案子 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">進行中的案子</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-8">
              <Stat label="件數" value={String(openDeals.count)} />
              {showAmounts && (
                <Stat label="合計金額" value={formatMoney(openDeals.amount)} />
              )}
            </div>
            {openDeals.oldest && (
              <div className="rounded-md bg-muted/50 p-3 text-sm">
                最久的一件：
                <button
                  className="ml-1 font-mono underline underline-offset-2"
                  onClick={() => navigate(`/quotations?search=${openDeals.oldest!.number}`)}
                >
                  {openDeals.oldest.number}
                </button>
                <span className="ml-1 text-muted-foreground">
                  （{openDeals.oldest.date}，已 {openDeals.oldest.days} 天）
                </span>
              </div>
            )}
            <Button variant="outline" size="sm" onClick={() => navigate("/quotations?openOnly=true")}>
              查看全部
            </Button>
          </CardContent>
        </Card>

        {/* 業績 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">{performance.period}業績</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Stat
                label="報價"
                value={`${performance.quoted.count} 件`}
                hint={showAmounts ? formatMoney(performance.quoted.amount) : undefined}
              />
              <Stat
                label="成交"
                value={`${performance.won.count} 件`}
                hint={showAmounts ? formatMoney(performance.won.amount) : undefined}
              />
              <Stat
                label="成交率"
                value={performance.winRate == null ? "—" : `${performance.winRate}%`}
                hint={performance.winRate == null ? "本季尚無結案的案子" : `已結案 ${performance.won.count + performance.lost.count} 件`}
              />
              <Stat
                label="平均成交天數"
                value={performance.avgDaysToClose == null ? "—" : `${performance.avgDaysToClose} 天`}
              />
            </div>
            {performance.lost.count === 0 && performance.quoted.count > 0 && (
              // 成交率要準，前提是輸掉的案子有被標記
              <p className="text-xs text-muted-foreground">
                本季沒有標記為拒絕或過期的報價。成交率要準確，輸掉的案子也要記得標。
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* 人事提醒 */}
      {hrAlerts.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">人事提醒</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {hrAlerts.map((alert: HrAlert, index) => (
              <div
                key={`${alert.kind}-${alert.employeeId}-${index}`}
                className={`rounded-md bg-card p-3 ${severityStyle(alert.severity)}`}
              >
                <div className="font-medium">{alert.label}</div>
                <p className="mt-0.5 text-sm text-muted-foreground">{alert.detail}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 6) return "夜深了";
  if (hour < 12) return "早安";
  if (hour < 18) return "午安";
  return "晚安";
}
