/**
 * 客戶主檔。
 *
 * 舊系統沒有這一頁 —— 客戶資料直接重打在每張報價上，造成
 * 同一個單位分裂成多筆（國防醫學大學 / 國防醫學院，統編都是 04189271）、
 * 客戶代號每張報價各生一組、多個聯絡人無處可放。
 *
 * 這裡的重點功能：
 *   - 統編重複時擋下並指出已存在的客戶
 *   - 更名保留時間軸（歷史報價印當時名稱，發票用現行名稱）
 *   - 一個客戶多個聯絡人
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { clients, ApiError, PERMISSION, type ClientSummary } from "@/lib/api";
import { formatMoney } from "@/lib/adapters";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/hooks/use-toast";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

const CATEGORY_LABEL: Record<string, string> = {
  government: "政府機關",
  school: "學校",
  hospital: "醫療院所",
  company: "企業",
};

export default function Clients() {
  const { can } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = can(PERMISSION.CLIENT_WRITE);

  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<number | null>(null);

  const { data: list = [], isLoading } = useQuery({
    queryKey: ["clients", search],
    queryFn: () => clients.list(search || undefined),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["clients"] });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">客戶主檔</h1>
        <span className="text-sm text-muted-foreground">共 {list.length} 家</span>
        {canWrite && (
          <Button className="ml-auto" onClick={() => setCreating(true)}>新增客戶</Button>
        )}
      </div>

      <Card>
        <CardContent className="p-4">
          <Input
            className="max-w-sm"
            placeholder="搜尋名稱、代號、統編或舊名稱"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>代號</TableHead>
                <TableHead>名稱</TableHead>
                <TableHead>統一編號</TableHead>
                <TableHead>類型</TableHead>
                <TableHead className="text-right">報價數</TableHead>
                <TableHead className="text-right">成交金額</TableHead>
                <TableHead className="text-right">聯絡人</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">載入中…</TableCell></TableRow>
              )}
              {!isLoading && list.length === 0 && (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">沒有符合的客戶</TableCell></TableRow>
              )}
              {list.map((client: ClientSummary) => (
                <TableRow
                  key={client.id}
                  className="cursor-pointer"
                  onClick={() => setDetailId(client.id)}
                >
                  <TableCell className="font-mono text-sm">{client.code}</TableCell>
                  <TableCell>
                    {client.name}
                    {client.aliases.length > 0 && (
                      <div className="text-xs text-muted-foreground">
                        舊名稱：{client.aliases.join("、")}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-sm">{client.taxId ?? "—"}</TableCell>
                  <TableCell>
                    {client.category && (
                      <Badge variant="outline">{CATEGORY_LABEL[client.category] ?? client.category}</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{client.quotationCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatMoney(client.wonAmount)}</TableCell>
                  <TableCell className="text-right tabular-nums">{client.contactCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <CreateClientDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={() => { setCreating(false); refresh(); }}
      />

      {detailId !== null && (
        <ClientDetailDialog
          clientId={detailId}
          canWrite={canWrite}
          onClose={() => setDetailId(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

/* ── 新增客戶 ─────────────────────────────────────────── */

function CreateClientDialog({
  open, onClose, onCreated,
}: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [taxId, setTaxId] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [category, setCategory] = useState("government");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => clients.create({
      name: name.trim(),
      taxId: taxId.trim() || undefined,
      address: address.trim() || undefined,
      phone: phone.trim() || undefined,
      category,
    }),
    onSuccess: () => {
      toast({ title: "已建立客戶" });
      setName(""); setTaxId(""); setAddress(""); setPhone(""); setError(null);
      onCreated();
    },
    onError: (err: unknown) => {
      // 統編重複時伺服器會回「已經是客戶『國防醫學院』…請改用更名功能」，
      // 這句直接顯示比自己重寫清楚
      setError(err instanceof ApiError ? err.message : "建立失敗");
    },
  });

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增客戶</DialogTitle>
          <DialogDescription>
            同一個統一編號只能有一個客戶。如果是既有客戶改名，請用該客戶的「更名」功能，
            不要另外新增一筆。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label>客戶名稱</Label>
            <Input value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-2">
            <Label>統一編號</Label>
            <Input
              value={taxId} maxLength={8} inputMode="numeric"
              placeholder="8 位數字"
              onChange={e => setTaxId(e.target.value.replace(/\D/g, ""))}
            />
            <p className="text-xs text-muted-foreground">
              會驗證檢查碼。政府機關與學校也有統編。
            </p>
          </div>
          <div className="space-y-2">
            <Label>類型</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {Object.entries(CATEGORY_LABEL).map(([value, label]) => (
                  <SelectItem key={value} value={value}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>地址</Label>
            <Input value={address} onChange={e => setAddress(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>電話</Label>
            <Input value={phone} onChange={e => setPhone(e.target.value)} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            onClick={() => { setError(null); mutation.mutate(); }}
            disabled={!name.trim() || mutation.isPending}
          >
            建立
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ── 客戶詳細 ─────────────────────────────────────────── */

function ClientDetailDialog({
  clientId, canWrite, onClose, onChanged,
}: { clientId: number; canWrite: boolean; onClose: () => void; onChanged: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState("");
  const [effectiveFrom, setEffectiveFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [contactName, setContactName] = useState("");
  const [contactTitle, setContactTitle] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["client", clientId],
    queryFn: () => clients.get(clientId),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["client", clientId] });
    onChanged();
  };

  const onError = (err: unknown, title: string) => toast({
    title, description: err instanceof ApiError ? err.message : "發生錯誤",
    variant: "destructive",
  });

  const renameMutation = useMutation({
    mutationFn: () => clients.rename(clientId, newName.trim(), { effectiveFrom }),
    onSuccess: result => {
      toast({
        title: "已更名",
        description: `${result.from} → ${result.to}（${result.effectiveFrom} 起生效）`,
      });
      setRenaming(false); setNewName(""); refresh();
    },
    onError: err => onError(err, "更名失敗"),
  });

  const contactMutation = useMutation({
    mutationFn: () => clients.addContact(clientId, {
      name: contactName.trim(),
      title: contactTitle.trim() || undefined,
      email: contactEmail.trim() || undefined,
      phone: contactPhone.trim() || undefined,
    }),
    onSuccess: () => {
      toast({ title: "已新增聯絡人" });
      setContactName(""); setContactTitle(""); setContactEmail(""); setContactPhone("");
      refresh();
    },
    onError: err => onError(err, "新增聯絡人失敗"),
  });

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        {isLoading || !data ? (
          <div className="py-10 text-center text-muted-foreground">載入中…</div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                {data.name}
                <span className="font-mono text-sm font-normal text-muted-foreground">
                  {data.code}
                </span>
              </DialogTitle>
              <DialogDescription>
                統一編號 {data.taxId ?? "未填"} · {data.quotationCount} 張報價
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-6">
              {/* 名稱時間軸 */}
              {data.nameHistory.length > 1 && (
                <section>
                  <h3 className="mb-2 text-sm font-medium">名稱沿革</h3>
                  <div className="space-y-1 text-sm">
                    {data.nameHistory.map(entry => (
                      <div key={entry.name} className="flex items-center gap-2">
                        <span className="font-medium">{entry.name}</span>
                        <span className="text-muted-foreground">
                          {entry.validFrom ?? "—"} ～ {entry.validUntil ?? "現在"}
                        </span>
                        {!entry.validUntil && <Badge variant="outline">現行</Badge>}
                      </div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    歷史報價會印當時的名稱；開發票時用現行名稱。
                  </p>
                </section>
              )}

              {/* 更名 */}
              {canWrite && (
                <section>
                  {!renaming ? (
                    <Button variant="outline" size="sm" onClick={() => { setRenaming(true); setNewName(data.name); }}>
                      客戶更名
                    </Button>
                  ) : (
                    <div className="space-y-3 rounded-md border p-3">
                      <div className="space-y-2">
                        <Label>新名稱</Label>
                        <Input value={newName} onChange={e => setNewName(e.target.value)} />
                      </div>
                      <div className="space-y-2">
                        <Label>生效日期</Label>
                        <Input type="date" value={effectiveFrom}
                          onChange={e => setEffectiveFrom(e.target.value)} />
                        <p className="text-xs text-muted-foreground">
                          這個日期之前的報價仍會顯示舊名稱。
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => renameMutation.mutate()}
                          disabled={!newName.trim() || renameMutation.isPending}>
                          確認更名
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>取消</Button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {/* 聯絡人 */}
              <section>
                <h3 className="mb-2 text-sm font-medium">聯絡人（{data.contacts.length}）</h3>
                <div className="space-y-1">
                  {data.contacts.length === 0 && (
                    <p className="text-sm text-muted-foreground">還沒有聯絡人。</p>
                  )}
                  {data.contacts.map(contact => (
                    <div key={contact.id} className="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-2 text-sm">
                      <span className="font-medium">{contact.name}</span>
                      {contact.title && <span className="text-muted-foreground">{contact.title}</span>}
                      {contact.isPrimary && <Badge variant="outline">主要</Badge>}
                      <span className="ml-auto text-xs text-muted-foreground">
                        {[contact.email, contact.phone].filter(Boolean).join(" · ")}
                      </span>
                    </div>
                  ))}
                </div>

                {canWrite && (
                  <div className="mt-3 grid gap-2 rounded-md border p-3 sm:grid-cols-2">
                    <Input placeholder="姓名" value={contactName}
                      onChange={e => setContactName(e.target.value)} />
                    <Input placeholder="職稱（選填）" value={contactTitle}
                      onChange={e => setContactTitle(e.target.value)} />
                    <Input placeholder="Email（選填）" value={contactEmail}
                      onChange={e => setContactEmail(e.target.value)} />
                    <Input placeholder="電話（選填）" value={contactPhone}
                      onChange={e => setContactPhone(e.target.value)} />
                    <Button
                      size="sm" className="sm:col-span-2"
                      onClick={() => contactMutation.mutate()}
                      disabled={!contactName.trim() || contactMutation.isPending}
                    >
                      新增聯絡人
                    </Button>
                  </div>
                )}
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
