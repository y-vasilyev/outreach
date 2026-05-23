import { describe, expect, it } from 'vitest';

import { withRetry } from '../decorators.js';
import { parseJsonStrict } from '../providers/jsonExtract.js';
import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
} from '../types.js';

/**
 * Repair-loop is implemented inside `wrap()` (the helper that backs
 * withRetry / withTokenAccounting). On a parser failure we re-prompt the
 * model with the previous response + zod error and try once more. Anything
 * that isn't a content failure (LLM_INVALID_JSON / LLM_SCHEMA_FAILED) must
 * still propagate as-is.
 */

interface Attempt {
  systemPrompt: string;
  userPrompt: string;
  text: string;
}

/**
 * Makes a provider whose `complete()` walks through a fixed list of replies.
 * Records every request so the test can assert on the repair-prompt shape.
 */
function makeScripted(replies: string[]): {
  provider: LLMProvider;
  attempts: Attempt[];
} {
  const attempts: Attempt[] = [];
  let i = 0;
  const provider: LLMProvider = {
    kind: 'openai_compat',
    estimateTokens: () => 1,
    listModels: async () => [],
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const text = replies[i] ?? replies[replies.length - 1] ?? '';
      attempts.push({ systemPrompt: req.systemPrompt, userPrompt: req.userPrompt, text });
      i += 1;
      return {
        text,
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0,
        model: req.model,
      };
    },
    async completeJson() {
      throw new Error('not used');
    },
  };
  return { provider, attempts };
}

const baseReq: CompletionRequest = {
  systemPrompt: 'be a JSON robot',
  userPrompt: 'Verdict?',
  model: 'm',
};

const validator = (raw: string) =>
  parseJsonStrict(raw, (v) => {
    const o = v as { verdict?: unknown };
    if (o.verdict !== 'ok' && o.verdict !== 'bad') {
      throw new Error('verdict must be "ok" or "bad"');
    }
    return { verdict: o.verdict };
  });

describe('completeJson repair-loop', () => {
  it('passes through cleanly on first valid response', async () => {
    const { provider, attempts } = makeScripted(['{"verdict":"ok"}']);
    const wrapped = withRetry(provider, { maxAttempts: 1, baseMs: 1 });
    const out = await wrapped.completeJson(baseReq, validator);
    expect(out.value).toEqual({ verdict: 'ok' });
    expect(attempts.length).toBe(1);
  });

  it('runs ONE repair pass when the first response fails schema', async () => {
    const { provider, attempts } = makeScripted([
      // First: structurally JSON but verdict is unknown enum.
      '{"verdict":"maybe"}',
      // Second: model "fixes" itself.
      '{"verdict":"ok"}',
    ]);
    const wrapped = withRetry(provider, { maxAttempts: 1, baseMs: 1 });
    const out = await wrapped.completeJson(baseReq, validator);
    expect(out.value).toEqual({ verdict: 'ok' });
    expect(attempts.length).toBe(2);
    // Repair prompt must include the previous answer + validation error.
    expect(attempts[1]!.userPrompt).toContain('"maybe"');
    expect(attempts[1]!.userPrompt).toMatch(/verdict must be/);
    // Repair system prompt must mark the response as failed validation.
    expect(attempts[1]!.systemPrompt).toMatch(/не прошёл валидацию|valid JSON/);
  });

  it('runs repair on LLM_INVALID_JSON (model returned non-JSON garbage)', async () => {
    const { provider, attempts } = makeScripted([
      'oh sorry I cannot do that',
      '{"verdict":"bad"}',
    ]);
    const wrapped = withRetry(provider, { maxAttempts: 1, baseMs: 1 });
    const out = await wrapped.completeJson(baseReq, validator);
    expect(out.value).toEqual({ verdict: 'bad' });
    expect(attempts.length).toBe(2);
  });

  it('only repairs ONCE — a second schema failure propagates', async () => {
    const { provider, attempts } = makeScripted([
      '{"verdict":"maybe"}',
      '{"verdict":"perhaps"}',
    ]);
    const wrapped = withRetry(provider, { maxAttempts: 1, baseMs: 1 });
    let caught: unknown;
    try {
      await wrapped.completeJson(baseReq, validator);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const err = caught as { code: string };
    expect(err.code).toBe('LLM_SCHEMA_FAILED');
    expect(attempts.length).toBe(2);
  });

  it('does NOT retry on transport errors (those are isTransient — withRetry handles them)', async () => {
    // Simulate a provider whose .complete() throws a transient network error
    // first, then succeeds. withRetry should retry the call itself; the
    // repair-loop should not do anything extra.
    let i = 0;
    const replies = ['{"verdict":"ok"}'];
    const provider: LLMProvider = {
      kind: 'openai_compat',
      estimateTokens: () => 1,
      listModels: async () => [],
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        if (i === 0) {
          i += 1;
          throw Object.assign(new Error('boom'), {
            code: 'LLM_TRANSIENT',
            name: 'AppError',
          });
        }
        return {
          text: replies[0]!,
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
          model: req.model,
        };
      },
      async completeJson() {
        throw new Error('not used');
      },
    };
    const wrapped = withRetry(provider, { maxAttempts: 2, baseMs: 1 });
    // Plain Error doesn't have AppError prototype, so isTransient falls
    // through "Non-AppError throwables — treat as transient" branch and
    // retries. Either way — the call should succeed.
    const out = await wrapped.completeJson(baseReq, validator);
    expect(out.value).toEqual({ verdict: 'ok' });
  });

  it('rolls up token usage across the repair pass', async () => {
    let i = 0;
    const provider: LLMProvider = {
      kind: 'openai_compat',
      estimateTokens: () => 1,
      listModels: async () => [],
      async complete(req: CompletionRequest): Promise<CompletionResponse> {
        const isFirst = i === 0;
        i += 1;
        return {
          text: isFirst ? '{"verdict":"maybe"}' : '{"verdict":"ok"}',
          tokensIn: isFirst ? 10 : 20,
          tokensOut: isFirst ? 5 : 7,
          costUsd: isFirst ? 0.001 : 0.002,
          model: req.model,
        };
      },
      async completeJson() {
        throw new Error('not used');
      },
    };
    const wrapped = withRetry(provider, { maxAttempts: 1, baseMs: 1 });
    const out = await wrapped.completeJson(baseReq, validator);
    expect(out.value).toEqual({ verdict: 'ok' });
    expect(out.meta.tokensIn).toBe(30);
    expect(out.meta.tokensOut).toBe(12);
    expect(out.meta.costUsd).toBeCloseTo(0.003, 5);
  });
});
