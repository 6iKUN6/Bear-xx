import type {
  AgentModelOptionDto,
  ModelReasoningCapabilityDto,
  ReasoningSelectionDto,
} from "../api/generated/models";
import { STORAGE_KEYS } from "../utils/constants";
import * as storage from "../utils/storage";

export interface AgentModelSelection {
  modelPresetId: string;
  reasoning?: ReasoningSelectionDto;
}

type SavedSelections = Record<string, AgentModelSelection>;

/**
 * 读取某个智能体最近一次模型选择
 * @param agentId 智能体 ID
 * @returns 返回本地保存的选择；数据损坏或缺失时返回 undefined
 * @description 本地值只作为界面初值，发送时服务端仍会重新验证允许集合和模型能力。
 */
export function loadAgentModelSelection(
  agentId: string,
): AgentModelSelection | undefined {
  const all = storage.get<unknown>(STORAGE_KEYS.AGENT_MODEL_SELECTIONS);
  if (!isRecord(all)) return undefined;
  return readSelection(all[agentId]);
}

/**
 * 保存某个智能体最近一次模型选择
 * @param agentId 智能体 ID
 * @param selection 已从当前能力目录生成的选择
 * @returns 无返回值
 */
export function saveAgentModelSelection(
  agentId: string,
  selection: AgentModelSelection,
): void {
  const current = storage.get<SavedSelections>(
    STORAGE_KEYS.AGENT_MODEL_SELECTIONS,
  );
  storage.set(STORAGE_KEYS.AGENT_MODEL_SELECTIONS, {
    ...(isRecord(current) ? current : {}),
    [agentId]: selection,
  });
}

/**
 * 按模型能力生成目录默认思考选择
 * @param capability 服务端下发的只读能力投影
 * @returns 可调模型返回默认选择，固定或普通模型返回 undefined
 */
export function defaultModelReasoning(
  capability: ModelReasoningCapabilityDto | null | undefined,
): ReasoningSelectionDto | undefined {
  if (!isReasoningConfigurable(capability)) return undefined;
  return capability?.defaultSelection
    ? { ...capability.defaultSelection }
    : undefined;
}

/** 判断当前模型是否存在终端可调整的思考字段。 */
export function isReasoningConfigurable(
  capability: ModelReasoningCapabilityDto | null | undefined,
): boolean {
  return Boolean(
    capability?.activation?.configurable ||
      capability?.effort?.configurable ||
      capability?.budget?.configurable,
  );
}

/**
 * 计算模型选择的稳定指纹
 * @param selection 本轮最终模型和思考选择
 * @returns 返回只用于判断前后轮配置是否变化的字符串
 */
export function modelSelectionFingerprint(
  selection: AgentModelSelection | undefined,
): string | undefined {
  if (!selection) return undefined;
  const reasoning = selection.reasoning;
  return JSON.stringify({
    modelPresetId: selection.modelPresetId,
    activation: reasoning?.activation ?? null,
    effort: reasoning?.effort ?? null,
    budgetTokens: reasoning?.budgetTokens ?? null,
  });
}

/**
 * 为当前接口响应解析可用初值
 * @param agentId 智能体 ID
 * @param models 当前允许模型闭集
 * @param defaultModelPresetId Agent 默认模型
 * @param defaultReasoning Agent 默认模型对应的思考设置
 * @returns 返回有效本地记忆或服务端默认；无可用模型时返回 undefined
 */
export function resolveInitialModelSelection(
  agentId: string,
  models: AgentModelOptionDto[],
  defaultModelPresetId: string | null,
  defaultReasoning: ReasoningSelectionDto | null,
): AgentModelSelection | undefined {
  if (models.length === 0) return undefined;
  const saved = loadAgentModelSelection(agentId);
  const savedModel = models.find(
    (model) => model.modelPresetId === saved?.modelPresetId,
  );
  if (saved && savedModel) {
    return {
      modelPresetId: saved.modelPresetId,
      reasoning: validReasoningOrDefault(
        savedModel.reasoningCapability,
        saved.reasoning,
      ),
    };
  }
  const model =
    models.find((item) => item.modelPresetId === defaultModelPresetId) ??
    models[0];
  return {
    modelPresetId: model.modelPresetId,
    reasoning:
      model.modelPresetId === defaultModelPresetId
        ? (defaultReasoning ?? undefined)
        : defaultModelReasoning(model.reasoningCapability),
  };
}

function validReasoningOrDefault(
  capability: ModelReasoningCapabilityDto | null,
  value: ReasoningSelectionDto | undefined,
): ReasoningSelectionDto | undefined {
  if (!isReasoningConfigurable(capability)) return undefined;
  if (!value) return defaultModelReasoning(capability);
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

function readSelection(value: unknown): AgentModelSelection | undefined {
  if (!isRecord(value) || typeof value.modelPresetId !== "string") {
    return undefined;
  }
  const reasoning = readReasoning(value.reasoning);
  return {
    modelPresetId: value.modelPresetId,
    ...(reasoning ? { reasoning } : {}),
  };
}

function readReasoning(value: unknown): ReasoningSelectionDto | undefined {
  if (!isRecord(value)) return undefined;
  const activation =
    value.activation === "enabled" ||
    value.activation === "disabled" ||
    value.activation === "auto"
      ? value.activation
      : undefined;
  const effort =
    value.effort === "minimal" ||
    value.effort === "low" ||
    value.effort === "medium" ||
    value.effort === "high" ||
    value.effort === "xhigh" ||
    value.effort === "max"
      ? value.effort
      : undefined;
  const budgetTokens =
    value.budgetTokens === "auto" ||
    (typeof value.budgetTokens === "number" &&
      Number.isInteger(value.budgetTokens) &&
      value.budgetTokens > 0)
      ? value.budgetTokens
      : undefined;
  return activation !== undefined ||
    effort !== undefined ||
    budgetTokens !== undefined
    ? { activation, effort, budgetTokens }
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
