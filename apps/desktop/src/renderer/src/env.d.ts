/// <reference types="vite/client" />

import type { SolaBridge } from "../../preload";

declare global {
  interface Window {
    /** preload contextBridge 暴露的桥；纯浏览器调试（无 preload）时为 undefined */
    sola?: SolaBridge;
  }

  interface ImportMetaEnv {
    /** C 端 API 地址（不带 /api 后缀），缺省 http://127.0.0.1:3000 */
    readonly RENDERER_API_BASE_URL?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
