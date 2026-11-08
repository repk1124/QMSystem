/**
 * 報價編輯頁。
 *
 * 跟舊版最大的差別：
 *   1. 客戶從主檔選，不是每次重打。這是「國防醫學大學 / 國防醫學院」
 *      分裂成兩個客戶的根本原因。
 *   2. 版本鎖定時整頁變唯讀，並提供「建立新版本」按鈕。
 *      舊版是客戶簽回之後還能直接改價格。
 *   3. 金額只是即時預覽，存檔時以伺服器重算的為準。
 *   4. PDF 走轉接層餵給原本的 pdfService，蓋章與一頁排版邏輯完全沒動。
 */

import { useState, useEffect, useMemo } from "react";
import { useLocation, useRoute } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  quotations, clients, products as productsApi, companies as companiesApi, ApiError, PERMISSION,
  type ApiQuotation, type ClientSummary,
} from "@/lib/api";
import { useSettings } from "@/context/SettingsContext";
import { loadStampDataUrl } from "@/lib/stampImage";
import QuotationWorkflow from "@/components/QuotationWorkflow";
import {
  toLegacyQuotation, pickVersion, formatMoney,
  STATUS_LABEL, type LegacyLineItem,
} from "@/lib/adapters";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { generateQuotationPDF } from "@/lib/pdfService";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

const TAX_RATE = 0.05;

interface EditableItem extends LegacyLineItem {
  unitCost?: number | null;
}

const emptyItem = (): EditableItem => ({
  id: `new-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
  productName: "", specification: "", quantity: 1, price: 0,
});

export default function QuotationForm() {
  const [, navigate] = useLocation();
  const [matched, params] = useRoute("/quotations/:id");
  // /quotations/new 也會被這個 route 接到（wouter 先比對前面宣告的 /quotations/new，
  // 但直接輸入網址或重新整理時 params.id 可能是 "new"）。
  // Number("new") 是 NaN —— 不擋掉的話會對 /api/quotations/NaN 發出請求。
  const parsedId = params?.id ? Number(params.id) : NaN;
  const quotationId = matched && Number.isInteger(parsedId) && parsedId > 0 ? parsedId : null;

  const { can } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { settings } = useSettings();

  const canWrite = can(PERMISSION.QUOTATION_WRITE);
  const showCost = can(PERMISSION.QUOTATION_VIEW_COST);

  /* ── 表單狀態 ── */
  const [clientId, setClientId] = useState<number | null>(null);
  const [contactId, setContactId] = useState<number | null>(null);
  const [quotationDate, setQuotationDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [validUntil, setValidUntil] = useState("");
  const [subject, setSubject] = useState("");
  const [notes, setNotes] = useState("");
  const [requireSignature, setRequireSignature] = useState(false);
  const [taxAdjustment, setTaxAdjustment] = useState(0);
  const [items, setItems] = useState<EditableItem[]>([emptyItem()]);
  const [generating, setGenerating] = useState(false);

  /* ── 資料 ── */
  const { data: clientList = [] } = useQuery({
    queryKey: ["clients"],
    queryFn: () => clients.list(),
    staleTime: 5 * 60_000,
  });

  const { data: clientDetail } = useQuery({
    queryKey: ["client", clientId],
    queryFn: () => clients.get(clientId!),
    enabled: clientId !== null,
    staleTime: 5 * 60_000,
  });

  // 我方公司主體：新報價用預設公司；PDF 上的我方資料則以系統設定為準
  const { data: companyList = [] } = useQuery({
    queryKey: ["companies"],
    queryFn: () => companiesApi.list(),
    staleTime: 5 * 60_000,
  });
  const defaultCompanyId = companyList.find(c => c.isDefault)?.id ?? companyList[0]?.id ?? null;

  const { data: existing, isLoading } = useQuery({
    queryKey: ["quotation", quotationId],
    queryFn: () => quotations.get(quotationId!),
    enabled: quotationId !== null,
  });

  // 產品主檔：品名欄的自動完成來源。
  // 選到完全一致的品名時，自動帶入規格、建議售價與成本，省去重打。
  const { data: productList = [] } = useQuery({
    queryKey: ["products"],
    queryFn: () => productsApi.list(),
    staleTime: 5 * 60_000,
  });

  const currentVersion = existing ? pickVersion(existing) : null;
  const isLocked = Boolean(currentVersion?.lockedAt);
  const readOnly = !canWrite || isLocked;

  /* 載入既有報價 */
  useEffect(() => {
    if (!existing || !currentVersion) return;
    setClientId(existing.client_id);
    setContactId(currentVersion.clientContactId);
    setQuotationDate(currentVersion.quotationDate);
    setValidUntil(currentVersion.validUntil ?? "");
    setSubject(currentVersion.subject ?? "");
    setNotes(currentVersion.notes ?? "");
    setRequireSignature(currentVersion.requireSignature);
    setTaxAdjustment(Number(currentVersion.taxAdjustment) || 0);
    setItems(currentVersion.items.map((item, index) => ({
      id: String(item.id ?? index),
      productName: item.product_name,
      specification: item.specification ?? "",
      quantity: Number(item.quantity),
      price: Number(item.unit_price),
      unitCost: item.unit_cost == null ? null : Number(item.unit_cost),
    })));
  }, [existing, currentVersion]);

  /* ── 即時預覽的金額。真正算數的是伺服器。 ── */
  const totals = useMemo(() => {
    const subtotal = items.reduce(
      (sum, item) => sum + Math.round((Number(item.quantity) || 0) * (Number(item.price) || 0)), 0);
    const tax = Math.round(subtotal * TAX_RATE) + (Number(taxAdjustment) || 0);
    const cost = items.reduce((sum, item) => item.unitCost == null
      ? sum : sum + Math.round((Number(item.quantity) || 0) * item.unitCost), 0);
    const hasCost = items.some(item => item.unitCost != null);
    return {
      subtotal, tax, total: subtotal + tax,
      cost: hasCost ? cost : null,
      margin: hasCost && subtotal > 0
        ? Math.round(((subtotal - cost) / subtotal) * 1000) / 10 : null,
    };
  }, [items, taxAdjustment]);

  /* ── 送出 ── */
  const buildDraft = () => ({
    clientId: clientId!,
    companyId: existing?.company_id ?? defaultCompanyId ?? 0,
    clientContactId: contactId,
    quotationDate,
    validUntil: validUntil || null,
    subject: subject || null,
    notes: notes || null,
    requireSignature,
    taxAdjustment: Number(taxAdjustment) || 0,
    lineItems: items
      .filter(item => item.productName.trim() || item.quantity > 0 || item.price > 0)
      .map(item => ({
        productName: item.productName.trim() || "(未命名)",
        specification: item.specification || null,
        quantity: Number(item.quantity) || 0,
        unitPrice: Number(item.price) || 0,
        ...(showCost && item.unitCost != null ? { unitCost: item.unitCost } : {}),
      })),
  });

  const handleError = (err: unknown, fallback: string) => {
    toast({
      title: fallback,
      description: err instanceof ApiError ? err.message : "發生未預期的錯誤",
      variant: "destructive",
    });
  };

  const createMutation = useMutation({
    mutationFn: () => quotations.create(buildDraft()),
    onSuccess: result => {
      toast({ title: "已建立", description: result.quotationNumber });
      void queryClient.invalidateQueries({ queryKey: ["quotations"] });
      navigate(`/quotations/${result.id}`);
    },
    onError: err => handleError(err, "建立失敗"),
  });

  const updateMutation = useMutation({
    mutationFn: () => quotations.updateVersion(currentVersion!.id, buildDraft()),
    onSuccess: () => {
      toast({ title: "已儲存" });
      void queryClient.invalidateQueries({ queryKey: ["quotation", quotationId] });
      void queryClient.invalidateQueries({ queryKey: ["quotations"] });
    },
    onError: err => handleError(err, "儲存失敗"),
  });

  const newVersionMutation = useMutation({
    mutationFn: () => quotations.createVersion(quotationId!, buildDraft()),
    onSuccess: result => {
      toast({ title: `已建立第 ${result.versionNumber} 版`, description: "舊版本已鎖定保存" });
      void queryClient.invalidateQueries({ queryKey: ["quotation", quotationId] });
      void queryClient.invalidateQueries({ queryKey: ["quotations"] });
    },
    onError: err => handleError(err, "建立新版本失敗"),
  });

  const save = () => {
    if (!clientId) {
      toast({ title: "請先選擇客戶", variant: "destructive" });
      return;
    }
    if (!items.some(i => i.productName.trim())) {
      toast({ title: "至少要有一個品項", variant: "destructive" });
      return;
    }
    if (!quotationId && !defaultCompanyId) {
      toast({ title: "尚未設定公司主體", description: "請先到系統設定填寫公司資料", variant: "destructive" });
      return;
    }
    if (quotationId) updateMutation.mutate();
    else createMutation.mutate();
  };

  /* ── PDF ── */
  const downloadPdf = async () => {
    if (!existing) return;
    setGenerating(true);
    try {
      // 我方資料來自系統設定；印章（若有上傳）轉成 data URL 蓋在簽章欄
      const company = {
        name: settings?.companyName ?? "",
        address: settings?.companyAddress ?? "",
        taxId: settings?.companyTaxId ?? "",
      };
      const stampImage = settings?.stampUrl ? await loadStampDataUrl(settings.stampUrl) : undefined;
      const legacy = toLegacyQuotation(existing as unknown as ApiQuotation, company);
      await generateQuotationPDF(legacy as never, false, stampImage ? { stampImage } : undefined);
    } catch (err) {
      handleError(err, "PDF 產生失敗");
    } finally {
      setGenerating(false);
    }
  };

  /* ── 品項編輯 ── */
  const updateItem = (index: number, patch: Partial<EditableItem>) => {
    setItems(prev => prev.map((item, i) => i === index ? { ...item, ...patch } : item));
  };

  /** 品名打完（或從自動完成選中）後，若跟主檔完全一致就帶入規格與價格 */
  const applyProductDefaults = (index: number, name: string) => {
    const hit = productList.find(p => p.name === name);
    if (!hit) return;
    setItems(prev => prev.map((item, i) => {
      if (i !== index) return item;
      const next = { ...item };
      // 只補「還空著」的欄位，不覆蓋使用者已經填的內容
      if (!next.specification && hit.specification) next.specification = hit.specification;
      if ((!next.price || next.price === 0) && hit.listPrice != null) {
        next.price = Math.round(Number(hit.listPrice));
      }
      if (next.unitCost == null && hit.costPrice != null) {
        next.unitCost = Math.round(Number(hit.costPrice));
      }
      return next;
    }));
  };
  const addItem = () => setItems(prev => [...prev, emptyItem()]);
  const removeItem = (index: number) => {
    setItems(prev => prev.length === 1 ? [emptyItem()] : prev.filter((_, i) => i !== index));
  };

  if (quotationId && isLoading) {
    return <div className="p-10 text-center text-muted-foreground">載入中…</div>;
  }

  return (
    <div className={readOnly ? "readonly-form space-y-4" : "space-y-4"}>
      {/* 標題列 */}
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">
          {quotationId ? existing?.quotation_number : "新增報價"}
        </h1>
        {currentVersion && (
          <>
            <Badge variant="outline">v{currentVersion.versionNumber}</Badge>
            <Badge>{STATUS_LABEL[currentVersion.status] ?? currentVersion.status}</Badge>
          </>
        )}
        <div className="ml-auto flex gap-2">
          {existing && (
            <Button variant="outline" onClick={downloadPdf} disabled={generating}>
              {generating ? "產生中…" : "下載 PDF"}
            </Button>
          )}
          {!readOnly && (
            <Button onClick={save} disabled={createMutation.isPending || updateMutation.isPending}>
              {quotationId ? "儲存" : "建立報價"}
            </Button>
          )}
          {isLocked && canWrite && (
            <Button onClick={() => newVersionMutation.mutate()} disabled={newVersionMutation.isPending}>
              建立新版本
            </Button>
          )}
        </div>
      </div>

      {/* 鎖定提示 */}
      {isLocked && (
        <Card className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="p-4 text-sm">
            這個版本已於 {new Date(currentVersion!.lockedAt!).toLocaleDateString("zh-TW")} 鎖定
            （狀態：{STATUS_LABEL[currentVersion!.status]}），內容不能再修改。
            <br />
            要調整報價內容請按「建立新版本」—— 目前這一版會保留成「已被新版本取代」，
            這樣客戶手上那份永遠查得到。
          </CardContent>
        </Card>
      )}

      {/* 流程面板：狀態推進、履約進度、簽回檔、歷程 */}
      {existing && (
        <QuotationWorkflow
          quotation={existing as unknown as ApiQuotation}
          canWrite={canWrite}
        />
      )}

      {/* 客戶 */}
      <Card>
        <CardHeader><CardTitle className="text-base">客戶資訊</CardTitle></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>客戶</Label>
            <Select
              value={clientId ? String(clientId) : ""}
              onValueChange={value => { setClientId(Number(value)); setContactId(null); }}
              disabled={readOnly || Boolean(quotationId)}
            >
              <SelectTrigger><SelectValue placeholder="選擇客戶" /></SelectTrigger>
              <SelectContent>
                {clientList.map((client: ClientSummary) => (
                  <SelectItem key={client.id} value={String(client.id)}>
                    {client.name}{client.taxId ? `（${client.taxId}）` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!quotationId && (
              <p className="text-xs text-muted-foreground">
                找不到客戶？請先到客戶主檔建立，不要直接打在報價上。
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>聯絡人</Label>
            <Select
              value={contactId ? String(contactId) : ""}
              onValueChange={value => setContactId(Number(value))}
              disabled={readOnly || !clientDetail}
            >
              <SelectTrigger><SelectValue placeholder="選擇聯絡人" /></SelectTrigger>
              <SelectContent>
                {(clientDetail?.contacts ?? []).map(contact => (
                  <SelectItem key={contact.id} value={String(contact.id)}>
                    {contact.name}{contact.title ? ` ${contact.title}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>報價日期</Label>
            <Input type="date" value={quotationDate} disabled={readOnly}
              onChange={e => setQuotationDate(e.target.value)} />
          </div>

          <div className="space-y-2">
            <Label>有效期限</Label>
            <Input type="date" value={validUntil} disabled={readOnly}
              onChange={e => setValidUntil(e.target.value)} />
          </div>

          <div className="space-y-2 sm:col-span-2">
            <Label>報價主旨</Label>
            <Input value={subject} disabled={readOnly}
              onChange={e => setSubject(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      {/* 品項 */}
      <Card>
        <CardHeader><CardTitle className="text-base">報價項目</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-48">品名</TableHead>
                <TableHead>規格</TableHead>
                <TableHead className="w-24 text-right">數量</TableHead>
                <TableHead className="w-32 text-right">單價</TableHead>
                {showCost && <TableHead className="w-32 text-right">成本</TableHead>}
                <TableHead className="w-32 text-right">小計</TableHead>
                {!readOnly && <TableHead className="w-12" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item, index) => (
                <TableRow key={item.id}>
                  <TableCell>
                    <Input value={item.productName} disabled={readOnly}
                      list="product-name-options"
                      onChange={e => {
                        updateItem(index, { productName: e.target.value });
                        applyProductDefaults(index, e.target.value);
                      }} />
                  </TableCell>
                  <TableCell>
                    <Textarea
                      rows={2}
                      className="min-h-[38px]"
                      value={item.specification}
                      disabled={readOnly}
                      onChange={e => updateItem(index, { specification: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Input type="number" min={0} className="text-right"
                      value={item.quantity} disabled={readOnly}
                      onChange={e => updateItem(index, { quantity: Number(e.target.value) })} />
                  </TableCell>
                  <TableCell>
                    <Input type="number" min={0} className="text-right"
                      value={item.price} disabled={readOnly}
                      onChange={e => updateItem(index, { price: Number(e.target.value) })} />
                  </TableCell>
                  {showCost && (
                    <TableCell>
                      <Input type="number" min={0} className="text-right"
                        placeholder="—"
                        value={item.unitCost ?? ""} disabled={readOnly}
                        onChange={e => updateItem(index, {
                          unitCost: e.target.value === "" ? null : Number(e.target.value),
                        })} />
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums">
                    {formatMoney((Number(item.quantity) || 0) * (Number(item.price) || 0))}
                  </TableCell>
                  {!readOnly && (
                    <TableCell>
                      <Button size="sm" variant="ghost" onClick={() => removeItem(index)}>✕</Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {!readOnly && (
            <Button variant="outline" size="sm" onClick={addItem}>新增一列</Button>
          )}

          {/* 品名自動完成選項（原生 datalist，不擋自由輸入） */}
          <datalist id="product-name-options">
            {productList.map(p => (
              <option key={p.id} value={p.name}>
                {p.listPrice != null ? `${p.sku}｜建議售價 ${Math.round(Number(p.listPrice)).toLocaleString("zh-TW")}` : p.sku}
              </option>
            ))}
          </datalist>

          <div className="ml-auto w-full max-w-xs space-y-1 pt-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">小計（未稅）</span>
              <span className="tabular-nums">{formatMoney(totals.subtotal)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">營業稅 5%</span>
              <span className="tabular-nums">{formatMoney(totals.tax)}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">稅額調整</span>
              <Input
                type="number" className="h-8 w-24 text-right"
                value={taxAdjustment} disabled={readOnly}
                onChange={e => setTaxAdjustment(Number(e.target.value) || 0)}
              />
            </div>
            <div className="flex justify-between border-t pt-1 font-semibold">
              <span>總計</span>
              <span className="tabular-nums">{formatMoney(totals.total)}</span>
            </div>
            {showCost && totals.margin != null && (
              <div className="flex justify-between text-muted-foreground">
                <span>毛利率</span>
                <span className="tabular-nums">{totals.margin}%</span>
              </div>
            )}
            <p className="pt-1 text-xs text-muted-foreground">
              以上為即時預覽，存檔時由伺服器重新計算為準。
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 備註 */}
      <Card>
        <CardHeader><CardTitle className="text-base">備註與條款</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            rows={8} value={notes} disabled={readOnly}
            placeholder={"每行一項，系統會自動編號。\n例如：\n單價以新台幣計，未稅。\n報價有效期限 30 天。"}
            onChange={e => setNotes(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <Checkbox
              id="require-signature"
              checked={requireSignature}
              disabled={readOnly}
              onCheckedChange={checked => setRequireSignature(checked === true)}
            />
            <Label htmlFor="require-signature" className="font-normal">
              需要客戶簽回（不勾選時印章會蓋在備註區右側，不另留簽名欄）
            </Label>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
