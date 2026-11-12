import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const API_TARGET = `http://127.0.0.1:${process.env.HABITAT_PORT ?? 8787}`;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: 5178,
    strictPort: false,
    proxy: {
      // 登录页与改密页是服务端渲染的，开发模式下也要走 API 端口；
      // 只代理 /api 的话，浏览器会被 5178/login 的 SPA 兜底接住，看不到表单。
      // changeOrigin 保持 false：服务端会校验 Origin 与 Host 同源（防 CSRF），改写 Host 会把自己拦掉。
      '/api': { target: API_TARGET, changeOrigin: false },
      '/login': { target: API_TARGET, changeOrigin: false },
      '/logout': { target: API_TARGET, changeOrigin: false },
      '/change-password': { target: API_TARGET, changeOrigin: false },
      // 对外只读页是服务端渲染的：不代理的话，开发模式下访问分享链接会落到 SPA 兜底，看到的是管理端。
      '/s/': { target: API_TARGET, changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
});
