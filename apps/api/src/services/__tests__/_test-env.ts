// Stubs the env vars that `apps/api/src/env.ts` validates at import time.
// Runs before any test file imports — the api's env validation is strict
// and would otherwise crash unit tests that don't actually need a real
// DB / Redis connection (the deps are mocked per-test).
process.env.DATABASE_URL ??= 'postgresql://localhost:5432/test';
process.env.REDIS_URL ??= 'redis://localhost:6379';
process.env.JWT_SECRET ??= 'test-jwt-secret-32-chars-minimum-yes';
process.env.ENCRYPTION_KEY ??= 'test-encryption-key-32-bytes-aaaaaaa';
