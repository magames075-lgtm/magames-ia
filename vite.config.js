import { defineConfig } from 'vite';
export default defineConfig({
  base: '/magames-ia/',
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
  worker: { format: 'es' },
  build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 8000 },
});
