// Stubs the env vars that `apps/workers/src/env.ts` validates at import
// time. Runs as vitest setupFile so unit tests can import worker
// modules without crashing on env validation. Real DB / Redis / TG
// creds aren't used — the deps that need them are mocked per test.
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.ENCRYPTION_KEY ??= 'test-encryption-key-32-bytes-aaaaaaa';
