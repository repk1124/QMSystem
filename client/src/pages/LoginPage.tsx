/**
 * 登入頁。只有帳號密碼一種方式；系統名稱與 logo 來自系統設定。
 */

import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/context/AuthContext";
import { useSettings } from "@/context/SettingsContext";
import { ApiError } from "@/lib/api";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function LoginPage() {
  const [, navigate] = useLocation();
  const { currentUser, isLoading, login } = useAuth();
  const { appName, logoUrl } = useSettings();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 已經登入就不要停在登入頁
  useEffect(() => {
    if (currentUser) navigate("/");
  }, [currentUser, navigate]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username.trim(), password);
      navigate("/");
    } catch (err) {
      // 伺服器的訊息已經是可以直接顯示的（例如爆破鎖定的 429）
      setError(err instanceof ApiError ? err.message : "登入失敗，請稍後再試");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="space-y-2 text-center">
          <img src={logoUrl} alt="" className="mx-auto h-14 w-14 rounded-lg object-contain" />
          <CardTitle className="text-2xl">{appName}</CardTitle>
          <CardDescription>請使用系統帳號登入</CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">帳號</Label>
              <Input
                id="username"
                autoComplete="username"
                value={username}
                onChange={e => setUsername(e.target.value)}
                required
                autoFocus
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">密碼</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
              />
            </div>

            {error && (
              <p className="text-sm text-destructive" role="alert">{error}</p>
            )}

            <Button type="submit" className="w-full" disabled={submitting || isLoading}>
              {submitting ? "登入中…" : "登入"}
            </Button>
          </form>
          <p className="text-center text-xs text-muted-foreground">
            忘記密碼請聯絡系統管理員重設。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
