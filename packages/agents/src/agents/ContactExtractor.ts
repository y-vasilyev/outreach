import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson, readParams } from './_runtime.js';
import { ConfidenceCoerced } from './_coerce.js';

export const contactCandidateSchema = z.object({
  type: z.enum(['tg_username', 'tg_link', 'email', 'phone', 'website', 'other']),
  raw_value: z.string(),
  context_snippet: z.string(),
  /** Deterministic role hint from regex.ts. LLM may override but should explain why. */
  role_hint: z
    .enum(['owner', 'ad_manager', 'bot', 'generic', 'unknown'])
    .default('unknown'),
});

export const contactExtractorInputSchema = z.object({
  platform: z.string(),
  channel_title: z.string(),
  /**
   * Channel's own handle (no `@`, lowercased). Required so the agent can
   * reject self-references — without it the LLM happily lists the channel
   * itself as a contact.
   */
  channel_handle: z.string().optional(),
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

const FALLBACK_SYSTEM = `Ты ищешь в описании и постах канала контакты, по которым можно написать «по рекламе» или «по сотрудничеству». Тебе уже дали список кандидатов регулярками вместе с предварительной ролью (role_hint) — она вычислена по словам рядом с контактом. Твоя задача:
1. Подтвердить или скорректировать роль каждого кандидата.
2. ОТФИЛЬТРОВАТЬ нерелевантные.
3. Добавить только те контакты, которые регулярки пропустили (упомянуты словами), но которые точно есть в тексте.

НИКОГДА НЕ ИЗВЛЕКАЙ:
- Свой канал ({{channel_handle}}) — это не контакт для аутрича.
- Сайты/handle регуляторов: rkn.gov.ru, gosuslugi.ru, knd.gov.ru, *.gov.* и подобные «реестр», «регистрация в РКН» — это не контакт.
- Платёжные/донат-ссылки (qiwi, yoomoney, donationalerts, boosty, patreon, paypal) — это не контакт.
- Чужие каналы для кросс-промо («наш второй канал», «подпишитесь на», «читайте также») — это не контакт.
- Курсы, тренинги, лендинги продуктов — даже если рядом есть @handle, это не outreach-контакт.
- Дисклеймеры «не размещаю рекламу», «без рекламы» — handle рядом с такой фразой → не контакт.
- @username из чужих email-адресов (foo@example.com — это email, а не tg).

Как определять роль:
- ad_manager — рядом слова: реклама, коллаб, сотрудничество, интеграция, размещение, partnership, ads, promo, business. ПРИОРИТЕТ для аутрича.
- owner — рядом слова: автор, основатель, создатель, founder, owner, «пишу я», «веду канал».
- bot — handle оканчивается на _bot/bot и контекст НЕ говорит о приёме рекламы.
- generic — общий контакт (поддержка, связь по любым вопросам).
- unknown — нет сигнала; ставь confidence ≤ 0.4.

Confidence calibration:
- 0.9+ — явная фраза «по рекламе пишите @x» / «автор @y».
- 0.6–0.8 — есть тематический сигнал, но не однозначный.
- 0.3–0.5 — handle есть, контекст невнятный.
- < 0.3 — почти угадывание, лучше дропнуть.

В rationale ОБЯЗАТЕЛЬНО процитируй фрагмент текста (5–10 слов), на котором ты основывал решение по роли. Это нужно для верификации. Если процитировать нечего — ставь role=unknown и confidence ≤ 0.3.

Поле label — это НЕ просто слово «реклама». Сохраняй туда короткий полезный фрагмент рядом с контактом целиком: кто на связи, роль, условия и часы. Пример: «На связи Кристина, автор @writeforfriends. Связь в будни 10-19:00. Без ссылок не отвечаю». Этот label потом пойдёт в первое сообщение.

Возвращай только JSON по схеме.`;

const FALLBACK_USER = `Платформа: {{platform}}
Канал: {{channel_title}} (свой handle: @{{channel_handle}})
Описание:
{{description}}

Ссылки: {{links}}

Последние посты:
{{recent_posts_text}}

Кандидаты от регулярок (role_hint — предварительная роль по контексту):
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
    'channel_handle',
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
        channel_handle: input.channel_handle ?? '',
        links: input.links.join(', '),
        regex_candidates: input.regex_candidates
          .map(
            (c, i) =>
              `${i + 1}. [${c.type}] ${c.raw_value} (role_hint=${c.role_hint}) — context: "${c.context_snippet}"`,
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
