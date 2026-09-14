import { useEffect } from "react";
import { useAppStore } from "@/stores/app-store";
import { useThemeStore } from "@/stores/theme-store";
import { WorkbenchPage } from "@/components/WorkbenchPage";
import { SettingsPage } from "@/components/SettingsPage";
import { LoginPage } from "@/components/LoginPage";

/**
 * 页内路由：工作台（默认）/ 设置 / 登录。
 * 登录不做整窗拦截，入口在侧边栏左下角账号行；Esc 可返回工作台。
 */
export default function App() {
  const page = useAppStore((s) => s.page);
  const setPage = useAppStore((s) => s.setPage);
  const hydrateAuth = useAppStore((s) => s.hydrateAuth);
  const handleUnauthorized = useAppStore((s) => s.handleUnauthorized);
  const hydrateTheme = useThemeStore((s) => s.hydrate);

  useEffect(() => {
    hydrateTheme();
    hydrateAuth();
  }, [hydrateTheme, hydrateAuth]);

  // client 在 401 且刷新失败后广播此事件（client 不反向依赖 store）
  useEffect(() => {
    const onUnauthorized = () => handleUnauthorized();
    window.addEventListener("sola:unauthorized", onUnauthorized);
    return () => window.removeEventListener("sola:unauthorized", onUnauthorized);
  }, [handleUnauthorized]);

  useEffect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && page !== "workbench") {
        setPage("workbench");
      }
    };
    document.addEventListener("keydown", onKeydown);
    return () => document.removeEventListener("keydown", onKeydown);
  }, [page, setPage]);

  if (page === "settings") {
    return <SettingsPage />;
  }
  if (page === "login") {
    return <LoginPage />;
  }
  return <WorkbenchPage />;
}
