/** 請假：申請、審核。特休會即時檢查額度。 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { hr, ApiError, PERMISSION, LEAVE_TYPE_LABEL, type LeaveRow } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

const STATUS_LABEL: Record<string, string> = {
  pending: "待審核", approved: "已核准", rejected: "已駁回",
};

export default function Leave() {
  const { can } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canApprove = can(PERMISSION.SYSTEM_ADMIN) || can("leave:approve");

  const [statusFilter, setStatusFilter] = useState("all");
  const [applying, setApplying] = useState(false);
  const [rejecting, setRejecting] = useState<LeaveRow | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const { data = [], isLoading } = useQuery({
    queryKey: ["leave-requests", statusFilter],
    queryFn: () => hr.leaveRequests({ status: statusFilter === "all" ? undefined : statusFilter }),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["leave-requests"] });
    void queryClient.invalidateQueries({ queryKey: ["employees"] });
    void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  };

  const onError = (err: unknown, title: string) => toast({
    title, description: err instanceof ApiError ? err.message : "發生錯誤", variant: "destructive",
  });

  const decide = useMutation({
    mutationFn: ({ id, decision, reason }: { id: number; decision: "approved" | "rejected"; reason?: string }) =>
      hr.decideLeave(id, decision, reason),
    onSuccess: (_r, vars) => {
      toast({ title: vars.decision === "approved" ? "已核准" : "已駁回" });
      setRejecting(null); setRejectReason(""); refresh();
    },
    onError: err => onError(err, "審核失敗"),
  });

  const pending = data.filter(l => l.status === "pending").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">請假</h1>
        {pending > 0 && <Badge variant="destructive">{pending} 筆待審核</Badge>}
        <div className="ml-auto flex gap-2">
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部狀態</SelectItem>
              {Object.entries(STATUS_LABEL).map(([v, l]) => (
                <SelectItem key={v} value={v}>{l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button onClick={() => setApplying(true)}>申請請假</Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>員工</TableHead>
                <TableHead>假別</TableHead>
                <TableHead>期間</TableHead>
                <TableHead className="text-right">天數</TableHead>
                <TableHead>事由</TableHead>
                <TableHead>狀態</TableHead>
                {canApprove && <TableHead className="w-40">審核</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={canApprove ? 7 : 6} className="py-10 text-center text-muted-foreground">載入中…</TableCell></TableRow>
              )}
              {!isLoading && data.length === 0 && (
                <TableRow><TableCell colSpan={canApprove ? 7 : 6} className="py-10 text-center text-muted-foreground">沒有請假紀錄</TableCell></TableRow>
              )}
              {data.map(row => (
                <TableRow key={row.id}>
                  <TableCell>
                    {row.employeeName}
                    <div className="text-xs text-muted-foreground">{row.employeeCode}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{LEAVE_TYPE_LABEL[row.leaveType] ?? row.leaveType}</Badge>
                  </TableCell>
                  <TableCell className="text-sm">
                    {row.startDate} ～ {row.endDate}
                    {row.tripLocation && (
                      <div className="text-xs text-muted-foreground">
                        {row.tripLocation}（{row.tripType === "international" ? "國外" : "國內"}）
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{Number(row.days)}</TableCell>
                  <TableCell className="max-w-xs truncate text-sm" title={row.reason}>{row.reason}</TableCell>
                  <TableCell>
                    <Badge variant={
                      row.status === "approved" ? "default"
                      : row.status === "rejected" ? "destructive" : "outline"
                    }>
                      {STATUS_LABEL[row.status] ?? row.status}
                    </Badge>
                    {row.rejectionReason && (
                      <div className="mt-0.5 text-xs text-muted-foreground">{row.rejectionReason}</div>
                    )}
                  </TableCell>
                  {canApprove && (
                    <TableCell>
                      {row.status === "pending" && (
                        <div className="flex gap-1">
                          <Button size="sm" variant="outline"
                            onClick={() => decide.mutate({ id: row.id, decision: "approved" })}
                            disabled={decide.isPending}>核准</Button>
                          <Button size="sm" variant="ghost" className="text-destructive"
                            onClick={() => setRejecting(row)}>駁回</Button>
                        </div>
                      )}
                      {row.status !== "pending" && row.approverName && (
                        <span className="text-xs text-muted-foreground" title="審核人">
                          {row.status === "approved" ? "核准人" : "駁回人"}：{row.approverName}
                        </span>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <ApplyDialog open={applying} onClose={() => setApplying(false)} onDone={() => { setApplying(false); refresh(); }} />

      <Dialog open={rejecting !== null} onOpenChange={o => !o && setRejecting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>駁回 {rejecting?.employeeName} 的請假</DialogTitle>
            <DialogDescription>
              駁回必須填寫理由，否則申請人只能用猜的。
            </DialogDescription>
          </DialogHeader>
          <Textarea rows={3} value={rejectReason} onChange={e => setRejectReason(e.target.value)}
            placeholder="例如：該期間有客戶驗收，請改期" />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejecting(null)}>取消</Button>
            <Button
              onClick={() => rejecting && decide.mutate({
                id: rejecting.id, decision: "rejected", reason: rejectReason,
              })}
              disabled={!rejectReason.trim() || decide.isPending}
            >確定駁回</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** 依起訖日期試算天數（含頭尾）。半天等特殊情況使用者可再手動修改。 */
function calcDays(start: string, end: string): number {
  if (!start || !end || end < start) return 1;
  const diff = (new Date(end).getTime() - new Date(start).getTime()) / 86_400_000;
  return Math.round(diff) + 1;
}

function ApplyDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const today = new Date().toISOString().slice(0, 10);
  const [leaveType, setLeaveType] = useState("annual");
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [days, setDays] = useState(1);
  const [reason, setReason] = useState("");
  const [tripLocation, setTripLocation] = useState("");
  const [tripType, setTripType] = useState<"domestic" | "international">("domestic");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => hr.createLeave({
      leaveType, startDate, endDate, days, reason: reason.trim(),
      ...(leaveType === "official"
        ? { tripLocation: tripLocation.trim() || undefined, tripType }
        : {}),
    }),
    onSuccess: () => { toast({ title: "已送出申請" }); setReason(""); onDone(); },
    // 特休不足時伺服器會回「本年度可用 X 天、已用 Y 天、剩餘 Z 天」，直接顯示
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : "送出失敗"),
  });

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>申請請假</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-2">
            <Label>假別</Label>
            <Select value={leaveType} onValueChange={setLeaveType}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(LEAVE_TYPE_LABEL).map(([v, l]) => (
                  <SelectItem key={v} value={v}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>開始</Label>
              <Input type="date" value={startDate} max={endDate || undefined}
                onChange={e => {
                  const v = e.target.value;
                  setStartDate(v);
                  // 結束日早於開始日時一起帶動，避免送出才被擋
                  const end = v > endDate ? v : endDate;
                  if (v > endDate) setEndDate(v);
                  setDays(calcDays(v, end));
                }} />
            </div>
            <div className="space-y-2">
              <Label>結束</Label>
              <Input type="date" value={endDate} min={startDate || undefined}
                onChange={e => {
                  const v = e.target.value;
                  setEndDate(v);
                  setDays(calcDays(startDate, v));
                }} />
            </div>
            <div className="space-y-2">
              <Label>天數</Label>
              <Input type="number" min={0.5} step={0.5} value={days}
                onChange={e => setDays(Number(e.target.value))} />
              <p className="text-xs text-muted-foreground">已依日期試算，半天請自行改成 0.5</p>
            </div>
          </div>
          {leaveType === "official" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>出差地點</Label>
                <Input value={tripLocation} onChange={e => setTripLocation(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>類型</Label>
                <Select value={tripType} onValueChange={v => setTripType(v as never)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="domestic">國內</SelectItem>
                    <SelectItem value="international">國外</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          <div className="space-y-2">
            <Label>事由</Label>
            <Textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => { setError(null); mutation.mutate(); }}
            disabled={!reason.trim() || mutation.isPending}>送出</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
