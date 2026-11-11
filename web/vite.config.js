import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development the API runs on :4000 and Vite proxies /api to it, so the browser sees one
// origin exactly as it does in production (where Express serves the built files itself).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:4000', changeOrigin: false },
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
