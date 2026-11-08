/**
 * 員工列表、特休明細，以及員工主檔的「新增／編輯」。
 *
 * 舊系統的員工資料只能看不能改，一異動就得直接進資料庫。
 * 這裡補上完整維護：新增員工、編輯所有欄位、設定離職日。
 * 薪資是敏感欄位，沒有 employee:view_salary 的人看不到也改不到。
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  hr, PERMISSION, ApiError,
  type EmployeeRow, type Entitlement, type EmployeeInput,
} from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/hooks/use-toast";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

const EMPLOYMENT_LABEL: Record<string, string> = {
  full_time: "正職", part_time: "兼職", contract: "約聘",
};

export default function Employees() {
  const { can } = useAuth();
  const canWrite = can(PERMISSION.SYSTEM_ADMIN) || can("employee:write");
  const canSeeSalary = can(PERMISSION.SYSTEM_ADMIN) || can("employee:view_salary");

  const [detailId, setDetailId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);

  const { data = [], isLoading } = useQuery({
    queryKey: ["employees", includeInactive],
    queryFn: () => hr.employees(includeInactive),
  });

  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">員工</h1>
        <span className="text-sm text-muted-foreground">共 {data.length} 位</span>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setIncludeInactive(v => !v)}>
            {includeInactive ? "只看在職" : "包含離職"}
          </Button>
          {canWrite && <Button size="sm" onClick={() => setCreating(true)}>新增員工</Button>}
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>員編</TableHead>
                <TableHead>姓名</TableHead>
                <TableHead className="hidden md:table-cell">部門 / 職位</TableHead>
                <TableHead className="hidden sm:table-cell">僱用型態</TableHead>
                <TableHead className="hidden lg:table-cell">到職日</TableHead>
                <TableHead className="hidden lg:table-cell">合約到期</TableHead>
                <TableHead>系統帳號</TableHead>
                {canWrite && <TableHead className="w-16 text-right">操作</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={canWrite ? 8 : 7} className="py-10 text-center text-muted-foreground">載入中…</TableCell></TableRow>
              )}
              {!isLoading && data.length === 0 && (
                <TableRow><TableCell colSpan={canWrite ? 8 : 7} className="py-10 text-center text-muted-foreground">
                  還沒有員工。{canWrite && "點右上角「新增員工」開始建立。"}
                </TableCell></TableRow>
              )}
              {data.map((emp: EmployeeRow) => {
                const expiring = emp.contractEndDate && emp.contractEndDate <= addDays(today, 60);
                return (
                  <TableRow key={emp.id} className="cursor-pointer" onClick={() => setDetailId(emp.id)}>
                    <TableCell className="whitespace-nowrap font-mono text-sm">{emp.employeeId}</TableCell>
                    <TableCell>
                      {emp.name}
                      {emp.pendingLeaves > 0 && (
                        <Badge variant="destructive" className="ml-2">{emp.pendingLeaves} 筆待審</Badge>
                      )}
                      {emp.terminationDate && <Badge variant="secondary" className="ml-2">已離職</Badge>}
                    </TableCell>
                    <TableCell className="hidden text-sm md:table-cell">
                      {emp.departmentName ?? "—"}
                      {emp.positionTitle && <span className="text-muted-foreground"> / {emp.positionTitle}</span>}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant="outline">{EMPLOYMENT_LABEL[emp.employmentType] ?? emp.employmentType}</Badge>
                      {emp.partnerName && (
                        <div className="mt-0.5 text-xs text-muted-foreground">{emp.partnerName}</div>
                      )}
                    </TableCell>
                    <TableCell className="hidden text-sm lg:table-cell">{emp.hireDate}</TableCell>
                    <TableCell className="hidden text-sm lg:table-cell">
                      {emp.contractEndDate
                        ? <span className={expiring ? "text-destructive" : ""}>{emp.contractEndDate}</span>
                        : "—"}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {emp.userId
                        ? <Badge variant="outline">{emp.userRole}</Badge>
                        : <span className="text-xs text-destructive">無帳號</span>}
                    </TableCell>
                    {canWrite && (
                      <TableCell className="text-right" onClick={e => e.stopPropagation()}>
                        <Button size="sm" variant="ghost" onClick={() => setEditId(emp.id)}>編輯</Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {detailId !== null && (
        <EmployeeDetail
          employeeId={detailId}
          canSeeSalary={canSeeSalary}
          canWrite={canWrite}
          onEdit={() => { setEditId(detailId); setDetailId(null); }}
          onClose={() => setDetailId(null)}
        />
      )}

      {creating && (
        <EmployeeForm canSeeSalary={canSeeSalary} onClose={() => setCreating(false)} />
      )}
      {editId !== null && (
        <EmployeeForm employeeId={editId} canSeeSalary={canSeeSalary} onClose={() => setEditId(null)} />
      )}
    </div>
  );
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/* ── 員工新增／編輯表單 ─────────────────────────────────── */

const EMPTY: EmployeeInput = {
  employeeId: "", name: "", email: "", phone: "",
  hireDate: new Date().toISOString().slice(0, 10),
  departmentName: "", positionName: "",
  employmentType: "full_time", monthlyWorkHours: null,
  contractEndDate: "", partnerName: "", requiresClockIn: true,
  terminationDate: "", salaryAmount: null, salaryType: "monthly",
};

function EmployeeForm({
  employeeId, canSeeSalary, onClose,
}: { employeeId?: number; canSeeSalary: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isEdit = employeeId !== undefined;

  const [form, setForm] = useState<EmployeeInput>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<EmployeeInput>) => setForm(f => ({ ...f, ...patch }));

  // 下拉來源
  const { data: departments = [] } = useQuery({ queryKey: ["departments"], queryFn: () => hr.departments(), staleTime: 5 * 60_000 });
  const { data: positions = [] } = useQuery({ queryKey: ["positions"], queryFn: () => hr.positions(), staleTime: 5 * 60_000 });

  // 編輯時載入現有資料
  const { data: existing } = useQuery({
    queryKey: ["employee", employeeId],
    queryFn: () => hr.employee(employeeId!),
    enabled: isEdit,
  });
  useEffect(() => {
    if (!existing) return;
    setForm({
      employeeId: existing.employee_id ?? "",
      name: existing.name ?? "",
      email: existing.email ?? "",
      phone: existing.phone ?? "",
      hireDate: existing.hire_date ?? "",
      departmentName: existing.department_name ?? "",
      positionName: existing.position_title ?? "",
      employmentType: existing.employment_type ?? "full_time",
      monthlyWorkHours: existing.monthly_work_hours != null ? Number(existing.monthly_work_hours) : null,
      contractEndDate: existing.contract_end_date ?? "",
      partnerName: existing.partner_name ?? "",
      requiresClockIn: existing.requires_clock_in ?? true,
      terminationDate: existing.termination_date ?? "",
      salaryAmount: existing.salary_amount != null ? Number(existing.salary_amount) : null,
      salaryType: existing.salary_type ?? "monthly",
    });
  }, [existing]);

  const save = useMutation({
    mutationFn: () => {
      // 空字串的日期要轉成 null，避免後端收到 "" 當日期
      const payload: EmployeeInput = {
        ...form,
        phone: form.phone || null,
        departmentName: form.departmentName || null,
        positionName: form.positionName || null,
        contractEndDate: form.contractEndDate || null,
        terminationDate: form.terminationDate || null,
        partnerName: form.partnerName || null,
      };
      if (!canSeeSalary) { delete (payload as Partial<EmployeeInput>).salaryAmount; delete (payload as Partial<EmployeeInput>).salaryType; }
      return isEdit ? hr.updateEmployee(employeeId!, payload) : hr.createEmployee(payload);
    },
    onSuccess: () => {
      toast({ title: isEdit ? "已儲存" : "已新增員工" });
      void queryClient.invalidateQueries({ queryKey: ["employees"] });
      void queryClient.invalidateQueries({ queryKey: ["employee", employeeId] });
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      onClose();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : "儲存失敗"),
  });

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? "編輯員工" : "新增員工"}</DialogTitle>
          <DialogDescription>標示 * 為必填。部門與職位可直接打字，沒有的會自動建立。</DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="員工編號 *"><Input value={form.employeeId} onChange={e => set({ employeeId: e.target.value })} placeholder="例如 A001" /></Field>
          <Field label="姓名 *"><Input value={form.name} onChange={e => set({ name: e.target.value })} /></Field>
          <Field label="Email *"><Input type="email" value={form.email} onChange={e => set({ email: e.target.value })} /></Field>
          <Field label="電話"><Input value={form.phone ?? ""} onChange={e => set({ phone: e.target.value })} /></Field>

          <Field label="部門">
            <Input list="dept-options" value={form.departmentName ?? ""} onChange={e => set({ departmentName: e.target.value })} />
            <datalist id="dept-options">{departments.map(d => <option key={d.id} value={d.name} />)}</datalist>
          </Field>
          <Field label="職位">
            <Input list="pos-options" value={form.positionName ?? ""} onChange={e => set({ positionName: e.target.value })} />
            <datalist id="pos-options">{positions.map(p => <option key={p.id} value={p.title} />)}</datalist>
          </Field>

          <Field label="僱用型態">
            <Select value={form.employmentType} onValueChange={v => set({ employmentType: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="full_time">正職</SelectItem>
                <SelectItem value="part_time">兼職</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="合作單位／派遣（兼職用）">
            <Input value={form.partnerName ?? ""} onChange={e => set({ partnerName: e.target.value })} />
          </Field>

          <Field label="到職日 *"><Input type="date" value={form.hireDate} onChange={e => set({ hireDate: e.target.value })} /></Field>
          <Field label="合約到期日"><Input type="date" value={form.contractEndDate ?? ""} onChange={e => set({ contractEndDate: e.target.value })} /></Field>

          <Field label="月工時（時薪制填每月時數）">
            <Input type="number" min={0} value={form.monthlyWorkHours ?? ""} onChange={e => set({ monthlyWorkHours: e.target.value === "" ? null : Number(e.target.value) })} />
          </Field>
          <Field label="離職日（在職留空）"><Input type="date" value={form.terminationDate ?? ""} onChange={e => set({ terminationDate: e.target.value })} /></Field>

          {canSeeSalary && (
            <>
              <Field label="薪資金額">
                <Input type="number" min={0} value={form.salaryAmount ?? ""} onChange={e => set({ salaryAmount: e.target.value === "" ? null : Number(e.target.value) })} />
              </Field>
              <Field label="薪資類型">
                <Select value={form.salaryType} onValueChange={v => set({ salaryType: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly">月薪</SelectItem>
                    <SelectItem value="hourly">時薪</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </>
          )}

          <div className="flex items-center gap-2 sm:col-span-2">
            <Checkbox id="rci" checked={form.requiresClockIn ?? true} onCheckedChange={c => set({ requiresClockIn: c === true })} />
            <Label htmlFor="rci" className="font-normal">需要打卡</Label>
          </div>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            onClick={() => { setError(null); save.mutate(); }}
            disabled={save.isPending || !form.employeeId.trim() || !form.name.trim() || !form.email.trim() || !form.hireDate}
          >
            {isEdit ? "儲存" : "建立"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

/* ── 員工檢視（含特休明細）─────────────────────────────── */

function EmployeeDetail({
  employeeId, canSeeSalary, canWrite, onEdit, onClose,
}: { employeeId: number; canSeeSalary: boolean; canWrite: boolean; onEdit: () => void; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["employee", employeeId],
    queryFn: () => hr.employee(employeeId),
  });

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        {isLoading || !data ? (
          <div className="py-10 text-center text-muted-foreground">載入中…</div>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-start justify-between gap-3">
                <div>
                  <DialogTitle>{data.name}（{data.employee_id}）</DialogTitle>
                  <DialogDescription>
                    {data.department_name ?? "—"} · {data.position_title ?? "—"} · 到職 {data.hire_date}
                  </DialogDescription>
                </div>
                {canWrite && <Button size="sm" variant="outline" onClick={onEdit}>編輯</Button>}
              </div>
            </DialogHeader>

            <div className="space-y-6">
              <section className="grid gap-3 text-sm sm:grid-cols-2">
                <div><span className="text-muted-foreground">Email：</span>{data.email}</div>
                <div><span className="text-muted-foreground">電話：</span>{data.phone ?? "—"}</div>
                <div><span className="text-muted-foreground">僱用型態：</span>
                  {EMPLOYMENT_LABEL[data.employment_type] ?? data.employment_type}</div>
                <div><span className="text-muted-foreground">合約到期：</span>{data.contract_end_date ?? "—"}</div>
                {data.termination_date && (
                  <div><span className="text-muted-foreground">離職日：</span>{data.termination_date}</div>
                )}
                {canSeeSalary && data.salary_amount != null && (
                  <div><span className="text-muted-foreground">薪資：</span>
                    {Number(data.salary_amount).toLocaleString("zh-TW")}
                    {data.salary_type === "hourly" ? " / 小時" : " / 月"}</div>
                )}
                <div><span className="text-muted-foreground">系統帳號：</span>
                  {data.username ?? "未建立"}</div>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-medium">特別休假（勞基法 §38，週年制）</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>年度</TableHead>
                      <TableHead className="text-right">法定</TableHead>
                      <TableHead className="text-right">遞延進</TableHead>
                      <TableHead className="text-right">可用</TableHead>
                      <TableHead className="text-right">已休</TableHead>
                      <TableHead className="text-right">剩餘</TableHead>
                      <TableHead className="text-right">應折發</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(data.entitlements as Entitlement[]).map(e => (
                      <TableRow key={e.id} className={e.isCurrent ? "bg-accent/40" : ""}>
                        <TableCell className="text-sm">
                          {e.period_start} ～ {e.period_end}
                          {e.isCurrent && <Badge className="ml-2">本年度</Badge>}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{num(e.entitled_days)}</TableCell>
                        <TableCell className="text-right tabular-nums">{num(e.carried_in_days)}</TableCell>
                        <TableCell className="text-right tabular-nums font-medium">{e.available}</TableCell>
                        <TableCell className="text-right tabular-nums">{num(e.used_days)}</TableCell>
                        <TableCell className="text-right tabular-nums font-medium">{e.remaining}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {num(e.paid_out_days) > 0
                            ? <span className="text-destructive">{num(e.paid_out_days)}</span>
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="mt-2 text-xs text-muted-foreground">
                  未休完的特休可遞延一年；遞延期滿仍未休者，雇主應折發工資（施行細則 §24-1）。
                  「應折發」欄位有數字代表該年度有必須發給的天數。
                </p>
              </section>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

const num = (v: string | number | null) => (v == null ? 0 : Math.round(Number(v) * 100) / 100);
