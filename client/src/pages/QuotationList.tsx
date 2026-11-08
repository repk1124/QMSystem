/**
 * 報價列表。資料一律來自後端 API。
 *
 * 跟舊版的差別：
 *   - 搜尋、篩選、分頁都在伺服器做。舊版是把全部報價抓回瀏覽器再篩，
 *     資料量一大就會卡。
 *   - 報價狀態與履約進度分成兩欄顯示
 *   - 多一欄「下一步」，直接講這張單現在該做什麼
 *   - 沒有成本檢視權限的人看不到毛利欄
 */

import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { quotations, ApiError, PERMISSION, type QuotationListItem } from "@/lib/api";
import { STATUS_LABEL, FULFILLMENT_LABEL, formatMoney, nextAction } from "@/lib/adapters";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/hooks/use-toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const PAGE_SIZE = 25;

/** 狀態對應的顏色。已接受用綠色、作廢用灰色、過期用紅色。 */
function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "accepted") return "default";
  if (status === "voided" || status === "superseded") return "secondary";
  if (status === "expired" || status === "declined") return "destructive";
  return "outline";
}

export default function QuotationList() {
  const [, navigate] = useLocation();
  const { can } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [fulfillment, setFulfillment] = useState<string>("all");
  const [openOnly, setOpenOnly] = useState(false);
  const [page, setPage] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<QuotationListItem | null>(null);

  const showCost = can(PERMISSION.QUOTATION_VIEW_COST);
  const canVoid = can(PERMISSION.QUOTATION_VOID);

  // 打字時不要每個字元都打一次 API。
  // 這裡一定要用 useEffect —— useMemo 不會執行回傳的 cleanup，
  // 用 useMemo 會導致每次輸入都堆積一個沒被清掉的 timer。
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filters = {
    search: debouncedSearch || undefined,
    status: status === "all" ? undefined : status,
    fulfillmentStatus: fulfillment === "all" ? undefined : fulfillment,
    openOnly: openOnly || undefined,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["quotations", filters],
    queryFn: () => quotations.list(filters),
    staleTime: 30_000,
  });

  const removeMutation = useMutation({
    mutationFn: (id: number) => quotations.remove(id),
    onSuccess: () => {
      toast({ title: "已刪除" });
      void queryClient.invalidateQueries({ queryKey: ["quotations"] });
    },
    onError: (err: unknown) => {
      // 伺服器的訊息已經寫成可以直接顯示的樣子，
      // 例如「只有從未寄出的草稿可以刪除…請改用作廢」
      toast({
        title: "無法刪除",
        description: err instanceof ApiError ? err.message : "發生未預期的錯誤",
        variant: "destructive",
      });
    },
    onSettled: () => setPendingDelete(null),
  });

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">報價單</h1>
        <span className="text-sm text-muted-foreground">共 {total} 筆</span>
        <div className="ml-auto">
          <Button onClick={() => navigate("/quotations/new")}>新增報價</Button>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap gap-3 p-4">
          <Input
            className="w-64"
            placeholder="搜尋單號、客戶或主旨"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />

          <Select value={status} onValueChange={v => { setStatus(v); setPage(0); }}>
            <SelectTrigger className="w-40"><SelectValue placeholder="報價狀態" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有報價狀態</SelectItem>
              {Object.entries(STATUS_LABEL).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={fulfillment} onValueChange={v => { setFulfillment(v); setPage(0); }}>
            <SelectTrigger className="w-40"><SelectValue placeholder="履約進度" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有履約進度</SelectItem>
              {Object.entries(FULFILLMENT_LABEL).map(([value, label]) => (
                <SelectItem key={value} value={value}>{label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button
            variant={openOnly ? "default" : "outline"}
            onClick={() => { setOpenOnly(v => !v); setPage(0); }}
          >
            只看進行中
          </Button>
        </CardContent>
      </Card>

      {isError && (
        <Card>
          <CardContent className="p-6 text-center text-destructive">
            {error instanceof ApiError ? error.message : "讀取失敗"}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>報價單號</TableHead>
                <TableHead className="hidden sm:table-cell">客戶</TableHead>
                <TableHead className="hidden md:table-cell">報價日期</TableHead>
                <TableHead className="text-right">金額</TableHead>
                {showCost && (
                  <TableHead className="hidden text-right lg:table-cell">
                    <span title="毛利率需要品項有成本資料才能計算。舊系統匯入的歷史報價沒有成本，所以顯示「—」。">
                      毛利率
                    </span>
                  </TableHead>
                )}
                <TableHead>報價狀態</TableHead>
                <TableHead className="hidden whitespace-nowrap sm:table-cell">履約進度</TableHead>
                <TableHead className="hidden lg:table-cell">下一步</TableHead>
                <TableHead className="w-32" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={showCost ? 9 : 8} className="py-10 text-center text-muted-foreground">
                    載入中…
                  </TableCell>
                </TableRow>
              )}

              {!isLoading && items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={showCost ? 9 : 8} className="py-10 text-center text-muted-foreground">
                    沒有符合條件的報價
                  </TableCell>
                </TableRow>
              )}

              {items.map(item => {
                const action = nextAction(item);
                return (
                  <TableRow
                    key={item.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/quotations/${item.id}`)}
                  >
                    <TableCell className="whitespace-nowrap font-mono text-sm">
                      <span className="inline-flex items-center gap-2">
                        <span>{item.quotationNumber}</span>
                        {item.versionNumber > 1 && (
                          <Badge variant="secondary" className="font-sans">第 {item.versionNumber} 版</Badge>
                        )}
                      </span>
                      {/* 手機版：客戶名稱直接放在單號下面，不另佔一欄 */}
                      <div className="font-sans text-xs text-muted-foreground sm:hidden">
                        {item.clientName}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      {item.clientName}
                      {/* 客戶已改名時提示一下，避免以為是打錯 */}
                      {item.clientName !== item.clientCurrentName && (
                        <div className="text-xs text-muted-foreground">
                          現稱 {item.clientCurrentName}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap md:table-cell">{item.quotationDate}</TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {formatMoney(item.totalAmount)}
                    </TableCell>
                    {showCost && (
                      <TableCell
                        className="hidden text-right tabular-nums lg:table-cell"
                        title={item.marginPercent == null ? "品項沒有成本資料，無法計算毛利" : undefined}
                      >
                        {item.marginPercent == null ? "—" : `${item.marginPercent}%`}
                      </TableCell>
                    )}
                    <TableCell className="whitespace-nowrap">
                      <Badge variant={statusVariant(item.status)}>
                        {STATUS_LABEL[item.status] ?? item.status}
                      </Badge>
                      {item.locked && (
                        <span className="ml-1 text-xs text-muted-foreground" title="已鎖定，不可修改">🔒</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap sm:table-cell">
                      <span className="text-sm">
                        {FULFILLMENT_LABEL[item.fulfillmentStatus] ?? item.fulfillmentStatus}
                      </span>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      {action && (
                        <span className={
                          item.suspectDocuments > 0
                            ? "text-sm text-destructive"
                            : "text-sm text-muted-foreground"
                        }>
                          {action}
                        </span>
                      )}
                    </TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      <div className="flex gap-1">
                        <Button
                          size="sm" variant="ghost"
                          onClick={() => navigate(`/quotations/${item.id}`)}
                        >
                          檢視
                        </Button>
                        {canVoid && item.status === "draft" && (
                          <Button
                            size="sm" variant="ghost"
                            className="text-destructive"
                            onClick={() => setPendingDelete(item)}
                          >
                            刪除
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline" size="sm"
            disabled={page === 0}
            onClick={() => setPage(p => Math.max(0, p - 1))}
          >
            上一頁
          </Button>
          <span className="text-sm text-muted-foreground">
            第 {page + 1} / {totalPages} 頁
          </span>
          <Button
            variant="outline" size="sm"
            disabled={page + 1 >= totalPages}
            onClick={() => setPage(p => p + 1)}
          >
            下一頁
          </Button>
        </div>
      )}

      <AlertDialog open={pendingDelete !== null} onOpenChange={open => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>刪除報價 {pendingDelete?.quotationNumber}？</AlertDialogTitle>
            <AlertDialogDescription>
              只有從未寄出的草稿可以刪除。已經寄給客戶或有往來紀錄的報價
              必須改用「作廢」，以保留稽核軌跡。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pendingDelete && removeMutation.mutate(pendingDelete.id)}
            >
              確定刪除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
