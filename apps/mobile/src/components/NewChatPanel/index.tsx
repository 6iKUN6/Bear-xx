import { useEffect, useState } from "react";
import { View, Text } from "@tarojs/components";
import AgentAvatar from "../AgentAvatar";
import AppIcon from "../AppIcon";
import AgentSheet from "../AgentSheet";
import { useAgentStore } from "../../store/agentStore";
import { useUserStore } from "../../store/userStore";
import { findAgent } from "../../utils/agent";

interface NewChatPanelProps {
  /** 选中引导条时把文案填进输入框（不直接发送） */
  onPickPrompt: (text: string) => void;
}

const starterPrompts = [
  { icon: "edit", title: "写一段文案" },
  { icon: "doc", title: "总结长文本" },
  { icon: "clock", title: "规划今天" },
  { icon: "chat", title: "随便聊聊" },
] as const;

/** 按小时给的问候语，空状态的称呼跟随一天的时间变化 */
function greetingByHour(hour: number): string {
  if (hour < 6) {
    return "夜深了";
  }
  if (hour < 12) {
    return "早上好";
  }
  if (hour < 18) {
    return "下午好";
  }
  return "晚上好";
}

/**
 * 新对话页
 * @description 尚未选定会话时的首屏：问候、选智能体、给几个起手式。
 *
 * 这里选中的智能体不会立刻建会话——它只是把 agentStore 的粘性选择改掉，
 * 首条消息发出时由后端隐式创建单聊并绑定，避免用户选完就退出留下一堆空会话。
 */
export default function NewChatPanel({ onPickPrompt }: NewChatPanelProps) {
  const userInfo = useUserStore((state) => state.userInfo);
  const agents = useAgentStore((state) => state.agents);
  const loaded = useAgentStore((state) => state.loaded);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const setSelectedAgent = useAgentStore((state) => state.setSelectedAgent);
  const ensureAgents = useAgentStore((state) => state.ensureAgents);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    void ensureAgents();
  }, [ensureAgents]);

  const currentAgent = findAgent(agents, selectedAgentId);
  const canPick = agents.length > 0;
  const greeting = greetingByHour(new Date().getHours());

  return (
    <View className='pb-[1.5rem]'>
      {/* 问候区：名字用强调色，跟随一天的时间 */}
      <View className='px-[1.25rem] pt-[3.5rem]'>
        <Text className='block text-[1.5rem] font-semibold leading-[1.3] tracking-[0.01em] text-[var(--lb-text-primary)]'>
          {greeting}
          {userInfo?.nickname ? (
            <Text className='text-[var(--lb-accent)]'>，{userInfo.nickname}</Text>
          ) : null}
        </Text>
        <Text className='mt-[0.5rem] block text-[0.8125rem] leading-[1.5] text-[var(--lb-text-secondary)]'>
          今天想聊点什么？选一个开场，或直接输入。
        </Text>
      </View>

      {/* 当前智能体 */}
      <View
        className={`mx-[1.25rem] mt-[1.5rem] box-border flex items-center gap-[0.75rem] rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-[0.875rem] py-[0.75rem] shadow-[var(--lb-shadow-card)] ${
          canPick ? "active:bg-[var(--lb-surface-hover)]" : ""
        }`}
        onClick={() => canPick && setSheetOpen(true)}
      >
        {canPick ? (
          <>
            <AgentAvatar
              className='h-[2.5rem] w-[2.5rem] shrink-0 rounded-[var(--lb-radius-sm)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] box-border'
              name={currentAgent?.name}
              avatar={currentAgent?.avatar}
              size='md'
            />
            <View className='min-w-0 flex-1'>
              <Text className='block overflow-hidden text-ellipsis whitespace-nowrap text-[0.875rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]'>
                {currentAgent?.name}
              </Text>
              <Text className='mt-[0.125rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.6875rem] leading-[1.45] text-[var(--lb-text-muted)]'>
                {currentAgent?.description || "点击切换其他智能体"}
              </Text>
            </View>
            <View className='flex min-h-[2.75rem] shrink-0 items-center gap-[0.125rem] px-[0.25rem]'>
              <Text className='text-[0.75rem] leading-none text-[var(--lb-accent)]'>
                切换
              </Text>
              <AppIcon name='chevronRight' className='h-[0.75rem] w-[0.75rem] text-[var(--lb-accent)]' />
            </View>
          </>
        ) : (
          // 拿不到列表时不回落显示默认助手名：那看起来像一个可用选择，实际不是
          <Text className='block text-[0.875rem] leading-[1.45] text-[var(--lb-text-muted)]'>
            {loaded ? "暂无可用智能体" : "正在载入智能体…"}
          </Text>
        )}
      </View>

      {/* 开场提示：双列卡片 */}
      <View className='grid grid-cols-2 gap-[0.625rem] p-[1.25rem]'>
        {starterPrompts.map((item) => (
          <View
            key={item.title}
            className='box-border flex min-h-[4.5rem] flex-col gap-[0.375rem] rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-[0.8125rem] py-[0.75rem] text-left active:border-[var(--lb-line-strong)]'
            onClick={() => onPickPrompt(`${item.title}：`)}
          >
            <AppIcon
              name={item.icon}
              className='h-[1rem] w-[1rem] text-[var(--lb-accent)]'
            />
            <Text className='block text-[0.8125rem] leading-[1.55] text-[var(--lb-text-primary)]'>
              {item.title}
            </Text>
          </View>
        ))}
      </View>

      {sheetOpen ? (
        <AgentSheet
          title='选择智能体'
          agents={agents}
          // 必须传（哪怕是 null）：AgentSheet 用 !== undefined 决定是否显示选中态
          selectedAgentId={selectedAgentId}
          onSelect={(agent) => {
            // 与 ChatInput 的切换保持一致：默认助手记为 null，
            // 「null = 交给后端默认」这条约定不能被具体 id 破坏
            setSelectedAgent(agent.isDefault ? null : agent.id);
            setSheetOpen(false);
          }}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}
    </View>
  );
}
