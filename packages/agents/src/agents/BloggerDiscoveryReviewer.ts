import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';

/**
 * BloggerDiscoveryReviewer — `blogger_discovery_reviewer`
 * (ajtbd-guided-blogger-discovery, task 2.2).
 *
 * Evaluates ONE enriched discovery candidate against the run's AJTBD/brief and
 * returns a fit score, a typed recommendation, rationale, risk notes, and
 * evidence posts. Each evidence item must point at a SUPPLIED public post and
 * explain why it matches the brief.
 *
 * Anti-fabrication is enforced deterministically, not by trusting the prompt:
 *   - evidence is grounded against supplied posts (post id match OR verbatim
 *     snippet substring); ungrounded items are dropped;
 *   - if no posts were supplied at all, evidence is forced empty and an
 *     `insufficient_evidence_reason` is required (defaulted if missing);
 *   - the agent never receives reach/price/contact fields it could echo as
 *     "facts": the worker passes only public channel/profile data, and the
 *     reviewer is told to leave unknowns unknown.
 *
 * Runs via AgentRunner (writes `agent_run`). Seeded in
 * `packages/db/prisma/agents.seed.ts`; the fallback prompts here are the
 * behaviour source of truth when no DB config exists.
 */

const evidenceInPostZ = z.object({
  id: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
  text: z.string().default(''),
  urls: z.array(z.string()).default([]),
});

export const bloggerDiscoveryReviewerInputSchema = z.object({
  brief: z.string().default(''),
  ajtbd: z
    .object({
      job: z.string().default(''),
      desired_outcome: z.string().default(''),
      non_goals: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),
  candidate: z.object({
    platform: z.string().default(''),
    handle: z.string().default(''),
    title: z.string().default(''),
    description: z.string().default(''),
    followers: z.number().nullable().default(null),
    language: z.string().nullable().default(null),
    /** Existing rolled-up BloggerProfile facts, if any (public-derived). */
    profile: z
      .object({
        topics: z.array(z.string()).default([]),
        languages: z.array(z.string()).default([]),
        formats: z.array(z.string()).default([]),
      })
      .nullable()
      .default(null),
    recent_posts: z.array(evidenceInPostZ).default([]),
  }),
});

export const reviewerEvidenceZ = z.object({
  post_id: z.string().nullable().default(null),
  date: z.string().nullable().default(null),
  snippet: z.string().default(''),
  urls: z.array(z.string()).default([]),
  why: z.string().default(''),
});

export const bloggerDiscoveryReviewerOutputSchema = z.object({
  score: z.number().min(0).max(1).default(0),
  recommendation: z.enum(['strong_fit', 'possible_fit', 'weak_fit', 'reject']).default('reject'),
  rationale: z.string().default(''),
  risk_notes: z.array(z.string()).default([]),
  evidence: z.array(reviewerEvidenceZ).default([]),
  insufficient_evidence_reason: z.string().nullable().default(null),
});

export type BloggerDiscoveryReviewerInput = z.infer<typeof bloggerDiscoveryReviewerInputSchema>;
export type BloggerDiscoveryReviewerOutput = z.infer<typeof bloggerDiscoveryReviewerOutputSchema>;

const FALLBACK_SYSTEM = `Ты — медиабайер агентства. Тебе дают бриф/AJTBD кампании и ОДНОГО кандидата-блогера: публичные данные канала (название, описание, подписчики, язык), уже известный профиль (темы/языки/форматы, если есть) и последние ПУБЛИЧНЫЕ посты. Оцени, насколько кандидат подходит под бриф.

Возвращай JSON:
{ score, recommendation, rationale, risk_notes[], evidence[], insufficient_evidence_reason }

ПРАВИЛА:
- recommendation: strong_fit | possible_fit | weak_fit | reject.
- score 0..1 согласуй с recommendation (strong ≥0.75; possible 0.5–0.75; weak 0.25–0.5; reject <0.25).
- evidence — ТОЛЬКО из переданных recent_posts. Каждый пункт: post_id (ровно тот id, что дан, или null), date, snippet (ДОСЛОВНЫЙ фрагмент поста), urls, why (почему этот пост подтверждает соответствие брифу).
- НИКОГДА не выдумывай посты, охваты, цены, контакты, прошлые интеграции. Если данных по охватам/прайсу/контактам нет — не пиши их. Можешь порекомендовать в risk_notes сделать scrape/контакт-экстракт.
- Если постов не дали или их недостаточно для оценки — поставь evidence: [], заполни insufficient_evidence_reason (что именно мешает оценить) и recommendation по доступным метаданным (обычно weak_fit/possible_fit максимум), без выдуманных доказательств.
- rationale — короткое объяснение решения со ссылкой на тему/аудиторию/формат.
- risk_notes — конкретные риски (мало данных, не та аудитория, язык не совпадает, возможна накрутка и т.п.).

Возвращай ТОЛЬКО JSON.`;

const FALLBACK_USER = `Бриф/ниша: {{brief}}
AJTBD (если есть): {{ajtbd}}

Кандидат:
{{candidate}}

Последние публичные посты (id | дата | текст):
{{posts_text}}

Оцени кандидата. Верни JSON. evidence — только из переданных постов, snippet — verbatim.`;

export const bloggerDiscoveryReviewer: Agent<
  BloggerDiscoveryReviewerInput,
  BloggerDiscoveryReviewerOutput
> = {
  name: 'blogger_discovery_reviewer',
  description:
    'Оценивает кандидата-блогера под AJTBD/бриф: score, рекомендация, обоснование, риски и доказательные посты (только из публичных данных, без выдумок).',
  inputSchema: bloggerDiscoveryReviewerInputSchema,
  outputSchema: bloggerDiscoveryReviewerOutputSchema,
  variables: ['brief', 'ajtbd', 'candidate', 'posts_text'],
  defaultModel: 'anthropic/claude-haiku-4.5',
  defaultParams: { temperature: 0.2, max_tokens: 900 },
  async run(input, ctx) {
    const posts = input.candidate.recent_posts;
    const postsText = posts.length
      ? posts
          .map((p, i) => {
            const id = p.id ?? String(i + 1);
            const date = p.date ? `[${p.date}] ` : '';
            const text = (p.text ?? '').replace(/\s+/g, ' ').trim();
            return `#${id} ${date}${text}`;
          })
          .join('\n')
      : '(постов нет)';

    const candidateSummary = {
      platform: input.candidate.platform,
      handle: input.candidate.handle,
      title: input.candidate.title,
      description: input.candidate.description,
      followers: input.candidate.followers,
      language: input.candidate.language,
      profile: input.candidate.profile,
    };

    const out = await invokeJson({
      ctx,
      vars: {
        brief: input.brief,
        ajtbd: input.ajtbd,
        candidate: candidateSummary,
        posts_text: postsText,
      },
      outputSchema: bloggerDiscoveryReviewerOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });

    return groundEvidence(out, posts);
  },
};

/**
 * Anti-fabrication guard. Keeps only evidence grounded in the supplied posts:
 *   - matched by `post_id` against a supplied post id, OR
 *   - the snippet appears verbatim (normalized) inside some supplied post.
 * When no posts were supplied, forces evidence empty and guarantees an
 * `insufficient_evidence_reason`. Re-attaches the real post date/urls when the
 * evidence matched a known post id.
 */
export function groundEvidence(
  out: BloggerDiscoveryReviewerOutput,
  posts: BloggerDiscoveryReviewerInput['candidate']['recent_posts'],
): BloggerDiscoveryReviewerOutput {
  if (posts.length === 0) {
    return {
      ...out,
      evidence: [],
      insufficient_evidence_reason:
        out.insufficient_evidence_reason ||
        'Нет публичных постов для оценки — требуется scrape/обогащение.',
    };
  }

  const byId = new Map(
    posts.filter((p) => p.id).map((p) => [p.id as string, p]),
  );
  const haystacks = posts.map((p) => normalize(p.text));

  const evidence: BloggerDiscoveryReviewerOutput['evidence'] = [];
  for (const e of out.evidence) {
    const needle = normalize(e.snippet);
    const matchedById = e.post_id ? byId.get(e.post_id) : undefined;
    const groundedBySnippet = needle.length >= 6 && haystacks.some((h) => h.includes(needle));
    if (!matchedById && !groundedBySnippet) continue;
    evidence.push({
      ...e,
      date: e.date ?? matchedById?.date ?? null,
      urls: e.urls.length ? e.urls : (matchedById?.urls ?? []),
    });
  }

  return { ...out, evidence };
}

function normalize(s: string): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}
