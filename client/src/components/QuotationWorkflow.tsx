/**
 * 報價單的「流程面板」：狀態推進、履約進度、簽回檔、歷程。
 *
 * 之前這些能力只存在於 API —— 列表的「下一步」欄告訴使用者該做什麼，
 * 頁面上卻沒有任何按鈕可以做。這個面板補上完整的操作入口：
 *
 *   - 報價狀態：依狀態機顯示「現在可以做什麼」，主要動作放大、
 *     次要動作收在後面。作廢、婉拒需要填原因。
 *   - 履約進度：客戶接受後出現里程碑（交付→驗收→請款→收款→結案），
 *     每一步可以補填實際日期（預設今天）。
 *   - 簽回檔：上傳、下載、掛錯警示。
 *   - 歷程：誰在什麼時候把狀態改成什麼，預設收合。
 *
 * 轉移規則跟 shared/schema.ts 的 QUOTATION_TRANSITIONS / FULFILLMENT_TRANSITIONS
 * 一致（伺服器才是真正把關的人，這裡只是不顯示註定失敗的按鈕）。
 * 不直接 import shared/schema 是為了避免把 drizzle-orm 拖進前端 bundle。
 */

import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  quotations, documents as documentsApi, ApiError,
  type ApiQuotation, type QuotationStatus, type FulfillmentStatus,
} from "@/lib/api";
import { STATUS_LABEL, FULFILLMENT_LABEL } from "@/lib/adapters";
import { useToast } from "@/hooks/use-toast";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

/* 跟 shared/schema.ts 同步（見檔頭說明） */
const QUOTE_NEXT: Record<string, QuotationStatus[]> = {
  draft: ["sent", "voided"],
  pending_approval: ["approved", "draft", "voided"],
  approved: ["sent", "draft", "voided"],
  sent: ["viewed", "accepted", "declined", "expired", "voided"],
  viewed: ["accepted", "declined", "expired", "voided"],
  accepted: ["voided"],
  declined: ["voided"],
  expired: ["voided"],
  superseded: [],
  voided: [],
};

const FULFILLMENT_NEXT: Record<string, FulfillmentStatus[]> = {
  not_started: ["in_progress", "on_hold", "canceled"],
  in_progress: ["delivered", "inspected", "invoiced", "on_hold", "canceled"],
  delivered: ["inspected", "invoiced", "on_hold", "canceled"],
  inspected: ["invoiced", "on_hold", "canceled"],
  invoiced: ["paid", "on_hold", "canceled"],
  paid: ["closed", "on_hold"],
  closed: [],
  on_hold: ["in_progress", "delivered", "inspected", "invoiced", "canceled"],
  canceled: [],
};

/** 每個動作的按鈕文案（比狀態名稱更像「動作」） */
const QUOTE_ACTION_LABEL: Record<string, string> = {
  sent: "寄出給客戶",
  viewed: "標記客戶已讀",
  accepted: "客戶接受 ✓",
  declined: "客戶婉拒",
  expired: "標記過期",
  voided: "作廢",
  approved: "核准",
  draft: "退回草稿",
};

/** 主要動作（放大顯示）：狀態機裡「最常見的下一步」 */
const PRIMARY_ACTION: Partial<Record<string, QuotationStatus>> = {
  draft: "sent",
  pending_approval: "approved",
  approved: "sent",
  sent: "accepted",
  viewed: "accepted",
};

/** 需要填原因的動作 */
const NEEDS_REASON: QuotationStatus[] = ["declined", "voided"];

const FULFILLMENT_ACTION_LABEL: Record<string, string> = {
  in_progress: "開始執行",
  delivered: "已交付",
  inspected: "已驗收",
  invoiced: "已請款",
  paid: "已收款",
  closed: "結案",
  on_hold: "暫停",
  canceled: "取消履約",
};

/** 里程碑順序（顯示進度條用） */
const MILESTONES: Array<{ key: FulfillmentStatus; dateField: keyof ApiQuotation }> = [
  { key: "in_progress", dateField: "closed_at" /* 無日期欄，僅顯示狀態 */ },
  { key: "delivered", dateField: "delivered_at" },
  { key: "inspected", dateField: "inspected_at" },
  { key: "invoiced", dateField: "invoiced_at" },
  { key: "paid", dateField: "paid_at" },
  { key: "closed", dateField: "closed_at" },
];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString("zh-TW", {
    year: "numeric", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export default function QuotationWorkflow({
  quotation, canWrite,
}: {
  quotation: ApiQuotation;
  canWrite: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  const currentVersion = quotation.versions.find(v => v.id === quotation.current_version_id)
    ?? quotation.versions[quotation.versions.length - 1];
  const status = currentVersion?.status ?? "draft";
  const fulfillment = quotation.fulfillment_status;

  const [reasonDialog, setReasonDialog] = useState<QuotationStatus | null>(null);
  const [reason, setReason] = useState("");
  const [fulfillDialog, setFulfillDialog] = useState<FulfillmentStatus | null>(null);
  const [milestoneDate, setMilestoneDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [historyOpen, setHistoryOpen] = useState(false);
  const [uploading, setUploading] = useState(false);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["quotation", quotation.id] });
    void queryClient.invalidateQueries({ queryKey: ["quotations"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const fail = (err: unknown, fallback: string) => {
    toast({
      title: fallback,
      description: err instanceof ApiError ? err.message : "發生未預期的錯誤",
      variant: "destructive",
    });
  };

  const statusMutation = useMutation({
    mutationFn: ({ to, why }: { to: QuotationStatus; why?: string }) =>
      quotations.setStatus(currentVersion!.id, to, why),
    onSuccess: (_result, vars) => {
      toast({ title: `已更新為「${STATUS_LABEL[vars.to] ?? vars.to}」` });
      setReasonDialog(null); setReason("");
      refresh();
    },
    onError: err => fail(err, "狀態更新失敗"),
  });

  const fulfillmentMutation = useMutation({
    mutationFn: ({ to, date }: { to: FulfillmentStatus; date?: string }) =>
      quotations.setFulfillment(quotation.id, to, date ? { milestoneDate: date } : {}),
    onSuccess: (_result, vars) => {
      toast({ title: `履約進度：${FULFILLMENT_LABEL[vars.to] ?? vars.to}` });
      setFulfillDialog(null);
      refresh();
    },
    onError: err => fail(err, "履約進度更新失敗"),
  });

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const result = await quotations.uploadDocument(quotation.id, file);
      if (result.suspect) {
        toast({
          title: "檔案已上傳，但可能掛錯",
          description: `同一份檔案也掛在：${result.conflictsWith.join("、")}。請到「待確認簽回檔」確認。`,
          variant: "destructive",
        });
      } else {
        toast({ title: result.deduplicated ? "檔案已存在，已建立關聯" : "簽回檔已上傳" });
      }
      refresh();
    } catch (err) {
      fail(err, "上傳失敗");
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = "";
    }
  };

  const nextStatuses = QUOTE_NEXT[status] ?? [];
  const primary = PRIMARY_ACTION[status];
  const secondary = nextStatuses.filter(s => s !== primary);
  const nextFulfillments = status === "accepted" ? (FULFILLMENT_NEXT[fulfillment] ?? []) : [];

  const runStatus = (to: QuotationStatus) => {
    if (NEEDS_REASON.includes(to)) { setReasonDialog(to); setReason(""); return; }
    statusMutation.mutate({ to });
  };

  const milestoneReached = (key: FulfillmentStatus): string | null => {
    const field = MILESTONES.find(m => m.key === key)?.dateField;
    if (key === "in_progress") {
      return ["in_progress", "delivered", "inspected", "invoiced", "paid", "closed"]
        .includes(fulfillment) ? "" : null;
    }
    if (!field) return null;
    const value = quotation[field] as string | null;
    return value ?? null;
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">狀態與流程</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">

        {/* ── 報價狀態動作 ── */}
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-muted-foreground">報價狀態</span>
            <Badge>{STATUS_LABEL[status] ?? status}</Badge>
            {currentVersion?.voidReason && (
              <span className="text-xs text-muted-foreground">原因：{currentVersion.voidReason}</span>
            )}
          </div>
          {canWrite && nextStatuses.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {primary && nextStatuses.includes(primary) && (
                <Button
                  size="sm"
                  disabled={statusMutation.isPending}
                  onClick={() => runStatus(primary)}
                >
                  {QUOTE_ACTION_LABEL[primary] ?? primary}
                </Button>
              )}
              {secondary.map(to => (
                <Button
                  key={to} size="sm" variant="outline"
                  className={to === "voided" || to === "declined" ? "text-destructive" : ""}
                  disabled={statusMutation.isPending}
                  onClick={() => runStatus(to)}
                >
                  {QUOTE_ACTION_LABEL[to] ?? STATUS_LABEL[to] ?? to}
                </Button>
              ))}
            </div>
          )}
          {status === "sent" && (
            <p className="text-xs text-muted-foreground">
              客戶回覆後記得回來更新狀態 —— 接受後才能開始記錄履約進度。
            </p>
          )}
        </div>

        {/* ── 履約進度（接受後才出現） ── */}
        {status === "accepted" && (
          <div className="space-y-3 border-t pt-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">履約進度</span>
              <Badge variant={fulfillment === "closed" ? "secondary" : "default"}>
                {FULFILLMENT_LABEL[fulfillment] ?? fulfillment}
              </Badge>
            </div>

            {/* 里程碑時間軸 */}
            <ol className="flex flex-wrap gap-x-1 gap-y-2 text-xs">
              {MILESTONES.map((m, i) => {
                const reached = milestoneReached(m.key) !== null;
                const date = milestoneReached(m.key);
                return (
                  <li key={m.key} className="flex items-center gap-1">
                    {i > 0 && <span className="text-muted-foreground/40">→</span>}
                    <span className={
                      "rounded-full px-2 py-1 " + (
                        m.key === fulfillment
                          ? "bg-primary text-primary-foreground"
                          : reached
                            ? "bg-muted text-foreground"
                            : "text-muted-foreground/60"
                      )
                    }>
                      {FULFILLMENT_LABEL[m.key]}
                      {date ? `　${date}` : ""}
                    </span>
                  </li>
                );
              })}
            </ol>

            {canWrite && nextFulfillments.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {nextFulfillments.map(to => {
                  const destructive = to === "canceled";
                  const wantsDate = ["delivered", "inspected", "invoiced", "paid"].includes(to);
                  return (
                    <Button
                      key={to} size="sm"
                      variant={destructive ? "outline" : ["on_hold"].includes(to) ? "outline" : "secondary"}
                      className={destructive ? "text-destructive" : ""}
                      disabled={fulfillmentMutation.isPending}
                      onClick={() => {
                        if (wantsDate) {
                          setMilestoneDate(new Date().toISOString().slice(0, 10));
                          setFulfillDialog(to);
                        } else {
                          fulfillmentMutation.mutate({ to });
                        }
                      }}
                    >
                      {FULFILLMENT_ACTION_LABEL[to] ?? FULFILLMENT_LABEL[to] ?? to}
                    </Button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── 簽回檔與附件 ── */}
        <div className="space-y-2 border-t pt-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">簽回檔與附件</span>
            {canWrite && (
              <>
                <input
                  ref={fileInput} type="file" className="hidden"
                  accept=".pdf,.png,.jpg,.jpeg"
                  onChange={e => { const f = e.target.files?.[0]; if (f) void upload(f); }}
                />
                <Button
                  size="sm" variant="outline"
                  disabled={uploading}
                  onClick={() => fileInput.current?.click()}
                >
                  {uploading ? "上傳中…" : "上傳簽回檔"}
                </Button>
              </>
            )}
          </div>

          {quotation.documents.length === 0 ? (
            <p className="text-xs text-muted-foreground">還沒有附件。客戶簽回後把掃描檔上傳到這裡。</p>
          ) : (
            <ul className="space-y-1">
              {quotation.documents.map(doc => (
                <li key={doc.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <a
                    className="underline-offset-2 hover:underline"
                    href={documentsApi.downloadUrl(doc.id)}
                    target="_blank" rel="noreferrer"
                  >
                    {doc.filename}
                  </a>
                  <span className="text-xs text-muted-foreground">
                    {formatBytes(doc.byteSize)}・{formatDateTime(doc.uploadedAt)}
                  </span>
                  {doc.verificationStatus === "suspect" && (
                    <Badge variant="destructive">可能掛錯</Badge>
                  )}
                  {doc.verificationStatus === "verified" && (
                    <Badge variant="secondary">已確認</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* ── 歷程 ── */}
        {quotation.history.length > 0 && (
          <div className="border-t pt-4">
            <button
              type="button"
              className="text-sm text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => setHistoryOpen(open => !open)}
            >
              {historyOpen ? "收合歷程 ▲" : `狀態歷程（${quotation.history.length} 筆）▼`}
            </button>
            {historyOpen && (
              <ol className="mt-2 space-y-1 text-xs text-muted-foreground">
                {quotation.history.map((h, i) => (
                  <li key={i}>
                    {formatDateTime(h.changedAt)}
                    {h.scope === "fulfillment" ? "履約" : "報價"}：
                    {h.fromStatus
                      ? `${(h.scope === "fulfillment" ? FULFILLMENT_LABEL : STATUS_LABEL)[h.fromStatus] ?? h.fromStatus} → `
                      : ""}
                    {(h.scope === "fulfillment" ? FULFILLMENT_LABEL : STATUS_LABEL)[h.toStatus] ?? h.toStatus}
                    {h.reason ? `（${h.reason}）` : ""}
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </CardContent>

      {/* 原因對話框（作廢／婉拒） */}
      <Dialog open={reasonDialog !== null} onOpenChange={open => !open && setReasonDialog(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {reasonDialog ? (QUOTE_ACTION_LABEL[reasonDialog] ?? reasonDialog) : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>原因（會寫入紀錄）</Label>
            <Textarea
              rows={3} value={reason} autoFocus
              placeholder={reasonDialog === "declined" ? "例如：預算不足、改採其他方案…" : "例如：重複開立、金額打錯…"}
              onChange={e => setReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReasonDialog(null)}>取消</Button>
            <Button
              variant={reasonDialog === "voided" ? "destructive" : "default"}
              disabled={statusMutation.isPending || !reason.trim()}
              onClick={() => reasonDialog && statusMutation.mutate({ to: reasonDialog, why: reason.trim() })}
            >
              確定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 里程碑日期對話框 */}
      <Dialog open={fulfillDialog !== null} onOpenChange={open => !open && setFulfillDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {fulfillDialog ? (FULFILLMENT_ACTION_LABEL[fulfillDialog] ?? fulfillDialog) : ""}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label>實際日期</Label>
            <Input
              type="date" value={milestoneDate}
              onChange={e => setMilestoneDate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              預設是今天。補登過去的里程碑時把日期改成實際發生日。
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFulfillDialog(null)}>取消</Button>
            <Button
              disabled={fulfillmentMutation.isPending || !milestoneDate}
              onClick={() => fulfillDialog && fulfillmentMutation.mutate({ to: fulfillDialog, date: milestoneDate })}
            >
              確定
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
