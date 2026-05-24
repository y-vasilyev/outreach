import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

/**
 * Vitest config for the admin web app.
 *
 * - `happy-dom` is the lightest DOM env that covers Vue Test Utils' needs
 *   (no SSR, no canvas, no layout-sensitive APIs in this UI).
 * - `setupFiles` wires per-test cleanup (auto-unmount) and is the single
 *   place to add global jsdom-style shims if needed later.
 * - `passWithNoTests` keeps `pnpm test` green during the rollout.
 */
export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
