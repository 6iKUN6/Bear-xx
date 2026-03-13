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
      className={`flex-1 h-[80rpx] rounded-td-pill border flex items-center justify-center ${
        isRecording
          ? "bg-[#FFECEB] border-[#F8B5B3]"
          : "bg-td-bg-secondary border-td-border-base"
      }`}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <Text
        className={`text-[28rpx] select-none ${
          isRecording ? "text-td-danger" : "text-td-text-secondary"
        }`}
      >
        {isRecording ? "松开 结束" : "按住 说话"}
      </Text>
    </View>
  );
}
