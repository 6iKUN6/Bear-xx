import { View, Text } from "@tarojs/components";
import useRecord, { RecordStatus } from "../../hooks/useRecord";
import "./index.scss";

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
      className={`voice-button ${isRecording ? "voice-button--recording" : ""}`}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <Text
        className={`voice-button__label ${isRecording ? "voice-button__label--recording" : ""}`}
      >
        {isRecording ? "松开 结束" : "按住 说话"}
      </Text>
    </View>
  );
}
