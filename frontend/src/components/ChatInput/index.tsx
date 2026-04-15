import { useState } from "react";
import { View, Text, Textarea } from "@tarojs/components";
import IconButton from "../IconButton";
import VoiceButton from "../VoiceButton";
import { safeAreaBottom } from "../../utils/style";

interface ChatInputProps {
  onSend: (content: string) => void;
  onStop?: () => void;
  onRecordComplete?: (filePath: string) => void;
  isStreaming?: boolean;
  disabled?: boolean;
}

const iconClassName = "inline-flex items-center justify-center text-[20px] leading-none [&::before]:block";

export default function ChatInput({
  onSend,
  onStop,
  onRecordComplete,
  isStreaming = false,
  disabled = false,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [inputMode, setInputMode] = useState<"text" | "voice">("text");

  const renderIcon = (name: string, extraClassName = "") => (
    <Text className={`at-icon at-icon-${name} ${iconClassName} ${extraClassName}`.trim()} />
  );

  const hasContent = value.trim().length > 0;

  const handleSend = () => {
    const content = value.trim();
    if (!content || disabled || isStreaming) return;
    onSend(content);
    setValue("");
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
          <IconButton icon={renderIcon("edit")} variant='ghost' onClick={toggleMode} />
          <IconButton icon={renderIcon("add")} variant='ghost' />
        </>
      );
    }

    if (isStreaming) {
      return (
        <>
          <IconButton icon={renderIcon("add")} variant='ghost' />
          <IconButton
            icon={renderIcon("stop", "text-white")}
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
            icon={renderIcon("arrow-up", "text-white")}
            variant='primary'
            onClick={handleSend}
          />
        </>
      );
    }

    return (
      <>
        <IconButton icon={renderIcon("sound")} variant='ghost' onClick={toggleMode} />
        <IconButton icon={renderIcon("add")} variant='ghost' />
      </>
    );
  };

  return (
    <View
      className='border-t border-[rgba(17,24,39,0.05)] bg-white px-[12px] pt-[10px] shadow-[0_-8px_20px_rgba(124,58,237,0.05)] box-border'
      style={{ paddingBottom: safeAreaBottom(16) }}
    >
      <View className='flex items-end gap-[12px]'>
        <View className='flex-1 min-w-0'>
          {inputMode === "text" ? (
            <Textarea
              className='app-soft-input w-full min-h-[42px] max-h-[120px] rounded-[16px] px-[16px] py-[10px] box-border text-[15px] leading-[1.5] text-[var(--lb-text-primary)]'
              value={value}
              onInput={(e) => setValue(e.detail.value)}
              placeholder='发消息或按住说话...'
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

        <View className='flex items-center gap-[8px]'>
          {renderRightButtons()}
        </View>
      </View>
    </View>
  );
}
