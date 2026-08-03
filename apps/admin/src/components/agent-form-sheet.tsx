import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import defaultAgentAvatar from "@litter-bear/assets/agents/default-avatar.png";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MultiSelect } from "@/components/ui/multi-select";
import {
  useAgentCapabilities,
  useAgentMutations,
  useAvatarAssets,
  useModelPresets,
} from "@/hooks/queries";
import { uploadAgentAvatar } from "@/api/upload";
import { ApiError } from "@/api/client";
import type { Agent, AgentInput, AgentStrategy } from "@/api/types";
import {
  STRATEGY_OPTIONS,
  TOOL_GROUP_META,
  toolGroupName,
} from "@/lib/agent-meta";
import { cn } from "@/lib/utils";

/** 逗号/空格分隔字符串 ↔ 数组 */
const toList = (s: string) =>
  s
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);

export function AgentFormSheet({
  agent,
  open,
  onClose,
}: {
  agent: Agent | null; // null = 新建
  open: boolean;
  onClose: () => void;
}) {
  const { create, update } = useAgentMutations();
  const { data: modelPresets } = useModelPresets();
  const { data: capabilities } = useAgentCapabilities();
  const [form, setForm] = useState<AgentInput>({ name: "" });
  const [skillsText, setSkillsText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { data: avatarAssets, isLoading: assetsLoading } =
    useAvatarAssets(pickerOpen);

  useEffect(() => {
    if (!open) return;
    setPickerOpen(false);
    if (agent) {
      setForm({
        name: agent.name,
        description: agent.description,
        avatar: agent.avatar ?? "",
        systemPrompt: agent.systemPrompt ?? "",
        modelPreset: agent.modelPreset ?? "",
        defaultStrategy: agent.defaultStrategy,
        allowedStrategies: agent.allowedStrategies,
        toolGroups: agent.toolGroups,
        maxSteps: agent.maxSteps,
        enabled: agent.enabled,
      });
      setSkillsText(agent.skills.join(", "));
    } else {
      setForm({
        name: "",
        defaultStrategy: "AUTO",
        allowedStrategies: [],
        toolGroups: [],
        enabled: true,
      });
      setSkillsText("");
    }
  }, [agent, open]);

  const submitting = create.isPending || update.isPending;
  const toolGroups = capabilities?.toolGroups ?? [];
  const selectedGroups = form.toolGroups ?? [];
  const allowedStrategies = form.allowedStrategies ?? [];

  const toggleAllowedStrategy = (strategy: AgentStrategy) => {
    setForm({
      ...form,
      allowedStrategies: allowedStrategies.includes(strategy)
        ? allowedStrategies.filter((s) => s !== strategy)
        : [...allowedStrategies, strategy],
    });
  };

  const handleAvatarFile = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const { url } = await uploadAgentAvatar(file);
      setForm((prev) => ({ ...prev, avatar: url }));
      toast.success("头像已上传");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "上传失败，请重试");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleSubmit = async () => {
    if (!form.name.trim()) {
      toast.error("请填写名称");
      return;
    }
    const payload: AgentInput = {
      ...form,
      skills: toList(skillsText),
      avatar: form.avatar?.trim() || null,
      systemPrompt: form.systemPrompt?.trim() || null,
      modelPreset: form.modelPreset?.trim() || null,
    };
    try {
      if (agent) {
        await update.mutateAsync({ id: agent.id, body: payload });
        toast.success("已更新");
      } else {
        await create.mutateAsync(payload);
        toast.success("已创建");
      }
      onClose();
    } catch (err) {
      toast.error(
        err instanceof ApiError ? err.message : "保存失败，请重试",
      );
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{agent ? "编辑智能体" : "新建智能体"}</SheetTitle>
        </SheetHeader>

        <div className="space-y-4">
          <Field label="名称">
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="通用助手"
            />
          </Field>
          <Field label="描述">
            <Input
              value={form.description ?? ""}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </Field>
          <Field label="头像（可上传 ≤2MB 图片，或复用已上传，留空用默认）">
            <div className="flex items-center gap-3">
              <img
                src={form.avatar?.trim() || defaultAgentAvatar}
                alt="头像预览"
                className="h-10 w-10 shrink-0 rounded-full border border-border bg-muted object-cover"
                onError={(e) => {
                  // 外链失效时回退默认头像，避免碎图
                  (e.target as HTMLImageElement).src = defaultAgentAvatar;
                }}
              />
              <Input
                value={form.avatar ?? ""}
                onChange={(e) => setForm({ ...form, avatar: e.target.value })}
                placeholder="https://example.com/avatar.png"
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void handleAvatarFile(e.target.files?.[0])}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={uploading}
                onClick={() => fileInputRef.current?.click()}
              >
                {uploading ? "上传中…" : "上传"}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setPickerOpen((o) => !o)}
              >
                已上传
              </Button>
            </div>
            {pickerOpen ? (
              <div className="mt-2 max-h-44 overflow-y-auto rounded-md border border-border bg-popover p-2">
                {assetsLoading ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    加载中…
                  </p>
                ) : (avatarAssets ?? []).length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    还没有已上传的头像
                  </p>
                ) : (
                  <div className="grid grid-cols-6 gap-2">
                    {(avatarAssets ?? []).map((asset) => (
                      <button
                        key={asset.id}
                        type="button"
                        title={asset.key}
                        onClick={() => {
                          setForm((prev) => ({ ...prev, avatar: asset.url }));
                          setPickerOpen(false);
                        }}
                        className={cn(
                          "overflow-hidden rounded-md border p-0 transition-colors",
                          form.avatar === asset.url
                            ? "border-primary ring-1 ring-primary"
                            : "border-border hover:border-primary/50",
                        )}
                      >
                        <img
                          src={asset.url}
                          alt=""
                          className="aspect-square w-full object-cover"
                          loading="lazy"
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
          </Field>
          <Field label="系统提示词（留空用内置默认）">
            <Textarea
              value={form.systemPrompt ?? ""}
              onChange={(e) =>
                setForm({ ...form, systemPrompt: e.target.value })
              }
              rows={4}
            />
          </Field>
          <Field label="模型预设（留空用默认）">
            <Select
              value={form.modelPreset ?? ""}
              onValueChange={(v) =>
                setForm({ ...form, modelPreset: v || null })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="用全局默认模型" />
              </SelectTrigger>
              <SelectContent>
                {(modelPresets ?? []).map((m) => (
                  <SelectItem key={m.id} value={m.presetId}>
                    {m.name}（{m.presetId}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="默认编排策略">
            <Select
              value={form.defaultStrategy ?? "AUTO"}
              onValueChange={(v) =>
                setForm({ ...form, defaultStrategy: v as AgentStrategy })
              }
            >
              <SelectTrigger className="h-auto min-h-9 py-1.5">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STRATEGY_OPTIONS.map((s) => (
                  <SelectItem key={s.value} value={s.value}>
                    <div className="flex flex-col items-start gap-0.5 text-left">
                      <span>{s.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {s.desc}
                      </span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="允许的策略（全不选 = 不限制）">
            <div className="flex flex-wrap gap-1.5">
              {STRATEGY_OPTIONS.map((s) => {
                const active = allowedStrategies.includes(s.value);
                return (
                  <button
                    key={s.value}
                    type="button"
                    title={s.desc}
                    onClick={() => toggleAllowedStrategy(s.value)}
                    className={cn(
                      "rounded-md border px-2.5 py-1 text-xs transition-colors",
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-background text-muted-foreground hover:border-primary/50 hover:text-foreground",
                    )}
                  >
                    {s.name}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="工具组（可多选；全不选 = 不启用工具）">
            <MultiSelect
              options={toolGroups.map((g) => ({
                value: g.name,
                label: toolGroupName(g.name),
                description: [
                  TOOL_GROUP_META[g.name]?.desc,
                  g.tools.length
                    ? `包含：${g.tools
                        .map(
                          (t) => t.name + (t.requiresApproval ? "·需审批" : ""),
                        )
                        .join("、")}`
                    : "",
                ]
                  .filter(Boolean)
                  .join("；"),
              }))}
              value={selectedGroups}
              onChange={(next) => setForm({ ...form, toolGroups: next })}
              placeholder="选择该智能体可用的工具组"
            />
          </Field>
          <Field label="技能（逗号分隔）">
            <Input
              value={skillsText}
              onChange={(e) => setSkillsText(e.target.value)}
            />
          </Field>
          <Field label="最大步数（1-10，留空不限）">
            <Input
              type="number"
              min={1}
              max={10}
              value={form.maxSteps ?? ""}
              onChange={(e) =>
                setForm({
                  ...form,
                  maxSteps: e.target.value ? Number(e.target.value) : null,
                })
              }
            />
          </Field>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={form.enabled ?? true}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
            />
            启用
          </label>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={handleSubmit} disabled={submitting}>
            {submitting ? "保存中…" : "保存"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
