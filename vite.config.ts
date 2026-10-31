import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

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
      '/api': {
        target: `http://127.0.0.1:${process.env.HABITAT_PORT ?? 8787}`,
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1500 },
});
