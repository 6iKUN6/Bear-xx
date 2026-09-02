import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { ShieldAlert } from "lucide-react";
import { ApiError } from "@/api/client";
import { useAuthStore } from "@/stores/auth-store";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";

type ProbeState = "checking" | "ok" | "forbidden" | "error";

/**
 * 管理员守卫：进入控制台前读取服务端实时角色，避免长期信任本地缓存身份。
 */
export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const logout = useAuthStore((s) => s.logout);
  const refreshSession = useAuthStore((s) => s.refreshSession);
  const [state, setState] = useState<ProbeState>("checking");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!isAuthenticated) return;
    let alive = true;
    setState("checking");
    refreshSession()
      .then(() => alive && setState("ok"))
      .catch((err) => {
        if (!alive) return;
        if (err instanceof ApiError && err.status === 403) {
          setState("forbidden");
          return;
        }
        if (!(err instanceof ApiError && err.status === 401)) {
          setState("error");
        }
      });
    return () => {
      alive = false;
    };
  }, [attempt, isAuthenticated, refreshSession]);

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
          <p className="text-lg font-semibold text-foreground">
            需要管理员权限
          </p>
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

  if (state === "error") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-4 text-center">
        <ShieldAlert className="h-12 w-12 text-[var(--lb-warning)]" />
        <div>
          <p className="text-lg font-semibold text-foreground">
            暂时无法确认后台权限
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            请检查网络连接后重试。
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setAttempt((value) => value + 1)}
        >
          重试
        </Button>
      </div>
    );
  }

  return <>{children}</>;
}

/** 仅允许顶级管理员访问的路由守卫；后端仍是最终权限源。 */
export function RequireSuperAdmin({ children }: { children: React.ReactNode }) {
  const role = useAuthStore((s) => s.user?.adminRole);
  if (role !== "SUPER_ADMIN") {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
        <ShieldAlert className="h-10 w-10 text-[var(--lb-danger)]" />
        <p className="text-lg font-semibold text-foreground">
          需要顶级管理员权限
        </p>
        <p className="text-sm text-muted-foreground">
          当前角色不能管理模型预设和密钥。
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
