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

const iconClassName = "inline-flex items-center justify-center text-rpx-36 leading-none [&::before]:block";

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

  // Determine which right-side buttons to show
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

    // Default: mic + plus
    return (
      <>
        <IconButton icon={renderIcon("sound")} variant='ghost' onClick={toggleMode} />
        <IconButton icon={renderIcon("add")} variant='ghost' />
      </>
    );
  };

  return (
    <View
      className='flex items-end gap-rpx-8 border-t border-td-border-base bg-white px-rpx-32 pt-rpx-24 box-border'
      style={{ paddingBottom: safeAreaBottom(20) }}
    >
      <View className='flex-1 min-w-0'>
        {inputMode === "text" ? (
          <Textarea
            className='w-full min-h-rpx-80 max-h-[220rpx] rounded-td-pill-rpx bg-td-bg-secondary px-rpx-32 py-rpx-14 box-border text-rpx-28 leading-[1.4] text-td-text-primary'
            value={value}
            onInput={(e) => setValue(e.detail.value)}
            placeholder='发消息或按住说话'
            placeholderClass='text-td-text-disabled'
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

      <View className='flex items-center gap-rpx-8 pb-rpx-4'>
        {renderRightButtons()}
      </View>
    </View>
  );
}
