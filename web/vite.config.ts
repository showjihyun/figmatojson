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
      '@core': resolve(__dirname, 'core'),
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
    rollupOptions: {
      output: {
        // Split heavy, rarely-changing dep groups out of the app bundle so
        // browser cache hits across deploys and the initial parse cost is
        // spread across parallel HTTP/2 streams. Konva is the dominant
        // offender (~600 kB unminified). Splitting it now makes a future
        // `React.lazy(Canvas)` cheap — Konva won't be loaded until the
        // user actually opens a document.
        manualChunks: {
          konva: ['konva', 'react-konva'],
          radix: [
            '@radix-ui/react-dialog',
            '@radix-ui/react-label',
            '@radix-ui/react-select',
            '@radix-ui/react-separator',
            '@radix-ui/react-slot',
            '@radix-ui/react-tabs',
          ],
        },
      },
    },
  },
});
