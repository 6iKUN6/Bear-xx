import { useEffect, useState } from "react";
import { View, Text } from "@tarojs/components";
import { useAgentStore } from "../../store/agentStore";
import { appGlassCardClass } from "../../utils/style";
import type { AgentSummary } from "../../api/agents";

const FALLBACK_TITLE = "AI 助手";

/**
 * 导航栏标题态的智能体切换器
 * @description 标题显示当前智能体名 + 下拉箭头，点击弹出底部选择弹层；选择即时生效、持久化。
 * 放进 NavBar 的 title slot（title 支持 ReactNode）。
 */
export default function AgentSwitcher() {
  const agents = useAgentStore((state) => state.agents);
  const loaded = useAgentStore((state) => state.loaded);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const setSelectedAgent = useAgentStore((state) => state.setSelectedAgent);
  const loadAgents = useAgentStore((state) => state.loadAgents);

  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!loaded) {
      void loadAgents();
    }
  }, [loaded, loadAgents]);

  const currentName = resolveCurrentName(agents, selectedAgentId);
  const canSwitch = agents.length > 0;

  const handleSelect = (agent: AgentSummary) => {
    // 选到默认 agent 时置空（请求不带 agentId，走后端默认）。
    setSelectedAgent(agent.isDefault ? null : agent.id);
    setOpen(false);
  };

  return (
    <View className="relative flex min-w-0 items-center justify-center">
      <View
        className="flex min-w-0 max-w-[12rem] items-center gap-[0.25rem]"
        onClick={() => canSwitch && setOpen(true)}
      >
        <Text className="block overflow-hidden text-ellipsis whitespace-nowrap text-[1.0625rem] font-semibold leading-[1.25] text-[var(--lb-text-primary)]">
          {currentName}
        </Text>
        {canSwitch ? (
          <Text className="at-icon at-icon-chevron-down shrink-0 text-[0.875rem] leading-none text-[var(--lb-text-muted)] [&::before]:block" />
        ) : null}
      </View>

      {open ? (
        <AgentSheet
          agents={agents}
          selectedAgentId={selectedAgentId}
          onSelect={handleSelect}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}

/**
 * 底部选择弹层
 * @description 半透明背板 + 上滑面板；卡片选中态复用主题选择器样式。
 */
function AgentSheet({
  agents,
  selectedAgentId,
  onSelect,
  onClose,
}: {
  agents: AgentSummary[];
  selectedAgentId: string | null;
  onSelect: (agent: AgentSummary) => void;
  onClose: () => void;
}) {
  return (
    <View
      className="fixed inset-0 z-[60] flex flex-col justify-end bg-black/40"
      onClick={onClose}
    >
      <View
        className="box-border max-h-[70vh] w-full overflow-y-auto rounded-t-[var(--lb-radius-md)] bg-[var(--lb-page-background)] px-[1rem] pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[1rem]"
        onClick={(e) => e.stopPropagation()}
      >
        <View className="mb-[0.75rem] flex items-center justify-between">
          <Text className="block text-[1.0625rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]">
            选择智能体
          </Text>
          <Text
            className="at-icon at-icon-close text-[1rem] leading-none text-[var(--lb-text-muted)] [&::before]:block"
            onClick={onClose}
          />
        </View>

        <View className="flex flex-col gap-[0.5rem]">
          {agents.map((agent) => {
            const selected = agent.isDefault
              ? !selectedAgentId
              : selectedAgentId === agent.id;
            return (
              <View
                key={agent.id}
                className={`${appGlassCardClass} box-border flex items-start gap-[0.75rem] px-[1rem] py-[0.875rem] transition-colors active:scale-[0.99] ${
                  selected
                    ? "border-[var(--lb-accent)] bg-[var(--lb-accent-soft)]"
                    : ""
                }`}
                onClick={() => onSelect(agent)}
              >
                <View className="min-w-0 flex-1">
                  <Text className="block overflow-hidden text-ellipsis whitespace-nowrap text-[0.9375rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]">
                    {agent.name}
                  </Text>
                  {agent.description ? (
                    <Text className="mt-[0.25rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] leading-[1.4] text-[var(--lb-text-secondary)]">
                      {agent.description}
                    </Text>
                  ) : null}
                </View>
                {selected ? (
                  <Text className="at-icon at-icon-check shrink-0 text-[1rem] leading-none text-[var(--lb-accent-ink)] [&::before]:block" />
                ) : null}
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}

/**
 * 计算标题显示名
 * @description 选中具体 agent → 其名；未选中（null）→ 默认 agent 名；都取不到 → 回退文案。
 */
function resolveCurrentName(
  agents: AgentSummary[],
  selectedAgentId: string | null,
): string {
  if (selectedAgentId) {
    const selected = agents.find((agent) => agent.id === selectedAgentId);
    if (selected) {
      return selected.name;
    }
  }
  const defaultAgent = agents.find((agent) => agent.isDefault);
  return defaultAgent?.name ?? FALLBACK_TITLE;
}
