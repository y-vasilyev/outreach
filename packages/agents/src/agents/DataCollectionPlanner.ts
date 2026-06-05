import { z } from 'zod';

import {
  getTarget,
  PlacementOfferDraftZ,
  missingRequiredAttributes,
  offerHasAttribute,
  derivePlacementFormatKey,
  PLACEMENT_ATTRIBUTE_REGISTRY_V1,
  type PlacementOfferDraft,
} from '@nosquare/shared';

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
  /**
   * Known structured placement offers (entity-style-rate-cards, Section 4).
   * Rolled up from the blogger profile. When present and an offer has a usable
   * price but is missing a required attribute (delete_policy, duration, tax,
   * includes), the planner asks a FOCUSED follow-up about that one attribute
   * instead of re-asking for the whole rate card. Empty / flag-off ⇒ today's
   * deterministic missing-target behaviour.
   */
  placement_offers: z.array(PlacementOfferDraftZ).optional(),
  /**
   * Active required attribute keys for the campaign (the active registry's
   * `requiredForKinds` ∪ campaign extras). Used to decide which missing
   * attribute to chase per offer. Empty ⇒ registry defaults via
   * `missingRequiredAttributes`.
   */
  required_attribute_keys: z.array(z.string()).optional(),
});

export const dataCollectionPlannerOutputSchema = z.object({
  /**
   * The single data point this turn targets. Null/absent when all collected
   * (goal satisfied). Always one of the still-missing target points when set
   * (enforced deterministically in run()).
   */
  next_data_point: z.string().optional(),
  /**
   * Same value as `next_data_point` when a question is emitted; omitted
   * on closing. The worker copies this into `Suggestion.meta.targetField`
   * (camelCase) so the data-collection HUD can mark the field `asked`
   * even before any answer arrives. Snake-case here matches the planner's
   * input/output naming convention; the persisted key is camelCase.
   */
  target_field: z.string().optional(),
  /**
   * When the planner chose to chase a missing required ATTRIBUTE of a known
   * offer (rather than a whole missing target), this is that attribute key
   * (e.g. `delete_policy`). Operator-facing only; not sent to the contact.
   */
  next_attribute_key: z.string().optional(),
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

const CLOSING_REPLY = 'Спасибо, всё собрал! Вернусь с конкретикой по клиенту.';

/**
 * Deterministic Russian question for a target. Used when the planner overrides
 * the LLM's `next_data_point` (because the model picked a collected/wrong
 * field) so the returned `reply` can't keep asking about the wrong point.
 * Reads from the shared `data-collection-targets` registry — there is one
 * place to edit a label or question. Unknown keys get a generic,
 * point-aware fallback (defensive — every key we ship is in the registry).
 */
function questionFor(point: string): string {
  return (
    getTarget(point)?.question_template ??
    `Подскажите, пожалуйста, по пункту «${point}» — что можете рассказать?`
  );
}

/**
 * Deterministic Russian follow-up for a single missing required ATTRIBUTE of
 * an already-priced offer (entity-style-rate-cards, Section 4). Focused: it
 * asks ONLY about that attribute, never re-asking price. Falls back to a
 * generic, attribute-aware phrasing for keys without a hand-written line.
 */
function attributeQuestionFor(attributeKey: string): string {
  switch (attributeKey) {
    case 'delete_policy':
      return 'Подскажите, пожалуйста: пост удаляется по истечении срока или остаётся в ленте навсегда?';
    case 'duration':
      return 'Уточните, пожалуйста, на какой срок размещение — на сутки, неделю, месяц или бессрочно?';
    case 'tax':
      return 'Цена указана с учётом налога или налог добавляется сверху? Если да — какой?';
    case 'includes':
      return 'Что входит в размещение помимо самой публикации — анонсы, доп. посты, упоминания?';
    default:
      return `Уточните, пожалуйста, ещё один момент по размещению — «${attributeKey}»?`;
  }
}

/**
 * One pending focused follow-up: a known offer that has a usable price but is
 * missing a required attribute. The first missing required key is chased.
 */
interface OfferAttributeFollowup {
  /** Index into the input `placement_offers` (for the LLM to reference). */
  offerIndex: number;
  /** Stable derived format key, e.g. `telegram_post_month`. */
  offerFormat: string;
  /** The single required attribute key to chase. */
  attributeKey: string;
}

/**
 * True when the offer carries a usable price+currency that the planner should
 * NOT re-ask. (Currency always defaults to a non-empty value in the schema, so
 * a finite, non-negative price is the gate.) Stale/low-confidence offers are
 * NOT treated as having a usable price so the planner can chase price again.
 */
function offerHasUsablePrice(offer: PlacementOfferDraft): boolean {
  return (
    typeof offer.price === 'number' &&
    Number.isFinite(offer.price) &&
    offer.price >= 0 &&
    offer.confidence >= 0.5
  );
}

/**
 * Compute the focused attribute follow-ups for the known offers: for each
 * offer with a usable price, EVERY missing required attribute (per the active
 * registry + campaign extras) becomes a follow-up so the planner can pick a
 * sensible one and chase the rest on later turns. Deterministic order (offer
 * order, then registry-required order) so the planner is stable; the FIRST
 * entry is the deterministic-override default.
 */
function computeOfferAttributeFollowups(
  offers: PlacementOfferDraft[],
  requiredAttributeKeys: string[],
): OfferAttributeFollowup[] {
  const followups: OfferAttributeFollowup[] = [];
  offers.forEach((offer, offerIndex) => {
    if (!offerHasUsablePrice(offer)) return;
    // Registry-required (by kind) ∪ campaign-required extras, minus what the
    // offer already carries. `missingRequiredAttributes` honours the promoted
    // top-level fields and only counts ACTIVE registry entries.
    const missing = missingRequiredAttributes(
      offer,
      PLACEMENT_ATTRIBUTE_REGISTRY_V1,
      requiredAttributeKeys,
    ).filter((k) => !offerHasAttribute(offer, k));
    const offerFormat = derivePlacementFormatKey(offer);
    for (const attributeKey of missing) {
      followups.push({ offerIndex, offerFormat, attributeKey });
    }
  });
  return followups;
}

const FALLBACK_SYSTEM = `Ты ведёшь диалог от лица агентства и собираешь у блогера коммерческие данные. Полный словарь целей — в targets_meta: каждая запись содержит \`key\`, \`description_for_agent\` (что именно спрашивать) и \`question_template\` (готовая формулировка вопроса).

Тебе дают:
- target_data_points — что нужно собрать всего (ключи);
- missing_data_points — что ещё НЕ собрано (спрашивай только это);
- targets_meta — словарь по ключам с описанием и шаблоном вопроса;
- placement_offers — уже известные размещения блогера (kind/platform/price/attributes);
- attribute_followups — у каких размещений УЖЕ ЕСТЬ цена, но НЕ хватает обязательного атрибута (delete_policy/duration/tax/includes). Каждый: {offer_index, offer_format, attribute_key};
- историю и последнее входящее.

ПРАВИЛА:
- Спрашивай РОВНО ОДИН недостающий пункт за ход. Не задавай несколько вопросов сразу.
- ПРИОРИТЕТ: если attribute_followups НЕ пуст, спроси ТОЧЕЧНО про первый недостающий атрибут конкретного размещения (next_attribute_key = его attribute_key). НЕ переспрашивай прайс/цену, если у размещения уже есть цена — уточняй только сам атрибут (например, удаляется ли пост, на какой срок, налог сверху или включён, что входит).
- Если attribute_followups пуст, работай по missing_data_points: за основу возьми question_template нужного пункта из targets_meta и подстрой под последнее входящее. Не выдумывай вопрос с нуля.
- НИКОГДА не переспрашивай то, что уже собрано, и не переспрашивай цену, если она уже известна (кроме случаев, когда она устарела/сомнительна).
- Если и missing_data_points, и attribute_followups пусты — ничего не спрашивай: напиши короткое благодарственное/закрывающее сообщение и поставь goal_satisfied=true.
- Тон деловой и живой. Без давления, без гарантий результата, без платёжных ссылок.

Возвращай JSON: { next_data_point?, target_field?, next_attribute_key?, reply, goal_satisfied, rationale }. При точечном вопросе про атрибут заполни next_attribute_key; при вопросе про цель — target_field (=next_data_point); на закрытии оба опущены.`;

const FALLBACK_USER = `Все целевые данные (target_data_points): {{target_data_points}}
Уже собрано: {{collected_data_points}}
Ещё НЕ собрано (спрашивай только это): {{missing_data_points}}

Словарь целей (targets_meta):
{{targets_meta}}

Известные размещения (placement_offers):
{{placement_offers}}

Точечные follow-up по атрибутам (attribute_followups):
{{attribute_followups}}

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
    'targets_meta',
    'placement_offers',
    'attribute_followups',
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
    // Render the registry slice for the targets in play so the LLM sees
    // the operator-tunable `description_for_agent` + `question_template`.
    // Editing those in the registry now changes the next planner question
    // on the happy path, not just the deterministic-override fallback.
    const targets_meta = input.target_data_points
      .map((k) => getTarget(k))
      .filter((t): t is NonNullable<ReturnType<typeof getTarget>> => !!t)
      .map((t) => ({
        key: t.key,
        description_for_agent: t.description_for_agent,
        question_template: t.question_template,
      }));

    // Focused attribute follow-ups (entity-style-rate-cards, Section 4):
    // priced offers that still miss a required attribute. Deterministic — the
    // LLM cannot invent or skip one. Empty when no offers / no flag-fed offers,
    // which keeps the legacy non-offer behaviour byte-for-byte.
    // Defensive `?? []`: the schema defaults these, but `run` is also called
    // directly (unit tests) with raw objects that bypass zod parsing.
    const placementOffers = input.placement_offers ?? [];
    const requiredAttributeKeys = input.required_attribute_keys ?? [];
    const attributeFollowups = computeOfferAttributeFollowups(
      placementOffers,
      requiredAttributeKeys,
    );

    const out = await invokeJson({
      ctx,
      vars: {
        target_data_points: input.target_data_points,
        collected_data_points: input.collected_data_points,
        missing_data_points: missing,
        targets_meta,
        placement_offers: placementOffers.map((o, i) => ({
          index: i,
          format: derivePlacementFormatKey(o),
          kind: o.kind,
          platform: o.platform,
          price: o.price,
          currency: o.currency,
          attributes: o.attributes.map((a) => ({ key: a.key, value: a.value })),
        })),
        attribute_followups: attributeFollowups.map((f) => ({
          offer_index: f.offerIndex,
          offer_format: f.offerFormat,
          attribute_key: f.attributeKey,
        })),
        history_tail: input.history_tail.join('\n'),
        last_inbound: input.last_inbound,
      },
      outputSchema: dataCollectionPlannerOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
    });

    // Goal is satisfied only when there is nothing left to chase — neither a
    // missing target NOR a missing required attribute of a priced offer. An
    // open attribute follow-up keeps the dialogue going even when every
    // coarse target is technically "collected".
    if (missing.length === 0 && attributeFollowups.length === 0) {
      // The LLM may still emit a reply that re-asks a collected point, so
      // replace it with a deterministic closing line — never pass the model
      // copy verbatim. `target_field` is intentionally omitted on closing.
      return {
        reply: CLOSING_REPLY,
        goal_satisfied: true,
        rationale: out.rationale || 'Все целевые данные собраны.',
      };
    }

    // PRIORITY: chase a focused attribute follow-up before a coarse target.
    // Asking a precise attribute (e.g. "пост удаляется или остаётся?") is
    // strictly more useful than re-opening the whole rate card the blogger
    // already priced. Honour the LLM's `next_attribute_key` when it matches a
    // genuinely-pending follow-up; otherwise take the first pending one.
    if (attributeFollowups.length > 0) {
      const llmAttr =
        typeof out.next_attribute_key === 'string'
          ? attributeFollowups.find((f) => f.attributeKey === out.next_attribute_key)
          : undefined;
      const chosen = llmAttr ?? attributeFollowups[0]!;
      // When we honoured the LLM's attribute pick, keep its (richer) natural
      // phrasing — but only if it actually targeted that attribute. When we
      // overrode it, substitute a deterministic focused question so the reply
      // never re-asks price or chases the wrong attribute.
      const reply = llmAttr !== undefined ? out.reply : attributeQuestionFor(chosen.attributeKey);
      return {
        next_attribute_key: chosen.attributeKey,
        reply,
        goal_satisfied: false,
        rationale:
          out.rationale ||
          `Уточняем атрибут «${chosen.attributeKey}» для размещения «${chosen.offerFormat}» (цена уже известна).`,
      };
    }

    // Still collecting a coarse target. Force `next_data_point` to a genuinely-
    // missing point: honour the LLM's pick if it is one, otherwise pick first.
    const llmPick =
      typeof out.next_data_point === 'string' && missing.includes(out.next_data_point)
        ? out.next_data_point
        : undefined;
    const nextPoint = llmPick ?? missing[0]!;

    // When we OVERRODE the model's pick (it chose a collected/wrong field),
    // its `reply` likely asks about that wrong point — so substitute a
    // deterministic question for the corrected field. When we honoured the
    // model's pick, keep its (richer) natural phrasing.
    const reply = llmPick === undefined ? questionFor(nextPoint) : out.reply;

    return {
      next_data_point: nextPoint,
      // Mirror the chosen point so downstream (worker → Suggestion.meta.targetField)
      // can tag the HUD without re-deriving from `next_data_point`.
      target_field: nextPoint,
      reply,
      goal_satisfied: false,
      rationale: out.rationale,
    };
  },
};
