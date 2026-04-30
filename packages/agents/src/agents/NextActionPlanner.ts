import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';

export const nextActionPlannerInputSchema = z.object({
  conversation_state: z.record(z.unknown()),
  intent_history: z.array(z.string()).default([]),
  contact_meta: z.record(z.unknown()).optional(),
});

export const nextActionPlannerOutputSchema = z.object({
  next_action: z.enum([
    'send_now',
    'wait_hours',
    'send_followup_at',
    'close',
    'escalate',
  ]),
  scheduled_at: z.string().optional(),
  reason: z.string(),
});

export type NextActionPlannerInput = z.infer<typeof nextActionPlannerInputSchema>;
export type NextActionPlannerOutput = z.infer<typeof nextActionPlannerOutputSchema>;

const FALLBACK_SYSTEM = `Ты планируешь следующее действие в CustDev-диалоге. Возможные действия: send_now, wait_hours, send_followup_at (с ISO-датой), close, escalate. Учитывай тишину, тон, последний интент. Возвращай JSON: { next_action, scheduled_at?, reason }.`;

const FALLBACK_USER = `Состояние диалога: {{conversation_state}}
История интентов: {{intent_history}}
Мета контакта: {{contact_meta}}

Верни JSON.`;

export const nextActionPlanner: Agent<
  NextActionPlannerInput,
  NextActionPlannerOutput
> = {
  name: 'next_action_planner',
  description: 'Решает следующий шаг в диалоге.',
  inputSchema: nextActionPlannerInputSchema,
  outputSchema: nextActionPlannerOutputSchema,
  variables: ['conversation_state', 'intent_history', 'contact_meta'],
  defaultModel: 'yandexgpt',
  defaultParams: { temperature: 0.2, max_tokens: 300 },
  async run(input, ctx) {
    return invokeJson({
      ctx,
      vars: {
        conversation_state: input.conversation_state,
        intent_history: input.intent_history,
        contact_meta: input.contact_meta ?? {},
      },
      outputSchema: nextActionPlannerOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
  },
};
