/**
 * 系統設定頁（白牌化）。
 *
 * 這裡改的東西全部存在資料庫的 app_settings：系統名稱、我方公司資料、
 * logo、印章、編號前綴、主色。改完之後側欄、登入頁、PDF、編號都會跟著變，
 * 不需要改程式碼或重新部署。
 */
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { settings as settingsApi, ApiError, PERMISSION, type AppSettings, type SettingsPatch } from "@/lib/api";
import { useSettings } from "@/context/SettingsContext";
import { useAuth } from "@/context/AuthContext";
import NoPermission from "@/components/NoPermission";
import { useToast } from "@/hooks/use-toast";
import { prepareStampImage } from "@/lib/stampImage";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type FormState = Required<{ [K in keyof SettingsPatch]: string }>;

const toForm = (s: AppSettings): FormState => ({
  appName: s.appName,
  companyName: s.companyName,
  companyTaxId: s.companyTaxId,
  companyAddress: s.companyAddress ?? "",
  companyPhone: s.companyPhone ?? "",
  companyEmail: s.companyEmail ?? "",
  companyPrincipal: s.companyPrincipal ?? "",
  quotationPrefix: s.quotationPrefix,
  contractPrefix: s.contractPrefix,
  primaryColor: s.primaryColor ?? "",
});

export default function SettingsPage() {
  const { refresh } = useSettings();
  const { can } = useAuth();
  const { toast } = useToast();
  const [form, setForm] = useState<FormState | null>(null);
  const allowed = can(PERMISSION.SETTINGS_MANAGE);

  // 完整設定走需要權限的端點；沒權限的人在下面直接顯示「需要權限」
  const { data: settings } = useQuery({
    queryKey: ["settings", "full"],
    queryFn: () => settingsApi.get(),
    enabled: allowed,
  });

  useEffect(() => {
    if (settings && !form) setForm(toForm(settings));
  }, [settings, form]);

  if (!allowed) return <NoPermission permission={PERMISSION.SETTINGS_MANAGE} />;

  const onError = (err: unknown, title: string) => toast({
    title, description: err instanceof ApiError ? err.message : "發生錯誤", variant: "destructive",
  });

  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => settingsApi.update(patch),
    onSuccess: updated => {
      toast({ title: "設定已儲存" });
      setForm(toForm(updated));
      refresh();
    },
    onError: err => onError(err, "儲存失敗"),
  });

  if (!settings || !form) {
    return <div className="p-10 text-center text-muted-foreground">載入中…</div>;
  }

  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => prev ? { ...prev, [key]: e.target.value } : prev);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    save.mutate({
      ...form,
      companyAddress: form.companyAddress || null,
      companyPhone: form.companyPhone || null,
      companyEmail: form.companyEmail || null,
      companyPrincipal: form.companyPrincipal || null,
      primaryColor: form.primaryColor || null,
    } as SettingsPatch);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">系統設定</h1>
        <span className="text-sm text-muted-foreground">
          品牌、公司資料與編號規則；儲存後立即生效
        </span>
      </div>

      <form onSubmit={submit} className="space-y-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">系統與公司</CardTitle>
            <CardDescription>
              公司資料會印在報價單與合約的「我方」欄位，並同步到預設公司主體。
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <Field label="系統名稱" value={form.appName} onChange={set("appName")} required />
            <Field label="公司名稱" value={form.companyName} onChange={set("companyName")} required />
            <Field label="統一編號" value={form.companyTaxId} onChange={set("companyTaxId")} required />
            <Field label="公司負責人／代表人" value={form.companyPrincipal} onChange={set("companyPrincipal")}
              placeholder="合約甲方代表人" />
            <Field label="公司電話" value={form.companyPhone} onChange={set("companyPhone")} />
            <Field label="公司 Email" type="email" value={form.companyEmail} onChange={set("companyEmail")} />
            <div className="sm:col-span-2">
              <Field label="公司地址" value={form.companyAddress} onChange={set("companyAddress")} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">編號與外觀</CardTitle>
            <CardDescription>
              編號格式為「前綴-YYYYMMDD-流水號」。改前綴不影響已建立的單據。
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <Field label="報價編號前綴" value={form.quotationPrefix} onChange={set("quotationPrefix")}
              placeholder="QT" required />
            <Field label="合約編號前綴" value={form.contractPrefix} onChange={set("contractPrefix")}
              placeholder="CNT" required />
            <div className="space-y-2">
              <Label>主色（選填）</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  className="h-9 w-12 cursor-pointer rounded border bg-background"
                  value={/^#[0-9a-fA-F]{6}$/.test(form.primaryColor) ? form.primaryColor : "#c9951a"}
                  onChange={set("primaryColor")}
                />
                <Input value={form.primaryColor} onChange={set("primaryColor")} placeholder="#c9951a" />
                {form.primaryColor && (
                  <Button type="button" variant="ghost" size="sm"
                    onClick={() => setForm(p => p ? { ...p, primaryColor: "" } : p)}>
                    清除
                  </Button>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "儲存中…" : "儲存設定"}
          </Button>
        </div>
      </form>

      <div className="grid gap-4 md:grid-cols-2">
        <ImageCard
          kind="logo"
          title="Logo"
          description="顯示在側欄、登入頁與瀏覽器分頁圖示。PNG／JPG／SVG，2 MB 以內。"
          currentUrl={settings.logoUrl}
          onChanged={refresh}
        />
        <ImageCard
          kind="stamp"
          title="公司印章"
          description="匯出報價單／合約 PDF 時自動用印。上傳前會在瀏覽器端縮圖並把白底去掉。"
          currentUrl={settings.stampUrl}
          onChanged={refresh}
          preprocess
        />
      </div>
    </div>
  );
}

function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Input {...props} />
    </div>
  );
}

function ImageCard({ kind, title, description, currentUrl, onChanged, preprocess }: {
  kind: "logo" | "stamp";
  title: string;
  description: string;
  currentUrl: string | null;
  onChanged: () => void;
  /** 印章：上傳前縮圖＋去背 */
  preprocess?: boolean;
}) {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (file: File) => {
    setBusy(true);
    try {
      if (preprocess) {
        const prepared = await prepareStampImage(file);
        const blob = await (await fetch(prepared.dataUrl)).blob();
        await settingsApi.uploadImage(kind, blob, "stamp.png");
      } else {
        await settingsApi.uploadImage(kind, file, file.name);
      }
      toast({ title: `${title}已更新` });
      onChanged();
    } catch (err) {
      toast({
        title: `${title}上傳失敗`,
        description: err instanceof ApiError ? err.message : (err as Error).message,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await settingsApi.removeImage(kind);
      toast({ title: `已移除${title}` });
      onChanged();
    } catch (err) {
      toast({ title: "移除失敗", description: err instanceof ApiError ? err.message : "", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex h-32 items-center justify-center rounded-md border bg-muted/30"
          style={{ backgroundImage: preprocess
            ? "linear-gradient(45deg,#eee 25%,transparent 25%,transparent 75%,#eee 75%),linear-gradient(45deg,#eee 25%,transparent 25%,transparent 75%,#eee 75%)"
            : undefined, backgroundSize: "16px 16px", backgroundPosition: "0 0,8px 8px" }}>
          {currentUrl
            ? <img src={currentUrl} alt={title} className="max-h-28 max-w-full object-contain" />
            : <span className="text-sm text-muted-foreground">尚未上傳</span>}
        </div>
        <div className="flex gap-2">
          <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/svg+xml" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) void pick(f); }} />
          <Button type="button" variant="outline" size="sm" disabled={busy}
            onClick={() => inputRef.current?.click()}>
            {busy ? "處理中…" : currentUrl ? "更換" : "上傳"}
          </Button>
          {currentUrl && (
            <Button type="button" variant="ghost" size="sm" className="text-destructive" disabled={busy}
              onClick={() => void remove()}>
              移除
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
