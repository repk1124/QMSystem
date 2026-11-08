/** 產品品項庫。成本價是這裡的重點 —— 市售報價 SaaS 都沒有這個欄位。 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { products, ApiError, PERMISSION, type ProductRow } from "@/lib/api";
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

const TYPE_LABEL: Record<string, string> = { sale: "銷售", rental: "租賃", service: "服務" };

export default function Products() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const canWrite = can(PERMISSION.SYSTEM_ADMIN) || can("product:write");
  const showCost = can(PERMISSION.QUOTATION_VIEW_COST);

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<ProductRow | null>(null);
  const [creating, setCreating] = useState(false);

  const { data = [], isLoading } = useQuery({
    queryKey: ["products", search],
    queryFn: () => products.list(search || undefined),
  });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["products"] });
  const missingCost = data.filter(p => p.costPrice == null).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">產品品項</h1>
        <span className="text-sm text-muted-foreground">共 {data.length} 項</span>
        {canWrite && <Button className="ml-auto" onClick={() => setCreating(true)}>新增品項</Button>}
      </div>

      {showCost && missingCost > 0 && (
        <Card className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="p-4 text-sm">
            有 {missingCost} 項還沒有成本價。這些品項在報價時算不出毛利 ——
            舊系統沒有成本欄位，所以從歷史報價匯進來的品項成本都是空的，需要人工補。
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4">
          <Input className="max-w-sm" placeholder="搜尋品名或編號"
            value={search} onChange={e => setSearch(e.target.value)} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>編號</TableHead>
                <TableHead>品名</TableHead>
                <TableHead>類型</TableHead>
                {showCost && <TableHead className="text-right">成本</TableHead>}
                <TableHead className="text-right">建議售價</TableHead>
                {showCost && <TableHead className="text-right">毛利率</TableHead>}
                <TableHead className="text-right">使用次數</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">載入中…</TableCell></TableRow>
              )}
              {data.map(p => {
                const cost = p.costPrice == null ? null : Number(p.costPrice);
                const price = p.listPrice == null ? null : Number(p.listPrice);
                const margin = cost != null && price != null && price > 0
                  ? Math.round(((price - cost) / price) * 1000) / 10 : null;
                return (
                  <TableRow key={p.id} className={canWrite ? "cursor-pointer" : ""}
                    onClick={() => canWrite && setEditing(p)}>
                    <TableCell className="font-mono text-sm">{p.sku}</TableCell>
                    <TableCell>
                      {p.name}
                      {p.specification && (
                        <div className="max-w-md truncate text-xs text-muted-foreground">
                          {p.specification.split("\n")[0]}
                        </div>
                      )}
                    </TableCell>
                    <TableCell><Badge variant="outline">{TYPE_LABEL[p.productType] ?? p.productType}</Badge></TableCell>
                    {showCost && (
                      <TableCell className="text-right tabular-nums">
                        {cost == null ? <span className="text-muted-foreground">未填</span> : formatMoney(cost)}
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">
                      {price == null ? "—" : formatMoney(price)}
                    </TableCell>
                    {showCost && (
                      <TableCell className="text-right tabular-nums">
                        {margin == null ? "—" : `${margin}%`}
                      </TableCell>
                    )}
                    <TableCell className="text-right tabular-nums">{p.usageCount}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {(creating || editing) && (
        <ProductDialog
          product={editing}
          onClose={() => { setCreating(false); setEditing(null); }}
          onDone={() => { setCreating(false); setEditing(null); refresh(); }}
        />
      )}
    </div>
  );
}

function ProductDialog({
  product, onClose, onDone,
}: { product: ProductRow | null; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(product?.name ?? "");
  const [specification, setSpecification] = useState(product?.specification ?? "");
  const [unit, setUnit] = useState(product?.unit ?? "式");
  const [costPrice, setCostPrice] = useState(product?.costPrice ?? "");
  const [listPrice, setListPrice] = useState(product?.listPrice ?? "");
  const [productType, setProductType] = useState(product?.productType ?? "sale");
  const [error, setError] = useState<string | null>(null);

  const payload = () => ({
    name: name.trim(), specification: specification || undefined, unit: unit || undefined,
    costPrice: costPrice === "" ? null : Number(costPrice),
    listPrice: listPrice === "" ? null : Number(listPrice),
    productType,
  });

  const mutation = useMutation({
    mutationFn: () => product
      ? products.update(product.id, payload() as never)
      : products.create(payload() as never),
    onSuccess: () => { toast({ title: product ? "已更新" : "已建立" }); onDone(); },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : "儲存失敗"),
  });

  const margin = costPrice !== "" && listPrice !== "" && Number(listPrice) > 0
    ? Math.round(((Number(listPrice) - Number(costPrice)) / Number(listPrice)) * 1000) / 10
    : null;

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{product ? `編輯 ${product.sku}` : "新增品項"}</DialogTitle>
          <DialogDescription>
            成本價只有具備成本檢視權限的人看得到，不會出現在給客戶的報價單上。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label>品名</Label>
            <Input value={name} onChange={e => setName(e.target.value)} autoFocus />
          </div>
          <div className="space-y-2">
            <Label>預設規格</Label>
            <Textarea rows={4} value={specification} onChange={e => setSpecification(e.target.value)}
              placeholder="報價時可以再改。每行一項會自動編號。" />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-2">
              <Label>類型</Label>
              <Select value={productType} onValueChange={setProductType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_LABEL).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>成本</Label>
              <Input type="number" min={0} value={costPrice}
                onChange={e => setCostPrice(e.target.value)} placeholder="未填" />
            </div>
            <div className="space-y-2">
              <Label>建議售價</Label>
              <Input type="number" min={0} value={listPrice}
                onChange={e => setListPrice(e.target.value)} />
            </div>
          </div>
          {margin != null && (
            <p className="text-sm text-muted-foreground">毛利率 {margin}%</p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => { setError(null); mutation.mutate(); }}
            disabled={!name.trim() || mutation.isPending}>儲存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
