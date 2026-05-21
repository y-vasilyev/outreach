// Env stubbing runs from vitest's setupFiles in apps/api/vitest.config.ts.

import { describe, expect, it, vi } from 'vitest';

// The route module imports services that touch @nosquare/db lazily (getPrisma
// is only called inside handlers). Stub it so importing the schema is cheap and
// side-effect-free.
vi.mock('@nosquare/db', () => ({ getPrisma: () => ({}) }));

import { matchOptsZ } from '../matching.js';

/**
 * S4: `?rerank=false` MUST parse to false (no LLM call). The previous
 * `z.coerce.boolean()` coerced the non-empty string 'false' to true, silently
 * issuing an LLM re-rank the caller explicitly opted out of. Only an explicit
 * `true` (boolean or 'true') enables it.
 */
describe('matchOptsZ rerank coercion (S4)', () => {
  it("parses the query string 'false' to false", () => {
    expect(matchOptsZ.parse({ rerank: 'false' }).rerank).toBe(false);
  });

  it("parses the query string 'true' to true", () => {
    expect(matchOptsZ.parse({ rerank: 'true' }).rerank).toBe(true);
  });

  it('treats an absent rerank as false', () => {
    expect(matchOptsZ.parse({}).rerank).toBe(false);
  });

  it('accepts a real boolean true (JSON body)', () => {
    expect(matchOptsZ.parse({ rerank: true }).rerank).toBe(true);
  });

  it('accepts a real boolean false (JSON body)', () => {
    expect(matchOptsZ.parse({ rerank: false }).rerank).toBe(false);
  });

  it('rejects an unexpected rerank string', () => {
    expect(() => matchOptsZ.parse({ rerank: 'maybe' })).toThrow();
  });
});
