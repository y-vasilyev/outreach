import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';

/**
 * DiscoveryQueryPlanner — `discovery_query_planner`
 * (ajtbd-guided-blogger-discovery, task 2.1).
 *
 * Expands a campaign goal/AJTBD or a manual niche brief into a BOUNDED set of
 * public web-search queries for blogger discovery. Each query carries a target
 * platform, rationale, the intended audience/topic signal, optional negative
 * terms, and a confidence.
 *
 * The worker — not the agent — enforces the hard `max_queries` budget
 * (deterministic truncation + a `budget.truncated` trace event), so this agent
 * only needs to produce a focused, de-duplicated plan. `query` is the PLAIN
 * niche text; the traceable search core adds the `site:<host>` scopes, so the
 * planner must NOT emit `site:` operators itself.
 *
 * Runs via AgentRunner (writes `agent_run`). Seeded in
 * `packages/db/prisma/agents.seed.ts`; the fallback prompts here are the
 * behaviour source of truth when no DB config exists.
 */

const PLATFORMS = ['telegram', 'instagram', 'youtube'] as const;

export const discoveryQueryPlannerInputSchema = z.object({
  /** Resolved brief / niche text (campaign goalText or operator brief). */
  brief: z.string().default(''),
  /** Structured AJTBD view when a campaign was supplied (else null). */
  ajtbd: z
    .object({
      job: z.string().default(''),
      when: z.string().default(''),
      desired_outcome: z.string().default(''),
      non_goals: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),
  /** Narrow to one platform, or null to let the planner fan across platforms. */
  platform: z.enum(PLATFORMS).nullable().default(null),
  geo: z.array(z.string()).default([]),
  language: z.string().nullable().default(null),
  /** Budget hint surfaced to the model; the worker enforces it. */
  max_queries: z.number().int().min(1).max(20).default(8),
});

export const plannedQueryOutZ = z.object({
  query: z.string().min(2).max(300),
  platform: z.enum(PLATFORMS).nullable().default(null),
  rationale: z.string().default(''),
  signal: z.string().default(''),
  negative_terms: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});

export const discoveryQueryPlannerOutputSchema = z.object({
  queries: z.array(plannedQueryOutZ).default([]),
});

export type DiscoveryQueryPlannerInput = z.infer<typeof discoveryQueryPlannerInputSchema>;
export type DiscoveryQueryPlannerOutput = z.infer<typeof discoveryQueryPlannerOutputSchema>;

const FALLBACK_SYSTEM = `Ты — стратег по поиску блогеров для агентства. На вход тебе дают бриф/нишу кампании (и, возможно, структурированный AJTBD) и просят составить ПЛАН веб-поиска публичных каналов/блогеров.

Твоя задача — превратить одну нишу в НЕСКОЛЬКО конкретных поисковых запросов под разные углы (тематика, поджанр, аудитория, гео, формат), чтобы найти релевантные публичные каналы.

ПРАВИЛА:
- Возвращай несколько запросов (ориентир — до max_queries штук), РАЗНЫХ по углу. Не плоди почти одинаковые формулировки.
- query — это ПЛАИН-текст ниши на естественном языке (русском, если язык русский). НЕ добавляй операторы site:, inurl:, кавычки-фильтры — площадку задаёт поле platform, scope добавит система.
- platform — telegram | instagram | youtube | null. Ставь конкретную платформу, если запрос имеет смысл только на ней; иначе null (искать на всех).
- rationale — короткое объяснение, зачем этот запрос (1 фраза).
- signal — какой сигнал аудитории/темы ты ожидаешь поймать этим запросом.
- negative_terms — слова, которые отсекают мусор (новости, агрегаторы, курсы), если уместно.
- confidence — 0..1, насколько запрос релевантен брифу.
- Учитывай geo/language: если заданы — отражай в части запросов.
- НЕ выдумывай конкретных названий каналов/брендов, если их нет в брифе.

Возвращай ТОЛЬКО JSON: { queries: [{ query, platform, rationale, signal, negative_terms[], confidence }] }.`;

const FALLBACK_USER = `Бриф/ниша кампании: {{brief}}
AJTBD (если есть): {{ajtbd}}
Платформа (если задана, иначе null — фанаут по всем): {{platform}}
Гео: {{geo}}
Язык: {{language}}
Максимум запросов (бюджет): {{max_queries}}

Составь план поиска. Верни JSON: { queries: [...] }. Запросы — плейн-текст ниши, без site:/операторов.`;

export const discoveryQueryPlanner: Agent<
  DiscoveryQueryPlannerInput,
  DiscoveryQueryPlannerOutput
> = {
  name: 'discovery_query_planner',
  description:
    'Превращает бриф/AJTBD кампании в ограниченный план веб-поиска публичных блогеров: несколько запросов с платформой, обоснованием и сигналом.',
  inputSchema: discoveryQueryPlannerInputSchema,
  outputSchema: discoveryQueryPlannerOutputSchema,
  variables: ['brief', 'ajtbd', 'platform', 'geo', 'language', 'max_queries'],
  defaultModel: 'google/gemini-3-flash-preview',
  defaultParams: { temperature: 0.4, max_tokens: 1000 },
  async run(input, ctx) {
    const out = await invokeJson({
      ctx,
      vars: {
        brief: input.brief,
        ajtbd: input.ajtbd,
        platform: input.platform,
        geo: input.geo,
        language: input.language,
        max_queries: input.max_queries,
      },
      outputSchema: discoveryQueryPlannerOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });

    // Deterministic hardening:
    //  - strip any `site:`/operator the model leaked into `query` (the search
    //    core owns scoping);
    //  - drop empty/too-short queries;
    //  - if the run is platform-scoped, force every query to that platform;
    //  - de-dupe by (platform, normalized query).
    const seen = new Set<string>();
    const queries: DiscoveryQueryPlannerOutput['queries'] = [];
    for (const q of out.queries) {
      const clean = stripOperators(q.query);
      if (clean.length < 2) continue;
      const platform = input.platform ?? q.platform ?? null;
      const key = `${platform ?? 'all'}:${clean.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push({ ...q, query: clean, platform });
    }
    return { queries };
  },
};

function stripOperators(query: string): string {
  return (query ?? '')
    .replace(/\b(?:site|inurl|intitle|filetype):\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
