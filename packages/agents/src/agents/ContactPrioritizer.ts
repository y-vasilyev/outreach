import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson, readParams } from './_runtime.js';
import { ConfidenceCoerced } from './_coerce.js';

const contactSchema = z.object({
  contact_id: z.string(),
  type: z.enum([
    'tg_username',
    'tg_link',
    'email',
    'phone',
    'website',
    'web_form',
    'other',
  ]),
  role_guess: z.enum(['owner', 'ad_manager', 'generic', 'bot', 'unknown']),
  // Tolerate qualitative LLM-emitted confidences ("medium"/"high"/percent).
  confidence: ConfidenceCoerced,
  reachability: z
    .enum(['reachable_tg', 'manual', 'unreachable'])
    .optional(),
});

const channelAnalysisLite = z
  .object({
    is_personal_brand: z.boolean().optional(),
    owner_signals: z
      .object({ is_personal_brand: z.boolean().optional() })
      .partial()
      .optional(),
  })
  .partial();

export const contactPrioritizerInputSchema = z.object({
  contacts: z.array(contactSchema),
  channel_analysis: channelAnalysisLite.optional(),
});

export const contactPrioritizerOutputSchema = z.object({
  ranked: z.array(
    z.object({
      contact_id: z.string(),
      score: z.number(),
      reason: z.string(),
    }),
  ),
});

export type ContactPrioritizerInput = z.infer<typeof contactPrioritizerInputSchema>;
export type ContactPrioritizerOutput = z.infer<typeof contactPrioritizerOutputSchema>;

const ROLE_BASE: Record<string, number> = {
  ad_manager: 100,
  owner: 80,
  generic: 50,
  bot: 25,
  unknown: 10,
};

const TYPE_BONUS: Record<string, number> = {
  tg_username: 15,
  tg_link: 12,
  email: 6,
  phone: 4,
  web_form: 2,
  website: 1,
  other: 0,
};

const FALLBACK_SYSTEM = `Ты выбираешь, какому контакту канала писать первым. Ранжируй контакты от самого подходящего к наименее подходящему. Используй роль (ad_manager > owner > generic > bot > unknown), тип (tg_username/tg_link предпочтительнее email и т.д.), и контекст канала. Если канал — личный бренд, владелец = ad_manager по приоритету. Возвращай только JSON с ranked[].`;

const FALLBACK_USER = `Контакты:
{{contacts}}

Анализ канала:
{{channel_analysis}}

Верни JSON: { ranked: [{ contact_id, score, reason }] }.`;

export const contactPrioritizer: Agent<
  ContactPrioritizerInput,
  ContactPrioritizerOutput
> = {
  name: 'contact_prioritizer',
  description: 'Ранжирует контакты канала для outreach.',
  inputSchema: contactPrioritizerInputSchema,
  outputSchema: contactPrioritizerOutputSchema,
  variables: ['contacts', 'channel_analysis'],
  defaultModel: 'yandexgpt-lite',
  defaultParams: {
    temperature: 0,
    max_tokens: 400,
    enable_llm_classification: false,
  },
  async run(input, ctx) {
    const params = readParams(ctx.config.params);
    const useLLM = params.enable_llm_classification === true;

    if (!useLLM) {
      return { ranked: rankDeterministic(input) };
    }

    return invokeJson({
      ctx,
      vars: {
        contacts: input.contacts,
        channel_analysis: input.channel_analysis ?? {},
      },
      outputSchema: contactPrioritizerOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
  },
};

function rankDeterministic(input: ContactPrioritizerInput): {
  contact_id: string;
  score: number;
  reason: string;
}[] {
  const isPersonalBrand =
    input.channel_analysis?.owner_signals?.is_personal_brand === true ||
    input.channel_analysis?.is_personal_brand === true;

  const scored = input.contacts.map((c) => {
    let role = c.role_guess;
    let reasonParts: string[] = [];
    if (isPersonalBrand && role === 'owner') {
      role = 'ad_manager';
      reasonParts.push('personal_brand:owner→ad_manager');
    }
    const roleScore = ROLE_BASE[role] ?? 0;
    const typeScore = TYPE_BONUS[c.type] ?? 0;
    const confidenceBoost = Math.round(c.confidence * 10);
    const reachabilityPenalty = c.reachability === 'unreachable' ? -100 : 0;
    const score = roleScore + typeScore + confidenceBoost + reachabilityPenalty;
    reasonParts.unshift(`role=${role}(${roleScore}) type=${c.type}(${typeScore}) conf=${c.confidence}`);
    return { contact_id: c.contact_id, score, reason: reasonParts.join('; ') };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}
