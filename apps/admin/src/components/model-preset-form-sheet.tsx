import { useEffect, useState } from "react";
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
import { ApiError } from "@/api/client";
import type { ModelPreset, ModelPresetInput } from "@/api/types";

const PROVIDERS = ["openai", "anthropic"];
const PLATFORMS = ["openai", "anthropic", "deepseek", "kimi", "doubao"];

const EMPTY: ModelPresetInput = {
  presetId: "",
  name: "",
  provider: "openai",
  platform: "openai",
  model: "",
  enabled: true,
  isDefault: false,
};

export function ModelPresetFormSheet({
  preset,
  open,
  onClose,
}: {
  preset: ModelPreset | null;
  open: boolean;
  onClose: () => void;
}) {
  const { create, update } = useModelPresetMutations();
  const [form, setForm] = useState<ModelPresetInput>(EMPTY);

  useEffect(() => {
    if (!open) return;
    if (preset) {
      setForm({
        presetId: preset.presetId,
        name: preset.name,
        description: preset.description,
        provider: preset.provider,
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
  const set = (patch: Partial<ModelPresetInput>) =>
    setForm((f) => ({ ...f, ...patch }));

  const handleSubmit = async () => {
    if (!form.presetId.trim() || !form.name.trim() || !form.model.trim()) {
      toast.error("请填写 presetId、名称、模型");
      return;
    }
    try {
      if (preset) {
        await update.mutateAsync({ id: preset.id, body: form });
        toast.success("已更新");
      } else {
        await create.mutateAsync(form);
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
          <div className="grid grid-cols-2 gap-3">
            <Field label="provider">
              <Select
                value={form.provider}
                onValueChange={(v) => set({ provider: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PROVIDERS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="platform">
              <Select
                value={form.platform}
                onValueChange={(v) => set({ platform: v })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLATFORMS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="模型名">
            <Input
              value={form.model}
              onChange={(e) => set({ model: e.target.value })}
              placeholder="gpt-5.5"
            />
          </Field>
          <Field label="baseURL（留空用 env 默认）">
            <Input
              value={form.baseURL ?? ""}
              onChange={(e) => set({ baseURL: e.target.value || null })}
            />
          </Field>
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
          <p className="text-xs text-muted-foreground">
            API 密钥不在此配置：运行时按 platform 从服务端 env 读取（预设列表会显示是否已配置）。
          </p>
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
