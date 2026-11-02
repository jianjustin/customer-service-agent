import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 前端根目录即 web/；开发时把 /api 代理到后端（SERVER_PORT，默认 3001）
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": `http://localhost:${process.env.SERVER_PORT ?? "3001"}` },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
