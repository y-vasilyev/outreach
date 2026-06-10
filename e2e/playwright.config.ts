import { defineConfig } from '@playwright/test';

/**
 * E2e harness (catalog-sql-search 4.3). The stack (Postgres in docker, api,
 * vite dev server) is orchestrated by `e2e/run.sh` — this config only points
 * playwright at the already-running web server. Run: `pnpm test:e2e`.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: process.env['E2E_WEB_URL'] ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  reporter: [['list']],
});
