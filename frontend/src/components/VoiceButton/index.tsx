import { View, Text } from "@tarojs/components";
import useRecord, { RecordStatus } from "../../hooks/useRecord";

interface VoiceButtonProps {
  onRecordComplete: (tempFilePath: string) => void;
  disabled?: boolean;
}

export default function VoiceButton({
  onRecordComplete,
  disabled = false,
}: VoiceButtonProps) {
  const { status, start, stop } = useRecord({
    onStop: (result) => {
      onRecordComplete(result.tempFilePath);
    },
  });

  const isRecording = status === RecordStatus.RECORDING;

  const handleTouchStart = () => {
    if (disabled) return;
    start();
  };

  const handleTouchEnd = () => {
    if (status === RecordStatus.IDLE) return;
    stop();
  };

  return (
    <View
      className={`app-soft-input flex min-h-[2.625rem] flex-1 items-center justify-center rounded-[1rem] box-border ${isRecording ? "border-[#f9b5c8] bg-[#fff1f7]" : ""}`}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <Text
        className={`select-none text-[0.875rem] leading-none ${isRecording ? "text-[#db2777]" : "text-[var(--lb-text-secondary)]"}`}
      >
        {isRecording ? "松开结束" : "按住说话"}
      </Text>
    </View>
  );
}
