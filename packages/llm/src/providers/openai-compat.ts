import { Errors } from '@nosquare/shared/errors';

import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  ProviderConfig,
} from '../types.js';
import { doOpenAICompatCall } from './openrouter.js';

/**
 * Generic OpenAI-compatible provider — for self-hosted gateways like vLLM,
 * Ollama, LM Studio, or a private Azure-OpenAI proxy. No special headers,
 * no usage.cost field, cost defaults to $0 (until a real pricing table is wired).
 */
export class OpenAICompatProvider implements LLMProvider {
  public readonly kind = 'openai_compat' as const;

  constructor(private readonly cfg: ProviderConfig) {
    if (!cfg.baseUrl) {
      throw Errors.badRequest('OpenAICompatProvider: baseUrl required');
    }
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    return doOpenAICompatCall(this.cfg, req, {
      model: this.kind,
      defaultHeaders: this.cfg.defaultHeaders ?? {},
      includeCost: false,
    });
  }

  async completeJson<T>(
    req: CompletionRequest,
    parser: (raw: string) => T,
  ): Promise<{ value: T; meta: CompletionResponse }> {
    const meta = await this.complete({
      ...req,
      jsonMode: req.jsonMode ?? true,
    });
    const value = parser(meta.text);
    return { value, meta };
  }
}
