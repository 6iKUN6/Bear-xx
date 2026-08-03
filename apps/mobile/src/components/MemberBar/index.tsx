import { useState } from "react";
import { Image, View, Text } from "@tarojs/components";
import AgentSheet from "../AgentSheet";
import { agentAvatarSrc } from "../../utils/agent";
import type { AgentSummary } from "../../api/agents";

const MAX_STACKED_AVATARS = 4;

/**
 * 群成员条
 * @description 群聊会话（有具体智能体参与）时显示成员头像堆叠；点开成员列表，
 * 点某个成员即在输入框快捷 @ TA。单助手会话不渲染，零噪音。
 */
export default function MemberBar({
  members,
  onMention,
}: {
  members: AgentSummary[];
  onMention: (agent: AgentSummary) => void;
}) {
  const [open, setOpen] = useState(false);

  if (members.length === 0) {
    return null;
  }

  const stacked = members.slice(0, MAX_STACKED_AVATARS);
  const restCount = members.length - stacked.length;

  return (
    <View className='border-b border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-[1rem] py-[0.375rem] box-border'>
      <View
        className='flex items-center gap-[0.5rem]'
        onClick={() => setOpen(true)}
      >
        <View className='flex items-center'>
          {stacked.map((agent, index) => (
            <Image
              key={agent.id}
              className={`h-[1.5rem] w-[1.5rem] rounded-full border border-[var(--lb-surface)] bg-[var(--lb-page-background)] box-border ${
                index > 0 ? "ml-[-0.375rem]" : ""
              }`}
              src={agentAvatarSrc(agent.avatar)}
              mode='aspectFill'
            />
          ))}
          {restCount > 0 ? (
            <View className='ml-[-0.375rem] flex h-[1.5rem] w-[1.5rem] items-center justify-center rounded-full border border-[var(--lb-surface)] bg-[var(--lb-accent-soft)] box-border'>
              <Text className='text-[0.625rem] font-semibold leading-none text-[var(--lb-accent-ink)]'>
                +{restCount}
              </Text>
            </View>
          ) : null}
        </View>
        <Text className='min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] leading-[1.3] text-[var(--lb-text-secondary)]'>
          {members.length} 位助手参与 · 点击 @ 指定回答
        </Text>
        <Text className='at-icon at-icon-chevron-right shrink-0 text-[0.75rem] leading-none text-[var(--lb-text-muted)] [&::before]:block' />
      </View>

      {open ? (
        <AgentSheet
          title='群内助手 · 点击 @ TA'
          agents={members}
          onSelect={(agent) => {
            onMention(agent);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </View>
  );
}
