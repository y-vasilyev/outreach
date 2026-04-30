import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson, readParams } from './_runtime.js';
import { RiskScoreCoerced } from './_coerce.js';

export const safetyFilterInputSchema = z.object({
  draft: z.string(),
  channel_analysis: z.record(z.unknown()).optional(),
  contact: z.record(z.unknown()).optional(),
  campaign: z.record(z.unknown()).optional(),
  /** Optional history to detect "do not message" cases. */
  history: z
    .array(
      z.object({
        direction: z.enum(['in', 'out']),
        text: z.string(),
        intent: z.string().optional(),
      }),
    )
    .optional(),
});

export const safetyFilterOutputSchema = z.object({
  allow: z.boolean(),
  reasons: z.array(z.string()).default([]),
  rewrite_hint: z.string().optional(),
  // LLMs return scores in any of: 0..1 (correct), 0..100 (percent),
  // sometimes 0..10 ("на сколько рискованно: 7"). Coerce all of those.
  risk_score: RiskScoreCoerced,
});

export type SafetyFilterInput = z.infer<typeof safetyFilterInputSchema>;
export type SafetyFilterOutput = z.infer<typeof safetyFilterOutputSchema>;

const DEFAULT_MAX_LENGTH = 600;

const FALLBACK_SYSTEM = `Ты — последний фильтр безопасности перед отправкой CustDev-сообщения. Цель — НЕ продажа. Блокируй любые формулировки, звучащие как покупка рекламы, обещания результата, неуместные эмодзи в начале, восклицания в первой строке, ссылки без причины, нарушение «не пиши, если попросили». Возвращай JSON: { allow, reasons[], rewrite_hint?, risk_score }.`;

const FALLBACK_USER = `Черновик:
{{draft}}

Канал: {{channel_analysis}}
Контакт: {{contact}}
Кампания: {{campaign}}
История: {{history}}

Верни JSON.`;

export const safetyFilter: Agent<SafetyFilterInput, SafetyFilterOutput> = {
  name: 'safety_filter',
  description: 'Финальная проверка исходящего сообщения.',
  inputSchema: safetyFilterInputSchema,
  outputSchema: safetyFilterOutputSchema,
  variables: ['draft', 'channel_analysis', 'contact', 'campaign', 'history'],
  defaultModel: 'yandexgpt-lite',
  defaultParams: {
    temperature: 0,
    max_tokens: 250,
    max_length: DEFAULT_MAX_LENGTH,
    allow_links: false,
  },
  async run(input, ctx) {
    const params = readParams(ctx.config.params);
    const maxLength =
      typeof params.max_length === 'number' ? params.max_length : DEFAULT_MAX_LENGTH;
    const allowLinks = params.allow_links === true;

    /**
     * Hard policy guards only. Substring/phrase matching for "salesy"
     * keywords was both noisy (every "интеграция AI" got blocked) and
     * brittle (LLM-written drafts in Russian rarely hit the literal
     * phrases anyway). We trust the LLM nuance check below for tone —
     * keep the deterministic checks for things the LLM physically cannot
     * override:
     *   - over the platform char limit
     *   - naked URL in a CustDev opener (we never want a link in turn one)
     *   - the recipient already declined (must escalate, not auto-reply)
     */
    const hardReasons: string[] = [];
    const draft = input.draft ?? '';

    if (draft.length > maxLength) {
      hardReasons.push(`max_length_exceeded:${draft.length}>${maxLength}`);
    }
    if (!allowLinks && /https?:\/\/\S+/i.test(draft)) {
      hardReasons.push('link_not_allowed');
    }
    if (Array.isArray(input.history)) {
      for (const h of input.history) {
        if (h.direction === 'in' && h.intent === 'declined') {
          hardReasons.push('recipient_declined_earlier');
          break;
        }
      }
    }

    if (hardReasons.length > 0) {
      return {
        allow: false,
        reasons: hardReasons,
        risk_score: 1,
        rewrite_hint: buildRewriteHint(hardReasons),
      };
    }

    // No hard violations — let the LLM judge tone/sales-iness.
    return invokeJson({
      ctx,
      vars: {
        draft,
        channel_analysis: input.channel_analysis ?? {},
        contact: input.contact ?? {},
        campaign: input.campaign ?? {},
        history: input.history ?? [],
      },
      outputSchema: safetyFilterOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
  },
};

function buildRewriteHint(reasons: string[]): string {
  const hints: string[] = [];
  if (reasons.some((r) => r.startsWith('max_length_exceeded'))) {
    hints.push('Сократи до 2–4 предложений.');
  }
  if (reasons.includes('link_not_allowed')) {
    hints.push('Не вставляй ссылки.');
  }
  if (reasons.includes('recipient_declined_earlier')) {
    hints.push('Получатель уже отказался — нужно эскалировать оператору, а не писать заново.');
  }
  return hints.join(' ');
}
