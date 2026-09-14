import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 主进程 / preload 打 CJS（不启 "type":"module"），规避 ESM preload 的 sandbox 限制；
// 产物统一进 dist/，与 turbo build 的 outputs 对齐。
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: "dist/main" },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: { outDir: "dist/preload" },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": resolve("src/renderer/src"),
      },
    },
    build: { outDir: "dist/renderer" },
  },
});
