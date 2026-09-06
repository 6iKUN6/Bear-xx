import { useEffect, useMemo, useState } from "react";
import { getAgentModelOptions } from "../api/agents";
import type {
  AgentModelOptionDto,
  AgentModelOptionsDto,
  ReasoningSelectionDto,
} from "../api/generated/models";
import {
  defaultModelReasoning,
  resolveInitialModelSelection,
  saveAgentModelSelection,
  type AgentModelSelection,
} from "../services/agent-model-selection";

const optionsCache = new Map<string, AgentModelOptionsDto>();

/**
 * 管理当前明确回答 Agent 的终端模型选择
 * @param agentId 单聊、新会话或明确 @ 后确定的智能体 ID；自动路由时为空
 * @returns 返回能力目录、当前选择、加载错误和受控修改方法
 * @description 自定义 Flow Agent 的接口响应没有模型，因此自然隐藏入口。切换模型时重置为
 * 新模型的目录默认思考值，并按 Agent ID 保存最近选择。
 */
export function useAgentModelSelection(agentId: string | undefined) {
  const [options, setOptions] = useState<AgentModelOptionsDto | null>(null);
  const [selection, setSelection] = useState<AgentModelSelection | undefined>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let active = true;
    if (!agentId) {
      setOptions(null);
      setSelection(undefined);
      setLoading(false);
      setError(null);
      return () => {
        active = false;
      };
    }

    const cached = optionsCache.get(agentId);
    if (cached) {
      setOptions(cached);
      setSelection(
        resolveInitialModelSelection(
          agentId,
          cached.models,
          cached.defaultModelPresetId,
          cached.defaultReasoning,
        ),
      );
      setLoading(false);
      setError(null);
    } else {
      setOptions(null);
      setSelection(undefined);
      setLoading(true);
      setError(null);
    }

    void (async () => {
      try {
        const next = await getAgentModelOptions(agentId);
        if (!active) return;
        optionsCache.set(agentId, next);
        setOptions(next);
        setSelection(
          resolveInitialModelSelection(
            agentId,
            next.models,
            next.defaultModelPresetId,
            next.defaultReasoning,
          ),
        );
        setError(null);
      } catch (reason) {
        if (!active) return;
        setError(
          reason instanceof Error ? reason : new Error("模型选项加载失败"),
        );
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [agentId]);

  const selectedModel = useMemo(
    () =>
      options?.models.find(
        (model) => model.modelPresetId === selection?.modelPresetId,
      ),
    [options, selection?.modelPresetId],
  );

  const changeModel = (model: AgentModelOptionDto) => {
    if (!agentId) return;
    const next: AgentModelSelection = {
      modelPresetId: model.modelPresetId,
      reasoning: defaultModelReasoning(model.reasoningCapability),
    };
    setSelection(next);
    saveAgentModelSelection(agentId, next);
  };

  const changeReasoning = (reasoning: ReasoningSelectionDto | undefined) => {
    if (!agentId || !selection) return;
    const next = { ...selection, reasoning };
    setSelection(next);
    saveAgentModelSelection(agentId, next);
  };

  return {
    options,
    selection,
    selectedModel,
    loading,
    error,
    changeModel,
    changeReasoning,
  };
}
