import { useState } from "react";
import { toast } from "sonner";
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
import { confirm } from "@/components/confirm-dialog";
import {
  useModelPresetMutations,
  useModelPresetReferences,
} from "@/hooks/queries";
import {
  capabilityMeta,
  upstreamFormatMeta,
  upstreamFormatName,
} from "@/lib/model-preset-meta";
import { versionStatusMeta } from "@/lib/flow-meta";
import { ApiError } from "@/api/client";
import { ReasoningCapabilitySummary } from "@/components/reasoning-controls";
import type {
  CreateModelPresetInput,
  ModelPreset,
  ModelProviderConnection,
  ModelProviderTemplate,
  UpstreamFormat,
} from "@/api/types";

export function ModelPresetFormSheet({
  connection,
  template,
  preset,
  onClose,
}: {
  connection: ModelProviderConnection;
  template: ModelProviderTemplate;
  preset: ModelPreset | null;
  onClose: () => void;
}) {
  const { create, update } = useModelPresetMutations();
  const references = useModelPresetReferences(preset?.id ?? null);
  const [form, setForm] = useState<CreateModelPresetInput>(() => ({
    name: preset?.name ?? "",
    description: preset?.description ?? "",
    upstreamFormat: preset?.upstreamFormat ?? template.defaultUpstreamFormat,
    model: preset?.model ?? "",
    temperature: preset?.temperature ?? null,
    maxOutputTokens: preset?.maxOutputTokens ?? null,
    topP: preset?.topP ?? null,
    enabled: preset?.enabled ?? true,
    isDefault: preset?.isDefault ?? false,
  }));
  const submitting =
    create.isPending || update.isPending || references.isFetching;
  const formatMeta = upstreamFormatMeta(form.upstreamFormat);
  const reasoningCapability =
    preset &&
    form.model.trim() === preset.model &&
    form.upstreamFormat === preset.upstreamFormat
      ? preset.reasoningCapability
      : (template.recommendedModels.find(
          (model) =>
            model.model === form.model.trim() &&
            model.upstreamFormat === form.upstreamFormat,
        )?.reasoningCapability ?? null);
  const hideTemperature =
    reasoningCapability?.temperaturePolicy === "forbidden";
  const hideTopP = reasoningCapability?.topPPolicy === "forbidden";
  const set = (patch: Partial<CreateModelPresetInput>) =>
    setForm((current) => ({ ...current, ...patch }));

  const handleSubmit = async () => {
    if (!form.name.trim() || !form.model.trim()) {
      toast.error("请填写模型名称和模型 ID");
      return;
    }
    const body: CreateModelPresetInput = {
      ...form,
      name: form.name.trim(),
      model: form.model.trim(),
      description: form.description?.trim(),
      temperature: hideTemperature ? null : form.temperature,
      topP: hideTopP ? null : form.topP,
    };
    try {
      if (preset) {
        if (preset.enabled && body.enabled === false) {
          const latestReferences = await references.refetch();
          if (latestReferences.isError || !latestReferences.data) {
            toast.error(
              latestReferences.error instanceof ApiError
                ? latestReferences.error.message
                : "无法确认模型影响范围，请稍后重试",
            );
            return;
          }
          const impact = latestReferences.data;
          const defaultWarning = preset.isDefault
            ? "该模型还是系统默认模型；停用后系统级任务不会自动切换到其它模型。"
            : "";
          if (
            !(await confirm({
              description: `停用「${preset.name}」会影响 ${impact.agentCount} 个智能体、${impact.flowCount} 个 Flow 和 ${impact.taskCount} 个运行中任务。${defaultWarning}确定继续？`,
              danger: true,
            }))
          ) {
            return;
          }
        }
        await update.mutateAsync({ id: preset.id, body });
        toast.success("模型已更新");
      } else {
        await create.mutateAsync({ connectionId: connection.id, body });
        toast.success("模型已添加，请执行能力探测");
      }
      onClose();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "保存失败");
    }
  };

  return (
    <Sheet open onOpenChange={(open) => !open && !submitting && onClose()}>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{preset ? "编辑模型" : "添加模型"}</SheetTitle>
        </SheetHeader>

        <div className="space-y-4">
          <div className="border-y border-border py-3 text-sm">
            <p className="font-medium text-foreground">{connection.name}</p>
            <p className="mt-1 break-all text-xs text-muted-foreground">
              {connection.baseURL}
            </p>
          </div>

          {preset ? (
            <Field label="模型预设 ID">
              <Input value={preset.presetId} disabled />
              <p className="text-xs text-muted-foreground">
                创建后保持不变，Agent 和 Flow 使用该 ID 引用模型。
              </p>
            </Field>
          ) : null}

          <Field label="模型名称">
            <Input
              value={form.name}
              onChange={(event) => set({ name: event.target.value })}
              placeholder="例如 DeepSeek Chat"
              maxLength={100}
            />
          </Field>

          <Field label="模型 ID">
            <Input
              value={form.model}
              onChange={(event) => set({ model: event.target.value })}
              placeholder="例如 deepseek-chat"
              maxLength={200}
            />
            {preset ? (
              <p className="text-xs text-muted-foreground">
                修改模型 ID 会将该模型重置为未探测，不影响预设 ID。
              </p>
            ) : null}
          </Field>

          <Field label="上游格式">
            <Select
              value={form.upstreamFormat}
              onValueChange={(value) =>
                set({ upstreamFormat: value as UpstreamFormat })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {template.allowedUpstreamFormats.map((format) => (
                  <SelectItem key={format} value={format}>
                    {upstreamFormatName(format)}
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

          <Field label="描述">
            <Textarea
              value={form.description ?? ""}
              onChange={(event) => set({ description: event.target.value })}
              maxLength={500}
            />
          </Field>

          <Field label="思考能力">
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
              <ReasoningCapabilitySummary capability={reasoningCapability} />
            </div>
          </Field>

          {reasoningCapability?.temperaturePolicy ===
            "forbidden_when_enabled" ||
          reasoningCapability?.topPPolicy === "forbidden_when_enabled" ? (
            <p className="text-xs text-[var(--lb-warning)]">
              该模型开启思考时不接受
              {reasoningCapability.temperaturePolicy ===
              "forbidden_when_enabled"
                ? " temperature"
                : ""}
              {reasoningCapability.temperaturePolicy ===
                "forbidden_when_enabled" &&
              reasoningCapability.topPPolicy === "forbidden_when_enabled"
                ? " /"
                : ""}
              {reasoningCapability.topPPolicy === "forbidden_when_enabled"
                ? " topP"
                : ""}
              ，需要使用思考模式时请将对应参数留空。
            </p>
          ) : null}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {!hideTemperature ? (
              <Field label="temperature">
                <Input
                  type="number"
                  min={0}
                  max={2}
                  step="0.1"
                  value={form.temperature ?? ""}
                  onChange={(event) =>
                    set({ temperature: numberOrNull(event.target.value) })
                  }
                />
              </Field>
            ) : null}
            <Field label="maxTokens">
              <Input
                type="number"
                min={1}
                value={form.maxOutputTokens ?? ""}
                onChange={(event) =>
                  set({ maxOutputTokens: numberOrNull(event.target.value) })
                }
              />
            </Field>
            {!hideTopP ? (
              <Field label="topP">
                <Input
                  type="number"
                  min={0}
                  max={1}
                  step="0.1"
                  value={form.topP ?? ""}
                  onChange={(event) =>
                    set({ topP: numberOrNull(event.target.value) })
                  }
                />
              </Field>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-5 border-y border-border py-3">
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={form.enabled ?? true}
                onChange={(event) => set({ enabled: event.target.checked })}
              />
              启用模型
            </label>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={form.isDefault ?? false}
                onChange={(event) => set({ isDefault: event.target.checked })}
              />
              设为系统默认模型
            </label>
          </div>

          {preset ? (
            <div className="space-y-3 border-t border-border pt-3">
              <p className="text-xs text-muted-foreground">
                当前能力：{capabilityMeta(preset.capability).name}。修改模型 ID
                或协议后需要重新执行能力探测。
              </p>
              <div>
                <p className="text-sm font-medium text-foreground">引用位置</p>
                {references.isLoading ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    正在查询引用...
                  </p>
                ) : references.error ? (
                  <p className="mt-1 text-xs text-[var(--lb-danger)]">
                    {references.error instanceof ApiError
                      ? references.error.message
                      : "引用查询失败"}
                  </p>
                ) : references.data?.items.length ? (
                  <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto text-xs text-muted-foreground">
                    {references.data.items.map((reference) => (
                      <li
                        key={`${reference.type}:${reference.id}:${reference.versionId ?? "agent"}`}
                      >
                        {reference.type === "agent"
                          ? `智能体 · ${reference.name}`
                          : reference.type === "flow"
                            ? `Flow · ${reference.name} · v${reference.version ?? "-"} · ${reference.status ? versionStatusMeta(reference.status).name : "未知状态"}`
                            : `运行中任务 · ${reference.id} · ${reference.status ?? "未知状态"}`}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-muted-foreground">
                    暂无智能体、有效 Flow 版本或运行中任务引用
                  </p>
                )}
              </div>
            </div>
          ) : null}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? "保存中..." : "保存"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function numberOrNull(value: string): number | null {
  return value === "" ? null : Number(value);
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
