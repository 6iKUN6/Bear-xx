import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { Image, View, Text, Textarea } from "@tarojs/components";
import IconButton from "../IconButton";
import VoiceButton from "../VoiceButton";
import AgentSheet from "../AgentSheet";
import { useAgentStore } from "../../store/agentStore";
import { agentAvatarSrc, findAgent, resolveAgentName } from "../../utils/agent";
import { appSoftInputClass, safeAreaBottom } from "../../utils/style";
import type { AgentSummary } from "../../api/agents";

/** 供外部（成员条等）触发一次性 @ 提及 */
export interface ChatInputHandle {
  insertMention: (agent: AgentSummary) => void;
}

interface ChatInputProps {
  /** agentId：本条消息的回答者；undefined = 后端默认智能体 */
  onSend: (content: string, agentId?: string) => void;
  onStop?: () => void;
  onRecordComplete?: (filePath: string) => void;
  isStreaming?: boolean;
  disabled?: boolean;
}

/** 一次性 @ 提及：仅对下一条消息生效 */
interface MentionTarget {
  /** null = 默认智能体 */
  agentId: string | null;
  name: string;
}

const iconClassName =
  "inline-flex items-center justify-center text-[1.25rem] leading-none [&::before]:block";

export default forwardRef<ChatInputHandle, ChatInputProps>(function ChatInput(
  { onSend, onStop, onRecordComplete, isStreaming = false, disabled = false },
  ref,
) {
  const [value, setValue] = useState("");
  const [inputMode, setInputMode] = useState<"text" | "voice">("text");
  /** 弹层模式：switch = 切换当前智能体（粘性）；mention = @ 指定本条回答者 */
  const [sheetMode, setSheetMode] = useState<"switch" | "mention" | null>(
    null,
  );
  const [mention, setMention] = useState<MentionTarget | null>(null);

  const agents = useAgentStore((state) => state.agents);
  const loaded = useAgentStore((state) => state.loaded);
  const selectedAgentId = useAgentStore((state) => state.selectedAgentId);
  const setSelectedAgent = useAgentStore((state) => state.setSelectedAgent);
  const loadAgents = useAgentStore((state) => state.loadAgents);

  useEffect(() => {
    if (!loaded) {
      void loadAgents();
    }
  }, [loaded, loadAgents]);

  const currentAgent = findAgent(agents, selectedAgentId);
  const currentName = resolveAgentName(agents, selectedAgentId);
  const canOpenSheet = agents.length > 0;

  const renderIcon = (name: string, extraClassName = "") => (
    <Text
      className={`at-icon at-icon-${name} ${iconClassName} ${extraClassName}`.trim()}
    />
  );

  const hasContent = value.trim().length > 0;

  const handleInput = (next: string) => {
    // 末尾新敲出 @ → 呼出提及选择（仅追加输入时触发，避免删除/粘贴误弹）
    if (
      canOpenSheet &&
      next.length > value.length &&
      next.endsWith("@") &&
      inputMode === "text"
    ) {
      setSheetMode("mention");
    }
    // 已有提及但 @名字 文本被删掉 → 提及随之取消
    if (mention && !next.includes(`@${mention.name}`)) {
      setMention(null);
    }
    setValue(next);
  };

  /** 设置一次性提及：补全/追加 @名字 文本并记录目标（成员条快捷 @ 也走这里） */
  const applyMention = (agent: AgentSummary) => {
    setInputMode("text");
    setValue((prev) =>
      prev.endsWith("@") ? `${prev}${agent.name} ` : `${prev}@${agent.name} `,
    );
    setMention({ agentId: agent.isDefault ? null : agent.id, name: agent.name });
  };

  useImperativeHandle(ref, () => ({ insertMention: applyMention }));

  const handleSheetSelect = (agent: AgentSummary) => {
    if (sheetMode === "switch") {
      setSelectedAgent(agent.isDefault ? null : agent.id);
    } else if (sheetMode === "mention") {
      applyMention(agent);
    }
    setSheetMode(null);
  };

  const clearMention = () => {
    if (!mention) return;
    // 同步移除输入框里的 @名字 文本（仅首个匹配）
    setValue((prev) =>
      prev.includes(`@${mention.name} `)
        ? prev.replace(`@${mention.name} `, "")
        : prev.replace(`@${mention.name}`, ""),
    );
    setMention(null);
  };

  const handleSend = () => {
    const content = value.trim();
    if (!content || disabled || isStreaming) return;
    // 本条 @ 优先于粘性选择；null（默认智能体）转为 undefined 走后端默认
    const effectiveAgentId = mention
      ? (mention.agentId ?? undefined)
      : (selectedAgentId ?? undefined);
    onSend(content, effectiveAgentId);
    setValue("");
    setMention(null);
  };

  const handleStop = () => {
    onStop?.();
  };

  const toggleMode = () => {
    setInputMode((prev) => (prev === "text" ? "voice" : "text"));
  };

  const handleRecordComplete = (filePath: string) => {
    onRecordComplete?.(filePath);
  };

  const renderRightButtons = () => {
    if (inputMode === "voice") {
      return (
        <>
          <IconButton
            icon={renderIcon("edit")}
            variant='ghost'
            onClick={toggleMode}
          />
          <IconButton icon={renderIcon("add")} variant='ghost' />
        </>
      );
    }

    if (isStreaming) {
      return (
        <>
          <IconButton icon={renderIcon("add")} variant='ghost' />
          <IconButton
            icon={renderIcon("stop", "text-[var(--lb-on-accent)]")}
            variant='primary'
            onClick={handleStop}
          />
        </>
      );
    }

    if (hasContent) {
      return (
        <>
          <IconButton icon={renderIcon("add")} variant='ghost' />
          <IconButton
            icon={renderIcon("arrow-up", "text-[var(--lb-on-accent)]")}
            variant='primary'
            onClick={handleSend}
          />
        </>
      );
    }

    return (
      <>
        <IconButton
          icon={renderIcon("sound")}
          variant='ghost'
          onClick={toggleMode}
        />
        <IconButton icon={renderIcon("add")} variant='ghost' />
      </>
    );
  };

  return (
    <View
      className='border-t border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-[0.75rem] pt-[0.5rem] box-border'
      style={{ paddingBottom: safeAreaBottom(16) }}
    >
      {/* 工具条：当前智能体胶囊（粘性切换） + 本条 @ 提及标记 */}
      <View className='mb-[0.5rem] flex min-w-0 items-center gap-[0.5rem]'>
        <View
          className='flex min-w-0 max-w-[60%] items-center gap-[0.375rem] rounded-full border border-[var(--lb-line-soft)] bg-[var(--lb-page-background)] py-[0.25rem] pl-[0.25rem] pr-[0.625rem] box-border'
          onClick={() => canOpenSheet && setSheetMode("switch")}
        >
          <Image
            className='h-[1.375rem] w-[1.375rem] shrink-0 rounded-full bg-[var(--lb-surface)]'
            src={agentAvatarSrc(currentAgent?.avatar)}
            mode='aspectFill'
          />
          <Text className='block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.8125rem] font-medium leading-[1.3] text-[var(--lb-text-primary)]'>
            {currentName}
          </Text>
          {canOpenSheet ? (
            <Text className='at-icon at-icon-chevron-down shrink-0 text-[0.75rem] leading-none text-[var(--lb-text-muted)] [&::before]:block' />
          ) : null}
        </View>

        {mention ? (
          <View
            className='flex min-w-0 items-center gap-[0.25rem] rounded-full bg-[var(--lb-accent-soft)] px-[0.625rem] py-[0.3125rem] box-border'
            onClick={clearMention}
          >
            <Text className='block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[0.75rem] font-medium leading-[1.3] text-[var(--lb-accent-ink)]'>
              本条 @{mention.name}
            </Text>
            <Text className='at-icon at-icon-close shrink-0 text-[0.625rem] leading-none text-[var(--lb-accent-ink)] [&::before]:block' />
          </View>
        ) : null}
      </View>

      <View className='flex items-end gap-[0.75rem]'>
        <View className='flex-1 min-w-0'>
          {inputMode === "text" ? (
            <Textarea
              className={`${appSoftInputClass} w-full min-h-[2.625rem] max-h-[7.5rem] rounded-[var(--lb-radius-md)] px-[0.875rem] py-[0.625rem] box-border text-[0.9375rem] leading-[1.5] text-[var(--lb-text-primary)]`}
              value={value}
              onInput={(e) => handleInput(e.detail.value)}
              placeholder='发消息，输入 @ 指定谁来回答...'
              placeholderClass='text-[var(--lb-text-muted)]'
              maxlength={2000}
              disabled={disabled || isStreaming}
              autoHeight
              confirmType='send'
              onConfirm={handleSend}
            />
          ) : (
            <VoiceButton
              onRecordComplete={handleRecordComplete}
              disabled={disabled}
            />
          )}
        </View>

        <View className='flex items-center gap-[0.5rem]'>
          {renderRightButtons()}
        </View>
      </View>

      {sheetMode ? (
        <AgentSheet
          title={sheetMode === "mention" ? "@ 谁来回答这条" : "切换智能体"}
          agents={agents}
          selectedAgentId={
            sheetMode === "switch" ? selectedAgentId : undefined
          }
          onSelect={handleSheetSelect}
          onClose={() => setSheetMode(null)}
        />
      ) : null}
    </View>
  );
});
