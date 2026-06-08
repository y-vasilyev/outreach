import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { LLMProvider } from '@nosquare/llm';

import { invokeJson } from '../agents/_runtime.js';
import { makeCtx, makeLLM, makeLogger } from './_mocks.js';

/**
 * Element-tolerant extractor validation (harden-reply-extraction D1).
 * A single bad element must not reject the whole payload; valid siblings are
 * kept and the invalid one is dropped with a logged warning.
 */

const ElemZ = z.object({ n: z.number() });
const OutZ = z.object({
  items: z.array(ElemZ).default([]),
  others: z.array(ElemZ).default([]),
  note: z.string().optional(),
});

describe('invokeJson tolerant element validation', () => {
  it('drops only the invalid element and keeps valid siblings', async () => {
    const logger = makeLogger();
    const llm = makeLLM({
      completeJsonImpl: () => ({ items: [{ n: 1 }, { n: 'bad' }, { n: 3 }], note: 'x' }),
    });
    const ctx = { ...makeCtx({ llm }), logger };
    const out = await invokeJson({
      ctx,
      vars: {},
      outputSchema: OutZ,
      tolerantArrayFields: { items: ElemZ, others: ElemZ },
    });
    expect(out.items.map((i) => i.n)).toEqual([1, 3]);
    expect(out.note).toBe('x');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect((logger.warn as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toMatchObject({
      event: 'extract.element_dropped',
      array: 'items',
    });
  });

  it('an invalid element in one array does not lose a valid element in another', async () => {
    const llm = makeLLM({
      completeJsonImpl: () => ({ items: [{ n: 1 }], others: [{ n: 'bad' }] }),
    });
    const out = await invokeJson({
      ctx: makeCtx({ llm }),
      vars: {},
      outputSchema: OutZ,
      tolerantArrayFields: { items: ElemZ, others: ElemZ },
    });
    expect(out.items.map((i) => i.n)).toEqual([1]);
    expect(out.others).toEqual([]);
  });

  it('a fully valid payload is returned unchanged with no warning', async () => {
    const logger = makeLogger();
    const llm = makeLLM({ completeJsonImpl: () => ({ items: [{ n: 1 }, { n: 2 }] }) });
    const ctx = { ...makeCtx({ llm }), logger };
    const out = await invokeJson({ ctx, vars: {}, outputSchema: OutZ, tolerantArrayFields: { items: ElemZ } });
    expect(out.items.map((i) => i.n)).toEqual([1, 2]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('without tolerantArrayFields, a bad element rejects the payload (strict behavior unchanged)', async () => {
    const llm = makeLLM({ completeJsonImpl: () => ({ items: [{ n: 'bad' }] }) });
    await expect(
      invokeJson({ ctx: makeCtx({ llm }), vars: {}, outputSchema: OutZ }),
    ).rejects.toBeTruthy();
  });

  it('tolerant assembly does NOT pre-empt the provider repair shot', async () => {
    // A provider whose completeJson succeeds on the (simulated) repaired attempt
    // must return that value WITHOUT triggering tolerant element-dropping.
    const logger = makeLogger();
    let attempt = 0;
    const provider: LLMProvider = {
      kind: 'openrouter',
      estimateTokens: () => 1,
      listModels: async () => [],
      complete: async (req) => ({ text: '', tokensIn: 1, tokensOut: 1, costUsd: 0, model: req.model }),
      completeJson: async (req, parser) => {
        attempt += 1;
        // First raw is broken; the "repair" attempt returns a valid payload.
        const raw = attempt === 1 ? '{"items":[{"n":"bad"}]}' : '{"items":[{"n":7}]}';
        try {
          return { value: parser(raw) as never, meta: { text: raw, tokensIn: 1, tokensOut: 1, costUsd: 0, model: req.model } };
        } catch {
          const repaired = '{"items":[{"n":7}]}';
          return { value: parser(repaired) as never, meta: { text: repaired, tokensIn: 1, tokensOut: 1, costUsd: 0, model: req.model } };
        }
      },
    };
    const ctx = { ...makeCtx({ llm: provider }), logger };
    const out = await invokeJson({ ctx, vars: {}, outputSchema: OutZ, tolerantArrayFields: { items: ElemZ } });
    expect(out.items.map((i) => i.n)).toEqual([7]);
    expect(logger.warn).not.toHaveBeenCalled(); // tolerant path never ran
  });
});
