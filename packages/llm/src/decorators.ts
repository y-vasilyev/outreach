import { AppError, Errors, isAppError } from '@nosquare/shared/errors';

import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  TokenAccountingHook,
} from './types.js';

/* -------------------------------------------------------------------------- */
/* withRetry                                                                  */
/* -------------------------------------------------------------------------- */

export interface RetryOpts {
  maxAttempts: number;
  baseMs: number;
}

export function withRetry(provider: LLMProvider, opts: RetryOpts): LLMProvider {
  return wrap(provider, (req, inner) => retryingCall(req, inner, opts));
}

async function retryingCall(
  req: CompletionRequest,
  inner: (r: CompletionRequest) => Promise<CompletionResponse>,
  opts: RetryOpts,
): Promise<CompletionResponse> {
  const { maxAttempts, baseMs } = opts;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await inner(req);
    } catch (e) {
      lastErr = e;
      if (req.abortSignal?.aborted) break;
      if (!isTransient(e) || attempt === maxAttempts) break;

      const jitter = Math.random() * baseMs;
      const delay = baseMs * 2 ** (attempt - 1) + jitter;
      await sleep(delay, req.abortSignal);
    }
  }

  if (isAppError(lastErr)) throw lastErr;
  throw Errors.upstream('LLM call failed after retries', {
    message: (lastErr as Error)?.message ?? String(lastErr),
  });
}

function isTransient(e: unknown): boolean {
  if (e instanceof AppError) {
    // Schema/JSON failures are NOT transient — repair-loop in
    // wrap.completeJson handles them. Network/HTTP-level failures are.
    if (e.code !== 'LLM_TRANSIENT' && e.code !== 'UPSTREAM_ERROR') return false;
    const status = readStatus(e.details);
    if (status == null) return true; // network error -> retry
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  // Non-AppError throwables (timeouts, raw fetch errors) — treat as transient.
  return true;
}

function readStatus(details: unknown): number | null {
  if (details && typeof details === 'object' && 'status' in details) {
    const s = (details as { status?: unknown }).status;
    if (typeof s === 'number') return s;
  }
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Errors.badRequest('aborted'));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(Errors.badRequest('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/* -------------------------------------------------------------------------- */
/* withTimeout                                                                */
/* -------------------------------------------------------------------------- */

export function withTimeout(provider: LLMProvider, ms: number): LLMProvider {
  return wrap(provider, async (req, inner) => {
    if (req.abortSignal) {
      // Caller provided a signal — respect it, don't add our own timeout.
      return inner(req);
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await inner({ ...req, abortSignal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) {
        throw Errors.upstream(`LLM call timed out after ${ms}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  });
}

/* -------------------------------------------------------------------------- */
/* withFallback                                                               */
/* -------------------------------------------------------------------------- */

export function withFallback(
  primary: LLMProvider,
  secondary: LLMProvider,
): LLMProvider {
  return {
    kind: primary.kind,
    estimateTokens: (t) => primary.estimateTokens(t),
    listModels: () => primary.listModels(),
    async complete(req) {
      try {
        const res = await primary.complete(req);
        markUsed(req, res, primary.kind);
        return res;
      } catch (primaryErr) {
        const res = await secondary.complete(req);
        markUsed(req, res, secondary.kind, primaryErr);
        return res;
      }
    },
    async completeJson(req, parser) {
      try {
        const out = await primary.completeJson(req, parser);
        markUsed(req, out.meta, primary.kind);
        return out;
      } catch (primaryErr) {
        const out = await secondary.completeJson(req, parser);
        markUsed(req, out.meta, secondary.kind, primaryErr);
        return out;
      }
    },
  };
}

function markUsed(
  req: CompletionRequest,
  res: CompletionResponse,
  used: string,
  primaryErr?: unknown,
): void {
  res.providerUsed = used;
  if (req.metadata) {
    req.metadata.providerUsed = used;
    if (primaryErr) {
      req.metadata.fallbackReason =
        primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* withTokenAccounting                                                        */
/* -------------------------------------------------------------------------- */

export function withTokenAccounting(
  provider: LLMProvider,
  hook: TokenAccountingHook,
): LLMProvider {
  return wrap(provider, async (req, inner) => {
    const start = Date.now();
    try {
      const res = await inner(req);
      await safeHook(hook, {
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        costUsd: res.costUsd,
        model: res.model,
        latencyMs: Date.now() - start,
        status: 'ok',
        providerKind: provider.kind,
      });
      return res;
    } catch (e) {
      await safeHook(hook, {
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        model: req.model,
        latencyMs: Date.now() - start,
        status: 'failed',
        error: e instanceof Error ? e.message : String(e),
        providerKind: provider.kind,
      });
      throw e;
    }
  });
}

async function safeHook(
  hook: TokenAccountingHook,
  run: Parameters<TokenAccountingHook>[0],
): Promise<void> {
  try {
    await hook(run);
  } catch {
    // Accounting must never break the caller. Swallow.
  }
}

/* -------------------------------------------------------------------------- */
/* Internal: wrap helper that preserves LLMProvider shape                     */
/* -------------------------------------------------------------------------- */

type CompleteFn = (
  req: CompletionRequest,
  inner: (r: CompletionRequest) => Promise<CompletionResponse>,
) => Promise<CompletionResponse>;

function wrap(provider: LLMProvider, around: CompleteFn): LLMProvider {
  const innerComplete = (r: CompletionRequest) => provider.complete(r);
  return {
    kind: provider.kind,
    estimateTokens: (t) => provider.estimateTokens(t),
    listModels: () => provider.listModels(),
    complete: (req) => around(req, innerComplete),
    completeJson: async (req, parser) => {
      // We need the wrapping strategy (retry / timeout / accounting) to apply
      // to every network call, so we route through `around`.
      //
      // Schema-validation failures (LLM_SCHEMA_FAILED / LLM_INVALID_JSON) are
      // a *content* problem, not a transport problem — `withRetry` rightly
      // ignores them. We instead run a repair-loop here: on the first such
      // failure, send the previous response and the validator's error back
      // to the model and ask it to fix only the broken fields. One pass is
      // enough to recover almost every case we've seen in production
      // (creative enum tokens, missing fields, wrong JSON shape) without
      // burning multiple turns of compute.
      const baseReq = { ...req, jsonMode: req.jsonMode ?? true };
      const meta = await around(baseReq, innerComplete);
      try {
        const value = parser(meta.text);
        return { value, meta };
      } catch (firstErr) {
        if (!isRepairable(firstErr)) throw firstErr;

        const repairReq: CompletionRequest = {
          ...baseReq,
          systemPrompt: buildRepairSystemPrompt(baseReq.systemPrompt),
          userPrompt: buildRepairUserPrompt(baseReq.userPrompt, meta.text, firstErr),
          // Slightly lower temperature on repair — we want the model to
          // correct, not re-improvise. Falls back to the original setting
          // when not provided.
          ...(typeof baseReq.temperature === 'number'
            ? { temperature: Math.max(0, Math.min(0.3, baseReq.temperature)) }
            : { temperature: 0 }),
        };
        const meta2 = await around(repairReq, innerComplete);
        const value = parser(meta2.text);
        // Roll up cost/tokens from both calls so accounting is faithful.
        const merged: CompletionResponse = {
          text: meta2.text,
          tokensIn: (meta.tokensIn ?? 0) + (meta2.tokensIn ?? 0),
          tokensOut: (meta.tokensOut ?? 0) + (meta2.tokensOut ?? 0),
          costUsd: (meta.costUsd ?? 0) + (meta2.costUsd ?? 0),
          model: meta2.model,
          ...(meta2.raw !== undefined && { raw: meta2.raw }),
          ...(meta2.providerUsed !== undefined && { providerUsed: meta2.providerUsed }),
        };
        return { value, meta: merged };
      }
    },
  };
}

function isRepairable(e: unknown): boolean {
  if (!isAppError(e)) return false;
  return e.code === 'LLM_SCHEMA_FAILED' || e.code === 'LLM_INVALID_JSON';
}

function buildRepairSystemPrompt(original: string): string {
  return [
    original,
    '',
    'ВАЖНО: предыдущий твой ответ не прошёл валидацию. Сейчас ты должен вернуть ИСКЛЮЧИТЕЛЬНО валидный JSON по той же схеме. Никаких комментариев до или после JSON. Не оборачивай в markdown-фенсы. Сохрани смысл и формулировки исходного ответа — поправь только то, что не прошло валидацию (формат, перечень допустимых значений enum, обязательные поля).',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildRepairUserPrompt(
  originalUser: string,
  previousAnswer: string,
  err: unknown,
): string {
  const details = isAppError(err) ? err.details : undefined;
  const validationMessage =
    (details && typeof details === 'object' && 'message' in details
      ? String((details as { message?: unknown }).message ?? '')
      : '') || (err instanceof Error ? err.message : String(err));

  return [
    originalUser,
    '',
    '— — —',
    'Твой предыдущий ответ:',
    truncate(previousAnswer, 1500),
    '',
    'Ошибка валидации:',
    truncate(validationMessage, 800),
    '',
    'Верни исправленный JSON. Только JSON.',
  ].join('\n');
}

function truncate(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
