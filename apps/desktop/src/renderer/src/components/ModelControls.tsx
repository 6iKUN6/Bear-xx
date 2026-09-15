import { useAppStore } from "@/stores/app-store";
import { useAgentStore } from "@/stores/agent-store";
import { useModelStore } from "@/stores/model-store";
import { AgentMenu } from "./AgentMenu";
import { ModelMenu } from "./ModelMenu";
import { ThinkingMenu } from "./ThinkingMenu";

export function ModelControls({
  agentId,
  selectedAgentId,
  scopeId = "chat",
  onAgentChange,
}: {
  agentId: string | null;
  selectedAgentId?: string | null;
  scopeId?: string;
  onAgentChange?: (id: string | null) => void;
}) {
  const user = useAppStore((s) => s.user);
  const agents = useAgentStore((s) => s.agents);
  const agentError = useAgentStore((s) => s.loadError);
  const modelError = useModelStore((s) => s.loadError);
  const loading = useModelStore((s) => s.loadingAgentId);
  const agent = agents.find((item) => item.id === agentId);
  if (!user) return null;
  return (
    <>
      <div className="model-controls">
        <AgentMenu
          {...(onAgentChange
            ? {
                value:
                  selectedAgentId === undefined ? agentId : selectedAgentId,
                onChange: onAgentChange,
              }
            : {})}
        />
        <ModelMenu
          key={`${scopeId}:${agentId}`}
          agentId={agentId}
          scopeId={scopeId}
        />
        <ThinkingMenu
          key={`thinking:${scopeId}:${agentId}`}
          agentId={agentId}
          scopeId={scopeId}
        />
        {agent?.defaultFlowVersionId && (
          <span className="muted text-xs">模型由流程节点指定</span>
        )}
        {agentId !== null && loading === agentId && (
          <span className="muted text-xs">加载模型…</span>
        )}
      </div>
      {(agentError || modelError) && (
        <button
          type="button"
          className="config-error"
          onClick={() => {
            if (agentError) void useAgentStore.getState().loadAgents();
            if (modelError && agentId)
              void useModelStore.getState().ensureOptions(agentId, scopeId);
          }}
        >
          {agentError || modelError} · 点击重试
        </button>
      )}
    </>
  );
}
