import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson, readParams } from './_runtime.js';

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
  risk_score: z.number().min(0).max(1),
});

export type SafetyFilterInput = z.infer<typeof safetyFilterInputSchema>;
export type SafetyFilterOutput = z.infer<typeof safetyFilterOutputSchema>;

/**
 * Phrase-level filters. Substring matching on single words like "реклама"
 * or "интеграц" was way too aggressive — every normal CustDev opener
 * mentioning "у вас интересная интеграция" or just being long enough to
 * say "реклама" once got blocked. We only flag phrases that are clearly
 * "buy advertising" — anything else falls through to the LLM nuance check.
 */
const DEFAULT_FORBIDDEN_PHRASES = [
  'купить рекламу',
  'купить рекламное',
  'разместить рекламу',
  'разместить рекламное',
  'приобрести рекламу',
  'хотим разместить',
  'выгодное предложение',
  'выгодное коммерческое',
  'рекламная интеграция',
  'рекламную интеграцию',
  'наш оффер',
  'спецпредложение',
];

const DEFAULT_MAX_LENGTH = 600;

// Leading emoji check — Unicode property class.
const LEADING_EMOJI_RE = /^\p{Extended_Pictographic}/u;

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
    forbidden_topics: DEFAULT_FORBIDDEN_PHRASES,
    escalation_keywords: [],
    max_length: DEFAULT_MAX_LENGTH,
    allow_links: false,
    /** Cap below which we skip the LLM check entirely (default true). */
    skip_llm_when_clean: true,
  },
  async run(input, ctx) {
    const params = readParams(ctx.config.params);
    const forbidden = readStringArray(params.forbidden_topics, DEFAULT_FORBIDDEN_PHRASES);
    const maxLength =
      typeof params.max_length === 'number' ? params.max_length : DEFAULT_MAX_LENGTH;
    const allowLinks = params.allow_links === true;

    /**
     * Two-tier filter. **Hard** blocks fail closed (`allow: false`) — they
     * represent unfixable problems (over the platform char limit, the
     * recipient already said no, naked URLs in a CustDev opener). **Soft**
     * signals raise the `risk_score` but let the message through; the
     * operator sees the suggestion in the inbox with a yellow/red bar and
     * decides. This avoids the previous failure where every greeting like
     * "Здравствуйте, Иван!" got hard-blocked by `exclamation_in_first_line`
     * and no suggestions were ever shown.
     */
    const hardReasons: string[] = [];
    const softReasons: string[] = [];
    let risk = 0;
    const draft = input.draft ?? '';
    const draftLower = draft.toLowerCase();

    // Soft: forbidden phrases (whole-phrase, not substring of single words).
    for (const phrase of forbidden) {
      if (!phrase) continue;
      if (draftLower.includes(phrase.toLowerCase())) {
        softReasons.push(`forbidden_phrase:${phrase}`);
        risk += 0.25;
      }
    }

    // Hard: too long for one TG message.
    if (draft.length > maxLength) {
      hardReasons.push(`max_length_exceeded:${draft.length}>${maxLength}`);
    }

    // Soft: leading emoji (looks bot-y, but not a deal-breaker).
    if (LEADING_EMOJI_RE.test(draft)) {
      softReasons.push('leading_emoji');
      risk += 0.15;
    }

    // Soft: exclamation in the first line. Common in Russian greetings
    // ("Здравствуйте, Иван!") — flag only, don't block.
    const firstLine = draft.split(/\r?\n/, 1)[0] ?? '';
    if (firstLine.includes('!')) {
      softReasons.push('exclamation_in_first_line');
      risk += 0.05;
    }

    // Hard: clickable URL in CustDev opener (looks spammy, plus we don't
    // ever want a Meet/Calendly link in turn one — it's a soft research ask).
    if (!allowLinks && /https?:\/\/\S+/i.test(draft)) {
      hardReasons.push('link_not_allowed');
    }

    // Hard: recipient declined earlier — must escalate, not auto-reply.
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
        reasons: [...hardReasons, ...softReasons],
        risk_score: 1,
        rewrite_hint: buildRewriteHint([...hardReasons, ...softReasons]),
      };
    }

    // No hard violations. Optionally short-circuit when the draft is also
    // free of soft signals — saves the LLM round-trip on the happy path.
    if (params.skip_llm_when_clean !== false && softReasons.length === 0) {
      return { allow: true, reasons: [], risk_score: 0 };
    }

    // We have soft signals OR the operator wants a nuance check anyway.
    // Ask the LLM; merge its risk_score with our deterministic floor so
    // detector signals can't be silently ignored by the model.
    const llmOut = await invokeJson({
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
    return {
      allow: llmOut.allow,
      reasons: [...softReasons, ...llmOut.reasons],
      risk_score: Math.max(Math.min(1, risk), llmOut.risk_score),
      ...(llmOut.rewrite_hint ? { rewrite_hint: llmOut.rewrite_hint } : {}),
    };
  },
};

function readStringArray(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return fallback;
}

function buildRewriteHint(reasons: string[]): string {
  const hints: string[] = [];
  if (reasons.some((r) => r.startsWith('forbidden_phrase'))) {
    hints.push('Убери продажные фразы (купить/разместить рекламу, оффер, спецпредложение).');
  }
  if (reasons.some((r) => r.startsWith('max_length_exceeded'))) {
    hints.push('Сократи до 2–4 предложений.');
  }
  if (reasons.includes('leading_emoji')) {
    hints.push('Не начинай сообщение с эмодзи.');
  }
  if (reasons.includes('link_not_allowed')) {
    hints.push('Не вставляй ссылки.');
  }
  if (reasons.includes('recipient_declined_earlier')) {
    hints.push('Получатель уже отказался — нужно эскалировать оператору, а не писать заново.');
  }
  return hints.join(' ');
}
