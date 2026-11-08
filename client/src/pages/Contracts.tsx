/**
 * 合約。
 *
 * 舊系統把合約內容塞在報價單的一個欄位裡 —— 合約沒有編號、沒有起訖日、
 * 沒有狀態，查不到哪些還在期限內。
 * 對租賃業務尤其致命：不知道「哪台設備租給誰、租到什麼時候」。
 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  contracts, templates, quotations, ApiError, PERMISSION,
  CONTRACT_STATUS_LABEL, CONTRACT_TYPE_LABEL, type ContractRow,
  companies as companiesApi,
} from "@/lib/api";
import { formatMoney } from "@/lib/adapters";
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

export default function Contracts() {
  const { can } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = can(PERMISSION.QUOTATION_WRITE);

  const [status, setStatus] = useState("all");
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data = [], isLoading } = useQuery({
    queryKey: ["contracts", status],
    queryFn: () => contracts.list({ status: status === "all" ? undefined : status }),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["contracts"] });
  const expiringSoon = data.filter(c =>
    c.endDate && ["signed", "active"].includes(c.status) &&
    c.endDate <= addDays(new Date().toISOString().slice(0, 10), 60));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">合約</h1>
        <span className="text-sm text-muted-foreground">共 {data.length} 份</span>
        <div className="ml-auto flex gap-2">
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部狀態</SelectItem>
              {Object.entries(CONTRACT_STATUS_LABEL).map(([v, l]) => (
                <SelectItem key={v} value={v}>{l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canWrite && <Button onClick={() => setCreating(true)}>從報價建立合約</Button>}
        </div>
      </div>

      {expiringSoon.length > 0 && (
        <Card className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="p-4 text-sm">
            有 {expiringSoon.length} 份合約將在 60 天內到期：
            {expiringSoon.map(c => `${c.clientName}（${c.endDate}）`).join("、")}
            。租賃合約記得提前談續約。
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>合約編號</TableHead>
                <TableHead>客戶</TableHead>
                <TableHead>類型</TableHead>
                <TableHead>期間</TableHead>
                <TableHead className="text-right">金額</TableHead>
                <TableHead>狀態</TableHead>
                <TableHead>來源報價</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">載入中…</TableCell></TableRow>
              )}
              {!isLoading && data.length === 0 && (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                  還沒有合約。可以從已接受的報價建立。
                </TableCell></TableRow>
              )}
              {data.map((c: ContractRow) => (
                <TableRow key={c.id} className="cursor-pointer" onClick={() => setDetailId(c.id)}>
                  <TableCell className="font-mono text-sm">
                    {c.contractNumber}
                    {c.locked && <span className="ml-1 text-xs" title="已鎖定">🔒</span>}
                  </TableCell>
                  <TableCell>{c.clientName}</TableCell>
                  <TableCell><Badge variant="outline">{CONTRACT_TYPE_LABEL[c.contractType] ?? c.contractType}</Badge></TableCell>
                  <TableCell className="text-sm">
                    {c.startDate ?? "—"} ～ <span className={c.pastDue ? "text-destructive" : ""}>{c.endDate ?? "—"}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {c.totalAmount ? formatMoney(c.totalAmount) : "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant={
                      c.status === "active" || c.status === "signed" ? "default"
                      : c.status === "terminated" || c.status === "voided" ? "secondary"
                      : c.status === "expired" ? "destructive" : "outline"
                    }>{CONTRACT_STATUS_LABEL[c.status] ?? c.status}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {c.quotationNumber ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {creating && <CreateFromQuotation onClose={() => setCreating(false)}
        onDone={() => { setCreating(false); refresh(); }} />}
      {detailId !== null && <ContractDetail contractId={detailId} canWrite={canWrite}
        onClose={() => setDetailId(null)} onChanged={refresh} />}
    </div>
  );
}

function addDays(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function CreateFromQuotation({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [quotationId, setQuotationId] = useState<number | null>(null);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 只有客戶已接受的報價才適合轉合約
  const { data: quotationList } = useQuery({
    queryKey: ["quotations", { status: "accepted" }],
    queryFn: () => quotations.list({ status: "accepted", limit: 100 }),
  });
  const { data: templateList = [] } = useQuery({
    queryKey: ["templates"], queryFn: () => templates.list(),
  });
  const { data: companyList = [] } = useQuery({
    queryKey: ["companies"], queryFn: () => companiesApi.list(), staleTime: 5 * 60_000,
  });
  const defaultCompanyId = companyList.find(c => c.isDefault)?.id ?? companyList[0]?.id ?? 0;

  const { data: preview, isFetching } = useQuery({
    queryKey: ["contract-preview", quotationId, templateId],
    queryFn: () => contracts.preview(quotationId!, templateId!),
    enabled: quotationId != null && templateId != null,
  });

  // 預覽回來就帶進編輯框，之後使用者可以自己改
  if (preview && content === "" ) setContent(preview.content);

  const selected = quotationList?.items.find(q => q.id === quotationId);

  const mutation = useMutation({
    mutationFn: () => contracts.create({
      clientId: selected!.clientId, companyId: defaultCompanyId, quotationId,
      templateId, contractType: templateList.find(t => t.id === templateId)?.templateType ?? "custom",
      title: title.trim() || selected!.subject || selected!.quotationNumber,
      content, startDate: startDate || null, endDate: endDate || null,
      totalAmount: selected ? Number(selected.totalAmount) : null,
    }),
    onSuccess: r => { toast({ title: "已建立合約", description: r.contract_number }); onDone(); },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : "建立失敗"),
  });

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>從報價建立合約</DialogTitle>
          <DialogDescription>
            套用範本後的內容會存成合約自己的一份。之後範本改了，已簽的合約不會跟著變。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label>來源報價（限已接受）</Label>
              <Select value={quotationId ? String(quotationId) : ""}
                onValueChange={v => { setQuotationId(Number(v)); setContent(""); }}>
                <SelectTrigger><SelectValue placeholder="選擇報價" /></SelectTrigger>
                <SelectContent>
                  {(quotationList?.items ?? []).map(q => (
                    <SelectItem key={q.id} value={String(q.id)}>
                      {q.quotationNumber} — {q.clientName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>合約範本</Label>
              <Select value={templateId ? String(templateId) : ""}
                onValueChange={v => { setTemplateId(Number(v)); setContent(""); }}>
                <SelectTrigger><SelectValue placeholder="選擇範本" /></SelectTrigger>
                <SelectContent>
                  {templateList.map(t => (
                    <SelectItem key={t.id} value={String(t.id)}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {preview && preview.missing.length > 0 && (
            <Card className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
              <CardContent className="p-3 text-sm">
                有 {preview.missing.length} 個欄位沒有資料，內容裡會保留 {"{變數名}"} 原樣：
                <span className="font-mono"> {preview.missing.join(", ")}</span>
                <div className="mt-1 text-xs text-muted-foreground">
                  請在下面的內容框直接補上，或先回去把報價的相關欄位填好。
                </div>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2 sm:col-span-1">
              <Label>合約標題</Label>
              <Input value={title} onChange={e => setTitle(e.target.value)}
                placeholder={selected?.subject ?? ""} />
            </div>
            <div className="space-y-2">
              <Label>開始日</Label>
              <Input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label>結束日</Label>
              <Input type="date" value={endDate} onChange={e => setEndDate(e.target.value)} />
            </div>
          </div>

          <div className="space-y-2">
            <Label>合約內容{isFetching && <span className="ml-2 text-xs text-muted-foreground">套用中…</span>}</Label>
            <Textarea rows={16} className="font-mono text-xs"
              value={content} onChange={e => setContent(e.target.value)} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => { setError(null); mutation.mutate(); }}
            disabled={!quotationId || !content.trim() || mutation.isPending}>建立合約</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ContractDetail({
  contractId, canWrite, onClose, onChanged,
}: { contractId: number; canWrite: boolean; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [uploading, setUploading] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["contract", contractId], queryFn: () => contracts.get(contractId),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["contract", contractId] });
    onChanged();
  };
  const onError = (err: unknown, title: string) => toast({
    title, description: err instanceof ApiError ? err.message : "發生錯誤", variant: "destructive",
  });

  const setStatus = useMutation({
    mutationFn: (status: string) => contracts.setStatus(contractId, status),
    onSuccess: () => { toast({ title: "狀態已更新" }); refresh(); },
    onError: err => onError(err, "狀態變更失敗"),
  });

  const upload = useMutation({
    mutationFn: (file: File) => contracts.uploadDocument(contractId, file),
    onSuccess: result => {
      toast({
        title: "已上傳",
        description: result.suspect
          ? `注意：這份檔案也掛在 ${result.conflictsWith.join("、")}`
          : undefined,
        variant: result.suspect ? "destructive" : undefined,
      });
      refresh();
    },
    onError: err => onError(err, "上傳失敗"),
    onSettled: () => setUploading(false),
  });

  const NEXT: Record<string, string[]> = {
    draft: ["sent", "signed", "voided"],
    sent: ["signed", "voided"],
    signed: ["active", "terminated"],
    active: ["expired", "terminated"],
    expired: ["terminated"],
  };

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        {isLoading || !data ? (
          <div className="py-10 text-center text-muted-foreground">載入中…</div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex flex-wrap items-center gap-2">
                {data.title}
                <span className="font-mono text-sm font-normal text-muted-foreground">
                  {data.contract_number}
                </span>
                <Badge>{CONTRACT_STATUS_LABEL[data.status] ?? data.status}</Badge>
              </DialogTitle>
              <DialogDescription>
                {data.client_name} · {data.start_date ?? "—"} ～ {data.end_date ?? "—"}
                {data.quotation_number && ` · 來自 ${data.quotation_number}`}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              {data.locked_at && (
                <Card className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
                  <CardContent className="p-3 text-sm">
                    這份合約已於 {new Date(data.locked_at).toLocaleDateString("zh-TW")} 鎖定，
                    內容不能再修改。已簽署的合約要調整，法律上應該簽補充協議，
                    而不是改原本那份。
                  </CardContent>
                </Card>
              )}

              {canWrite && NEXT[data.status]?.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {NEXT[data.status].map(next => (
                    <Button key={next} size="sm" variant="outline"
                      onClick={() => setStatus.mutate(next)} disabled={setStatus.isPending}>
                      標記為{CONTRACT_STATUS_LABEL[next]}
                    </Button>
                  ))}
                </div>
              )}

              <section>
                <h3 className="mb-2 text-sm font-medium">簽署文件（{data.documents.length}）</h3>
                {data.documents.length === 0 && (
                  <p className="text-sm text-muted-foreground">還沒有上傳簽署後的合約。</p>
                )}
                {data.documents.map(doc => (
                  <div key={doc.id} className="flex items-center gap-2 rounded-md bg-muted/40 p-2 text-sm">
                    <span className="truncate">{doc.filename}</span>
                    <span className="text-xs text-muted-foreground">
                      {(doc.byteSize / 1024).toFixed(0)} KB
                    </span>
                    <a className="ml-auto text-xs underline underline-offset-2"
                      href={`/api/documents/${doc.id}/download`} target="_blank" rel="noreferrer">下載</a>
                  </div>
                ))}
                {canWrite && (
                  <div className="mt-2">
                    <Input type="file" accept="application/pdf,image/*" disabled={uploading}
                      onChange={e => {
                        const file = e.target.files?.[0];
                        if (file) { setUploading(true); upload.mutate(file); }
                        e.target.value = "";
                      }} />
                  </div>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-sm font-medium">合約內容</h3>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs">
                  {data.content}
                </pre>
              </section>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onClose}>關閉</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
