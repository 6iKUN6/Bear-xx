import { useEffect, useState } from "react";
import { View, Text } from "@tarojs/components";
import AgentAvatar from "../AgentAvatar";
import AgentSheet from "../AgentSheet";
import { useAgentStore } from "../../store/agentStore";
import { useUserStore } from "../../store/userStore";
import { findAgent } from "../../utils/agent";
import {
  appGlassCardStrongClass,
  appHeroClass,
  appHeroSubtitleClass,
  appHeroTitleClass,
} from "../../utils/style";

interface NewChatPanelProps {
  /** 选中引导条时把文案填进输入框（不直接发送） */
  onPickPrompt: (text: string) => void;
}

const starterPrompts = [
  { icon: "✎", title: "写一段文案" },
  { icon: "⌁", title: "总结长文本" },
  { icon: "◷", title: "规划今天" },
  { icon: "?", title: "随便聊聊" },
];

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

  return (
    <View className='pb-[1.5rem]'>
      <View className={appHeroClass}>
        <Text className={appHeroTitleClass}>
          {userInfo?.nickname ? `${userInfo.nickname}，我们开始吧` : "我们开始吧"}
        </Text>
        <Text className={appHeroSubtitleClass}>
          先挑一个智能体，或者直接说你想做什么。
        </Text>
      </View>

      <View className='px-[1rem]'>
        <Text className='mb-[0.5rem] block text-[0.6875rem] leading-none text-[var(--lb-text-muted)]'>
          当前智能体
        </Text>
        <View
          className={`${appGlassCardStrongClass} box-border flex items-center gap-[0.75rem] px-[1rem] py-[0.875rem] ${
            canPick ? "active:bg-[var(--lb-surface-hover)]" : ""
          }`}
          onClick={() => canPick && setSheetOpen(true)}
        >
          {canPick ? (
            <>
              <AgentAvatar
                className='h-[3rem] w-[3rem] shrink-0 rounded-full border border-[var(--lb-line-soft)] bg-[var(--lb-surface)] box-border'
                name={currentAgent?.name}
                avatar={currentAgent?.avatar}
                size='md'
              />
              <View className='min-w-0 flex-1'>
                <Text className='block overflow-hidden text-ellipsis whitespace-nowrap text-[0.9375rem] font-semibold leading-[1.35] text-[var(--lb-text-primary)]'>
                  {currentAgent?.name}
                </Text>
                <Text className='mt-[0.1875rem] block overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] leading-[1.45] text-[var(--lb-text-secondary)]'>
                  {currentAgent?.description || "点击切换其他智能体"}
                </Text>
              </View>
              <Text className='at-icon at-icon-chevron-down shrink-0 text-[0.875rem] leading-none text-[var(--lb-text-muted)] [&::before]:block' />
            </>
          ) : (
            // 拿不到列表时不回落显示默认助手名：那看起来像一个可用选择，实际不是
            <Text className='block text-[0.875rem] leading-[1.45] text-[var(--lb-text-muted)]'>
              {loaded ? "暂无可用智能体" : "正在载入智能体…"}
            </Text>
          )}
        </View>
      </View>

      <View className='mt-[1.25rem] px-[1rem]'>
        <Text className='mb-[0.625rem] block text-[0.8125rem] font-semibold leading-none text-[var(--lb-text-muted)]'>
          可以这样开始
        </Text>
        <View className='flex flex-col gap-[0.5rem]'>
          {starterPrompts.map((item) => (
            <View
              key={item.title}
              className='box-border flex items-center gap-[0.75rem] rounded-[var(--lb-radius-md)] border border-[var(--lb-line-soft)] bg-[var(--lb-surface-muted)] px-[0.875rem] py-[0.75rem] active:bg-[var(--lb-surface-hover)]'
              onClick={() => onPickPrompt(`${item.title}：`)}
            >
              <Text className='block w-[1.25rem] shrink-0 text-[1rem] leading-none text-[var(--lb-accent-ink)]'>
                {item.icon}
              </Text>
              <Text className='block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.875rem] leading-[1.35] text-[var(--lb-text-primary)]'>
                {item.title}
              </Text>
              <Text className='at-icon at-icon-chevron-right shrink-0 text-[0.75rem] leading-none text-[var(--lb-text-muted)] [&::before]:block' />
            </View>
          ))}
        </View>
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
