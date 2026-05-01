import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  root: 'client',
  server: {
    port: 5273,
    strictPort: true,           // fail if 5273 occupied (no silent fallback)
    proxy: {
      '/api': 'http://localhost:5274',
    },
  },
  build: {
    outDir: '../dist-client',
    emptyOutDir: true,
  },
});
