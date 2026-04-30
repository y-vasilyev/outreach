import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson, readParams } from './_runtime.js';
import { ConfidenceCoerced } from './_coerce.js';

export const contactCandidateSchema = z.object({
  type: z.enum(['tg_username', 'tg_link', 'email', 'phone', 'website', 'other']),
  raw_value: z.string(),
  context_snippet: z.string(),
});

export const contactExtractorInputSchema = z.object({
  platform: z.string(),
  channel_title: z.string(),
  description: z.string(),
  links: z.array(z.string()).default([]),
  recent_posts_text: z.string().default(''),
  regex_candidates: z.array(contactCandidateSchema).default([]),
});

export const extractedContactSchema = z.object({
  type: z.enum([
    'tg_username',
    'tg_link',
    'email',
    'phone',
    'website',
    'web_form',
    'other',
  ]),
  value: z.string(),
  raw_value: z.string(),
  role_guess: z.enum(['owner', 'ad_manager', 'generic', 'bot', 'unknown']),
  label: z.string().optional(),
  // Coerce qualitative LLM outputs ("medium"/"high"/"низкая") → 0..1.
  confidence: ConfidenceCoerced,
  rationale: z.string(),
});

export const contactExtractorOutputSchema = z.object({
  contacts: z.array(extractedContactSchema),
  no_contacts_reason: z.string().optional(),
});

export type ContactExtractorInput = z.infer<typeof contactExtractorInputSchema>;
export type ContactExtractorOutput = z.infer<typeof contactExtractorOutputSchema>;
export type ExtractedContact = z.infer<typeof extractedContactSchema>;

const FALLBACK_SYSTEM = `Ты ищешь в описании и постах канала контакты, по которым можно написать «по рекламе» или «по сотрудничеству». Тебе уже дали список найденных кандидатов регулярками — твоя задача классифицировать каждого: это владелец канала, рекламный менеджер, бот для заявок, общий контакт или нерелевантно. Если в тексте есть контакты, которые регулярки пропустили (например, упомянуты словами) — добавь их. Не выдумывай контактов, которых нет в тексте. Возвращай JSON по схеме.

Типы ролей:
- owner — личный аккаунт автора канала
- ad_manager — отдельный аккаунт «по рекламе», менеджер
- bot — бот для заявок (@xxxbot, ссылка на форму)
- generic — контакт без явной роли
- unknown — не удалось определить`;

const FALLBACK_USER = `Платформа: {{platform}}
Канал: {{channel_title}}
Описание: {{description}}
Ссылки: {{links}}
Последние посты: {{recent_posts_text}}

Кандидаты от регулярок:
{{regex_candidates}}

Верни JSON: { contacts: [...], no_contacts_reason?: string }.`;

export const contactExtractor: Agent<ContactExtractorInput, ContactExtractorOutput> = {
  name: 'contact_extractor',
  description: 'Извлекает и классифицирует контакты «для рекламы» из канала.',
  inputSchema: contactExtractorInputSchema,
  outputSchema: contactExtractorOutputSchema,
  variables: [
    'platform',
    'channel_title',
    'description',
    'links',
    'recent_posts_text',
    'regex_candidates',
  ],
  defaultModel: 'yandexgpt',
  defaultParams: {
    temperature: 0.1,
    max_tokens: 1200,
    min_confidence: 0.4,
    prefer_ad_manager_for_outreach: true,
  },
  async run(input, ctx) {
    const llmOut = await invokeJson({
      ctx,
      vars: {
        ...input,
        links: input.links.join(', '),
        regex_candidates: input.regex_candidates
          .map(
            (c, i) =>
              `${i + 1}. [${c.type}] ${c.raw_value} — context: "${c.context_snippet}"`,
          )
          .join('\n'),
      },
      outputSchema: contactExtractorOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });

    // Deterministic post-process: normalise + dedup + threshold.
    const params = readParams(ctx.config.params);
    const minConfidence =
      typeof params.min_confidence === 'number' ? params.min_confidence : 0.4;

    const seen = new Map<string, ExtractedContact>();
    for (const raw of llmOut.contacts) {
      const value = normalizeValue(raw.type, raw.value);
      if (!value) continue;
      if (raw.confidence < minConfidence) continue;
      const key = `${raw.type}::${value}`;
      const existing = seen.get(key);
      if (!existing || existing.confidence < raw.confidence) {
        seen.set(key, { ...raw, value });
      }
    }

    const contacts = Array.from(seen.values());
    return {
      contacts,
      ...(llmOut.no_contacts_reason !== undefined && contacts.length === 0
        ? { no_contacts_reason: llmOut.no_contacts_reason }
        : {}),
    };
  },
};

/** Normalise a contact value depending on its type. Empty string → drop. */
export function normalizeValue(type: ExtractedContact['type'], value: string): string {
  if (!value) return '';
  let v = value.trim();
  switch (type) {
    case 'tg_username':
      // Strip leading @ and any t.me/ prefix that snuck in.
      v = v.replace(/^https?:\/\/t\.me\//i, '');
      v = v.replace(/^@/, '');
      return v;
    case 'tg_link':
      v = v.replace(/^https?:\/\//i, '');
      v = v.replace(/^t\.me\//i, '');
      return v;
    case 'email':
      return v.toLowerCase();
    case 'website':
    case 'web_form':
      return v.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    case 'phone':
      return v.replace(/[\s().-]/g, '');
    default:
      return v;
  }
}
