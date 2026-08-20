import { useEffect, useState } from "react";
import { Check, Loader2, X, Zap } from "lucide-react";
import { toast } from "sonner";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useModelPresetMutations } from "@/hooks/queries";
import {
  UPSTREAM_FORMAT_OPTIONS,
  capabilityMeta,
  upstreamFormatMeta,
} from "@/lib/model-preset-meta";
import { ApiError } from "@/api/client";
import type {
  ModelPreset,
  ModelPresetInput,
  ModelPresetProbeResult,
  UpstreamFormat,
} from "@/api/types";

const EMPTY: ModelPresetInput = {
  presetId: "",
  name: "",
  upstreamFormat: "openai_chat_completions",
  platform: "openai",
  model: "",
  enabled: true,
  isDefault: false,
};

/** 改动其中任一字段，先前的探测结论即失效 */
const CONNECTION_FIELDS: Array<keyof ModelPresetInput> = [
  "upstreamFormat",
  "platform",
  "model",
  "baseURL",
  "apiKey",
];

export function ModelPresetFormSheet({
  preset,
  open,
  onClose,
}: {
  preset: ModelPreset | null;
  open: boolean;
  onClose: () => void;
}) {
  const { create, update, probeDraft } = useModelPresetMutations();
  const [form, setForm] = useState<ModelPresetInput>(EMPTY);
  const [probeResult, setProbeResult] = useState<ModelPresetProbeResult | null>(
    null,
  );

  useEffect(() => {
    if (!open) return;
    setProbeResult(null);
    if (preset) {
      setForm({
        presetId: preset.presetId,
        name: preset.name,
        description: preset.description,
        upstreamFormat: preset.upstreamFormat,
        platform: preset.platform,
        model: preset.model,
        baseURL: preset.baseURL,
        temperature: preset.temperature,
        maxOutputTokens: preset.maxOutputTokens,
        topP: preset.topP,
        enabled: preset.enabled,
        isDefault: preset.isDefault,
      });
    } else {
      setForm(EMPTY);
    }
  }, [preset, open]);

  const submitting = create.isPending || update.isPending;
  const formatMeta = upstreamFormatMeta(form.upstreamFormat);

  const set = (patch: Partial<ModelPresetInput>) => {
    // 连接参数一变，旧结论就不再描述当前表单——留着它等于给出一个过期的绿灯
    if (
      Object.keys(patch).some((key) =>
        CONNECTION_FIELDS.includes(key as keyof ModelPresetInput),
      )
    ) {
      setProbeResult(null);
    }
    setForm((f) => ({ ...f, ...patch }));
  };

  const apiKey = form.apiKey?.trim();
  const canProbe = Boolean(apiKey && form.model.trim() && form.platform.trim());

  const handleProbe = async () => {
    try {
      setProbeResult(
        await probeDraft.mutateAsync({
          upstreamFormat: form.upstreamFormat,
          platform: form.platform.trim(),
          model: form.model.trim(),
          baseURL: form.baseURL?.trim() || undefined,
          apiKey,
        }),
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "探测失败");
    }
  };

  const handleSubmit = async () => {
    if (!form.presetId.trim() || !form.name.trim() || !form.model.trim()) {
      toast.error("请填写 presetId、名称、模型");
      return;
    }
    // 留空不提交该字段，服务端据此保持已存密钥不变
    const body: ModelPresetInput = { ...form, apiKey: apiKey || undefined };
    try {
      if (preset) {
        await update.mutateAsync({ id: preset.id, body });
        toast.success("已更新");
      } else {
        await create.mutateAsync(body);
        toast.success("已创建");
      }
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "保存失败");
    }
  };

  const numOrNull = (v: string) => (v === "" ? null : Number(v));

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{preset ? "编辑模型预设" : "新建模型预设"}</SheetTitle>
        </SheetHeader>

        <div className="space-y-4">
          <Field label="presetId（供 agent 引用，如 openai:gpt-5.5）">
            <Input
              value={form.presetId}
              onChange={(e) => set({ presetId: e.target.value })}
              disabled={Boolean(preset)}
            />
          </Field>
          <Field label="名称">
            <Input
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </Field>
          <Field label="描述">
            <Input
              value={form.description ?? ""}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>

          <Field label="上游格式">
            <Select
              value={form.upstreamFormat}
              onValueChange={(v) =>
                set({ upstreamFormat: v as UpstreamFormat })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UPSTREAM_FORMAT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {formatMeta ? (
              <p className="text-xs text-muted-foreground">
                {formatMeta.desc} · SDK：{formatMeta.provider}
              </p>
            ) : null}
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="platform（分组标签，可自由填写）">
              <Input
                value={form.platform}
                onChange={(e) => set({ platform: e.target.value })}
                placeholder="openai / kimi / 自建中转站"
              />
            </Field>
            <Field label="模型名">
              <Input
                value={form.model}
                onChange={(e) => set({ model: e.target.value })}
                placeholder="gpt-5.5"
              />
            </Field>
          </div>

          <Field label="baseURL（留空用 SDK 默认地址）">
            <Input
              value={form.baseURL ?? ""}
              onChange={(e) => set({ baseURL: e.target.value || null })}
            />
          </Field>

          <Field
            label={
              preset?.apiKeyConfigured
                ? `apiKey（已配置 ${preset.apiKeyHint ?? ""}，留空则不修改）`
                : "apiKey"
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={form.apiKey ?? ""}
              onChange={(e) => set({ apiKey: e.target.value })}
              placeholder={preset?.apiKeyConfigured ? "••••••••" : "sk-..."}
            />
            <p className="text-xs text-muted-foreground">
              提交后加密存库，此后永不回显，页面只显示指纹尾部。
            </p>
          </Field>

          <div className="space-y-2 rounded-md border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-medium text-foreground">
                连接探测
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleProbe}
                disabled={!canProbe || probeDraft.isPending}
              >
                {probeDraft.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Zap className="h-4 w-4" />
                )}
                测试连接
              </Button>
            </div>
            {probeResult ? (
              <div className="space-y-1">
                <ProbeStage ok={probeResult.reachable} label="连通性" />
                <ProbeStage
                  ok={probeResult.toolRoundTrip}
                  label="工具调用往返"
                />
                {probeResult.error ? (
                  <p className="pt-1 text-xs text-[var(--lb-danger)]">
                    {probeResult.error}
                  </p>
                ) : null}
                <p className="pt-1 text-xs text-muted-foreground">
                  结论：{capabilityMeta(probeResult.capability).name} —{" "}
                  {capabilityMeta(probeResult.capability).desc}
                </p>
                <p className="text-xs text-muted-foreground">
                  这次结果不会存库；保存后可在列表页用已存密钥复测，届时才写回档位。
                </p>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                {canProbe
                  ? "测试将真实调用一次上游，验证连通性与工具调用闭环。"
                  : "填入 apiKey、platform 与模型名后可先测再存；已保存的预设可在列表页用已存密钥测试。"}
              </p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-3">
            <Field label="temperature">
              <Input
                type="number"
                value={form.temperature ?? ""}
                onChange={(e) => set({ temperature: numOrNull(e.target.value) })}
              />
            </Field>
            <Field label="maxTokens">
              <Input
                type="number"
                value={form.maxOutputTokens ?? ""}
                onChange={(e) =>
                  set({ maxOutputTokens: numOrNull(e.target.value) })
                }
              />
            </Field>
            <Field label="topP">
              <Input
                type="number"
                value={form.topP ?? ""}
                onChange={(e) => set({ topP: numOrNull(e.target.value) })}
              />
            </Field>
          </div>
          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={form.enabled ?? true}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              启用
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={form.isDefault ?? false}
                onChange={(e) => set({ isDefault: e.target.checked })}
              />
              设为默认
            </label>
          </div>
          {preset ? (
            <p className="text-xs text-muted-foreground">
              改动格式、模型、baseURL 或密钥后，服务端会把能力档位重置为「未探测」，需重新测试连接。
            </p>
          ) : null}
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

function ProbeStage({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {ok ? (
        <Check className="h-3.5 w-3.5 text-[var(--lb-success)]" />
      ) : (
        <X className="h-3.5 w-3.5 text-[var(--lb-danger)]" />
      )}
      <span className={ok ? "text-foreground" : "text-muted-foreground"}>
        {label}
      </span>
    </div>
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
