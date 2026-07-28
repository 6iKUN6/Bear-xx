import { create } from "zustand";

interface UiState {
  /** 观测时间窗口天数（全局，各页共用） */
  rangeDays: number;
  setRangeDays: (days: number) => void;
}

export const useUiStore = create<UiState>((set) => ({
  rangeDays: 7,
  setRangeDays: (rangeDays) => set({ rangeDays }),
}));

export const RANGE_OPTIONS = [
  { value: 7, label: "近 7 天" },
  { value: 14, label: "近 14 天" },
  { value: 30, label: "近 30 天" },
] as const;
