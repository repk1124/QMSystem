/** 使用者與角色。權限清單直接列出來，不要讓人用猜的。 */
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { users, ApiError, type UserRow } from "@/lib/api";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

const ROLE_LABEL: Record<string, string> = {
  admin: "管理員", manager: "主管", sales: "業務", accounting: "會計", employee: "一般員工",
};

const PERMISSION_LABEL: Record<string, string> = {
  "quotation:read": "檢視報價", "quotation:write": "編輯報價",
  "quotation:approve": "核准報價", "quotation:void": "作廢報價",
  "quotation:view_cost": "檢視成本與毛利",
  "client:read": "檢視客戶", "client:write": "編輯客戶",
  "product:read": "檢視品項", "product:write": "編輯品項",
  "employee:read": "檢視員工", "employee:write": "編輯員工",
  "employee:delete": "刪除員工", "employee:view_salary": "檢視薪資",
  "attendance:read": "檢視出勤", "attendance:write": "打卡", "attendance:manage": "管理出勤",
  "leave:read": "檢視請假", "leave:write": "申請請假", "leave:approve": "審核請假",
  "user:read": "檢視使用者", "user:write": "編輯使用者", "user:delete": "刪除使用者",
  "role:read": "檢視角色", "role:write": "編輯角色", "role:delete": "刪除角色",
  "audit:read": "檢視稽核紀錄", "settings:manage": "管理系統設定", "system:admin": "系統管理員",
};

export default function Users() {
  const { currentUser } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);

  const { data: list = [], isLoading } = useQuery({ queryKey: ["users"], queryFn: () => users.list() });
  const { data: roles = [] } = useQuery({ queryKey: ["roles"], queryFn: () => users.roles() });

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["users"] });
  const onError = (err: unknown, title: string) => toast({
    title, description: err instanceof ApiError ? err.message : "發生錯誤", variant: "destructive",
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: { role?: string; isActive?: boolean } }) =>
      users.update(id, patch),
    onSuccess: () => { toast({ title: "已更新" }); refresh(); },
    // 「最後一個管理員不能降級」這種訊息由伺服器提供
    onError: err => onError(err, "更新失敗"),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">使用者與權限</h1>
        <span className="text-sm text-muted-foreground">共 {list.length} 位</span>
        <Button className="ml-auto" onClick={() => setCreating(true)}>新增使用者</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>帳號</TableHead>
                <TableHead>Email</TableHead>
                <TableHead>對應員工</TableHead>
                <TableHead>角色</TableHead>
                <TableHead>最後登入</TableHead>
                <TableHead>狀態</TableHead>
                <TableHead className="w-24 text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">載入中…</TableCell></TableRow>
              )}
              {list.map((user: UserRow) => (
                <TableRow key={user.id} className={user.isActive ? "" : "opacity-50"}>
                  <TableCell>
                    {user.username}
                    {user.id === currentUser?.id && <Badge variant="outline" className="ml-2">你自己</Badge>}
                    {user.mustChangePassword && (
                      <Badge variant="destructive" className="ml-2">需改密碼</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm">{user.email}</TableCell>
                  <TableCell className="text-sm">
                    {user.employeeName
                      ? <>{user.employeeName}<span className="text-xs text-muted-foreground"> {user.employeeCode}</span></>
                      : <span className="text-xs text-muted-foreground">未對應</span>}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={user.role}
                      onValueChange={role => update.mutate({ id: user.id, patch: { role } })}
                    >
                      <SelectTrigger className="h-8 w-32"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {roles.map(r => (
                          <SelectItem key={r.name} value={r.name}>
                            {ROLE_LABEL[r.name] ?? r.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleDateString("zh-TW") : "從未登入"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {user.isActive
                      ? <Badge variant="secondary" className="whitespace-nowrap">啟用中</Badge>
                      : <Badge variant="destructive" className="whitespace-nowrap">已停用</Badge>}
                  </TableCell>
                  <TableCell className="text-right">
                    {/* 不能把自己停用 —— 鎖死自己就沒人能開門了 */}
                    {user.id !== currentUser?.id && (
                      <Button
                        size="sm" variant="ghost"
                        className={user.isActive ? "text-destructive" : ""}
                        onClick={() => update.mutate({ id: user.id, patch: { isActive: !user.isActive } })}
                        disabled={update.isPending}
                      >
                        {user.isActive ? "停用" : "重新啟用"}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3"><CardTitle className="text-base">角色權限</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {roles.map(role => (
            <div key={role.name}>
              <div className="flex items-center gap-2">
                <span className="font-medium">{ROLE_LABEL[role.name] ?? role.name}</span>
                <span className="text-xs text-muted-foreground">{role.userCount} 位</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {role.permissions.map(p => (
                  <Badge key={p} variant="outline" className="text-[11px] font-normal">
                    {PERMISSION_LABEL[p] ?? p}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
          <p className="text-xs text-muted-foreground">
            「編輯報價」與「核准報價」是分開的權限 —— 能改不代表能核准。
          </p>
        </CardContent>
      </Card>

      <CreateUserDialog open={creating} roles={roles.map(r => r.name)}
        onClose={() => setCreating(false)} onDone={() => { setCreating(false); refresh(); }} />
    </div>
  );
}

function CreateUserDialog({
  open, roles, onClose, onDone,
}: { open: boolean; roles: string[]; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("employee");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: () => users.create({
      username: username.trim(), email: email.trim(),
      displayName: displayName.trim() || undefined, role,
      password: password.trim(),
    }),
    onSuccess: () => {
      toast({ title: "已建立使用者" });
      setUsername(""); setEmail(""); setDisplayName(""); setPassword("");
      onDone();
    },
    onError: (err: unknown) => setError(err instanceof ApiError ? err.message : "建立失敗"),
  });

  return (
    <Dialog open={open} onOpenChange={o => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增使用者</DialogTitle>
          <DialogDescription>
            初始密碼至少 10 個字元且含英文與數字；對方第一次登入時會被要求改掉。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label>帳號</Label>
            <Input value={username} onChange={e => setUsername(e.target.value)} autoFocus />
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input type="email" value={email} onChange={e => setEmail(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>顯示名稱</Label>
            <Input value={displayName} onChange={e => setDisplayName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>角色</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {roles.map(r => (
                  <SelectItem key={r} value={r}>{ROLE_LABEL[r] ?? r}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>初始密碼</Label>
            <Input type="password" value={password} onChange={e => setPassword(e.target.value)}
              autoComplete="new-password" placeholder="至少 10 個字元，含英文與數字" />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={() => { setError(null); mutation.mutate(); }}
            disabled={!username.trim() || !email.trim() || password.trim().length < 10 || mutation.isPending}>建立</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
