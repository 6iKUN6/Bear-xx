import { Input, Text, View } from "@tarojs/components";
import AppIcon from "../AppIcon";
import type {
  AgentModelOptionDto,
  ModelReasoningCapabilityDto,
  ReasoningSelectionDto,
} from "../../api/generated/models";
import { appGlassCardClass } from "../../utils/style";

const ACTIVATION_LABELS = {
  enabled: "开启",
  disabled: "关闭",
  auto: "自动",
} as const;

const EFFORT_LABELS = {
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
} as const;

/**
 * 终端模型与思考设置底部面板
 * @param props 允许模型、当前选择及变更回调
 * @returns 返回模型单选与由服务端能力目录驱动的思考控件
 * @description 不按模型名推断档位；固定思考只展示状态，普通模型不展示思考区。
 */
export default function ModelSelectionSheet({
  models,
  selectedModel,
  reasoning,
  onSelectModel,
  onChangeReasoning,
  onClose,
}: {
  models: AgentModelOptionDto[];
  selectedModel: AgentModelOptionDto;
  reasoning: ReasoningSelectionDto | undefined;
  onSelectModel: (model: AgentModelOptionDto) => void;
  onChangeReasoning: (reasoning: ReasoningSelectionDto | undefined) => void;
  onClose: () => void;
}) {
  return (
    <View
      className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/40"
      onClick={onClose}
    >
      <View
        className="box-border max-h-[75vh] w-full overflow-y-auto rounded-t-[var(--lb-radius-md)] bg-[var(--lb-page-background)] px-[1rem] pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[1rem]"
        onClick={(event) => event.stopPropagation()}
      >
        <View className="mb-[0.75rem] flex items-center justify-between">
          <Text className="text-[1.0625rem] font-semibold text-[var(--lb-text-primary)]">
            模型与思考
          </Text>
          <View
            className="flex h-[2rem] w-[2rem] items-center justify-center text-[var(--lb-text-muted)]"
            onClick={onClose}
          >
            <AppIcon name="close" className="h-[1rem] w-[1rem]" />
          </View>
        </View>

        {models.length > 1 ? (
          <View className="flex flex-col gap-[0.5rem]">
            {models.map((model) => {
              const active = model.modelPresetId === selectedModel.modelPresetId;
              return (
                <View
                  key={model.modelPresetId}
                  className={`${appGlassCardClass} box-border flex items-center justify-between px-[0.875rem] py-[0.75rem] ${active ? "border-[var(--lb-accent)] bg-[var(--lb-accent-soft)]" : ""}`}
                  onClick={() => onSelectModel(model)}
                >
                  <View className="min-w-0">
                    <Text className="block overflow-hidden text-ellipsis whitespace-nowrap text-[0.875rem] font-semibold text-[var(--lb-text-primary)]">
                      {model.name}
                    </Text>
                    <Text className="mt-[0.125rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.6875rem] text-[var(--lb-text-muted)]">
                      {model.providerKey} · {model.model}
                    </Text>
                  </View>
                  {active ? (
                    <AppIcon name="check" className="h-[1rem] w-[1rem] shrink-0 text-[var(--lb-accent-ink)]" />
                  ) : null}
                </View>
              );
            })}
          </View>
        ) : null}

        <ReasoningFields
          capability={selectedModel.reasoningCapability}
          value={reasoning}
          onChange={onChangeReasoning}
        />
      </View>
    </View>
  );
}

function ReasoningFields({
  capability,
  value,
  onChange,
}: {
  capability: ModelReasoningCapabilityDto | null;
  value: ReasoningSelectionDto | undefined;
  onChange: (reasoning: ReasoningSelectionDto | undefined) => void;
}) {
  if (!capability) return null;
  const configurable = Boolean(
    capability.activation?.configurable ||
      capability.effort?.configurable ||
      capability.budget?.configurable,
  );
  if (!configurable) {
    return (
      <Text className="mt-[0.75rem] block text-[0.75rem] text-[var(--lb-text-muted)]">
        该模型的思考模式由供应商固定。
      </Text>
    );
  }
  const selection = value ?? capability.defaultSelection ?? {};
  const disabled = selection.activation === "disabled";
  return (
    <View className="mt-[0.875rem] border-t border-[var(--lb-line-soft)] pt-[0.875rem]">
      <Text className="mb-[0.625rem] block text-[0.8125rem] font-semibold text-[var(--lb-text-primary)]">
        思考设置
      </Text>
      {capability.activation?.configurable ? (
        <ChoiceRow
          label="状态"
          values={capability.activation.values}
          selected={selection.activation ?? capability.activation.defaultValue}
          getLabel={(item) => ACTIVATION_LABELS[item]}
          onSelect={(activation) =>
            onChange(
              activation === "disabled"
                ? { activation: "disabled" }
                : { ...capability.defaultSelection, activation },
            )
          }
        />
      ) : null}
      {capability.effort?.configurable && !disabled ? (
        <ChoiceRow
          label="强度"
          values={capability.effort.values}
          selected={selection.effort ?? capability.effort.defaultValue}
          getLabel={(item) => EFFORT_LABELS[item]}
          onSelect={(effort) => onChange({ ...selection, effort })}
        />
      ) : null}
      {capability.budget?.configurable && !disabled ? (
        <View className="mb-[0.75rem]">
          <ChoiceRow
            label="预算"
            values={capability.budget.supportsAuto ? ["auto", "manual"] : ["manual"]}
            selected={selection.budgetTokens === "auto" ? "auto" : "manual"}
            getLabel={(item) => (item === "auto" ? "自动" : "手动")}
            onSelect={(mode) =>
              onChange({
                ...selection,
                budgetTokens:
                  mode === "auto"
                    ? "auto"
                    : typeof capability.budget?.defaultValue === "number"
                      ? capability.budget.defaultValue
                      : (capability.budget?.minimum ?? 1),
              })
            }
          />
          {selection.budgetTokens !== "auto" ? (
            <Input
              type="number"
              className="box-border h-[2.25rem] rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-[0.75rem] text-[0.8125rem]"
              value={String(
                selection.budgetTokens ?? capability.budget.defaultValue,
              )}
              onInput={(event) =>
                onChange({
                  ...selection,
                  budgetTokens:
                    Number(event.detail.value) || capability.budget?.minimum || 1,
                })
              }
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ChoiceRow<T extends string>({
  label,
  values,
  selected,
  getLabel,
  onSelect,
}: {
  label: string;
  values: T[];
  selected: T;
  getLabel: (value: T) => string;
  onSelect: (value: T) => void;
}) {
  return (
    <View className="mb-[0.75rem]">
      <Text className="mb-[0.375rem] block text-[0.6875rem] text-[var(--lb-text-muted)]">
        {label}
      </Text>
      <View className="flex flex-wrap gap-[0.375rem]">
        {values.map((value) => (
          <View
            key={value}
            className={`rounded-full border px-[0.75rem] py-[0.375rem] text-[0.75rem] ${selected === value ? "border-[var(--lb-accent)] bg-[var(--lb-accent-soft)] text-[var(--lb-accent-ink)]" : "border-[var(--lb-line-soft)] bg-[var(--lb-surface)] text-[var(--lb-text-secondary)]"}`}
            onClick={() => onSelect(value)}
          >
            {getLabel(value)}
          </View>
        ))}
      </View>
    </View>
  );
}
