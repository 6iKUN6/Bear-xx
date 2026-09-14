import { useEffect, useRef, useState } from "react";
import { Brain, ChevronDown } from "lucide-react";
import type { ReasoningSelection } from "@litter-bear/types";
import type { ModelReasoningCapability } from "@/api/types";
import {
  isReasoningConfigurable,
  useModelStore,
} from "@/stores/model-store";
import { Switch } from "@/components/Switch";

const EFFORT_LABELS = {
  minimal: "极低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
} as const;

type EffortKey = keyof typeof EFFORT_LABELS;

interface ThinkingMenuProps {
  /** 当前生效的智能体 id；null = 后端默认路由（无具体 agent，不出思考选项） */
  agentId: string | null;
}

/**
 * 思考设置下拉（是否开启思考 / 强度 / 预算）
 * @description 跟随当前选中模型的 reasoningCapability 目录；模型思考不可调时不渲染。
 * 与 ModelMenu 的模型选择分离，但共享 model-store 的 selection——切模型会重置思考为该模型目录默认。
 */
export function ThinkingMenu({ agentId }: ThinkingMenuProps) {
  const options = useModelStore((s) => (agentId ? s.optionsByAgent[agentId] : undefined));
  const selection = useModelStore((s) =>
    agentId ? s.selectionByAgent[agentId] : undefined,
  );
  const ensureOptions = useModelStore((s) => s.ensureOptions);
  const changeReasoning = useModelStore((s) => s.changeReasoning);

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (agentId) {
      void ensureOptions(agentId);
    }
  }, [agentId, ensureOptions]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeydown, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeydown, true);
    };
  }, [open]);

  const selectedModel = options?.models.find(
    (m) => m.modelPresetId === selection?.modelPresetId,
  );
  const capability = selectedModel?.reasoningCapability ?? null;

  // 模型思考由供应商固定（或选项未就绪）时不渲染入口
  if (!options || !selectedModel || !selection || !capability || !isReasoningConfigurable(capability)) {
    return null;
  }

  const reasoning = selection.reasoning ?? capability.defaultSelection ?? {};
  const thinkingOff = reasoning.activation === "disabled";
  const effortKey = (reasoning.effort ?? capability.effort?.defaultValue) as
    | EffortKey
    | undefined;
  const triggerLabel = thinkingOff
    ? "思考关闭"
    : effortKey
      ? `思考 · ${EFFORT_LABELS[effortKey]}`
      : "思考";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="思考设置"
        className={`flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-[12px] font-semibold transition-colors ${
          thinkingOff
            ? "border-[var(--lb-line-soft)] bg-[var(--lb-surface)] text-[var(--lb-text-muted)] hover:border-[var(--lb-line-strong)] hover:text-[var(--lb-text-secondary)]"
            : "border-[var(--lb-accent)] bg-[var(--lb-accent-soft)] text-[var(--lb-accent-ink)]"
        }`}
      >
        <Brain size={13} />
        <span>{triggerLabel}</span>
        <ChevronDown
          size={13}
          className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="absolute bottom-full z-20 mb-1.5 w-[280px] overflow-hidden rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] shadow-[var(--lb-shadow-glow)]">
          <ReasoningFields
            capability={capability}
            value={selection.reasoning}
            onChange={(r) => agentId && changeReasoning(agentId, r)}
          />
        </div>
      )}
    </div>
  );
}

function ReasoningFields({
  capability,
  value,
  onChange,
}: {
  capability: ModelReasoningCapability;
  value: ReasoningSelection | undefined;
  onChange: (reasoning: ReasoningSelection | undefined) => void;
}) {
  const selection = value ?? capability.defaultSelection ?? {};
  const disabled = selection.activation === "disabled";

  // 思考开关的有效「开」值：取目录里第一个非 disabled 项（通常即 enabled），回退 enabled
  const activationValues = capability.activation?.values ?? [];
  const enabledActivation =
    activationValues.find((v) => v !== "disabled") ?? "enabled";

  return (
    <div className="p-2.5">
      <div className="mb-2 text-[11px] font-semibold text-[var(--lb-text-muted)]">
        思考设置
      </div>
      {capability.activation?.configurable && (
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="text-[12px] text-[var(--lb-text-secondary)]">
            是否开启思考
          </span>
          <Switch
            aria-label="是否开启思考"
            checked={!disabled}
            onCheckedChange={(on) =>
              onChange(
                on
                  ? { ...capability.defaultSelection, activation: enabledActivation }
                  : { activation: "disabled" },
              )
            }
          />
        </div>
      )}
      {capability.effort?.configurable && !disabled && (
        <EffortSelect
          values={capability.effort.values}
          selected={selection.effort ?? capability.effort.defaultValue}
          onSelect={(effort) => onChange({ ...selection, effort })}
        />
      )}
      {capability.budget?.configurable && !disabled && (
        <BudgetRow
          capability={capability.budget}
          selection={selection}
          onChange={onChange}
        />
      )}
    </div>
  );
}

function EffortSelect({
  values,
  selected,
  onSelect,
}: {
  values: readonly EffortKey[];
  selected: EffortKey;
  onSelect: (value: EffortKey) => void;
}) {
  return (
    <div className="mb-2 flex items-center justify-between gap-2">
      <span className="text-[12px] text-[var(--lb-text-secondary)]">思考强度</span>
      <div className="relative">
        <select
          value={selected}
          onChange={(e) => onSelect(e.target.value as EffortKey)}
          aria-label="思考强度"
          className="h-7 appearance-none rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] pl-2.5 pr-7 text-[12px] text-[var(--lb-text-primary)] outline-none transition-colors hover:border-[var(--lb-line-strong)] focus:border-[var(--lb-accent)]"
        >
          {values.map((value) => (
            <option key={value} value={value}>
              {EFFORT_LABELS[value]}
            </option>
          ))}
        </select>
        <ChevronDown
          size={13}
          className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-[var(--lb-text-muted)]"
        />
      </div>
    </div>
  );
}

function BudgetRow({
  capability,
  selection,
  onChange,
}: {
  capability: NonNullable<ModelReasoningCapability["budget"]>;
  selection: ReasoningSelection;
  onChange: (reasoning: ReasoningSelection | undefined) => void;
}) {
  const isAuto = selection.budgetTokens === "auto";
  return (
    <div className="mb-1">
      <ChoiceRow
        label="预算"
        values={capability.supportsAuto ? (["auto", "manual"] as const) : (["manual"] as const)}
        selected={isAuto ? "auto" : "manual"}
        getLabel={(v) => (v === "auto" ? "自动" : "手动")}
        onSelect={(mode) =>
          onChange({
            ...selection,
            budgetTokens:
              mode === "auto"
                ? "auto"
                : typeof capability.defaultValue === "number"
                  ? capability.defaultValue
                  : (capability.minimum ?? 1),
          })
        }
      />
      {!isAuto && (
        <input
          type="number"
          min={capability.minimum ?? 1}
          max={capability.maximum}
          value={
            typeof selection.budgetTokens === "number"
              ? selection.budgetTokens
              : typeof capability.defaultValue === "number"
                ? capability.defaultValue
                : (capability.minimum ?? 1)
          }
          onChange={(e) =>
            onChange({
              ...selection,
              budgetTokens: Number(e.target.value) || capability.minimum || 1,
            })
          }
          className="h-8 w-full rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-soft)] bg-[var(--lb-page-background)] px-2 text-[12px] outline-none focus:border-[var(--lb-accent)]"
        />
      )}
    </div>
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
  values: readonly T[];
  selected: T;
  getLabel: (value: T) => string;
  onSelect: (value: T) => void;
}) {
  return (
    <div className="mb-2">
      <div className="mb-1 text-[11px] text-[var(--lb-text-muted)]">{label}</div>
      <div className="flex flex-wrap gap-1">
        {values.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => onSelect(value)}
            className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${
              selected === value
                ? "border-[var(--lb-accent)] bg-[var(--lb-accent-soft)] text-[var(--lb-accent-ink)]"
                : "border-[var(--lb-line-soft)] bg-[var(--lb-surface)] text-[var(--lb-text-secondary)] hover:bg-[var(--lb-surface-hover)]"
            }`}
          >
            {getLabel(value)}
          </button>
        ))}
      </div>
    </div>
  );
}
