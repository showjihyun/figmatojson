import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), tailwind()],
  root: 'client',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'client/src'),
    },
  },
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
