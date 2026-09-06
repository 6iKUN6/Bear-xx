import { useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { ApiError } from "@/api/client";
import type {
  CreateModelPresetInput,
  ModelProviderConnection,
  ModelProviderTemplate,
  UpstreamFormat,
} from "@/api/types";
import { confirm } from "@/components/confirm-dialog";
import { ModelProviderLogo } from "@/components/model-provider-logo";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useModelProviderConnectionMutations } from "@/hooks/queries";
import { upstreamFormatName } from "@/lib/model-preset-meta";

interface CustomModelRow {
  id: number;
  name: string;
  model: string;
  upstreamFormat: UpstreamFormat;
}

export function ModelProviderConnectionSheet({
  template,
  connection,
  onClose,
}: {
  template: ModelProviderTemplate;
  connection: ModelProviderConnection | null;
  onClose: () => void;
}) {
  const { create, update, probe } = useModelProviderConnectionMutations();
  const [name, setName] = useState(connection?.name ?? `${template.name} 官方`);
  const [baseURL, setBaseURL] = useState(
    connection?.baseURL ?? template.defaultBaseURL ?? "",
  );
  const [apiKey, setApiKey] = useState("");
  const [enabled, setEnabled] = useState(connection?.enabled ?? true);
  const [setFirstModelAsDefault, setSetFirstModelAsDefault] = useState(false);
  const [selectedRecommended, setSelectedRecommended] = useState<
    ReadonlySet<string>
  >(
    new Set(
      connection || template.recommendedModels.length === 0
        ? []
        : [template.recommendedModels[0].model],
    ),
  );
  const [customModels, setCustomModels] = useState<CustomModelRow[]>(() =>
    !connection && template.recommendedModels.length === 0
      ? [newCustomModel(1, template.defaultUpstreamFormat)]
      : [],
  );
  const submitting = create.isPending || update.isPending || probe.isPending;

  const initialModels = useMemo<CreateModelPresetInput[]>(() => {
    const recommended = template.recommendedModels
      .filter((model) => selectedRecommended.has(model.model))
      .map((model) => ({
        name: model.name,
        model: model.model,
        upstreamFormat: model.upstreamFormat,
        enabled: true,
      }));
    const custom = customModels
      .filter((model) => model.name.trim() && model.model.trim())
      .map((model) => ({
        name: model.name.trim(),
        model: model.model.trim(),
        upstreamFormat: model.upstreamFormat,
        enabled: true,
      }));
    return [...recommended, ...custom].map((model, index) => ({
      ...model,
      isDefault: setFirstModelAsDefault && index === 0,
    }));
  }, [
    customModels,
    selectedRecommended,
    setFirstModelAsDefault,
    template.recommendedModels,
  ]);

  const handleSubmit = async () => {
    if (!name.trim() || !baseURL.trim()) {
      toast.error("请填写连接名称和 API 根地址");
      return;
    }
    if (!connection && !apiKey.trim()) {
      toast.error("请填写 API Key");
      return;
    }
    if (!connection && initialModels.length === 0) {
      toast.error("至少选择或填写一个模型");
      return;
    }

    try {
      if (connection) {
        const affectsRuntime =
          baseURL.trim() !== connection.baseURL ||
          Boolean(apiKey.trim()) ||
          enabled !== connection.enabled;
        if (
          affectsRuntime &&
          !(await confirm({
            description: `这会影响 ${connection.models.length} 个模型、${connection.agentReferenceCount} 个智能体和 ${connection.flowReferenceCount} 个 Flow。${!enabled && connection.models.some((model) => model.isDefault) ? "其中包含全局默认模型；停用后系统不会自动切换到其它连接。" : ""}确定继续？`,
            danger: !enabled,
          }))
        ) {
          return;
        }
        await update.mutateAsync({
          id: connection.id,
          body: {
            name: name.trim(),
            baseURL: baseURL.trim(),
            enabled,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          },
        });
        toast.success("连接已更新");
        onClose();
        return;
      }

      const created = await create.mutateAsync({
        providerKey: template.providerKey,
        name: name.trim(),
        baseURL: baseURL.trim(),
        apiKey: apiKey.trim(),
        enabled,
        models: initialModels,
      });
      const probeModel = created.models.find((model) => model.enabled);
      if (!probeModel || !enabled) {
        toast.success("连接已保存，当前未启用，未执行测试");
        onClose();
        return;
      }
      try {
        const result = await probe.mutateAsync({
          id: created.id,
          modelPresetId: probeModel.id,
        });
        if (result.reachable) {
          toast.success("连接已保存并通过基础连通性测试");
        } else {
          toast.warning(
            `连接已保存，但测试未通过${result.error ? `：${result.error}` : ""}`,
          );
        }
      } catch (error) {
        toast.warning(
          `连接已保存，但测试未完成：${error instanceof ApiError ? error.message : "请求失败"}`,
        );
      }
      onClose();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : "保存失败");
    }
  };

  const toggleRecommended = (model: string) => {
    setSelectedRecommended((selected) => {
      const next = new Set(selected);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });
  };

  const updateCustom = (id: number, patch: Partial<CustomModelRow>) =>
    setCustomModels((models) =>
      models.map((model) => (model.id === id ? { ...model, ...patch } : model)),
    );

  const requestPath = requestEndpointPreview(
    connection?.models[0]?.upstreamFormat ??
      initialModels[0]?.upstreamFormat ??
      template.defaultUpstreamFormat,
  );

  return (
    <Sheet open onOpenChange={(open) => !open && !submitting && onClose()}>
      <SheetContent className="max-w-2xl">
        <SheetHeader>
          <SheetTitle>{connection ? "编辑连接" : "添加供应商连接"}</SheetTitle>
        </SheetHeader>

        <div className="flex items-center gap-3 border-y border-border py-3">
          <ModelProviderLogo
            providerKey={template.providerKey}
            name={template.name}
          />
          <div>
            <p className="font-medium text-foreground">{template.name}</p>
            <p className="text-xs text-muted-foreground">
              供应商类型创建后不可修改
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <Field label="连接名称">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={100}
            />
          </Field>

          <Field label="API 根地址">
            <Input
              value={baseURL}
              onChange={(event) => setBaseURL(event.target.value)}
              placeholder="https://api.example.com/v1"
              maxLength={500}
            />
            <p className="break-all text-xs text-muted-foreground">
              请求端点预览：{baseURL.trim().replace(/\/+$/, "") || "根地址"}
              {requestPath}
            </p>
          </Field>

          <Field
            label={
              connection
                ? `API Key（${connection.apiKeyHint ?? "已配置"}，留空不修改）`
                : "API Key"
            }
          >
            <Input
              type="password"
              autoComplete="new-password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={connection ? "保持现有密钥" : "sk-..."}
            />
            <p className="text-xs text-muted-foreground">
              密钥加密保存，之后只显示不可逆指纹尾部。
            </p>
          </Field>

          <label className="flex items-center gap-2 border-y border-border py-3 text-sm text-foreground">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            启用连接
          </label>

          {!connection ? (
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium text-foreground">初始模型</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  至少添加一个模型。保存后将用首个启用模型执行基础连接测试。
                </p>
              </div>

              {template.recommendedModels.length > 0 ? (
                <div className="divide-y divide-border border-y border-border">
                  {template.recommendedModels.map((model) => (
                    <label
                      key={model.model}
                      className="flex cursor-pointer items-center justify-between gap-3 py-3"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <input
                          type="checkbox"
                          checked={selectedRecommended.has(model.model)}
                          onChange={() => toggleRecommended(model.model)}
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-foreground">
                            {model.name}
                          </span>
                          <span className="block truncate font-mono text-xs text-muted-foreground">
                            {model.model}
                          </span>
                        </span>
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {upstreamFormatName(model.upstreamFormat)}
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}

              {customModels.map((model) => (
                <div
                  key={model.id}
                  className="flex items-end gap-2 border-b border-border pb-3"
                >
                  <div className="grid min-w-0 flex-1 grid-cols-1 gap-2 sm:grid-cols-2">
                    <Field label="模型名称">
                      <Input
                        value={model.name}
                        onChange={(event) =>
                          updateCustom(model.id, { name: event.target.value })
                        }
                        placeholder="显示名称"
                      />
                    </Field>
                    <Field label="模型 ID">
                      <Input
                        value={model.model}
                        onChange={(event) =>
                          updateCustom(model.id, { model: event.target.value })
                        }
                        placeholder="供应商模型 ID"
                      />
                    </Field>
                    {template.allowedUpstreamFormats.length > 1 ? (
                      <div className="sm:col-span-2">
                        <Select
                          value={model.upstreamFormat}
                          onValueChange={(value) =>
                            updateCustom(model.id, {
                              upstreamFormat: value as UpstreamFormat,
                            })
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
                      </div>
                    ) : null}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="移除自定义模型"
                    onClick={() =>
                      setCustomModels((models) =>
                        models.filter((item) => item.id !== model.id),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}

              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setCustomModels((models) => [
                    ...models,
                    newCustomModel(
                      Math.max(0, ...models.map((model) => model.id)) + 1,
                      template.defaultUpstreamFormat,
                    ),
                  ])
                }
              >
                <Plus className="h-4 w-4" />
                手动添加模型
              </Button>

              <label className="flex items-start gap-2 border-t border-border pt-3 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={setFirstModelAsDefault}
                  onChange={(event) =>
                    setSetFirstModelAsDefault(event.target.checked)
                  }
                  disabled={initialModels.length === 0}
                />
                <span>
                  将首个模型设为全局默认
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    勾选后会替换当前全局默认；不勾选则保留现状。
                  </span>
                </span>
              </label>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              更改 URL、密钥或重新启用连接，会把其下全部模型重置为未探测。
            </p>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            取消
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting
              ? connection
                ? "保存中..."
                : "保存并测试中..."
              : connection
                ? "保存"
                : "保存并测试"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function newCustomModel(
  id: number,
  upstreamFormat: UpstreamFormat,
): CustomModelRow {
  return { id, name: "", model: "", upstreamFormat };
}

function requestEndpointPreview(format: UpstreamFormat): string {
  if (format === "openai_responses") return "/responses";
  if (format === "anthropic_messages") return "/messages";
  return "/chat/completions";
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
