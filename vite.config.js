import { defineConfig } from 'vite';
export default defineConfig({
  base: '/magames-ia/',
  worker: { format: 'es' },
  build: { target: 'es2022', outDir: 'dist', chunkSizeWarningLimit: 800 },
});
