/**
 * 認證狀態。
 *
 *   - 身分來自伺服器的 session cookie
 *   - 帶權限清單，UI 可以據此決定顯示什麼（實際把關仍在伺服器）
 *   - 任何 API 回 401 時會自動把狀態清掉，不會讓使用者看著
 *     「已登入」的畫面但每個操作都失敗
 */

import React, {
  createContext, useContext, useState, useEffect, useCallback, type ReactNode,
} from "react";
import { auth as authApi, ApiError, hasPermission, type ApiUser } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

interface AuthContextValue {
  currentUser: ApiUser | null;
  isLoading: boolean;
  /** 首次登入必須改密碼 */
  mustChangePassword: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  /** UI 用的權限判斷。伺服器才是真正把關的那層。 */
  can: (permission: string) => boolean;
}

const AuthContext = createContext<AuthContextValue>({
  currentUser: null,
  isLoading: true,
  mustChangePassword: false,
  login: async () => {},
  logout: async () => {},
  refresh: async () => {},
  can: () => false,
});

export const useAuth = () => useContext(AuthContext);

/**
 * 全域的 401 處理。
 *
 * session 過期時，任何一支 API 都可能回 401。與其在每個呼叫點各寫一次
 * 處理，不如在這裡集中攔截：清掉使用者狀態，畫面自然會退回登入頁。
 */
let onUnauthorized: (() => void) | null = null;
export function registerUnauthorizedHandler(handler: () => void) {
  onUnauthorized = handler;
}
export function notifyUnauthorized() {
  onUnauthorized?.();
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [currentUser, setCurrentUser] = useState<ApiUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    try {
      const { user } = await authApi.me();
      setCurrentUser(user);
    } catch (error) {
      // 401 是正常的「還沒登入」，不需要跳錯誤訊息
      if (!(error instanceof ApiError && error.isUnauthorized)) {
        console.error("讀取登入狀態失敗:", error);
      }
      setCurrentUser(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    registerUnauthorizedHandler(() => {
      setCurrentUser(null);
      setIsLoading(false);
    });
    void refresh();
  }, [refresh]);

  // 使用者切回這個分頁時重新確認一次登入狀態。
  // 舊版只在掛載時檢查一次，在別的分頁登出後這裡還是顯示已登入。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && currentUser) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [currentUser, refresh]);

  const login = useCallback(async (username: string, password: string) => {
    setIsLoading(true);
    try {
      const { user } = await authApi.login(username, password);
      setCurrentUser(user);
      toast({ title: "登入成功", description: `歡迎 ${user.displayName || user.username}` });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : "登入過程發生錯誤";
      toast({ title: "登入失敗", description: message, variant: "destructive" });
      throw error;
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } catch (error) {
      console.error("登出時發生錯誤:", error);
    } finally {
      // 就算伺服器那邊出錯，本地也要清掉
      setCurrentUser(null);
      toast({ title: "已登出" });
    }
  }, [toast]);

  const can = useCallback(
    (permission: string) => hasPermission(currentUser, permission),
    [currentUser],
  );

  return (
    <AuthContext.Provider value={{
      currentUser, isLoading,
      mustChangePassword: Boolean(currentUser?.mustChangePassword),
      login, logout, refresh, can,
    }}>
      {children}
    </AuthContext.Provider>
  );
}
