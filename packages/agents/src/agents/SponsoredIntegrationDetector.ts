import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';

/**
 * SponsoredIntegrationDetector — `sponsored_integration_detector`
 *
 * Reads a channel's recent posts and returns the subset classified as
 * sponsored integrations (paid ads, brand partnerships, sponsored placements).
 * Sole valid source for the `observed_integrations` input of
 * `agency_opening_composer` — see `sponsored-integration-detection` capability.
 *
 * Detection is LLM-driven. Heuristic/regex/marker-based approaches
 * (`#реклама`, `erid=`, etc.) are intentionally NOT used: that signal is
 * noisy, regional, and easily bypassed; an opener that cites a non-sponsored
 * post as "вашу интеграцию с …" is a worse failure mode than a missed
 * sponsored post (the no-fabrication guard in the composer then falls back
 * to a generic hook).
 *
 * MUST (spec):
 *   - preserve the verbatim post snippet on each detected integration;
 *   - only emit posts the LLM truly classifies as sponsored — never
 *     downgrade a non-sponsored post to a low-confidence "maybe" entry to
 *     pad the list. An empty result is the correct answer when nothing is
 *     sponsored;
 *   - populate `brand` only when the post explicitly names one.
 *
 * Runs via AgentRunner (writes `agent_run`). Configured/seeded in
 * `packages/db/prisma/agents.seed.ts`; the fallback prompts here are the
 * source of truth for the agent's behaviour when no DB config exists.
 */

export const sponsoredPostSchema = z.object({
  /** Post date if known. */
  date: z.string().optional(),
  /** Post text. */
  text: z.string(),
});

export const sponsoredIntegrationDetectorInputSchema = z.object({
  posts: z.array(sponsoredPostSchema).default([]),
  channel_title: z.string().default(''),
  language: z.string().default('ru'),
});

export const sponsoredIntegrationSchema = z.object({
  /** Verbatim snippet from the source post that evidences the integration. */
  snippet: z.string().min(1, 'sponsored integration snippet must be non-empty'),
  /** Brand / advertiser named in the post, if identifiable. */
  brand: z.string().optional(),
  /** Post date if known. */
  date: z.string().optional(),
  /** LLM confidence in [0,1]. */
  confidence: z.number().min(0).max(1),
  /** Short rationale (one line) explaining why the post reads as sponsored. */
  rationale: z.string().default(''),
});

export const sponsoredIntegrationDetectorOutputSchema = z.object({
  integrations: z.array(sponsoredIntegrationSchema).default([]),
});

export type SponsoredIntegrationDetectorInput = z.infer<
  typeof sponsoredIntegrationDetectorInputSchema
>;
export type SponsoredIntegrationDetectorOutput = z.infer<
  typeof sponsoredIntegrationDetectorOutputSchema
>;

const FALLBACK_SYSTEM = `Ты классифицируешь посты Telegram-канала: какие из них являются РЕКЛАМНЫМИ ИНТЕГРАЦИЯМИ (платная реклама, бренд-партнёрство, спонсорский пост), а какие — обычным контентом автора.

Тебе дают список последних постов канала. Верни ТОЛЬКО те, которые ты уверенно классифицировал как рекламную интеграцию.

ПРИЗНАКИ РЕКЛАМЫ:
- Явное указание бренда/продукта/услуги с призывом перейти/купить/попробовать.
- Промокоды, специальные ссылки, упоминание «партнёр», «спонсор», «реклама», «при поддержке».
- Структура «обычный заход → продукт бренда → ссылка/CTA».
- Дисклеймеры «реклама», «#реклама», erid, ИП/самозанятый/ОГРН в подписи (не используй как единственный сигнал — это просто маркер; нужна и СУТЬ).
- Описание партнёрского сервиса/курса/приложения с подачей «нам понравилось» / «рекомендую».

НЕ ЯВЛЯЕТСЯ РЕКЛАМОЙ:
- Личный пост автора, мнение, рассказ из жизни.
- Пересказ новостей без CTA.
- Бесплатная отсылка к чужому каналу/материалу без видимой коммерческой выгоды.
- Анонс СОБСТВЕННОГО продукта/курса/мероприятия канала — это самореклама, не интеграция со сторонним брендом.

ФОРМАТ ВЫВОДА:
{
  integrations: [
    {
      snippet: <ДОСЛОВНЫЙ фрагмент исходного поста, ~5–20 слов, чтобы было понятно, что это за интеграция>,
      brand?: <название бренда, если явно есть в посте; иначе опусти>,
      date?: <дата поста, если была дана>,
      confidence: <0..1>,
      rationale: <одна короткая фраза, почему этот пост рекламный>
    }
  ]
}

ПРАВИЛА:
- confidence 0.8+ — явная реклама бренда с CTA/промокодом.
- confidence 0.6–0.8 — вероятная интеграция, но без всех маркеров (например, нет промокода, но есть продуктовая подача).
- НЕ возвращай посты с confidence < 0.6.
- snippet — обязательно VERBATIM. Не перефразируй.
- НЕ выдумывай рекламные интеграции там, где их нет. Если ни один пост не похож на рекламу — верни пустой массив.
- brand — только если он прямо упомянут в snippet. Иначе опусти.

Возвращай ТОЛЬКО JSON.`;

const FALLBACK_USER = `Канал: {{channel_title}} (язык: {{language}})

Последние посты (самый свежий — последний):
{{posts_text}}

Верни JSON с integrations[] — только подтверждённые рекламные интеграции.`;

export const sponsoredIntegrationDetector: Agent<
  SponsoredIntegrationDetectorInput,
  SponsoredIntegrationDetectorOutput
> = {
  name: 'sponsored_integration_detector',
  description:
    'LLM-классификатор: какие из последних постов канала являются рекламными интеграциями. Источник истины для observed_integrations агентского opener.',
  inputSchema: sponsoredIntegrationDetectorInputSchema,
  outputSchema: sponsoredIntegrationDetectorOutputSchema,
  variables: ['channel_title', 'language', 'posts_text'],
  defaultModel: 'anthropic/claude-haiku-4.5',
  defaultParams: { temperature: 0.1, max_tokens: 900 },
  async run(input, ctx) {
    if (input.posts.length === 0) {
      return { integrations: [] };
    }
    const postsText = input.posts
      .map((p, i) => {
        const date = p.date ? `[${p.date}] ` : '';
        const text = (p.text ?? '').replace(/\s+/g, ' ').trim();
        return `${i + 1}. ${date}${text}`;
      })
      .join('\n');

    const out = await invokeJson({
      ctx,
      vars: {
        channel_title: input.channel_title,
        language: input.language,
        posts_text: postsText,
      },
      outputSchema: sponsoredIntegrationDetectorOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });

    // Deterministic guard: drop entries whose snippet doesn't actually appear
    // in any supplied post. The LLM occasionally paraphrases; an opener that
    // later "cites" a paraphrased snippet would still pass the composer's
    // no-fabrication guard (which only checks token overlap), so we filter
    // here at the source.
    const haystacks = input.posts.map((p) => (p.text ?? '').toLowerCase());
    const integrations = out.integrations.filter((i) => {
      const needle = i.snippet.trim().toLowerCase();
      if (needle.length === 0) return false;
      return haystacks.some((h) => h.includes(needle));
    });

    return { integrations };
  },
};
