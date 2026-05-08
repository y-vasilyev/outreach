import { z } from 'zod';

import type { Agent } from '../types.js';
import { invokeJson, readParams } from './_runtime.js';
import { RiskScoreCoerced } from './_coerce.js';

export const safetyFilterInputSchema = z.object({
  draft: z.string(),
  channel_analysis: z.record(z.unknown()).optional(),
  contact: z.record(z.unknown()).optional(),
  campaign: z.record(z.unknown()).optional(),
  /**
   * Campaign AJTBD non_goals — fed into the LLM tone check as
   * additional risk context. Kept generic: non-goals do NOT become
   * hard filters here (that's the gate's job in
   * GoalFitEvaluator). SafetyFilter just biases the risk_score
   * upward when the draft references a non-goal.
   */
  ajtbd_non_goals: z.array(z.string()).optional(),
  /** Optional history to detect "do not message" cases. */
  history: z
    .array(
      z.object({
        direction: z.enum(['in', 'out']),
        text: z.string(),
        intent: z.string().optional(),
      }),
    )
    .optional(),
});

export const safetyFilterOutputSchema = z.object({
  allow: z.boolean(),
  reasons: z.array(z.string()).default([]),
  rewrite_hint: z.string().optional(),
  // LLMs return scores in any of: 0..1 (correct), 0..100 (percent),
  // sometimes 0..10 ("на сколько рискованно: 7"). Coerce all of those.
  risk_score: RiskScoreCoerced,
});

export type SafetyFilterInput = z.infer<typeof safetyFilterInputSchema>;
export type SafetyFilterOutput = z.infer<typeof safetyFilterOutputSchema>;

const DEFAULT_MAX_LENGTH = 600;

const FALLBACK_SYSTEM = `Ты оцениваешь тон CustDev-сообщения. Цель кампании — НЕ продажа: мы зовём на короткое исследовательское интервью.

Твоя задача — присвоить risk_score (0..1), отражающий, насколько сообщение звучит «продающе» / неуместно:
- 0.0–0.2 — спокойный исследовательский тон, всё в порядке.
- 0.3–0.5 — слегка натянуто или маркетингово, но допустимо.
- 0.6–0.8 — звучит как продажа рекламы / интеграции / спецпредложения.
- 0.9–1.0 — явный спам или агрессивная продажа.

В reasons[] кратко перечисли поводы для оценки (если есть). В rewrite_hint можешь предложить, как переписать.

ВАЖНО: ты только оцениваешь. Финальное решение об отправке принимает оператор и hard-guards уровнем выше. Поэтому всегда возвращай allow=true — твой risk_score важен сам по себе. Не блокируй из-за стиля, восклицаний или эмодзи.

Формат: { allow: true, reasons: [...], rewrite_hint?: "...", risk_score: 0..1 }.`;

const FALLBACK_USER = `Черновик:
{{draft}}

Канал: {{channel_analysis}}
Контакт: {{contact}}
Кампания: {{campaign}}
Anti-цели кампании (non_goals — если черновик их затрагивает, повышай risk_score; не блокируй): {{ajtbd_non_goals}}
История: {{history}}

Верни JSON.`;

export const safetyFilter: Agent<SafetyFilterInput, SafetyFilterOutput> = {
  name: 'safety_filter',
  description: 'Финальная проверка исходящего сообщения.',
  inputSchema: safetyFilterInputSchema,
  outputSchema: safetyFilterOutputSchema,
  variables: ['draft', 'channel_analysis', 'contact', 'campaign', 'ajtbd_non_goals', 'history'],
  defaultModel: 'yandexgpt-lite',
  defaultParams: {
    temperature: 0,
    max_tokens: 250,
    max_length: DEFAULT_MAX_LENGTH,
    allow_links: false,
  },
  async run(input, ctx) {
    const params = readParams(ctx.config.params);
    const maxLength =
      typeof params.max_length === 'number' ? params.max_length : DEFAULT_MAX_LENGTH;
    const allowLinks = params.allow_links === true;

    /**
     * Hard policy guards only. Substring/phrase matching for "salesy"
     * keywords was both noisy (every "интеграция AI" got blocked) and
     * brittle (LLM-written drafts in Russian rarely hit the literal
     * phrases anyway). We trust the LLM nuance check below for tone —
     * keep the deterministic checks for things the LLM physically cannot
     * override:
     *   - over the platform char limit
     *   - naked URL in a CustDev opener (we never want a link in turn one)
     *   - the recipient already declined (must escalate, not auto-reply)
     */
    const hardReasons: string[] = [];
    const draft = input.draft ?? '';

    if (draft.length > maxLength) {
      hardReasons.push(`max_length_exceeded:${draft.length}>${maxLength}`);
    }
    if (!allowLinks && /https?:\/\/\S+/i.test(draft)) {
      hardReasons.push('link_not_allowed');
    }
    if (Array.isArray(input.history)) {
      for (const h of input.history) {
        if (h.direction === 'in' && h.intent === 'declined') {
          hardReasons.push('recipient_declined_earlier');
          break;
        }
      }
    }

    if (hardReasons.length > 0) {
      return {
        allow: false,
        reasons: hardReasons,
        risk_score: 1,
        rewrite_hint: buildRewriteHint(hardReasons),
      };
    }

    // No hard violations — ask the LLM for a tone risk_score, but DO NOT
    // let it set `allow: false`. Hard guards above are the only authoritative
    // block; the LLM's verdict is advisory.
    //
    // Why: when the LLM had block authority it killed every variant on
    // stylistic grounds (exclamations, emoji, "salesy"-by-vibes). The
    // operator should see all variants with a risk badge and decide.
    const llm = await invokeJson({
      ctx,
      vars: {
        draft,
        channel_analysis: input.channel_analysis ?? {},
        contact: input.contact ?? {},
        campaign: input.campaign ?? {},
        ajtbd_non_goals: input.ajtbd_non_goals ?? [],
        history: input.history ?? [],
      },
      outputSchema: safetyFilterOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });
    return {
      allow: true,
      reasons: llm.reasons,
      risk_score: llm.risk_score,
      ...(llm.rewrite_hint ? { rewrite_hint: llm.rewrite_hint } : {}),
    };
  },
};

function buildRewriteHint(reasons: string[]): string {
  const hints: string[] = [];
  if (reasons.some((r) => r.startsWith('max_length_exceeded'))) {
    hints.push('Сократи до 2–4 предложений.');
  }
  if (reasons.includes('link_not_allowed')) {
    hints.push('Не вставляй ссылки.');
  }
  if (reasons.includes('recipient_declined_earlier')) {
    hints.push('Получатель уже отказался — нужно эскалировать оператору, а не писать заново.');
  }
  return hints.join(' ');
}
