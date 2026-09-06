import type {
  ModelReasoningCapability,
  ReasoningSelection,
} from "@/api/types";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
 * 复制能力目录声明的默认思考选择
 * @param capability 服务端下发的模型思考能力
 * @returns 返回可安全写进表单的新对象；普通或固定思考模型返回 undefined
 * @description 固定能力不允许提交 reasoning，只有存在可调字段时才采用目录默认值。
 */
export function defaultReasoningSelection(
  capability: ModelReasoningCapability | null | undefined,
): ReasoningSelection | undefined {
  if (!isReasoningConfigurable(capability)) return undefined;
  return capability?.defaultSelection
    ? { ...capability.defaultSelection }
    : undefined;
}

/** 判断能力目录中是否至少有一个可由用户调整的字段。 */
export function isReasoningConfigurable(
  capability: ModelReasoningCapability | null | undefined,
): boolean {
  return Boolean(
    capability?.activation?.configurable ||
      capability?.effort?.configurable ||
      capability?.budget?.configurable,
  );
}

/**
 * 模型思考配置控件
 * @param props 能力目录、当前选择、编辑状态与变更回调
 * @returns 返回由能力投影组合出的开关、强度和预算控件；普通模型不渲染
 * @description 控件不按模型名推断能力。关闭思考时立即清理 effort 和预算，防止提交
 * 服务端必定拒绝的组合；重新开启时恢复目录默认值。
 */
export function ReasoningControls({
  capability,
  value,
  disabled = false,
  onChange,
}: {
  capability: ModelReasoningCapability | null | undefined;
  value: ReasoningSelection | undefined;
  disabled?: boolean;
  onChange: (value: ReasoningSelection | undefined) => void;
}) {
  if (!capability) return null;
  if (!isReasoningConfigurable(capability)) {
    return (
      <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
        该模型的思考模式由供应商固定，调用时无需额外配置。
      </p>
    );
  }

  const selection = value ?? defaultReasoningSelection(capability) ?? {};
  const activation = selection.activation;
  const thinkingDisabled = activation === "disabled";

  return (
    <div className="space-y-2 rounded-md border border-border p-3">
      <p className="text-xs font-medium text-foreground">思考设置</p>
      {capability.activation?.configurable ? (
        <Control label="状态">
          <Select
            value={activation ?? capability.activation.defaultValue}
            disabled={disabled}
            onValueChange={(next) => {
              if (next === "disabled") {
                onChange({ activation: "disabled" });
                return;
              }
              const defaults = defaultReasoningSelection(capability) ?? {};
              onChange({
                ...defaults,
                activation: next as "enabled" | "auto",
              });
            }}
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {capability.activation.values.map((item) => (
                <SelectItem key={item} value={item}>
                  {ACTIVATION_LABELS[item]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Control>
      ) : null}

      {capability.effort?.configurable && !thinkingDisabled ? (
        <Control label="思考强度">
          <Select
            value={selection.effort ?? capability.effort.defaultValue}
            disabled={disabled}
            onValueChange={(effort) =>
              onChange({
                ...selection,
                effort: effort as ReasoningSelection["effort"],
              })
            }
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {capability.effort.values.map((item) => (
                <SelectItem key={item} value={item}>
                  {EFFORT_LABELS[item]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Control>
      ) : null}

      {capability.budget?.configurable && !thinkingDisabled ? (
        <BudgetControl
          capability={capability.budget}
          value={selection.budgetTokens ?? capability.budget.defaultValue}
          disabled={disabled}
          onChange={(budgetTokens) => onChange({ ...selection, budgetTokens })}
        />
      ) : null}
    </div>
  );
}

/**
 * 只读展示模型能力目录中的思考能力
 * @param capability 服务端返回的安全能力投影
 * @returns 返回简短能力摘要，未知模型明确说明不开放思考参数
 */
export function ReasoningCapabilitySummary({
  capability,
}: {
  capability: ModelReasoningCapability | null | undefined;
}) {
  if (!capability) {
    return (
      <p className="text-xs text-muted-foreground">
        未匹配到官方能力目录，按普通模型调用，不能配置思考参数。
      </p>
    );
  }
  const parts: string[] = [];
  if (capability.activation) {
    parts.push(
      capability.activation.configurable
        ? `状态：${capability.activation.values.map((item) => ACTIVATION_LABELS[item]).join("/")}`
        : `状态：${ACTIVATION_LABELS[capability.activation.defaultValue]}（固定）`,
    );
  }
  if (capability.effort) {
    parts.push(
      `强度：${capability.effort.values.map((item) => EFFORT_LABELS[item]).join("/")}`,
    );
  }
  if (capability.budget) {
    const range = [
      capability.budget.minimum,
      capability.budget.maximum,
    ].filter((item): item is number => item !== undefined);
    parts.push(
      `预算：${capability.budget.supportsAuto ? "自动或手动" : "手动"}${range.length ? `（${range.join("–")} token）` : ""}`,
    );
  }
  if (parts.length === 0) {
    parts.push("思考模式由供应商固定，无可调参数");
  }
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      {parts.map((part) => (
        <p key={part}>{part}</p>
      ))}
    </div>
  );
}

function BudgetControl({
  capability,
  value,
  disabled,
  onChange,
}: {
  capability: NonNullable<ModelReasoningCapability["budget"]>;
  value: number | "auto";
  disabled: boolean;
  onChange: (value: number | "auto") => void;
}) {
  return (
    <Control label="思考预算">
      <div className="grid grid-cols-[104px_1fr] gap-2">
        <Select
          value={value === "auto" ? "auto" : "manual"}
          disabled={disabled || !capability.supportsAuto}
          onValueChange={(mode) =>
            onChange(
              mode === "auto"
                ? "auto"
                : typeof capability.defaultValue === "number"
                  ? capability.defaultValue
                  : (capability.minimum ?? 1),
            )
          }
        >
          <SelectTrigger className="h-8">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {capability.supportsAuto ? (
              <SelectItem value="auto">自动</SelectItem>
            ) : null}
            <SelectItem value="manual">手动</SelectItem>
          </SelectContent>
        </Select>
        <Input
          className="h-8"
          type="number"
          min={capability.minimum ?? 1}
          max={capability.maximum}
          value={value === "auto" ? "" : value}
          placeholder={value === "auto" ? "由模型决定" : undefined}
          disabled={disabled || value === "auto"}
          onChange={(event) =>
            onChange(Number(event.target.value) || capability.minimum || 1)
          }
        />
      </div>
      {capability.lessThanMaxOutputTokens ? (
        <p className="text-xs text-muted-foreground">
          手动预算必须小于该模型的最大输出 token。
        </p>
      ) : null}
    </Control>
  );
}

function Control({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">{label}</p>
      {children}
    </div>
  );
}
