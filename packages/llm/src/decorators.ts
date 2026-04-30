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
    if (e.code !== 'UPSTREAM_ERROR') return false;
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
    complete: (req) => around(req, innerComplete),
    completeJson: async (req, parser) => {
      // We need the wrapping strategy (retry / timeout / accounting) to apply
      // to the network call, so we route through `around` rather than calling
      // provider.completeJson directly. The parser receives raw response text
      // (and is expected to use parseJsonStrict / extractJson helpers).
      const meta = await around(
        { ...req, jsonMode: req.jsonMode ?? true },
        innerComplete,
      );
      const value = parser(meta.text);
      return { value, meta };
    },
  };
}
