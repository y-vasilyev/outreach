import { z } from 'zod';

import { CampaignAjtbdZ } from '@nosquare/shared/schemas';

import type { Agent } from '../types.js';
import { invokeJson, readParams } from './_runtime.js';
import { ConfidenceCoerced } from './_coerce.js';
import { INTENTS } from './IntentClassifier.js';

/**
 * GoalFitEvaluator — model-side quality gate for the on_inbound pipeline.
 *
 * Runs only when conversation.mode is `semi_auto` or `auto` (the workers
 * skip it for `assisted` and `manual` to keep cost down). Evaluates whether
 * the latest exchange + the AI's draft reply still tracks the campaign's
 * AJTBD, and produces an action that downstream auto-approve composition
 * keys off:
 *
 *   - `continue`        — on track. Auto-send eligible (subject to safety
 *                         and the per-mode goalfit threshold).
 *   - `soften`          — drifting. Auto-send eligible only in semi_auto;
 *                         in `auto` mode the draft is downgraded to a
 *                         `pending` suggestion.
 *   - `handoff_silent`  — the contact has shifted into a non_goal or the
 *                         draft is firmly off-rails. In `auto` mode the
 *                         conversation flips silently to `assisted` (no
 *                         contact-visible artifact); in `semi_auto` the
 *                         draft is just left as a pending suggestion.
 *
 * Composition with safety / intent / handoff lives in
 * `apps/workers/src/services/auto-approve.ts`. Hysteresis (don't flip on a
 * single soft handoff) is applied in `agent-run.ts` before mutating mode.
 */

const HandoffActionZ = z.enum(['continue', 'soften', 'handoff_silent']);

export const goalFitEvaluatorInputSchema = z.object({
  ajtbd: CampaignAjtbdZ,
  history_tail: z.array(z.string()).default([]),
  intent: z.object({
    intent: z.enum(INTENTS),
    confidence: ConfidenceCoerced,
  }),
  handoff: z.object({
    action: z.enum(['ai_continue', 'ai_suggest_only', 'operator_now']),
    reason: z.string(),
  }),
  /** The top draft from ReplyComposer that auto-approve would send. */
  draft: z.string(),
  /**
   * Previous gate decision for hysteresis. Null when this is the first
   * gate run for the conversation.
   */
  previous_decision: z
    .object({
      action: HandoffActionZ,
      score: z.number().min(0).max(1),
      decidedAt: z.string().optional(),
    })
    .nullable()
    .optional(),
});

export const goalFitEvaluatorOutputSchema = z.object({
  score: z.number().min(0).max(1),
  action: HandoffActionZ,
  reasons: z.array(z.string()).default([]),
});

export type GoalFitEvaluatorInput = z.infer<typeof goalFitEvaluatorInputSchema>;
export type GoalFitEvaluatorOutput = z.infer<typeof goalFitEvaluatorOutputSchema>;

const FALLBACK_SYSTEM = `Ты оцениваешь, насколько активный CustDev-диалог по-прежнему движется к цели кампании, описанной через AJTBD.

Возвращай JSON: { score: 0..1, action: "continue" | "soften" | "handoff_silent", reasons: string[] }.

action:
- continue — диалог идёт по плану, ответ хороший, можно отправить.
- soften — на трассе, но черновик начинает скользить (слишком напористо или к non_goal). В semi_auto допустимо отправлять, в auto — нет.
- handoff_silent — диалог явно в non_goal или сошёл с цели. Молчаливо передаём оператору.

ВАЖНО: ты оцениваешь fit к цели, не стиль и не безопасность. Это отдельные слои. Твой вклад — «ещё CustDev или уже что-то другое?».`;

const FALLBACK_USER = `AJTBD кампании: {{ajtbd}}

Хвост истории:
{{history_tail}}

Последний intent собеседника: {{intent}}
Решение handoff_decider: {{handoff}}
Черновик ИИ-ответа: {{draft}}
Предыдущее решение gate (для тренда, может быть null): {{previous_decision}}

Верни JSON.`;

const DEFAULT_HISTORY_TAIL_CAP = 8;

export const goalFitEvaluator: Agent<GoalFitEvaluatorInput, GoalFitEvaluatorOutput> = {
  name: 'goal_fit_evaluator',
  description:
    'Оценивает goal-fit активного CustDev-диалога к AJTBD кампании. Решает: continue / soften / handoff_silent.',
  inputSchema: goalFitEvaluatorInputSchema,
  outputSchema: goalFitEvaluatorOutputSchema,
  variables: ['ajtbd', 'history_tail', 'intent', 'handoff', 'draft', 'previous_decision'],
  defaultModel: 'google/gemini-2.5-flash-lite',
  defaultParams: {
    temperature: 0.0,
    max_tokens: 350,
    t_safety: 0.8,
    t_semi_auto_goalfit: 0.6,
    t_auto_goalfit: 0.75,
    max_history_tail: DEFAULT_HISTORY_TAIL_CAP,
  },
  async run(input, ctx) {
    const params = readParams(ctx.config.params);
    const cap =
      typeof params.max_history_tail === 'number' && params.max_history_tail > 0
        ? params.max_history_tail
        : DEFAULT_HISTORY_TAIL_CAP;

    // Cap the trailing history to keep tokens bounded — gate runs on every
    // inbound for semi_auto/auto conversations.
    const tail = input.history_tail.slice(-cap);

    return invokeJson({
      ctx,
      vars: {
        ajtbd: input.ajtbd,
        history_tail: tail,
        intent: input.intent,
        handoff: input.handoff,
        draft: input.draft,
        previous_decision: input.previous_decision ?? null,
      },
      outputSchema: goalFitEvaluatorOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
  },
};
