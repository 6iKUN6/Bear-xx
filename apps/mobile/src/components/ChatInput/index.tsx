import { useState } from "react";
import { View, Text, Textarea } from "@tarojs/components";
import IconButton from "../IconButton";
import VoiceButton from "../VoiceButton";
import { appSoftInputClass, safeAreaBottom } from "../../utils/style";

interface ChatInputProps {
  onSend: (content: string) => void;
  onStop?: () => void;
  onRecordComplete?: (filePath: string) => void;
  isStreaming?: boolean;
  disabled?: boolean;
}

const iconClassName =
  "inline-flex items-center justify-center text-[1.25rem] leading-none [&::before]:block";

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
    <Text
      className={`at-icon at-icon-${name} ${iconClassName} ${extraClassName}`.trim()}
    />
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
          <IconButton
            icon={renderIcon("edit")}
            variant="ghost"
            onClick={toggleMode}
          />
          <IconButton icon={renderIcon("add")} variant="ghost" />
        </>
      );
    }

    if (isStreaming) {
      return (
        <>
          <IconButton icon={renderIcon("add")} variant="ghost" />
          <IconButton
            icon={renderIcon("stop", "text-[var(--lb-on-accent)]")}
            variant="primary"
            onClick={handleStop}
          />
        </>
      );
    }

    if (hasContent) {
      return (
        <>
          <IconButton icon={renderIcon("add")} variant="ghost" />
          <IconButton
            icon={renderIcon("arrow-up", "text-[var(--lb-on-accent)]")}
            variant="primary"
            onClick={handleSend}
          />
        </>
      );
    }

    return (
      <>
        <IconButton
          icon={renderIcon("sound")}
          variant="ghost"
          onClick={toggleMode}
        />
        <IconButton icon={renderIcon("add")} variant="ghost" />
      </>
    );
  };

  return (
    <View
      className="border-t border-[var(--lb-line-soft)] bg-[var(--lb-surface)] px-[0.75rem] pt-[0.5rem] box-border"
      style={{ paddingBottom: safeAreaBottom(16) }}
    >
      <View className="flex items-end gap-[0.75rem]">
        <View className="flex-1 min-w-0">
          {inputMode === "text" ? (
            <Textarea
              className={`${appSoftInputClass} w-full min-h-[2.625rem] max-h-[7.5rem] rounded-[var(--lb-radius-md)] px-[0.875rem] py-[0.625rem] box-border text-[0.9375rem] leading-[1.5] text-[var(--lb-text-primary)]`}
              value={value}
              onInput={(e) => setValue(e.detail.value)}
              placeholder="发消息或按住说话..."
              placeholderClass="text-[var(--lb-text-muted)]"
              maxlength={2000}
              disabled={disabled || isStreaming}
              autoHeight
              confirmType="send"
              onConfirm={handleSend}
            />
          ) : (
            <VoiceButton
              onRecordComplete={handleRecordComplete}
              disabled={disabled}
            />
          )}
        </View>

        <View className="flex items-center gap-[0.5rem]">
          {renderRightButtons()}
        </View>
      </View>
    </View>
  );
}
