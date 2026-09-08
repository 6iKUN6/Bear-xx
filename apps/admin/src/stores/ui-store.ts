import { create } from "zustand";
import { persist } from "zustand/middleware";

/** Flow 编辑器左右栏宽度（像素）；中栏自适应占满剩余。 */
export interface FlowEditorPanels {
  left: number;
  right: number;
}

/** 分栏默认值与可拖拽边界（像素）：中栏始终 ≥320，避免画布被挤没 */
export const FLOW_EDITOR_PANEL_LIMITS = {
  left: { min: 180, max: 400, default: 212 },
  right: { min: 280, max: 520, default: 336 },
} as const;

interface UiState {
  /** 观测时间窗口天数（全局，各页共用） */
  rangeDays: number;
  setRangeDays: (days: number) => void;
  /** Flow 编辑器左右栏宽度；persist 到 localStorage，刷新后保持 */
  flowEditorPanels: FlowEditorPanels;
  setFlowEditorPanels: (panels: FlowEditorPanels) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      rangeDays: 7,
      setRangeDays: (rangeDays) => set({ rangeDays }),
      flowEditorPanels: {
        left: FLOW_EDITOR_PANEL_LIMITS.left.default,
        right: FLOW_EDITOR_PANEL_LIMITS.right.default,
      },
      setFlowEditorPanels: (flowEditorPanels) => set({ flowEditorPanels }),
    }),
    {
      name: "lb-ui",
      // 只持久化分栏宽度；rangeDays 保持每次会话重置为 7 天的现状
      partialize: (state) => ({ flowEditorPanels: state.flowEditorPanels }),
    },
  ),
);

export const RANGE_OPTIONS = [
  { value: 7, label: "近 7 天" },
  { value: 14, label: "近 14 天" },
  { value: 30, label: "近 30 天" },
] as const;
