import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';
import { LengthCoerced, RiskScoreCoerced } from './_coerce.js';

/**
 * AgencyOpeningComposer — `agency_opening_composer`
 *
 * The agency-sourcing inverse of OpeningComposer. Presents the sender as a
 * media-buying agency and opens off a CONCRETE sponsored integration the
 * blogger already ran, framed as "we have a client who wants a similar
 * placement". Commercial framing is on-goal here (D7) — but the message must
 * never invent a past ad, guarantee results, or push for money/links before
 * an operator confirms terms (those are blocked by the agency safety profile
 * + forced handoff intents downstream).
 *
 * No-fabrication guard (spec "Opening does not invent placements"):
 *   - `observed_integrations` carries the sponsored posts we actually
 *     detected. When non-empty, a variant cites one and sets
 *     `cited_integration` to the source it used.
 *   - When empty, the composer MUST fall back to a generic topic hook OR
 *     emit no auto-send-eligible variant, and MUST NOT name a specific past
 *     ad. Each variant declares `auto_send_eligible` so the worker can drop
 *     fabricated-but-confident drafts; we also enforce it deterministically.
 */

export const observedIntegrationSchema = z.object({
  /** Brand / advertiser named in the post, if identifiable. */
  brand: z.string().optional(),
  /** Verbatim (trimmed) snippet that evidences the integration. */
  snippet: z.string().default(''),
  /** Post date if known. */
  date: z.string().optional(),
});

export const agencyOpeningComposerInputSchema = z.object({
  channel_analysis: z.record(z.unknown()),
  contact: z.record(z.unknown()),
  campaign: z.object({
    /** What the agency is sourcing (e.g. "интеграции для клиента из финтеха"). */
    goal_text: z.string().default(''),
    /** Optional client brief context the operator authored. */
    client_brief: z.string().default(''),
  }),
  /**
   * Sponsored integrations actually observed in the channel's recent posts.
   * Detected upstream (extractor / heuristic) — NOT something this agent may
   * invent. Empty ⇒ generic-hook-or-nothing path.
   */
  observed_integrations: z.array(observedIntegrationSchema).default([]),
  examples: z.array(z.string()).optional(),
});

export const agencyOpeningComposerOutputSchema = z.object({
  variants: z
    .array(
      z.object({
        text: z.string().max(800, 'agency opening text must be ≤800 chars'),
        rationale: z.string(),
        length: LengthCoerced,
        risk_score: RiskScoreCoerced,
        /**
         * Which observed integration this variant cited, if any. MUST be one
         * of the supplied snippets/brands — never invented. Absent ⇒ generic
         * topic hook.
         */
        cited_integration: z.string().optional(),
        /**
         * Whether the variant is eligible for auto-send. A variant that
         * neither cites a real observed integration NOR is an honest generic
         * hook is NOT eligible. Enforced deterministically below.
         */
        auto_send_eligible: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(5),
});

export type AgencyOpeningComposerInput = z.infer<
  typeof agencyOpeningComposerInputSchema
>;
export type AgencyOpeningComposerOutput = z.infer<
  typeof agencyOpeningComposerOutputSchema
>;

const FALLBACK_SYSTEM = `Ты пишешь первое сообщение блогеру/автору канала от лица агентства по размещению рекламы. Цель — открыть КОММЕРЧЕСКИЙ разговор: узнать прайс, форматы, сроки, охваты под запрос клиента. Здесь коммерческая лексика уместна (это не CustDev).

ГЛАВНОЕ ПРАВИЛО — НЕ ВЫДУМЫВАТЬ:
- Можно ссылаться ТОЛЬКО на интеграции из списка observed_integrations (реальные рекламные посты, которые мы у автора нашли).
- Если список observed_integrations ПУСТ — НЕЛЬЗЯ упоминать «видел вашу рекламу/интеграцию с брендом X». Никаких конкретных прошлых размещений. В этом случае: либо общий заход по тематике канала (channel_analysis.topic), либо вариант с auto_send_eligible=false.
- Никогда не придумывай название бренда, цифры охватов, прошлые кейсы.

ЧТО МОЖНО (on-goal для агентства):
- Представиться агентством, у которого есть клиент с похожим запросом.
- Сослаться на конкретную интеграцию автора как на причину обращения.
- Спросить про формат размещения, прайс, сроки, охваты.

ЧТО НЕЛЬЗЯ (повышай risk_score, не делай этого):
- Гарантии результата: «гарантируем продажи», «точно окупится», «100% охват».
- Выдуманные детали клиента: конкретные суммы бюджета, имена брендов, обещания контракта — если их нет в client_brief.
- Перевод денег / платёжные ссылки / реквизиты ДО подтверждения оператором.
- Давление: «только сегодня», «срочно», «последнее место», ультиматумы.

КАК ПИСАТЬ:
1. Если есть observed_integration — назови её как зацепку: «видел вашу интеграцию с {brand}» / процитируй узнаваемую деталь из snippet. Заполни cited_integration этой зацепкой.
2. Представься агентством с клиентом, которому нужно похожее размещение (без выдуманных деталей клиента).
3. Спроси про формат/прайс/сроки — открыто, без обязательств по цене.
4. Тон деловой, живой, без канцелярита и эмодзи в начале. 2–5 предложений, ≤ 800 символов.

auto_send_eligible:
- true — вариант либо цитирует реальную observed_integration, либо это честный общий заход по тематике (без выдуманных конкретики), и в нём нет гарантий/давления/денег.
- false — если пришлось бы выдумать конкретику, либо данных мало и лучше показать оператору.

ВАРИАНТЫ:
Сгенерируй 2–3 варианта. В rationale укажи, какую observed_integration ты процитировал, или явно «нет наблюдаемых интеграций — общий заход по тематике».

Возвращай JSON: { variants: [{ text, rationale, length, risk_score, cited_integration?, auto_send_eligible }] }.`;

const FALLBACK_USER = `Канал (анализ): {{channel_analysis}}
Контакт: {{contact}}
Что ищем для клиента (goal_text): {{goal_text}}
Бриф клиента (если есть): {{client_brief}}

Наблюдаемые интеграции автора (ТОЛЬКО на них можно ссылаться; если пусто — общий заход):
{{observed_integrations_for_hook}}

Верни JSON. 2–3 варианта.`;

export const agencyOpeningComposer: Agent<
  AgencyOpeningComposerInput,
  AgencyOpeningComposerOutput
> = {
  name: 'agency_opening_composer',
  description:
    'Пишет первое сообщение от лица агентства, цитируя реальную интеграцию автора; не выдумывает прошлых размещений.',
  inputSchema: agencyOpeningComposerInputSchema,
  outputSchema: agencyOpeningComposerOutputSchema,
  variables: [
    'channel_analysis',
    'contact',
    'campaign',
    'goal_text',
    'client_brief',
    'observed_integrations_for_hook',
    'examples',
  ],
  defaultModel: 'anthropic/claude-sonnet-4.6',
  defaultParams: { temperature: 0.7, max_tokens: 1200 },
  async run(input, ctx) {
    const hasObserved = input.observed_integrations.some(
      (i) => (i.snippet && i.snippet.trim().length > 0) || (i.brand && i.brand.trim().length > 0),
    );

    const observedForHook = hasObserved
      ? input.observed_integrations
          .filter((i) => (i.snippet && i.snippet.trim().length > 0) || i.brand)
          .slice(0, 5)
          .map((i, idx) => {
            const brand = i.brand ? `бренд: ${i.brand}; ` : '';
            const snippet = (i.snippet ?? '').replace(/\s+/g, ' ').trim();
            const trimmed = snippet.length > 220 ? `${snippet.slice(0, 220)}…` : snippet;
            return `${idx + 1}. ${i.date ? `[${i.date}] ` : ''}${brand}${trimmed}`;
          })
          .join('\n')
      : '(наблюдаемых интеграций нет — НЕ выдумывай прошлых размещений; используй общий заход по тематике или auto_send_eligible=false)';

    const out = await invokeJson({
      ctx,
      vars: {
        channel_analysis: input.channel_analysis,
        contact: input.contact,
        campaign: input.campaign,
        goal_text: input.campaign.goal_text,
        client_brief: input.campaign.client_brief,
        observed_integrations_for_hook: observedForHook,
        examples: input.examples ?? [],
      },
      outputSchema: agencyOpeningComposerOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });

    // Deterministic no-fabrication guard. The LLM can hallucinate a brand
    // even when `observed_integrations` is empty; we don't trust its
    // self-reported `cited_integration` either. When there are no observed
    // integrations, force every variant to be auto-send-INeligible so a
    // human reviews whatever generic/invented hook the model produced. When
    // there ARE observed integrations, a variant only stays auto-send-
    // eligible if it actually references one of the supplied snippets/brands.
    const knownHooks = input.observed_integrations
      .flatMap((i) => [i.brand, i.snippet])
      .filter((s): s is string => Boolean(s && s.trim().length > 0))
      .map((s) => s.toLowerCase());

    const variants = out.variants.map((v) => {
      if (!hasObserved) {
        return { ...v, cited_integration: undefined, auto_send_eligible: false };
      }
      const citesReal =
        typeof v.cited_integration === 'string' &&
        knownHooks.some((h) => v.cited_integration!.toLowerCase().includes(h) || h.includes(v.cited_integration!.toLowerCase()));
      return { ...v, auto_send_eligible: v.auto_send_eligible && citesReal };
    });

    return { variants };
  },
};
