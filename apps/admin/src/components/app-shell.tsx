import { useCallback, useEffect, useRef, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ChevronLeft, ChevronRight, LogOut } from "lucide-react";
import { themes, pixelThemes, type AnyThemeId } from "@litter-bear/theme";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/theme-store";
import { useAuthStore } from "@/stores/auth-store";
import { RANGE_OPTIONS, useUiStore } from "@/stores/ui-store";

const NAV = [
  { to: "/", label: "概览", end: true },
  { to: "/agents", label: "智能体" },
  { to: "/agents/manage", label: "智能体管理" },
  { to: "/models", label: "模型", superAdminOnly: true },
  { to: "/users", label: "用户与权限" },
  { to: "/resources", label: "图片资源" },
  { to: "/flows", label: "Flow" },
  { to: "/tools", label: "工具" },
  { to: "/tasks", label: "任务" },
  { to: "/errors", label: "错误" },
  { to: "/debug", label: "调试" },
];

export function AppShell() {
  const navRef = useRef<HTMLElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const themeId = useThemeStore((s) => s.themeId);
  const setTheme = useThemeStore((s) => s.setTheme);
  const rangeDays = useUiStore((s) => s.rangeDays);
  const setRangeDays = useUiStore((s) => s.setRangeDays);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);

  const updateNavigationScrollState = useCallback(() => {
    const nav = navRef.current;
    if (!nav) return;
    const maxScrollLeft = Math.max(0, nav.scrollWidth - nav.clientWidth);
    setCanScrollLeft(nav.scrollLeft > 1);
    setCanScrollRight(nav.scrollLeft < maxScrollLeft - 1);
  }, []);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    updateNavigationScrollState();
    const observer = new ResizeObserver(updateNavigationScrollState);
    observer.observe(nav);
    nav.addEventListener("scroll", updateNavigationScrollState, {
      passive: true,
    });
    return () => {
      observer.disconnect();
      nav.removeEventListener("scroll", updateNavigationScrollState);
    };
  }, [updateNavigationScrollState, user?.adminRole]);

  const scrollNavigation = (direction: -1 | 1) => {
    const nav = navRef.current;
    if (!nav) return;
    nav.scrollBy({
      left: direction * Math.min(240, nav.clientWidth * 0.75),
      behavior: "smooth",
    });
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[80rem] items-center gap-4 px-6">
          <span className="shrink-0 text-base font-semibold text-foreground">
            办伴 Banban 管理后台
          </span>

          <Button
            variant="ghost"
            size="icon"
            className="ml-2 shrink-0"
            title="向左滚动导航"
            aria-label="向左滚动导航"
            onClick={() => scrollNavigation(-1)}
            disabled={!canScrollLeft}
          >
            <ChevronLeft />
          </Button>
          <nav
            ref={navRef}
            className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
          >
            {NAV.filter(
              (item) => !item.superAdminOnly || user?.adminRole === "SUPER_ADMIN",
            ).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    isActive
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            title="向右滚动导航"
            aria-label="向右滚动导航"
            onClick={() => scrollNavigation(1)}
            disabled={!canScrollRight}
          >
            <ChevronRight />
          </Button>

          <div className="flex shrink-0 items-center gap-2">
            <Select
              value={String(rangeDays)}
              onValueChange={(v) => setRangeDays(Number(v))}
            >
              <SelectTrigger className="h-8 w-[7rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RANGE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={String(opt.value)}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={themeId}
              onValueChange={(v) => setTheme(v as AnyThemeId)}
            >
              <SelectTrigger className="h-8 w-[9rem]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <div className="px-2 py-1 text-xs text-muted-foreground">
                  常规
                </div>
                {themes.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
                <div className="mt-1 px-2 py-1 text-xs text-muted-foreground">
                  像素
                </div>
                {pixelThemes.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <span className="hidden text-sm text-muted-foreground sm:inline">
              {user?.nickname ?? "管理员"}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={logout}
              title="退出登录"
            >
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[80rem] px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
