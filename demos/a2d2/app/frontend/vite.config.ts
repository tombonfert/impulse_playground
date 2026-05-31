import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Build output goes to dist/ (served by the FastAPI backend from frontend/dist).
// Dev server proxies /api to the local uvicorn backend on :8000.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
});
