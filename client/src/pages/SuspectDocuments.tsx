/**
 * 待確認的簽回檔。
 *
 * 舊資料匯入時偵測到 4 筆同一份 PDF 被掛到多張報價上 ——
 * 對照 PDF 內頁的報價單號後確認是掛錯的。這一頁把它們列出來讓人處理，
 * 而不是讓錯誤資料靜靜地留在系統裡。
 *
 * 兩個動作：
 *   - 確認無誤：例如一份驗收單真的涵蓋多張報價，標記為已確認
 *   - 解除關聯：確定掛錯了，移除後再上傳正確的檔案
 */

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { documents, ApiError, PERMISSION } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/hooks/use-toast";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export default function SuspectDocuments() {
  const [, navigate] = useLocation();
  const { can } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canWrite = can(PERMISSION.QUOTATION_WRITE);

  const { data = [], isLoading } = useQuery({
    queryKey: ["suspect-links"],
    queryFn: () => documents.suspectLinks(),
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["suspect-links"] });
    void queryClient.invalidateQueries({ queryKey: ["quotations"] });
  };

  const onError = (err: unknown, title: string) => toast({
    title,
    description: err instanceof ApiError ? err.message : "發生未預期的錯誤",
    variant: "destructive",
  });

  const verifyMutation = useMutation({
    mutationFn: (linkId: number) => documents.verifyLink(linkId, "人工確認：檔案確實屬於這張報價"),
    onSuccess: () => { toast({ title: "已標記為確認無誤" }); refresh(); },
    onError: err => onError(err, "標記失敗"),
  });

  const unlinkMutation = useMutation({
    mutationFn: (linkId: number) => documents.unlink(linkId),
    onSuccess: () => { toast({ title: "已解除關聯" }); refresh(); },
    onError: err => onError(err, "解除失敗"),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">待確認簽回檔</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          同一份檔案被掛在多張報價上。可能是掛錯了，也可能是一份文件
          本來就涵蓋多張報價 —— 需要人工判斷。
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>報價單號</TableHead>
                <TableHead>客戶</TableHead>
                <TableHead>報價日期</TableHead>
                <TableHead>檔案</TableHead>
                <TableHead>原因</TableHead>
                {canWrite && <TableHead className="w-56" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={canWrite ? 6 : 5} className="py-10 text-center text-muted-foreground">
                    載入中…
                  </TableCell>
                </TableRow>
              )}

              {!isLoading && data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canWrite ? 6 : 5} className="py-10 text-center text-muted-foreground">
                    沒有待確認的項目
                  </TableCell>
                </TableRow>
              )}

              {data.map(row => (
                <TableRow key={row.id}>
                  <TableCell className="whitespace-nowrap font-mono text-sm">
                    <button
                      className="underline underline-offset-2"
                      onClick={() => navigate(`/quotations/${row.quotationId}`)}
                    >
                      {row.quotationNumber}
                    </button>
                  </TableCell>
                  <TableCell>{row.clientName}</TableCell>
                  <TableCell className="whitespace-nowrap">{row.quotationDate}</TableCell>
                  <TableCell className="max-w-xs truncate text-sm" title={row.filename}>
                    {row.filename}
                  </TableCell>
                  <TableCell className="max-w-sm text-xs text-muted-foreground">
                    {row.note}
                  </TableCell>
                  {canWrite && (
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="sm" variant="outline"
                          onClick={() => verifyMutation.mutate(row.id)}
                          disabled={verifyMutation.isPending}
                        >
                          確認無誤
                        </Button>
                        <Button
                          size="sm" variant="ghost" className="text-destructive"
                          onClick={() => unlinkMutation.mutate(row.id)}
                          disabled={unlinkMutation.isPending}
                        >
                          解除關聯
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
