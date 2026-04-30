import { Errors } from '@nosquare/shared/errors';

import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  ProviderConfig,
} from '../types.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const COMPLETION_PATH = '/chat/completions';

interface OpenAIChoice {
  message?: { role?: string; content?: string };
  finish_reason?: string;
}

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** OpenRouter-specific: actual USD cost of the call when available. */
  cost?: number;
}

interface OpenAIResponse {
  id?: string;
  model?: string;
  choices?: OpenAIChoice[];
  usage?: OpenAIUsage;
}

export class OpenRouterProvider implements LLMProvider {
  public readonly kind = 'openrouter' as const;

  constructor(private readonly cfg: ProviderConfig) {
    if (!cfg.apiKey) {
      throw Errors.badRequest('OpenRouterProvider: apiKey required');
    }
  }

  estimateTokens(text: string): number {
    // ~4 chars/token is the canonical OpenAI-ish heuristic.
    return Math.ceil(text.length / 4);
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    return doOpenAICompatCall(this.cfg, req, {
      model: this.kind,
      defaultHeaders: this.buildHeaders(),
      includeCost: true,
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

  private buildHeaders(): Record<string, string> {
    const referer =
      process.env.OPENROUTER_HTTP_REFERER ?? 'https://nosquare.local/outreach';
    const title = process.env.OPENROUTER_X_TITLE ?? 'NoSquare Outreach';
    return {
      'HTTP-Referer': referer,
      'X-Title': title,
      ...(this.cfg.defaultHeaders ?? {}),
    };
  }
}

interface OpenAICallOpts {
  model: 'openrouter' | 'openai_compat';
  defaultHeaders: Record<string, string>;
  includeCost: boolean;
}

export async function doOpenAICompatCall(
  cfg: ProviderConfig,
  req: CompletionRequest,
  opts: OpenAICallOpts,
): Promise<CompletionResponse> {
  const url = `${cfg.baseUrl || DEFAULT_BASE_URL}${COMPLETION_PATH}`;

  // TODO: tighten body type once we settle on which schema features each provider supports.
  const body: Record<string, unknown> = {
    model: req.model,
    messages: [
      { role: 'system', content: req.systemPrompt },
      { role: 'user', content: req.userPrompt },
    ],
    temperature: req.temperature ?? 0.3,
    max_tokens: req.maxTokens ?? 2000,
  };
  if (req.topP != null) body.top_p = req.topP;

  if (req.responseSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'out', schema: req.responseSchema, strict: true },
    };
  } else if (req.jsonMode) {
    body.response_format = { type: 'json_object' };
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
    ...opts.defaultHeaders,
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: req.abortSignal,
    });
  } catch (e) {
    throw Errors.upstream(`${opts.model}: network error`, {
      message: (e as Error).message,
    });
  }

  if (!res.ok) {
    const errText = await safeReadText(res);
    throw Errors.upstream(`${opts.model}: HTTP ${res.status}`, {
      status: res.status,
      body: errText.slice(0, 500),
    });
  }

  let json: OpenAIResponse;
  try {
    json = (await res.json()) as OpenAIResponse;
  } catch (e) {
    throw Errors.upstream(`${opts.model}: invalid JSON response`, {
      message: (e as Error).message,
    });
  }

  const text = json.choices?.[0]?.message?.content;
  if (typeof text !== 'string') {
    throw Errors.upstream(`${opts.model}: missing choices[0].message.content`);
  }

  const usage = json.usage ?? {};
  const tokensIn = usage.prompt_tokens ?? 0;
  const tokensOut = usage.completion_tokens ?? 0;
  const costUsd = computeCost(opts, usage, tokensIn, tokensOut);

  return {
    text,
    tokensIn,
    tokensOut,
    costUsd,
    model: json.model ?? req.model,
    raw: json,
  };
}

function computeCost(
  opts: OpenAICallOpts,
  usage: OpenAIUsage,
  tokensIn: number,
  tokensOut: number,
): number {
  if (opts.includeCost && typeof usage.cost === 'number' && Number.isFinite(usage.cost)) {
    return usage.cost;
  }
  if (opts.model === 'openai_compat') {
    // Self-hosted: zero by default. Real pricing comes from endpoint config in a future iteration.
    return 0;
  }
  // Fallback placeholder until we wire a per-model rate table for OpenRouter.
  return (tokensIn + tokensOut) * 0.000001;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
