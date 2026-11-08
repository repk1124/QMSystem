/**
 * 沒有權限時的整頁提示。側欄已經不會列出沒權限的項目，
 * 這是給直接輸入網址的人看的，避免整頁渲染出來只有存檔才被擋。
 */
import { Link } from "wouter";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NoPermission({ permission }: { permission?: string }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
      <ShieldAlert className="h-10 w-10 text-muted-foreground" />
      <h1 className="text-xl font-semibold">需要權限</h1>
      <p className="text-sm text-muted-foreground">
        你的帳號沒有這個頁面的權限{permission ? `（${permission}）` : ""}，請聯絡系統管理員。
      </p>
      <Link href="/"><Button variant="outline" size="sm">回首頁</Button></Link>
    </div>
  );
}
