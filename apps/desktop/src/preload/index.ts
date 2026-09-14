import { contextBridge } from "electron";

/**
 * 渲染层桥：只暴露只读环境信息。
 * 后续主进程能力（窗口控制、本地缓存、更新）按需在此加白名单 API，不开通用 ipcRenderer。
 */
const bridge = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
  },
} as const;

export type SolaBridge = typeof bridge;

contextBridge.exposeInMainWorld("sola", bridge);
