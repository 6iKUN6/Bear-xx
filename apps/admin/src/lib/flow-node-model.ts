import type { FlowNodeType } from "@litter-bear/types/agent-flow";
import type { ModelPresetOption } from "@/api/types";

/**
 * 画布节点上的供应商信息
 * @description 节点 config 只存模型预设 id，供应商要经预设列表解析；引用了已不存在
 * 的预设时标 stale，画布上给警示而不是静默消失（诚实呈现）。
 */
export interface NodeProviderInfo {
  providerKey: ModelPresetOption["providerKey"];
  /** 连接名；stale 时回退为残留预设 id */
  name: string;
  stale: boolean;
}

/**
 * 读取节点引用的模型预设 id
 * @param type 节点类型
 * @param config 节点 config
 * @returns 预设 id；该类型不可配模型或未配置时返回 undefined
 * @description plan-loop 的预设在 config.executor.modelPreset（执行器是嵌套的 agent 配置），
 * 其余可配模型的节点在顶层 config.modelPreset。
 */
export function nodeModelPresetId(
  type: FlowNodeType,
  config: Record<string, unknown>,
): string | undefined {
  if (type === "plan-loop") {
    const executor = config.executor;
    if (typeof executor === "object" && executor !== null) {
      const preset = (executor as Record<string, unknown>).modelPreset;
      return typeof preset === "string" && preset ? preset : undefined;
    }
    return undefined;
  }
  const preset = config.modelPreset;
  return typeof preset === "string" && preset ? preset : undefined;
}

/**
 * 解析节点当前接入的供应商
 * @param type 节点类型
 * @param config 节点 config
 * @param presets 后台下发的模型预设列表（/admin/capabilities）
 * @returns 供应商信息；未配置预设返回 null，预设已不存在返回 stale 标记
 */
export function resolveNodeProvider(
  type: FlowNodeType,
  config: Record<string, unknown>,
  presets: ModelPresetOption[],
): NodeProviderInfo | null {
  const presetId = nodeModelPresetId(type, config);
  if (!presetId) {
    return null;
  }
  const preset = presets.find((item) => item.id === presetId);
  if (!preset) {
    return { providerKey: "custom-openai", name: presetId, stale: true };
  }
  return {
    providerKey: preset.providerKey,
    name: preset.connectionName,
    stale: false,
  };
}
