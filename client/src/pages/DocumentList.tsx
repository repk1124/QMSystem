/**
 * 檔案總覽。
 *
 * 舊系統的「文件管理」其實只是把報價上的一個網址欄位列出來 ——
 * 不知道檔案多大、誰上傳的、什麼時候、有沒有被掛到多張單據上。
 *
 * 這一頁以「檔案」為主體，列出每個檔案被掛到哪些單據，
 * 同一份檔案掛超過一處的會標紅字。
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { documentLibrary, type DocumentRow } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const KIND_LABEL: Record<string, string> = {
  signed_quotation: "報價簽回", contract: "合約", attachment: "附件",
  stamp: "印章", logo: "商標", invoice: "發票",
};

const ENTITY_LABEL: Record<string, string> = {
  quotation: "報價", contract: "合約", order: "訂單", invoice: "發票", employee: "員工",
};

const size = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

export default function DocumentList() {
  const [search, setSearch] = useState("");
  const { data = [], isLoading } = useQuery({
    queryKey: ["documents"], queryFn: () => documentLibrary.list(),
  });

  const filtered = search
    ? data.filter(d =>
        d.filename.toLowerCase().includes(search.toLowerCase()) ||
        d.links.some(l => l.label?.toLowerCase().includes(search.toLowerCase())))
    : data;

  const multiLinked = data.filter(d => d.links.length > 1).length;
  const orphans = data.filter(d => d.links.length === 0).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">檔案總覽</h1>
        <span className="text-sm text-muted-foreground">共 {data.length} 個</span>
      </div>

      {(multiLinked > 0 || orphans > 0) && (
        <Card className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
          <CardContent className="p-4 text-sm">
            {multiLinked > 0 && <>有 {multiLinked} 個檔案被掛在多張單據上。</>}
            {orphans > 0 && <>有 {orphans} 個檔案沒有掛在任何單據上（孤兒檔）。</>}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-4">
          <Input className="max-w-sm" placeholder="搜尋檔名或單號"
            value={search} onChange={e => setSearch(e.target.value)} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>檔名</TableHead>
                <TableHead>類型</TableHead>
                <TableHead className="text-right">大小</TableHead>
                <TableHead>掛在哪些單據</TableHead>
                <TableHead>上傳者</TableHead>
                <TableHead>上傳時間</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">載入中…</TableCell></TableRow>
              )}
              {!isLoading && filtered.length === 0 && (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">沒有符合的檔案</TableCell></TableRow>
              )}
              {filtered.map((doc: DocumentRow) => (
                <TableRow key={doc.id}>
                  <TableCell className="max-w-xs">
                    <div className="truncate" title={doc.filename}>{doc.filename}</div>
                    <div className="font-mono text-[10px] text-muted-foreground" title={doc.sha256}>
                      {doc.sha256.slice(0, 16)}
                    </div>
                  </TableCell>
                  <TableCell><Badge variant="outline">{KIND_LABEL[doc.kind] ?? doc.kind}</Badge></TableCell>
                  <TableCell className="text-right tabular-nums text-sm">{size(doc.byteSize)}</TableCell>
                  <TableCell>
                    {doc.links.length === 0 && (
                      <span className="text-xs text-muted-foreground">未掛載</span>
                    )}
                    <div className="flex flex-wrap gap-1">
                      {doc.links.map(link => (
                        <Badge
                          key={link.linkId}
                          variant={link.status === "suspect" ? "destructive"
                            : link.status === "verified" ? "default" : "outline"}
                          className="font-mono text-[11px] font-normal"
                          title={link.status === "suspect" ? "疑似掛錯" : undefined}
                        >
                          {ENTITY_LABEL[link.entityType] ?? link.entityType}
                          {" "}{link.label ?? `#${link.entityId}`}
                        </Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{doc.uploadedBy ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(doc.uploadedAt).toLocaleDateString("zh-TW")}
                  </TableCell>
                  <TableCell>
                    <a className="text-sm underline underline-offset-2"
                      href={`/api/documents/${doc.id}/download`} target="_blank" rel="noreferrer">
                      下載
                    </a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
