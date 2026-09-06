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

  // 住在悬浮胶囊输入条里：容器由外层提供，此处透明；
  // 录音中用 danger-soft 圆角块给出明确的按压反馈。
  return (
    <View
      className={`flex min-h-[2.25rem] flex-1 items-center justify-center rounded-[var(--lb-radius-md)] box-border ${isRecording ? "bg-[var(--lb-danger-soft)]" : ""}`}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <Text
        className={`select-none text-[0.875rem] leading-none ${isRecording ? "text-[var(--lb-danger)]" : "text-[var(--lb-text-secondary)]"}`}
      >
        {isRecording ? "松开结束" : "按住说话"}
      </Text>
    </View>
  );
}
