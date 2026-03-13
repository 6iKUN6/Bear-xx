import { useState } from "react";
import { View, Textarea } from "@tarojs/components";
import { Audio, Edit, Plus, StopCircle, ArrowUp } from "@taroify/icons";
import IconButton from "../IconButton";
import VoiceButton from "../VoiceButton";

interface ChatInputProps {
  onSend: (content: string) => void;
  onStop?: () => void;
  onRecordComplete?: (filePath: string) => void;
  isStreaming?: boolean;
  disabled?: boolean;
}

const ICON_SIZE = 22;

export default function ChatInput({
  onSend,
  onStop,
  onRecordComplete,
  isStreaming = false,
  disabled = false,
}: ChatInputProps) {
  const [value, setValue] = useState("");
  const [inputMode, setInputMode] = useState<"text" | "voice">("text");

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
          <IconButton
            icon={<Edit size={ICON_SIZE} />}
            variant='ghost'
            onClick={toggleMode}
          />
          <IconButton icon={<Plus size={ICON_SIZE} />} variant='ghost' />
        </>
      );
    }

    if (isStreaming) {
      return (
        <>
          <IconButton icon={<Plus size={ICON_SIZE} />} variant='ghost' />
          <IconButton
            icon={<StopCircle size={ICON_SIZE} color='#fff' />}
            variant='primary'
            onClick={handleStop}
          />
        </>
      );
    }

    if (hasContent) {
      return (
        <>
          <IconButton icon={<Plus size={ICON_SIZE} />} variant='ghost' />
          <IconButton
            icon={<ArrowUp size={ICON_SIZE} color='#fff' />}
            variant='primary'
            onClick={handleSend}
          />
        </>
      );
    }

    // Default: mic + plus
    return (
      <>
        <IconButton
          icon={<Audio size={ICON_SIZE} />}
          variant='ghost'
          onClick={toggleMode}
        />
        <IconButton icon={<Plus size={ICON_SIZE} />} variant='ghost' />
      </>
    );
  };

  return (
    <View
      className='flex items-end gap-[8rpx] px-4 pt-3 bg-white border-t border-td-border-base'
      style={{ paddingBottom: "calc(20rpx + env(safe-area-inset-bottom))" }}
    >
      {/* Left: input area or voice button */}
      <View className='flex-1'>
        {inputMode === "text" ? (
          <Textarea
            className='w-full min-h-[80rpx] max-h-[220rpx] px-4 py-[14rpx] bg-td-bg-secondary rounded-td-pill text-[28rpx] leading-[1.4] text-td-text-primary'
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

      {/* Right: action buttons */}
      <View className='flex items-center gap-[8rpx] pb-[4rpx]'>
        {renderRightButtons()}
      </View>
    </View>
  );
}
