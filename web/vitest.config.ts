import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Vitest config — separate from vite.config.ts because vite scopes its
 * `root` to the React client (`./client`), which would hide unit tests
 * living under `core/` and `server/`. Vitest needs the wider tree.
 *
 * Path aliases mirror the Vite ones so `@/...` and `@core/...` imports
 * resolve identically inside tests.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'client/src'),
      '@core': resolve(__dirname, 'core'),
    },
  },
  test: {
    include: ['client/**/*.test.{ts,tsx}', 'core/**/*.test.{ts,tsx}'],
    // jsdom is opt-in per file via `// @vitest-environment jsdom`;
    // pure unit tests (multiResize, EditNode) run faster in node.
    environment: 'node',
    // @testing-library/react needs explicit cleanup between tests when
    // not using globals — without this the previous test's DOM stays
    // mounted and getByRole sees ambiguous matches.
    setupFiles: ['./vitest.setup.ts'],
  },
});
