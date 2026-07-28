import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { getOverview } from "@/api/endpoints";
import { ApiError } from "@/api/client";
import { useAuthStore } from "@/stores/auth-store";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

type ProbeState = "checking" | "ok" | "forbidden";

/**
 * 管理员守卫：后端 profile 不含 role，故进控制台前探测一个 admin 端点，
 * 200 放行、403 显示“需要管理员权限”、401 跳登录（client 已自动处理跳转）。
 */
export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const logout = useAuthStore((s) => s.logout);
  const [state, setState] = useState<ProbeState>("checking");

  useEffect(() => {
    if (!isAuthenticated) return;
    let alive = true;
    getOverview(7)
      .then(() => alive && setState("ok"))
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 403) {
          setState("forbidden");
        }
        // 401 由 client 清凭证并跳转，无需在此处理
      });
    return () => {
      alive = false;
    };
  }, [isAuthenticated]);

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  if (state === "checking") {
    return (
      <div className="mx-auto max-w-[80rem] space-y-4 p-6">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (state === "forbidden") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
        <ShieldAlert className="h-12 w-12 text-[var(--lb-danger)]" />
        <div>
          <p className="text-lg font-semibold text-foreground">需要管理员权限</p>
          <p className="mt-1 text-sm text-muted-foreground">
            当前账号无权访问管理后台，请用管理员账号登录。
          </p>
        </div>
        <Button variant="outline" onClick={logout}>
          切换账号
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}
