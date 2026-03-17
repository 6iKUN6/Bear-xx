import { useState } from "react";
import { View, Text, Textarea } from "@tarojs/components";
import IconButton from "../IconButton";
import VoiceButton from "../VoiceButton";
import { safeAreaBottom } from "../../utils/style";
import "./index.scss";

interface ChatInputProps {
  onSend: (content: string) => void;
  onStop?: () => void;
  onRecordComplete?: (filePath: string) => void;
  isStreaming?: boolean;
  disabled?: boolean;
}

const iconClassName = "chat-input__icon at-icon";

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
      className='chat-input'
      style={{ paddingBottom: safeAreaBottom(20) }}
    >
      <View className='chat-input__field'>
        {inputMode === "text" ? (
          <Textarea
            className='chat-input__textarea'
            value={value}
            onInput={(e) => setValue(e.detail.value)}
            placeholder='发消息或按住说话'
            placeholderClass='chat-input__placeholder'
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

      <View className='chat-input__actions'>
        {renderRightButtons()}
      </View>
    </View>
  );
}
