/**
 * 修改密碼。
 *
 * 兩種情境共用：
 *   - 首次登入（must_change_password）：整頁擋住，改完才能進系統
 *   - 自行修改：從右上角「修改密碼」進來
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { auth as authApi, ApiError } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useSettings } from "@/context/SettingsContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function ChangePassword({ forced = false }: { forced?: boolean }) {
  const [, navigate] = useLocation();
  const { refresh, logout, currentUser } = useAuth();
  const { appName } = useSettings();
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirm) { setError("兩次輸入的新密碼不一致"); return; }
    setBusy(true);
    try {
      await authApi.changePassword(currentPassword, newPassword);
      await refresh();
      navigate("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "修改失敗");
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <form onSubmit={submit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="current">目前密碼</Label>
        <Input id="current" type="password" autoComplete="current-password" required
          value={currentPassword} onChange={e => setCurrentPassword(e.target.value)} autoFocus />
      </div>
      <div className="space-y-2">
        <Label htmlFor="new">新密碼</Label>
        <Input id="new" type="password" autoComplete="new-password" required
          value={newPassword} onChange={e => setNewPassword(e.target.value)}
          placeholder="至少 10 個字元，含英文與數字" />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm">再輸入一次新密碼</Label>
        <Input id="confirm" type="password" autoComplete="new-password" required
          value={confirm} onChange={e => setConfirm(e.target.value)} />
      </div>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" className="flex-1" disabled={busy}>{busy ? "儲存中…" : "更新密碼"}</Button>
        {forced
          ? <Button type="button" variant="ghost" onClick={() => void logout()}>登出</Button>
          : <Button type="button" variant="ghost" onClick={() => navigate("/")}>取消</Button>}
      </div>
    </form>
  );

  if (!forced) {
    return (
      <div className="mx-auto max-w-md space-y-4">
        <h1 className="text-2xl font-semibold">修改密碼</h1>
        <Card><CardContent className="pt-6">{form}</CardContent></Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>{appName}</CardTitle>
          <CardDescription>
            {currentUser?.username} 你好，第一次登入請先設定自己的密碼。
          </CardDescription>
        </CardHeader>
        <CardContent>{form}</CardContent>
      </Card>
    </div>
  );
}
