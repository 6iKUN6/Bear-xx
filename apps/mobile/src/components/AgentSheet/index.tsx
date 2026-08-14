import { View, Text } from "@tarojs/components";
import AgentAvatar from "../AgentAvatar";
import { appGlassCardClass } from "../../utils/style";
import type { AgentSummary } from "../../api/agents";

/**
 * 智能体底部选择弹层（共享）
 * @description 半透明背板 + 上滑面板，带头像卡片列表。供输入栏的当前智能体
 * 切换与 @ 提及选择复用，两处仅标题与选中态语义不同。
 */
export default function AgentSheet({
  title = "选择智能体",
  agents,
  selectedAgentId,
  onSelect,
  onClose,
}: {
  title?: string;
  agents: AgentSummary[];
  /** 高亮项；undefined = 不显示选中态（@ 提及模式） */
  selectedAgentId?: string | null;
  onSelect: (agent: AgentSummary) => void;
  onClose: () => void;
}) {
  const showSelected = selectedAgentId !== undefined;

  return (
    <View
      className='fixed inset-0 z-[60] flex flex-col justify-end bg-black/40'
      onClick={onClose}
    >
      <View
        className='box-border max-h-[70vh] w-full overflow-y-auto rounded-t-[var(--lb-radius-md)] bg-[var(--lb-page-background)] px-[1rem] pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[1rem]'
        onClick={(e) => e.stopPropagation()}
      >
        <View className='mb-[0.75rem] flex items-center justify-between'>
          <Text className='block text-[1.0625rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]'>
            {title}
          </Text>
          <Text
            className='at-icon at-icon-close text-[1rem] leading-none text-[var(--lb-text-muted)] [&::before]:block'
            onClick={onClose}
          />
        </View>

        <View className='flex flex-col gap-[0.5rem]'>
          {agents.map((agent) => {
            const selected =
              showSelected &&
              (agent.isDefault
                ? !selectedAgentId
                : selectedAgentId === agent.id);
            return (
              <View
                key={agent.id}
                className={`${appGlassCardClass} box-border flex items-center gap-[0.75rem] px-[1rem] py-[0.875rem] transition-colors active:scale-[0.99] ${
                  selected
                    ? "border-[var(--lb-accent)] bg-[var(--lb-accent-soft)]"
                    : ""
                }`}
                onClick={() => onSelect(agent)}
              >
                <AgentAvatar
                  className='h-[2.25rem] w-[2.25rem] shrink-0 rounded-full border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] box-border'
                  name={agent.name}
                  avatar={agent.avatar}
                  size='sm'
                />
                <View className='min-w-0 flex-1'>
                  <Text className='block overflow-hidden text-ellipsis whitespace-nowrap text-[0.9375rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]'>
                    {agent.name}
                  </Text>
                  {agent.description ? (
                    <Text className='mt-[0.25rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] leading-[1.4] text-[var(--lb-text-secondary)]'>
                      {agent.description}
                    </Text>
                  ) : null}
                </View>
                {selected ? (
                  <Text className='at-icon at-icon-check shrink-0 text-[1rem] leading-none text-[var(--lb-accent-ink)] [&::before]:block' />
                ) : null}
              </View>
            );
          })}
        </View>
      </View>
    </View>
  );
}
