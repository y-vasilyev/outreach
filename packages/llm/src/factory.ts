import { Errors } from '@nosquare/shared/errors';

import { withRetry, withTimeout } from './decorators.js';
import { OpenAICompatProvider } from './providers/openai-compat.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { YandexProvider } from './providers/yandex.js';
import type { LLMProvider, ProviderConfig, ProviderKind } from './types.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY = { maxAttempts: 3, baseMs: 500 };

/**
 * Build a ready-to-use LLMProvider from a `kind` and credential config.
 *
 * Decorators applied (in order, outermost first):
 *   timeout -> retry -> raw provider
 *
 * The caller (typically AgentRunner) is expected to additionally wrap with
 * withTokenAccounting and optionally withFallback.
 */
export function createProvider(
  kind: ProviderKind,
  cfg: ProviderConfig,
): LLMProvider {
  const raw = buildRaw(kind, cfg);
  const retried = withRetry(raw, DEFAULT_RETRY);
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return withTimeout(retried, timeoutMs);
}

function buildRaw(kind: ProviderKind, cfg: ProviderConfig): LLMProvider {
  switch (kind) {
    case 'yandex':
      return new YandexProvider(cfg);
    case 'openrouter':
      return new OpenRouterProvider(cfg);
    case 'openai_compat':
      return new OpenAICompatProvider(cfg);
    default: {
      const exhaustive: never = kind;
      throw Errors.badRequest(`createProvider: unknown kind ${String(exhaustive)}`);
    }
  }
}
