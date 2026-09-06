import { useState } from "react";
import {
  CalendarX2,
  ChevronLeft,
  ChevronRight,
  Save,
  Search,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import {
  useAdminUserMutations,
  useAdminUsers,
  useManagementAuditLogs,
} from "@/hooks/queries";
import { useAuthStore } from "@/stores/auth-store";
import type { AdminUser, ManagementAuditLog } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const TIERS = ["FREE", "PLUS", "PRO"] as const;
const PAGE_SIZE = 50;

export function UsersPage() {
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const { data, isLoading, error: usersError } = useAdminUsers(query, page);
  const { data: audit, error: auditError } = useManagementAuditLogs();
  const mutations = useAdminUserMutations();
  const currentUser = useAuthStore((state) => state.user);
  const rows = data?.items ?? [];
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));

  const saveMembership = async (
    user: AdminUser,
    tier: AdminUser["membershipTier"],
    membershipExpiresAt: string | null,
  ) => {
    try {
      await mutations.membership.mutateAsync({
        id: user.id,
        membershipTier: tier,
        membershipExpiresAt,
      });
      toast.success("会员权益已更新");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "更新失败");
    }
  };

  const saveRole = async (user: AdminUser, role: AdminUser["role"]) => {
    if (user.id === currentUser?.id) return;
    try {
      await mutations.adminRole.mutateAsync({ id: user.id, role });
      toast.success("管理员角色已更新");
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "更新失败");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">运营权限</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            用户与权限
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            会员权益与后台角色分开管理，服务端会在每次任务发送时重新校验。
          </p>
        </div>
        <form
          className="flex w-full max-w-sm gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setPage(1);
            setQuery(search.trim());
          }}
        >
          <Label htmlFor="user-search" className="sr-only">
            搜索用户
          </Label>
          <Input
            id="user-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索 ID、昵称、账号或手机号"
          />
          <Button type="submit" variant="outline" size="icon" title="搜索">
            <Search className="h-4 w-4" />
          </Button>
        </form>
      </div>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle>账号列表</CardTitle>
          <Badge variant="outline">{data?.total ?? 0} 个账号</Badge>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <Skeleton className="m-6 h-64" />
          ) : usersError ? (
            <p className="px-6 py-12 text-center text-sm text-[var(--lb-danger)]">
              {usersError instanceof ApiError
                ? usersError.message
                : "用户列表加载失败"}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-y border-border bg-muted/30 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-6 py-3 font-medium">用户</th>
                    <th className="px-4 py-3 font-medium">后台角色</th>
                    <th className="px-4 py-3 font-medium">
                      会员配置与到期时间
                    </th>
                    <th className="px-4 py-3 font-medium">有效等级</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((user) => (
                    <tr key={user.id} className="align-middle">
                      <td className="min-w-[15rem] px-6 py-4">
                        <p className="font-medium">{user.nickname}</p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {user.username ?? user.phone ?? user.id}
                        </p>
                      </td>
                      <td className="px-4 py-4">
                        {currentUser?.adminRole === "SUPER_ADMIN" ? (
                          <Select
                            value={user.role}
                            onValueChange={(value) =>
                              void saveRole(user, value as AdminUser["role"])
                            }
                            disabled={
                              user.id === currentUser.id ||
                              !user.hasPasswordAccount
                            }
                          >
                            <SelectTrigger className="h-8 w-36">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="USER">普通用户</SelectItem>
                              <SelectItem value="ADMIN">次级管理员</SelectItem>
                              <SelectItem value="SUPER_ADMIN">
                                顶级管理员
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        ) : (
                          <Badge variant="secondary">
                            {roleLabel(user.role)}
                          </Badge>
                        )}
                        {!user.hasPasswordAccount && user.role === "USER" ? (
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            需先设置用户名或手机号密码
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-4">
                        <MembershipEditor
                          key={`${user.id}:${user.membershipTier}:${user.membershipExpiresAt ?? "permanent"}`}
                          user={user}
                          onSave={saveMembership}
                        />
                      </td>
                      <td className="px-4 py-4">
                        <Badge
                          variant={
                            user.membershipExpired ? "warning" : "outline"
                          }
                        >
                          {user.effectiveMembershipTier}
                          {user.membershipExpired ? " · 已到期" : ""}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 ? (
                <p className="px-6 py-12 text-center text-sm text-muted-foreground">
                  没有匹配的用户
                </p>
              ) : null}
              {data && data.total > PAGE_SIZE ? (
                <div className="flex items-center justify-end gap-2 border-t border-border px-6 py-3">
                  <span className="text-xs text-muted-foreground">
                    第 {page} / {totalPages} 页
                  </span>
                  <Button
                    variant="outline"
                    size="icon"
                    title="上一页"
                    disabled={page <= 1}
                    onClick={() => setPage((value) => Math.max(1, value - 1))}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="outline"
                    size="icon"
                    title="下一页"
                    disabled={page >= totalPages}
                    onClick={() =>
                      setPage((value) => Math.min(totalPages, value + 1))
                    }
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4" />
            最近管理审计
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {auditError ? (
            <p className="text-sm text-[var(--lb-danger)]">
              {auditError instanceof ApiError
                ? auditError.message
                : "管理审计加载失败"}
            </p>
          ) : null}
          {(audit?.items ?? []).slice(0, 8).map((log) => (
            <div
              key={log.id}
              className="border-b border-border py-2 text-sm last:border-0"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  {log.actor?.nickname ?? "系统"} ·{" "}
                  {auditActionLabel(log.action)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(log.createdAt).toLocaleString("zh-CN")}
                </span>
              </div>
              <p className="mt-1 break-all text-xs text-muted-foreground">
                {log.targetType === "USER" ? "用户" : "智能体"} {log.targetId}
                {formatAuditChange(log.before, log.after)}
              </p>
            </div>
          ))}
          {!auditError && !audit?.items.length ? (
            <p className="text-sm text-muted-foreground">暂无管理变更记录</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function MembershipEditor({
  user,
  onSave,
}: {
  user: AdminUser;
  onSave: (
    user: AdminUser,
    tier: AdminUser["membershipTier"],
    membershipExpiresAt: string | null,
  ) => Promise<void>;
}) {
  const initialExpiresAt = toLocalDateTime(user.membershipExpiresAt);
  const [tier, setTier] = useState(user.membershipTier);
  const [expiresAt, setExpiresAt] = useState(initialExpiresAt);
  const [saving, setSaving] = useState(false);
  const dirty = tier !== user.membershipTier || expiresAt !== initialExpiresAt;

  const save = async () => {
    setSaving(true);
    try {
      await onSave(
        user,
        tier,
        expiresAt ? new Date(expiresAt).toISOString() : null,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-w-[28rem] items-center gap-2">
      <Select
        value={tier}
        onValueChange={(value) => setTier(value as AdminUser["membershipTier"])}
        disabled={saving}
      >
        <SelectTrigger className="h-8 w-28">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {TIERS.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        type="datetime-local"
        value={expiresAt}
        onChange={(event) => setExpiresAt(event.target.value)}
        disabled={saving}
        className="h-8 w-48"
        aria-label="会员到期时间"
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        title="设为永久"
        disabled={saving || !expiresAt}
        onClick={() => setExpiresAt("")}
      >
        <CalendarX2 className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        size="icon"
        title="保存会员配置"
        disabled={saving || !dirty}
        onClick={() => void save()}
      >
        <Save className="h-4 w-4" />
      </Button>
    </div>
  );
}

function roleLabel(role: AdminUser["role"]) {
  return role === "SUPER_ADMIN"
    ? "顶级管理员"
    : role === "ADMIN"
      ? "次级管理员"
      : "普通用户";
}

function auditActionLabel(action: ManagementAuditLog["action"]) {
  return (
    {
      ADMIN_ROLE_UPDATED: "调整管理员角色",
      MEMBERSHIP_UPDATED: "调整会员权益",
      AGENT_ACCESS_UPDATED: "调整智能体开放策略",
      SUPER_ADMIN_BOOTSTRAPPED: "初始化顶级管理员",
    }[action] ?? action
  );
}

function toLocalDateTime(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function formatAuditChange(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string {
  if (!before && !after) return "";
  return ` · ${before ? JSON.stringify(before) : "无"} → ${after ? JSON.stringify(after) : "无"}`;
}
