/** 稽核紀錄。誰在什麼時候改了什麼。 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { audit } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ACTION_LABEL: Record<string, string> = {
  create: "建立", update: "修改", delete: "刪除",
  status_change: "狀態變更", fulfillment_change: "履約變更",
  new_version: "建立新版本", rename: "更名", verify: "確認",
  login: "登入", import: "資料匯入",
};

const ENTITY_LABEL: Record<string, string> = {
  quotation: "報價", quotation_version: "報價版本", client: "客戶",
  client_contact: "客戶聯絡人", document: "檔案", document_link: "檔案關聯",
  user: "使用者", product: "品項", leave_request: "請假", import_batch: "匯入批次",
};

export default function AuditLog() {
  const [entityType, setEntityType] = useState("all");

  const { data = [], isLoading } = useQuery({
    queryKey: ["audit", entityType],
    queryFn: () => audit.list({
      limit: 200,
      entityType: entityType === "all" ? undefined : entityType,
    }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">稽核紀錄</h1>
        <span className="text-sm text-muted-foreground">最近 {data.length} 筆</span>
        <Select value={entityType} onValueChange={setEntityType}>
          <SelectTrigger className="ml-auto w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部類型</SelectItem>
            {Object.entries(ENTITY_LABEL).map(([v, l]) => (
              <SelectItem key={v} value={v}>{l}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-44">時間</TableHead>
                <TableHead>操作者</TableHead>
                <TableHead>對象</TableHead>
                <TableHead>動作</TableHead>
                <TableHead>內容</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">載入中…</TableCell></TableRow>
              )}
              {!isLoading && data.length === 0 && (
                <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">沒有紀錄</TableCell></TableRow>
              )}
              {data.map(row => (
                <TableRow key={row.id}>
                  <TableCell className="text-xs tabular-nums">
                    {new Date(row.at).toLocaleString("zh-TW")}
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-sm" title={row.actor ?? ""}>
                    {row.actor ?? "系統"}
                  </TableCell>
                  <TableCell className="text-sm">
                    {ENTITY_LABEL[row.entityType] ?? row.entityType}
                    {row.entityId && <span className="text-muted-foreground"> #{row.entityId}</span>}
                  </TableCell>
                  <TableCell>
                    <Badge variant={row.action === "delete" ? "destructive" : "outline"}>
                      {ACTION_LABEL[row.action] ?? row.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-md">
                    {row.changes != null && (
                      <code className="block truncate text-xs text-muted-foreground"
                        title={JSON.stringify(row.changes)}>
                        {JSON.stringify(row.changes)}
                      </code>
                    )}
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
