import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/services/__tests__/_test-env.ts'],
    passWithNoTests: true,
  },
});
