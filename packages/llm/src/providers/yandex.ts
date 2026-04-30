import { Errors } from '@nosquare/shared/errors';

import type {
  CompletionRequest,
  CompletionResponse,
  LLMProvider,
  ModelInfo,
  ProviderConfig,
} from '../types.js';

const DEFAULT_BASE_URL = 'https://llm.api.cloud.yandex.net';
const COMPLETION_PATH = '/foundationModels/v1/completion';

/**
 * Yandex Foundation Models pricing — USD per 1M tokens, public list price
 * approximations. Real billing uses RUB; treat these as estimates so the
 * `agent_run` has a non-zero number for budgeting/alerts.
 */
const PRICING: Record<string, { in: number; out: number }> = {
  'yandexgpt-lite': { in: 0.2, out: 0.2 },
  yandexgpt: { in: 1.2, out: 1.2 },
};
const DEFAULT_PRICE = { in: 0.5, out: 0.5 };

interface YandexUsage {
  inputTextTokens?: string | number;
  completionTokens?: string | number;
  totalTokens?: string | number;
}

interface YandexAlternative {
  message?: { role?: string; text?: string };
  status?: string;
}

interface YandexResponse {
  result?: {
    alternatives?: YandexAlternative[];
    usage?: YandexUsage;
    modelVersion?: string;
  };
}

export class YandexProvider implements LLMProvider {
  public readonly kind = 'yandex' as const;

  constructor(private readonly cfg: ProviderConfig) {
    if (!cfg.iamToken && !cfg.apiKey) {
      throw Errors.badRequest('YandexProvider: apiKey or iamToken required');
    }
    // folderId is required unless callers pass a fully-qualified `gpt://...` model uri.
    // We resolve per-request in `resolveModelUri` so a missing folderId only fails
    // when a short-form model name is actually used.
  }

  estimateTokens(text: string): number {
    // Rough heuristic: ~3.5 chars / token for mixed RU/EN text.
    return Math.ceil(text.length / 3.5);
  }

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const modelUri = this.resolveModelUri(req.model);

    const body = {
      modelUri,
      completionOptions: {
        stream: false,
        temperature: req.temperature ?? 0.3,
        maxTokens: String(req.maxTokens ?? 2000),
      },
      messages: [
        { role: 'system', text: req.systemPrompt },
        { role: 'user', text: req.userPrompt },
      ],
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.cfg.defaultHeaders ?? {}),
    };
    if (this.cfg.iamToken) {
      headers.Authorization = `Bearer ${this.cfg.iamToken}`;
    } else {
      headers.Authorization = `Api-Key ${this.cfg.apiKey}`;
    }
    if (this.cfg.folderId) {
      headers['x-folder-id'] = this.cfg.folderId;
    }

    const url = `${this.cfg.baseUrl || DEFAULT_BASE_URL}${COMPLETION_PATH}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: req.abortSignal,
      });
    } catch (e) {
      throw Errors.upstream('yandex: network error', {
        message: (e as Error).message,
      });
    }

    if (!res.ok) {
      const errText = await safeReadText(res);
      throw Errors.upstream(`yandex: HTTP ${res.status}`, {
        status: res.status,
        body: errText.slice(0, 500),
      });
    }

    let json: YandexResponse;
    try {
      json = (await res.json()) as YandexResponse;
    } catch (e) {
      throw Errors.upstream('yandex: invalid JSON response', {
        message: (e as Error).message,
      });
    }

    const alt = json.result?.alternatives?.[0];
    const text = alt?.message?.text;
    if (typeof text !== 'string') {
      throw Errors.upstream('yandex: missing alternatives[0].message.text', {
        modelVersion: json.result?.modelVersion,
      });
    }

    const usage = json.result?.usage ?? {};
    const tokensIn = toNumber(usage.inputTextTokens);
    const tokensOut = toNumber(usage.completionTokens);
    const costUsd = computeCost(req.model, tokensIn, tokensOut);

    return {
      text,
      tokensIn,
      tokensOut,
      costUsd,
      model: json.result?.modelVersion ?? req.model,
      raw: json,
    };
  }

  async completeJson<T>(
    req: CompletionRequest,
    parser: (raw: string) => T,
  ): Promise<{ value: T; meta: CompletionResponse }> {
    // Yandex does not support OpenAI-style structured output, so we instruct
    // via the system prompt. The parser is responsible for extracting JSON
    // from the raw response (use parseJsonStrict / extractJson helpers).
    const sys = appendJsonInstruction(req.systemPrompt);
    const meta = await this.complete({ ...req, systemPrompt: sys });
    const value = parser(meta.text);
    return { value, meta };
  }

  private resolveModelUri(model: string): string {
    if (model.startsWith('gpt://')) return model;
    const folder = this.cfg.folderId;
    if (!folder) {
      throw Errors.badRequest(
        'yandex: folderId required when model is not a full gpt:// uri',
      );
    }
    // Allow `yandexgpt`, `yandexgpt-lite`, `yandexgpt/rc`, `yandexgpt-lite/latest`, etc.
    const hasVersion = model.includes('/');
    return hasVersion
      ? `gpt://${folder}/${model}`
      : `gpt://${folder}/${model}/latest`;
  }

  /**
   * Try the OpenAI-compatible models endpoint Yandex AI Studio exposes
   * (https://aistudio.yandex.ru/docs/ru/ai-studio/concepts/api.html); fall
   * back to a hand-curated list of legacy gpt:// URIs when the catalogue
   * call is unavailable for the configured baseUrl.
   */
  async listModels(): Promise<ModelInfo[]> {
    try {
      const url = `${this.cfg.baseUrl || DEFAULT_BASE_URL}/v1/models`;
      const headers: Record<string, string> = { ...(this.cfg.defaultHeaders ?? {}) };
      if (this.cfg.iamToken) headers.Authorization = `Bearer ${this.cfg.iamToken}`;
      else if (this.cfg.apiKey) headers.Authorization = `Api-Key ${this.cfg.apiKey}`;
      if (this.cfg.folderId) headers['x-folder-id'] = this.cfg.folderId;
      const res = await fetch(url, { method: 'GET', headers });
      if (res.ok) {
        const json = (await res.json()) as { data?: Array<{ id?: string; name?: string }> };
        const items = (json.data ?? [])
          .filter((m): m is { id: string } & typeof m => typeof m.id === 'string' && m.id.length > 0)
          .map((m) => ({ id: m.id, ...(m.name ? { name: m.name } : {}) }))
          .sort((a, b) => a.id.localeCompare(b.id));
        if (items.length > 0) return items;
      }
    } catch {
      /* fall through to fallback */
    }
    const ids = [
      'yandexgpt',
      'yandexgpt/latest',
      'yandexgpt/rc',
      'yandexgpt-lite',
      'yandexgpt-lite/latest',
      'yandexgpt-lite/rc',
      'yandexgpt-32k',
      'yandexgpt-32k/latest',
      'yandexgpt-32k/rc',
      'llama',
      'llama/latest',
      'llama-lite',
      'llama-lite/latest',
    ];
    return ids.map((id) => ({ id }));
  }
}

function appendJsonInstruction(systemPrompt: string): string {
  const note =
    '\n\nReturn ONLY a single JSON document. No markdown, no commentary, no code fences.';
  return systemPrompt.includes('Return ONLY') ? systemPrompt : systemPrompt + note;
}

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function computeCost(model: string, tokensIn: number, tokensOut: number): number {
  const key = pricingKey(model);
  const price = PRICING[key] ?? DEFAULT_PRICE;
  return (tokensIn * price.in + tokensOut * price.out) / 1_000_000;
}

function pricingKey(model: string): string {
  // Strip gpt://folder/<name>/<version> down to <name>.
  const stripped = model.startsWith('gpt://') ? model.split('/')[3] ?? model : model;
  // `yandexgpt-lite/latest` -> `yandexgpt-lite`
  return stripped.split('/')[0] ?? stripped;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
