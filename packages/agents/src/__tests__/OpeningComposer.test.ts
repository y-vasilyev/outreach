import { describe, expect, it } from 'vitest';

import { openingComposer, assignVariantKeys } from '../agents/OpeningComposer.js';
import { makeCtx, makeConfig, makeLLM } from './_mocks.js';

/**
 * OpeningComposer (ab-opener-variants change):
 *   - Every variant gets a stable, non-optional `variantKey`.
 *   - LLM-supplied `variant_key` is preserved verbatim (trim + cap 32).
 *   - Duplicates from the LLM get `_2` / `_3` suffix.
 *   - Missing keys fall back to alphabetical A / B / C / ...
 */
describe('opening_composer — variantKey post-process', () => {
  const baseConfig = makeConfig({ systemPrompt: '', userPromptTemplate: '' });

  const baseInput = {
    channel_analysis: { topic: 'edtech' },
    contact: {},
    strategy: { approach: 'industry_fit' },
    campaign: { goal_text: 'custdev про процесс работы с брендами', value_prop: 'портфолио' },
    recent_posts: [],
  };

  it('assigns A/B/C alphabetically when LLM does not supply variant_key', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        variants: [
          { text: 'v1', rationale: '', length: 'short', risk_score: 0.1 },
          { text: 'v2', rationale: '', length: 'medium', risk_score: 0.1 },
          { text: 'v3', rationale: '', length: 'long', risk_score: 0.1 },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await openingComposer.run(baseInput, ctx);
    expect(out.variants.map((v) => v.variantKey)).toEqual(['A', 'B', 'C']);
  });

  it('preserves LLM-supplied variant_key verbatim', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        variants: [
          { text: 'v1', rationale: '', length: 'short', risk_score: 0.1, variant_key: 'concise' },
          { text: 'v2', rationale: '', length: 'medium', risk_score: 0.1, variant_key: 'value_prop' },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await openingComposer.run(baseInput, ctx);
    expect(out.variants.map((v) => v.variantKey)).toEqual(['concise', 'value_prop']);
  });

  it('disambiguates duplicate variant_key with _2 / _3 suffix', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        variants: [
          { text: 'v1', rationale: '', length: 'short', risk_score: 0.1, variant_key: 'short' },
          { text: 'v2', rationale: '', length: 'short', risk_score: 0.1, variant_key: 'short' },
          { text: 'v3', rationale: '', length: 'short', risk_score: 0.1, variant_key: 'short' },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await openingComposer.run(baseInput, ctx);
    expect(out.variants.map((v) => v.variantKey)).toEqual(['short', 'short_2', 'short_3']);
  });

  it('treats blank / whitespace-only variant_key as missing', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({
        variants: [
          { text: 'v1', rationale: '', length: 'short', risk_score: 0.1, variant_key: '   ' },
          { text: 'v2', rationale: '', length: 'medium', risk_score: 0.1, variant_key: '' },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await openingComposer.run(baseInput, ctx);
    expect(out.variants.map((v) => v.variantKey)).toEqual(['A', 'B']);
  });

  it('mixes LLM-supplied and missing keys without collision', async () => {
    // Edge case: LLM supplies 'B' on variant 0; variant 1 has no key — the
    // fallback for variant 1 must skip 'B' (already taken) and use 'A' or 'C'.
    const llm = makeLLM({
      completeJsonImpl: () => ({
        variants: [
          { text: 'v1', rationale: '', length: 'short', risk_score: 0.1, variant_key: 'B' },
          { text: 'v2', rationale: '', length: 'medium', risk_score: 0.1 },
          { text: 'v3', rationale: '', length: 'long', risk_score: 0.1 },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await openingComposer.run(baseInput, ctx);
    const keys = out.variants.map((v) => v.variantKey);
    // The LLM-supplied 'B' is preserved; the missing slots are filled with
    // the next free alphabetical keys ('A', 'C') in iteration order.
    expect(keys[0]).toBe('B');
    expect(keys.every((k, i, arr) => arr.indexOf(k) === i)).toBe(true);
    expect(keys).toContain('A');
    expect(keys).toContain('C');
  });

  it('caps variant_key at 32 characters', async () => {
    const longKey = 'a'.repeat(50);
    const llm = makeLLM({
      completeJsonImpl: () => ({
        variants: [
          { text: 'v1', rationale: '', length: 'short', risk_score: 0.1, variant_key: longKey },
        ],
      }),
    });
    const ctx = makeCtx({ llm, config: baseConfig });
    const out = await openingComposer.run(baseInput, ctx);
    expect(out.variants[0]!.variantKey).toBe('a'.repeat(32));
  });
});

// `AgentRunner` re-parses every `run()` output through `agent.outputSchema`
// — see AgentRunner.ts. If the agent's published `outputSchema` doesn't
// include `variantKey`, that re-parse silently strips it and the workers'
// `meta: { openerVariant: v.variantKey }` ends up as `meta: { openerVariant: undefined }`.
// These tests pin the schema's surface to the post-processed shape so a
// future refactor can't quietly regress.
describe('openingComposer.outputSchema includes variantKey', () => {
  it('parses a postprocessed-shape variant cleanly', () => {
    const parsed = openingComposer.outputSchema.parse({
      variants: [
        { text: 't', rationale: 'r', length: 'short', risk_score: 0.1, variantKey: 'A' },
      ],
    });
    expect(parsed.variants[0]!.variantKey).toBe('A');
  });
  it('rejects a variant without variantKey', () => {
    expect(() =>
      openingComposer.outputSchema.parse({
        variants: [{ text: 't', rationale: 'r', length: 'short', risk_score: 0.1 }],
      }),
    ).toThrow();
  });

  it('rejects a variant whose text exceeds the 600-char cap (existing constraint preserved)', () => {
    const tooLong = 'x'.repeat(601);
    expect(() =>
      openingComposer.outputSchema.parse({
        variants: [
          { text: tooLong, rationale: 'r', length: 'short', risk_score: 0.1, variantKey: 'A' },
        ],
      }),
    ).toThrow(/≤600 chars/);
  });
});

// Direct unit tests on the helper — guards against composer-specific drift
// (the helper is exported so AgencyOpeningComposer reuses it, and the spec
// requires identical behaviour across both composers).
describe('assignVariantKeys (shared helper)', () => {
  it('returns a stable array length matching the input', () => {
    const v = [{ variant_key: 'x' }, {}, { variant_key: undefined }];
    const out = assignVariantKeys(v);
    expect(out).toHaveLength(3);
  });

  it('handles an empty input array', () => {
    expect(assignVariantKeys([])).toEqual([]);
  });

  it('keeps every key unique even with adversarial input', () => {
    const v = [
      { variant_key: 'A' },
      { variant_key: 'A' },
      {},
      {},
      { variant_key: 'A' },
    ];
    const keys = assignVariantKeys(v).map((x) => x.variantKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
