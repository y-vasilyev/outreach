import { z } from 'zod';
import { SafetyProfileZ, AutonomyPolicyZ } from '@nosquare/shared';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';

/**
 * CampaignTypeBuilder — meta-agent (agency-sourcing-matching, milestone 3).
 *
 * Turns a plain-language goal into a structured DRAFT for a new campaign
 * type: a goal JSON-schema, a safety profile (forbidden / allowed vocabulary,
 * link policy, length), an autonomy policy (gate thresholds + intents that
 * force operator handoff), and a system/user prompt for each required
 * pipeline role.
 *
 * This agent ONLY drafts text/config — it does not pick endpoints/models
 * (that's done deterministically from the capability map in the builder
 * service), does not run fixtures, and does not persist anything. Decision D3
 * in the change design: the builder never auto-publishes; the operator
 * reviews and explicitly saves.
 *
 * Model: strong (it authors prompts + schemas). Selected by the service via
 * the capability map, like every other agent.
 */

/** Roles the builder always drafts. Mirrors PipelineRoleZ's consumed set. */
export const BUILDER_REQUIRED_ROLES = [
  'opening_composer',
  'reply_composer',
  'intent_classifier',
  'safety_filter',
  'goal_fit_evaluator',
] as const;

const DraftRoleZ = z.object({
  role: z.string().min(1),
  description: z.string().default(''),
  systemPrompt: z.string().min(1),
  userPromptTemplate: z.string().min(1),
  /** Present when the role produces structured output. */
  outputJsonSchema: z.record(z.unknown()).nullable().default(null),
});

export const campaignTypeBuilderInputSchema = z.object({
  goal_description: z.string().min(1),
  examples: z.array(z.string()).default([]),
  constraints: z.record(z.unknown()).default({}),
  /** The roles the service expects the builder to draft. */
  required_roles: z.array(z.string().min(1)).default([...BUILDER_REQUIRED_ROLES]),
});

export const campaignTypeBuilderOutputSchema = z.object({
  /** snake_case key suggestion for the new type. */
  key: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/, 'key must be snake_case'),
  name: z.string().min(1),
  description: z.string().default(''),
  /** JSON-schema (object) describing the campaign goal of this type. */
  goalSchema: z.record(z.unknown()).default({}),
  // Reuse the canonical shared schemas instead of duplicating them — keeps
  // the builder output in lock-step with `SafetyProfileZ` / `AutonomyPolicyZ`
  // as those evolve (e.g. new hard_block_patterns shape) and stops the two
  // copies from drifting.
  safetyProfile: SafetyProfileZ,
  autonomyPolicy: AutonomyPolicyZ,
  agents: z.array(DraftRoleZ).min(1),
});

export type CampaignTypeBuilderInput = z.infer<typeof campaignTypeBuilderInputSchema>;
export type CampaignTypeBuilderOutput = z.infer<typeof campaignTypeBuilderOutputSchema>;

const FALLBACK_SYSTEM = `Ты — конструктор типов кампаний для системы аутрича. По описанию цели на естественном языке ты проектируешь конфигурацию нового типа кампании.

Тебе нужно вернуть строго JSON со следующими полями:
- key: короткий snake_case идентификатор типа (например "podcast_guesting").
- name: человекочитаемое название.
- description: 1–2 предложения, в чём суть кампании и чего она НЕ делает.
- goalSchema: JSON-схема (object) структурированной цели кампании этого типа. Обязательно укажи "type":"object", "required":[...] и "properties". Поля должны отражать, что кампания собирает или чего добивается.
- safetyProfile: { forbidden_topics: string[] (темы/слова, повышающие риск; advisory), allowed_topics: string[] (уместные темы, риск НЕ повышают), allow_links: boolean, max_length: число символов, hard_block_patterns: [{ id, pattern (regex source), reason, flags? }] (детерминированные блокировки ДО LLM — для категорий, которые нельзя пропускать никогда: гарантии результата, упоминание оплаты до оператора, давление; для нейтральных типов оставляй [] ) }.
- autonomyPolicy: { defaultMode: "manual"|"assisted"|"semi_auto"|"auto", T_safety, T_semi_auto_goalfit, T_auto_goalfit (0..1), forceHandoffIntents: string[] (интенты, при которых диалог принудительно уходит оператору) }. Для коммерчески чувствительных кампаний выбирай defaultMode "assisted".
- agents: массив объектов { role, description, systemPrompt, userPromptTemplate, outputJsonSchema }. Для КАЖДОЙ роли из required_roles напиши осмысленный системный промпт и шаблон пользовательского промпта (с {{переменными}}). Если роль возвращает структурированный JSON (intent_classifier, safety_filter, goal_fit_evaluator) — заполни outputJsonSchema схемой; для свободного текста ставь outputJsonSchema = null.

Правила:
- Не выдумывай гарантии результата. Не подталкивай к обману.
- Промпты пиши на русском, конкретно под описанную цель, а не общими словами.
- Покрой ВСЕ роли из required_roles, по одному объекту на роль.
- Возвращай только JSON по схеме.`;

const FALLBACK_USER = `Описание цели кампании:
{{goal_description}}

Примеры (опционально):
{{examples}}

Ограничения (опционально):
{{constraints}}

Роли, которые нужно спроектировать (по одному объекту agents на каждую):
{{required_roles}}

Верни JSON.`;

export const campaignTypeBuilder: Agent<
  CampaignTypeBuilderInput,
  CampaignTypeBuilderOutput
> = {
  name: 'campaign_type_builder',
  description:
    'Мета-агент: из описания цели проектирует draft типа кампании (goal schema, safety profile, autonomy policy, промпты по ролям).',
  inputSchema: campaignTypeBuilderInputSchema,
  outputSchema: campaignTypeBuilderOutputSchema,
  variables: ['goal_description', 'examples', 'constraints', 'required_roles'],
  defaultModel: 'anthropic/claude-sonnet-4.6',
  defaultParams: {
    temperature: 0.3,
    max_tokens: 4000,
  },
  async run(input, ctx) {
    const out = await invokeJson({
      ctx,
      vars: {
        goal_description: input.goal_description,
        examples: input.examples,
        constraints: input.constraints,
        required_roles: input.required_roles,
      },
      outputSchema: campaignTypeBuilderOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
    return out;
  },
};
