import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';

/**
 * DataCollectionPlanner — `data_collection_planner`
 *
 * Drives the agency-sourcing data-collection dialogue. Given the target data
 * points (rate card per format, reach/views, audience demographics, geo,
 * deals contact) and which are already collected, it proposes the NEXT single
 * question for one missing point — never re-asking a collected one — and
 * signals goal-satisfied (with a closing/thank-you reply) once everything is
 * collected.
 *
 * The agent stays one-topic-at-a-time on purpose (spec: "proposes the next
 * question … one topic at a time"). The set of missing points is computed
 * deterministically here so the LLM cannot re-ask a collected field or claim
 * completion prematurely.
 */

export const dataCollectionPlannerInputSchema = z.object({
  /** All target data points this campaign wants harvested. */
  target_data_points: z.array(z.string().min(1)).min(1),
  /** Subset already collected (matched against target by exact string). */
  collected_data_points: z.array(z.string()).default([]),
  /** Recent dialogue turns for tone/context (optional). */
  history_tail: z.array(z.string()).default([]),
  /** Last inbound, so the planner can acknowledge it naturally. */
  last_inbound: z.string().default(''),
});

export const dataCollectionPlannerOutputSchema = z.object({
  /**
   * The single data point this turn targets. Null/absent when all collected
   * (goal satisfied). Always one of the still-missing target points when set
   * (enforced deterministically in run()).
   */
  next_data_point: z.string().optional(),
  /** Proposed reply text: a question for `next_data_point`, or a closing. */
  reply: z.string(),
  /** True iff every target data point is collected. */
  goal_satisfied: z.boolean(),
  rationale: z.string().default(''),
});

export type DataCollectionPlannerInput = z.infer<
  typeof dataCollectionPlannerInputSchema
>;
export type DataCollectionPlannerOutput = z.infer<
  typeof dataCollectionPlannerOutputSchema
>;

const FALLBACK_SYSTEM = `Ты ведёшь диалог от лица агентства и собираешь у блогера коммерческие данные: прайс по форматам, охваты/просмотры, демографию аудитории, гео, контакт для сделок.

Тебе дают:
- target_data_points — что нужно собрать всего;
- missing_data_points — что ещё НЕ собрано (спрашивай только это);
- историю и последнее входящее.

ПРАВИЛА:
- Спрашивай РОВНО ОДИН недостающий пункт за ход (next_data_point). Не задавай несколько вопросов сразу.
- НИКОГДА не переспрашивай то, что уже собрано.
- Если missing_data_points пуст — ничего не спрашивай: напиши короткое благодарственное/закрывающее сообщение и поставь goal_satisfied=true, next_data_point не указывай.
- Тон деловой и живой. Без давления, без гарантий результата, без платёжных ссылок.
- Естественно подхвати последнее входящее, потом задай следующий вопрос.

Возвращай JSON: { next_data_point?, reply, goal_satisfied, rationale }.`;

const FALLBACK_USER = `Все целевые данные (target_data_points): {{target_data_points}}
Уже собрано: {{collected_data_points}}
Ещё НЕ собрано (спрашивай только это): {{missing_data_points}}

История:
{{history_tail}}

Последнее входящее: {{last_inbound}}

Верни JSON.`;

export const dataCollectionPlanner: Agent<
  DataCollectionPlannerInput,
  DataCollectionPlannerOutput
> = {
  name: 'data_collection_planner',
  description:
    'Планирует следующий вопрос для сбора недостающих коммерческих данных блогера; сигналит goal-satisfied когда всё собрано.',
  inputSchema: dataCollectionPlannerInputSchema,
  outputSchema: dataCollectionPlannerOutputSchema,
  variables: [
    'target_data_points',
    'collected_data_points',
    'missing_data_points',
    'history_tail',
    'last_inbound',
  ],
  defaultModel: 'anthropic/claude-haiku-4.5',
  defaultParams: { temperature: 0.3, max_tokens: 400 },
  async run(input, ctx) {
    // Deterministic missing-set: target minus collected, order preserved.
    const collected = new Set(input.collected_data_points);
    const missing = input.target_data_points.filter((p) => !collected.has(p));

    // Short-circuit when nothing is missing — no LLM call needed for the
    // structural decision, but we still let the model phrase a natural
    // closing. To keep cost down and the goal-satisfied signal authoritative,
    // we ask the LLM for the closing copy and override the structural fields.
    const out = await invokeJson({
      ctx,
      vars: {
        target_data_points: input.target_data_points,
        collected_data_points: input.collected_data_points,
        missing_data_points: missing,
        history_tail: input.history_tail.join('\n'),
        last_inbound: input.last_inbound,
      },
      outputSchema: dataCollectionPlannerOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });

    if (missing.length === 0) {
      // Goal satisfied: the structural truth is deterministic. Keep the LLM's
      // reply copy but never let it re-open a collected point.
      return {
        reply: out.reply,
        goal_satisfied: true,
        rationale: out.rationale || 'Все целевые данные собраны.',
      };
    }

    // Still collecting. Force `next_data_point` to a genuinely-missing point:
    // honour the LLM's pick if it is one, otherwise pick the first missing.
    const llmPick =
      typeof out.next_data_point === 'string' && missing.includes(out.next_data_point)
        ? out.next_data_point
        : undefined;
    const nextPoint = llmPick ?? missing[0]!;

    return {
      next_data_point: nextPoint,
      reply: out.reply,
      goal_satisfied: false,
      rationale: out.rationale,
    };
  },
};
