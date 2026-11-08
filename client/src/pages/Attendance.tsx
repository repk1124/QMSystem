/**
 * 出勤。
 *
 * 重點在「修改要留痕」—— 勞基法 §30 要求出勤紀錄逐日記載至分鐘、
 * 保存 5 年，而勞檢實務最看的是「改過的紀錄能不能還原」。
 * 所以補登一定要填事由，而且每筆修改都看得到原值。
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { hr, ApiError, PERMISSION, type AttendanceRow } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

const time = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString("zh-TW", { hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

/** 出勤狀態的中文標籤（資料庫存英文代碼） */
const ATTENDANCE_STATUS_LABEL: Record<string, string> = {
  present: "正常",
  late: "遲到",
  early_leave: "早退",
  absent: "缺勤",
  leave: "請假",
  holiday: "假日",
  remote: "遠端",
};

const duration = (minutes: number | null) =>
  minutes == null ? "—" : `${Math.floor(minutes / 60)} 小時 ${minutes % 60} 分`;

/** datetime-local 需要本地時間格式 */
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default function Attendance() {
  const { can } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canManage = can(PERMISSION.SYSTEM_ADMIN) || can("attendance:manage");

  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(today);
  const [amending, setAmending] = useState<AttendanceRow | null>(null);

  const { data = [], isLoading } = useQuery({
    queryKey: ["attendance", from, to],
    queryFn: () => hr.attendance({ from, to }),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["attendance"] });
  const onError = (err: unknown, title: string) => toast({
    title, description: err instanceof ApiError ? err.message : "發生錯誤", variant: "destructive",
  });

  const clockIn = useMutation({
    mutationFn: () => hr.clockIn(),
    onSuccess: () => { toast({ title: "已打上班卡" }); refresh(); },
    onError: err => onError(err, "打卡失敗"),
  });
  const clockOut = useMutation({
    mutationFn: () => hr.clockOut(),
    onSuccess: () => { toast({ title: "已打下班卡" }); refresh(); },
    onError: err => onError(err, "打卡失敗"),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">出勤</h1>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={() => clockIn.mutate()} disabled={clockIn.isPending}>上班打卡</Button>
          <Button variant="outline" onClick={() => clockOut.mutate()} disabled={clockOut.isPending}>下班打卡</Button>
        </div>
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div className="space-y-1">
            <Label className="text-xs">起</Label>
            <Input type="date" className="w-40" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">迄</Label>
            <Input type="date" className="w-40" value={to} onChange={e => setTo(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>日期</TableHead>
                <TableHead>員工</TableHead>
                <TableHead>上班</TableHead>
                <TableHead>下班</TableHead>
                <TableHead>工時</TableHead>
                <TableHead>狀態</TableHead>
                <TableHead>備註</TableHead>
                {canManage && <TableHead className="w-24" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={canManage ? 8 : 7} className="py-10 text-center text-muted-foreground">載入中…</TableCell></TableRow>
              )}
              {!isLoading && data.length === 0 && (
                <TableRow><TableCell colSpan={canManage ? 8 : 7} className="py-10 text-center text-muted-foreground">
                  這段期間沒有出勤紀錄
                </TableCell></TableRow>
              )}
              {data.map(row => (
                <TableRow key={row.id}>
                  <TableCell className="text-sm">{row.workDate}</TableCell>
                  <TableCell className="text-sm">{row.employeeName}</TableCell>
                  <TableCell className="tabular-nums">{time(row.clockInAt)}</TableCell>
                  <TableCell className="tabular-nums">{time(row.clockOutAt)}</TableCell>
                  <TableCell className="tabular-nums text-sm">{duration(row.workMinutes)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{ATTENDANCE_STATUS_LABEL[row.status] ?? row.status}</Badge>
                    {row.editCount > 0 && (
                      <Badge variant="secondary" className="ml-1" title="這筆紀錄被修改過">
                        改過 {row.editCount} 次
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-xs text-muted-foreground">{row.notes}</TableCell>
                  {canManage && (
                    <TableCell>
                      <Button size="sm" variant="ghost" onClick={() => setAmending(row)}>補登</Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {amending && (
        <AmendDialog record={amending} onClose={() => setAmending(null)}
          onDone={() => { setAmending(null); refresh(); }} />
      )}
    </div>
  );
}

function AmendDialog({
  record, onClose, onDone,
}: { record: AttendanceRow; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [clockInAt, setClockInAt] = useState(toLocalInput(record.clockInAt));
  const [clockOutAt, setClockOutAt] = useState(toLocalInput(record.clockOutAt));
  const [notes, setNotes] = useState(record.notes ?? "");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data: history = [] } = useQuery({
    queryKey: ["attendance-history", record.id],
    queryFn: () => hr.attendanceHistory(record.id),
  });

  const mutation = useMutation({
    mutationFn: () => hr.amendAttendance(record.id, {
      reason: reason.trim(),
      clockInAt: clockInAt ? new Date(clockInAt).toISOString() : null,
      clockOutAt: clockOutAt ? new Date(clockOutAt).toISOString() : null,
      notes,
    }),
    onSuccess: result => {
      toast({ title: "已補登", description: `修改了：${result.changed.join("、")}` });
      onDone();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : "補登失敗"),
  });

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>補登出勤 — {record.employeeName} {record.workDate}</DialogTitle>
          <DialogDescription>
            依勞基法 §30，出勤紀錄的修改必須可還原。原始值與事由會永久保留，
            勞檢時查得到。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>上班時間</Label>
              <Input type="datetime-local" value={clockInAt} onChange={e => setClockInAt(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>下班時間</Label>
              <Input type="datetime-local" value={clockOutAt} onChange={e => setClockOutAt(e.target.value)} />
            </div>
          </div>
          <div className="space-y-2">
            <Label>備註</Label>
            <Input value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>修改事由（必填）</Label>
            <Textarea rows={2} value={reason} onChange={e => setReason(e.target.value)}
              placeholder="例如：打卡機當機，依門禁紀錄補正" />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          {history.length > 0 && (
            <section className="rounded-md bg-muted/40 p-3">
              <h4 className="mb-2 text-sm font-medium">修改紀錄</h4>
              <div className="space-y-2 text-xs">
                {history.map((h, i) => (
                  <div key={i}>
                    <span className="font-medium">{h.field}</span>
                    <span className="text-muted-foreground">
                      ：{h.oldValue ?? "（空）"} → {h.newValue ?? "（空）"}
                    </span>
                    <div className="text-muted-foreground">
                      {h.reason} — {h.changedBy} · {new Date(h.changedAt).toLocaleString("zh-TW")}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => { setError(null); mutation.mutate(); }}
            disabled={!reason.trim() || mutation.isPending}>儲存並留痕</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
