import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5273,
  },
  build: {
    rollupOptions: {
      output: {
        // 把大体积且相对稳定的依赖拆成独立 chunk，避免单个 index.js 超 1MB：
        // 画布（xyflow）、图表（recharts）、动效（motion）只在对应页面用到，按需并行加载。
        manualChunks: {
          "vendor-react": ["react", "react-dom", "react-router-dom"],
          "vendor-motion": ["motion"],
          "vendor-xyflow": ["@xyflow/react"],
          "vendor-recharts": ["recharts"],
        },
      },
    },
  },
});
