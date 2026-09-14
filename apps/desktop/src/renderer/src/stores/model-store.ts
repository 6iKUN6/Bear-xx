import { create } from "zustand";
import type { ReasoningSelection } from "@litter-bear/types";
import { getAgentModelOptions } from "@/api/endpoints";
import type {
  AgentModelOption,
  AgentModelOptions,
  ModelReasoningCapability,
} from "@/api/types";

/** 某个智能体的一次模型 + 思考选择 */
export interface AgentModelSelection {
  modelPresetId: string;
  reasoning?: ReasoningSelection;
}

const STORAGE_KEY = "sola_desktop_agent_model_selections";

type SavedSelections = Record<string, AgentModelSelection>;

function readSaved(): SavedSelections {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as SavedSelections)
      : {};
  } catch {
    return {};
  }
}

function writeSaved(selections: SavedSelections) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(selections));
  } catch {
    // 本地记忆失败不影响发送：服务端仍以允许集合为准
  }
}

/** 判断模型是否存在终端可调的思考字段 */
export function isReasoningConfigurable(
  capability: ModelReasoningCapability | null | undefined,
): boolean {
  return Boolean(
    capability?.activation?.configurable ||
      capability?.effort?.configurable ||
      capability?.budget?.configurable,
  );
}

/** 按模型能力生成目录默认思考选择；不可调时返回 undefined */
export function defaultModelReasoning(
  capability: ModelReasoningCapability | null | undefined,
): ReasoningSelection | undefined {
  if (!isReasoningConfigurable(capability)) {
    return undefined;
  }
  return capability?.defaultSelection ? { ...capability.defaultSelection } : undefined;
}

/** 校验本地记忆的思考值是否仍在能力目录闭集内；越界则回退目录默认 */
function validReasoningOrDefault(
  capability: ModelReasoningCapability | null,
  value: ReasoningSelection | undefined,
): ReasoningSelection | undefined {
  if (!isReasoningConfigurable(capability)) {
    return undefined;
  }
  if (!value) {
    return defaultModelReasoning(capability);
  }
  if (
    value.activation !== undefined &&
    !capability?.activation?.values.includes(value.activation)
  ) {
    return defaultModelReasoning(capability);
  }
  if (
    value.effort !== undefined &&
    !capability?.effort?.values.includes(value.effort)
  ) {
    return defaultModelReasoning(capability);
  }
  if (
    typeof value.budgetTokens === "number" &&
    (value.budgetTokens < (capability?.budget?.minimum ?? 1) ||
      (capability?.budget?.maximum !== undefined &&
        value.budgetTokens > capability.budget.maximum))
  ) {
    return defaultModelReasoning(capability);
  }
  if (value.budgetTokens === "auto" && !capability?.budget?.supportsAuto) {
    return defaultModelReasoning(capability);
  }
  return { ...value };
}

/**
 * 为接口响应解析初值：优先本地记忆（需仍在允许集合内），否则 Agent 默认模型，
 * 再退到列表第一个。本地值只作初值，发送时服务端仍重新校验。
 */
function resolveInitialSelection(
  agentId: string,
  options: AgentModelOptions,
): AgentModelSelection | undefined {
  const { models, defaultModelPresetId, defaultReasoning } = options;
  if (models.length === 0) {
    return undefined;
  }
  const saved = readSaved()[agentId];
  const savedModel = models.find((m) => m.modelPresetId === saved?.modelPresetId);
  if (saved && savedModel) {
    return {
      modelPresetId: saved.modelPresetId,
      reasoning: validReasoningOrDefault(savedModel.reasoningCapability, saved.reasoning),
    };
  }
  const model =
    models.find((m) => m.modelPresetId === defaultModelPresetId) ?? models[0];
  return {
    modelPresetId: model.modelPresetId,
    reasoning:
      model.modelPresetId === defaultModelPresetId
        ? (defaultReasoning ?? undefined)
        : defaultModelReasoning(model.reasoningCapability),
  };
}

interface ModelState {
  /** 每个智能体的模型选项缓存（会话内） */
  optionsByAgent: Record<string, AgentModelOptions>;
  /** 每个智能体当前选择 */
  selectionByAgent: Record<string, AgentModelSelection>;
  loadingAgentId: string | null;
  loadError: string | null;
  /** 拉取并缓存某智能体的模型选项；同时解析出当前选择 */
  ensureOptions: (agentId: string) => Promise<void>;
  selectModel: (agentId: string, model: AgentModelOption) => void;
  changeReasoning: (agentId: string, reasoning: ReasoningSelection | undefined) => void;
  reset: () => void;
}

export const useModelStore = create<ModelState>((set, get) => ({
  optionsByAgent: {},
  selectionByAgent: {},
  loadingAgentId: null,
  loadError: null,

  async ensureOptions(agentId) {
    if (get().optionsByAgent[agentId]) {
      return;
    }
    set({ loadingAgentId: agentId, loadError: null });
    try {
      const options = await getAgentModelOptions(agentId);
      set((state) => ({
        optionsByAgent: { ...state.optionsByAgent, [agentId]: options },
        selectionByAgent: {
          ...state.selectionByAgent,
          [agentId]:
            state.selectionByAgent[agentId] ?? resolveInitialSelection(agentId, options),
        },
        loadingAgentId: null,
      }));
    } catch (error) {
      set({
        loadingAgentId: null,
        loadError: error instanceof Error ? error.message : "模型选项加载失败",
      });
    }
  },

  selectModel(agentId, model) {
    // 切模型时重置为该模型目录默认思考值
    const selection: AgentModelSelection = {
      modelPresetId: model.modelPresetId,
      reasoning: defaultModelReasoning(model.reasoningCapability),
    };
    set((state) => ({
      selectionByAgent: { ...state.selectionByAgent, [agentId]: selection },
    }));
    writeSaved({ ...readSaved(), [agentId]: selection });
  },

  changeReasoning(agentId, reasoning) {
    const current = get().selectionByAgent[agentId];
    if (!current) {
      return;
    }
    const selection = { ...current, reasoning };
    set((state) => ({
      selectionByAgent: { ...state.selectionByAgent, [agentId]: selection },
    }));
    writeSaved({ ...readSaved(), [agentId]: selection });
  },

  reset() {
    set({ optionsByAgent: {}, selectionByAgent: {}, loadingAgentId: null, loadError: null });
  },
}));
