import Taro from "@tarojs/taro";
import { useEffect, useRef, useState } from "react";

export enum RecordStatus {
  IDLE = "idle", // 闲置状态
  RECORDING = "recording", // 录音状态
  PAUSED = "paused", // 暂停状态
}

interface RecordResult {
  duration: number; // 录音时长
  fileSize: number; // 录音文件大小
  tempFilePath: string; // 录音文件路径
}

interface RecordError {
  errMsg: string; // 错误信息
}

interface RecordFrameData {
  frameBuffer: ArrayBuffer; // 录音帧数据
  isLastFrame: boolean; // 是否是最后一帧
}

interface UseRecordOptions {
  onStart?: () => void;
  onPause?: () => void;
  onResume?: () => void;
  onStop?: (result: RecordResult) => void;
  onError?: (error: RecordError) => void;
  onFrameRecorded?: (data: RecordFrameData) => void;
  onInterruptionBegin?: () => void;
  onInterruptionEnd?: () => void;
}

type RecordStartOption = Taro.RecorderManager.StartOption;

interface UseRecordReturn {
  status: RecordStatus;
  start: (option?: RecordStartOption) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

const useRecord = (options: UseRecordOptions = {}): UseRecordReturn => {
  const recorderManager = useRef(Taro.getRecorderManager());
  const [status, setStatus] = useState<RecordStatus>(RecordStatus.IDLE);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const mgr = recorderManager.current;

    mgr.onStart(() => {
      setStatus(RecordStatus.RECORDING);
      optionsRef.current.onStart?.();
    });

    mgr.onPause(() => {
      setStatus(RecordStatus.PAUSED);
      optionsRef.current.onPause?.();
    });

    mgr.onResume(() => {
      setStatus(RecordStatus.RECORDING);
      optionsRef.current.onResume?.();
    });

    mgr.onStop((res) => {
      setStatus(RecordStatus.IDLE);
      optionsRef.current.onStop?.(res);
    });

    mgr.onError((res) => {
      setStatus(RecordStatus.IDLE);
      optionsRef.current.onError?.(res);
    });

    mgr.onFrameRecorded((res) => {
      optionsRef.current.onFrameRecorded?.(res);
    });

    mgr.onInterruptionBegin(() => {
      setStatus(RecordStatus.PAUSED);
      optionsRef.current.onInterruptionBegin?.();
    });

    mgr.onInterruptionEnd(() => {
      optionsRef.current.onInterruptionEnd?.();
    });
  }, []);

  const start = (option?: RecordStartOption) => {
    if (status !== RecordStatus.IDLE) return;
    recorderManager.current.start(option ?? {});
  };

  const pause = () => {
    if (status !== RecordStatus.RECORDING) return;
    recorderManager.current.pause();
  };

  const resume = () => {
    if (status !== RecordStatus.PAUSED) return;
    recorderManager.current.resume();
  };

  const stop = () => {
    if (status === RecordStatus.IDLE) return;
    recorderManager.current.stop();
  };

  return { status, start, pause, resume, stop };
};

export default useRecord;
export type {
  RecordResult,
  RecordError,
  RecordFrameData,
  UseRecordOptions,
  RecordStartOption,
  UseRecordReturn,
};
