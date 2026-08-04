import { Image, View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useNavBarMetrics } from "../../hooks/useNavBarMetrics";
import { useAgentStore } from "../../store/agentStore";
import { groupConversationsByTime } from "../../utils/conversation";
import { agentAvatarSrc } from "../../utils/agent";
import { appTextTruncateClass } from "../../utils/style";
import type { AgentSummary } from "../../api/agents";

/**
 * 历史会话抽屉（左侧滑出）
 * @description 会话按 今天/昨天/七天内/30天内/更早 分组展示；点击切换当前会话，
 * 行尾删除按钮带确认弹窗。顶部提供「新对话」入口。
 */
export default function HistoryDrawer({
  open,
  conversations,
  currentId,
  onSelect,
  onCreate,
  onDelete,
  onClose,
}: {
  open: boolean;
  conversations: Conversation[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const metrics = useNavBarMetrics();
  const agents = useAgentStore((state) => state.agents);

  if (!open) {
    return null;
  }

  const groups = groupConversationsByTime(conversations);

  const handleDelete = (conversation: Conversation) => {
    void Taro.showModal({
      title: "删除会话",
      content: `确定删除「${conversation.title || "新对话"}」？`,
      confirmColor: "#e5484d",
    }).then((res) => {
      if (res.confirm) {
        onDelete(conversation.id);
      }
    });
  };

  return (
    <View className='fixed inset-0 z-[70] flex bg-black/40' onClick={onClose}>
      <View
        className='box-border flex h-full w-[78%] max-w-[20rem] flex-col bg-[var(--lb-page-background)]'
        style={{
          paddingTop:
            typeof metrics.topPadding === "number"
              ? metrics.topPadding + 12
              : `calc(${metrics.topPadding} + 12px)`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <View className='flex items-center justify-between px-[1rem] pb-[0.75rem]'>
          <Text className='block text-[1.0625rem] font-semibold leading-[1.3] text-[var(--lb-text-primary)]'>
            历史会话
          </Text>
          <View
            className='flex items-center gap-[0.25rem] rounded-full bg-[var(--lb-accent-soft)] px-[0.75rem] py-[0.375rem] active:scale-95'
            onClick={() => {
              onCreate();
              onClose();
            }}
          >
            <Text className='at-icon at-icon-add text-[0.875rem] leading-none text-[var(--lb-accent-ink)] [&::before]:block' />
            <Text className='text-[0.8125rem] font-medium leading-none text-[var(--lb-accent-ink)]'>
              新对话
            </Text>
          </View>
        </View>

        <View className='min-h-0 flex-1 overflow-y-auto px-[0.75rem] pb-[calc(env(safe-area-inset-bottom)+1rem)]'>
          {groups.length === 0 ? (
            <Text className='block px-[0.5rem] pt-[1rem] text-[0.875rem] leading-[1.5] text-[var(--lb-text-muted)]'>
              还没有历史会话，点右上角开始新对话
            </Text>
          ) : (
            groups.map((group) => (
              <View key={group.label} className='mb-[0.5rem]'>
                <Text className='block px-[0.5rem] py-[0.5rem] text-[0.75rem] font-medium leading-none text-[var(--lb-text-muted)]'>
                  {group.label}
                </Text>
                {group.items.map((conversation) => {
                  const active = conversation.id === currentId;
                  const lastMessage =
                    conversation.messages[conversation.messages.length - 1];
                  const preview = lastMessage
                    ? lastMessage.content.replace(/\s+/g, " ").slice(0, 30)
                    : "";
                  return (
                    <View
                      key={conversation.id}
                      className={`mb-[0.25rem] flex items-center gap-[0.625rem] rounded-[var(--lb-radius-md)] px-[0.625rem] py-[0.5rem] transition-colors ${
                        active
                          ? "bg-[var(--lb-accent-soft)]"
                          : "active:bg-[var(--lb-surface-hover)]"
                      }`}
                      onClick={() => {
                        onSelect(conversation.id);
                        onClose();
                      }}
                    >
                      <ConversationAvatar
                        conversation={conversation}
                        agents={agents}
                      />
                      <View className='min-w-0 flex-1'>
                        <Text
                          className={`${appTextTruncateClass} block text-[0.9375rem] leading-[1.35] ${
                            active
                              ? "font-semibold text-[var(--lb-accent-ink)]"
                              : "text-[var(--lb-text-primary)]"
                          }`}
                        >
                          {conversation.title || "新对话"}
                        </Text>
                        {preview ? (
                          <Text
                            className={`${appTextTruncateClass} mt-[0.125rem] block text-[0.6875rem] leading-[1.35] text-[var(--lb-text-muted)]`}
                          >
                            {preview}
                          </Text>
                        ) : null}
                      </View>
                      <Text
                        className='at-icon at-icon-trash shrink-0 p-[0.25rem] text-[0.875rem] leading-none text-[var(--lb-text-muted)] [&::before]:block'
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(conversation);
                        }}
                      />
                    </View>
                  );
                })}
              </View>
            ))
          )}
        </View>

      </View>
    </View>
  );
}

/**
 * 会话头像：单聊显示绑定智能体头像；群聊显示 2x2 迷你头像宫格；兜底默认图
 */
function ConversationAvatar({
  conversation,
  agents,
}: {
  conversation: Conversation;
  agents: AgentSummary[];
}) {
  const memberIds = conversation.agentIds ?? [];
  const findAvatar = (id: string) =>
    agentAvatarSrc(agents.find((a) => a.id === id)?.avatar);

  if (conversation.type === "GROUP" && memberIds.length > 1) {
    return (
      <View className='grid h-[2.25rem] w-[2.25rem] shrink-0 grid-cols-2 gap-[0.0625rem] overflow-hidden rounded-[0.625rem] border border-[var(--lb-line-soft)] bg-[var(--lb-surface-muted)] p-[0.125rem] box-border'>
        {memberIds.slice(0, 4).map((id) => (
          <Image
            key={id}
            className='h-full w-full rounded-[0.25rem] bg-[var(--lb-surface)]'
            src={findAvatar(id)}
            mode='aspectFill'
          />
        ))}
      </View>
    );
  }

  return (
    <Image
      className='h-[2.25rem] w-[2.25rem] shrink-0 rounded-[0.625rem] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)]'
      src={agentAvatarSrc(
        memberIds[0]
          ? (agents.find((a) => a.id === memberIds[0])?.avatar ?? null)
          : null,
      )}
      mode='aspectFill'
    />
  );
}
