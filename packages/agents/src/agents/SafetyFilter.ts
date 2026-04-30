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

const DEFAULT_FORBIDDEN = [
  'реклама',
  'рекламная',
  'интеграц',
  'купить рекламу',
  'разместить',
  'промо',
  'приобрести',
  'оффер',
  'выгодное предложение',
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
    forbidden_topics: DEFAULT_FORBIDDEN,
    escalation_keywords: [],
    max_length: DEFAULT_MAX_LENGTH,
    allow_links: false,
  },
  async run(input, ctx) {
    const params = readParams(ctx.config.params);
    const forbidden = readStringArray(params.forbidden_topics, DEFAULT_FORBIDDEN);
    const maxLength =
      typeof params.max_length === 'number' ? params.max_length : DEFAULT_MAX_LENGTH;
    const allowLinks = params.allow_links === true;

    const reasons: string[] = [];
    const draft = input.draft ?? '';
    const draftLower = draft.toLowerCase();

    // 1. forbidden_topics — substring (case-insensitive).
    for (const word of forbidden) {
      if (!word) continue;
      if (draftLower.includes(word.toLowerCase())) {
        reasons.push(`forbidden_topic:${word}`);
      }
    }

    // 2. max_length.
    if (draft.length > maxLength) {
      reasons.push(`max_length_exceeded:${draft.length}>${maxLength}`);
    }

    // 3. leading emoji.
    if (LEADING_EMOJI_RE.test(draft)) {
      reasons.push('leading_emoji');
    }

    // 4. exclamation in first line.
    const firstLine = draft.split(/\r?\n/, 1)[0] ?? '';
    if (firstLine.includes('!')) {
      reasons.push('exclamation_in_first_line');
    }

    // 5. links not allowed.
    if (!allowLinks && /https?:\/\/\S+/i.test(draft)) {
      reasons.push('link_not_allowed');
    }

    // 6. recipient declined earlier — don't message without operator.
    if (Array.isArray(input.history)) {
      for (const h of input.history) {
        if (h.direction === 'in' && h.intent === 'declined') {
          reasons.push('recipient_declined_earlier');
          break;
        }
      }
    }

    if (reasons.length > 0) {
      return {
        allow: false,
        reasons,
        risk_score: 1,
        rewrite_hint: buildRewriteHint(reasons),
      };
    }

    // No deterministic violations — ask the LLM for nuanced check.
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

function readStringArray(v: unknown, fallback: string[]): string[] {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return fallback;
}

function buildRewriteHint(reasons: string[]): string {
  const hints: string[] = [];
  if (reasons.some((r) => r.startsWith('forbidden_topic'))) {
    hints.push('Убери слова, звучащие как продажа рекламы.');
  }
  if (reasons.some((r) => r.startsWith('max_length_exceeded'))) {
    hints.push('Сократи до 2–4 предложений.');
  }
  if (reasons.includes('leading_emoji')) {
    hints.push('Не начинай сообщение с эмодзи.');
  }
  if (reasons.includes('exclamation_in_first_line')) {
    hints.push('Убери восклицательный знак из первой строки.');
  }
  if (reasons.includes('link_not_allowed')) {
    hints.push('Не вставляй ссылки.');
  }
  if (reasons.includes('recipient_declined_earlier')) {
    hints.push('Получатель уже отказался — нужно эскалировать оператору, а не писать заново.');
  }
  return hints.join(' ');
}
