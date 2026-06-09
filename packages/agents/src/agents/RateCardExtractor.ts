import { z } from 'zod';
import {
  extractPlacementOffersFromText,
  extractRateCardDataPointsFromText,
  normalizePriceToken,
  PLACEMENT_ATTRIBUTE_REGISTRY_V1,
  PlacementAttributeProposalDraftZ,
  PlacementOfferDraftZ,
  ProfileDataPointDraftZ,
  ProfileExtractionOutputZ,
  validateOfferAttributes,
  type PlacementAttributeProposalDraft,
  type PlacementOfferDraft,
} from '@nosquare/shared';

import type { Agent } from '../types.js';
import { invokeJson } from './_runtime.js';

/**
 * RateCardExtractor — `rate_card_extractor`
 *
 * Reads a blogger's free-text reply(s) (and an optional structured snapshot)
 * and emits per-format rate data points as `ProfileDataPointDraft`s
 * (agency-sourcing-matching M5, task 5.1). Each draft:
 *   - `field`  — `rate.<format>` (e.g. `rate.post`, `rate.story`, `rate.reels`)
 *   - `value`  — numeric price
 *   - `unit`   — currency (RUB/USD/…)
 *   - `confidence` — 0..1
 *   - `rawSnippet` — VERBATIM source fragment the price came from
 *
 * MUST (spec):
 *   - preserve the verbatim source text in `rawSnippet` (provenance + audit);
 *   - emit low-confidence/ambiguous facts (with a low confidence) rather than
 *     dropping them, so an operator can review.
 *
 * Runs via AgentRunner (writes `agent_run`). The worker persists the drafts as
 * `profile_data_point` rows linked to the channel's BloggerProfile.
 */

export const rateCardExtractorInputSchema = z.object({
  /** The blogger's free-text reply(s), most recent last, joined or as lines. */
  replies: z.array(z.string()).default([]),
  /** Convenience single-string form (latest reply); used when replies empty. */
  last_inbound: z.string().default(''),
  /** Optional structured snapshot (e.g. a parsed media-kit blob). */
  structured_snapshot: z.record(z.unknown()).optional(),
  /** Light context so the model can disambiguate currency/format. */
  channel_title: z.string().default(''),
  language: z.string().default('ru'),
  /**
   * Operator hints (operator-reanalyze-and-markup): advisory parsing rules the
   * operator added for this channel/conversation. Rendered into a fenced block;
   * they steer interpretation but never license inventing facts.
   */
  operator_hints: z.array(z.string()).optional(),
});

export const rateCardExtractorOutputSchema = ProfileExtractionOutputZ;

export type RateCardExtractorInput = z.infer<typeof rateCardExtractorInputSchema>;
export type RateCardExtractorOutput = z.infer<typeof rateCardExtractorOutputSchema>;

const FALLBACK_SYSTEM = `Ты извлекаешь ПРАЙС за рекламные размещения из ответов блогера. На вход — свободный текст (и иногда структурированный снимок). Размещение — это коммерческий объект (пост на сутки, пост на месяц, выездной обзор без удаления, интеграция), а не просто цена. Возвращай ДВА представления одновременно.

1) placement_offers — массив структурированных размещений. Каждое:
- kind — тип: post, story, reels, shorts, video, integration, offsite_review, package, other.
- platform — площадка: telegram, youtube, instagram, vk, tiktok (или null, если не указана).
- price — ЧИСЛО (цена), без валюты и пробелов. "47 000" → 47000, "15к"/"15k" → 15000, "1.2к" → 1200. null, если цена не указана.
- currency — "RUB" (руб/₽/р по умолчанию для русского), "USD" ($), "EUR" (€).
- attributes — массив типизированных атрибутов { key, value, confidence, rawSnippet }. Допустимые key из активного реестра: duration (enum day/week/month/permanent — "сутки"→day, "месяц"→month), delete_policy (enum deleted/permanent — "без удаления"→permanent), includes (список строк — "входит ...", "+ доп пост"), tax (строка — НАЛОГ как атрибут, напр. "налог 6%"; можно НЕСКОЛЬКО tax если налогов несколько; НИКОГДА не делай налог отдельным размещением или ценой), notes (строка — прочие условия), tariff_name (строка — название тарифа: "Основной", "Продвинутый"), slot (строка — слот/позиция: "1", "2"), price_period (enum base/seasonal/promo — обычная цена→base, "цена июня"/сезон→seasonal, акция→promo), prepayment (строка — "100%", "50/50"), tax_regime (enum ip/self_employed/ooo/none — "ИП"→ip, "самозанятый"→self_employed), tax_included (boolean — "налог включён"→true), top_pin_hours (число — часы в топе: 24, 72), package_items (список строк — состав пакета; пакет это kind=package с ценой пакета в price).
- confidence — 0..1. Явное размещение с ценой → 0.9+. Неясный формат → 0.4–0.6. Пакет/двусмысленно → kind='package' или 'other' с НИЗКИМ confidence (≤0.5), но ВСЁ РАВНО верни (не выбрасывай).
- rawSnippet — ДОСЛОВНЫЙ фрагмент-источник (verbatim, не перефразируй).

2) attribute_proposals — если в тексте есть коммерчески значимое условие, которого НЕТ в активном реестре атрибутов (duration, delete_policy, includes, tax, notes, platform, kind, price, currency), НЕ добавляй его как attribute, а предложи: { suggestedKey, suggestedType (string/number/boolean/enum/string_list), applicableKinds, enumValues?, evidence: [verbatim], confidence, rationale }.

3) data_points — ЛЕГАСИ-представление (нужно во время раскатки): то же самое как "rate.<формат>" латиницей (rate.post, rate.story, rate.reels, rate.video, rate.integration; иначе rate.other), value — ЧИСЛО, unit — валюта, confidence, rawSnippet verbatim. Верни data_points ПАРАЛЛЕЛЬНО с placement_offers.

ПРАВИЛА:
- Не выдумывай цены/условия, которых нет в тексте.
- Несколько размещений с ценами — верни по объекту на каждое. "пост на сутки" и "пост на месяц" — это ДВА РАЗНЫХ размещения (разный duration), не объединяй.
- Налог — это attribute tax на размещении, а не отдельное размещение/цена.
- Если прайса нет вообще — верни пустые массивы и заполни note.

Возвращай только JSON: { data_points: [...], placement_offers: [...], attribute_proposals: [...], note? }.`;

const FALLBACK_USER = `Канал: {{channel_title}} (язык: {{language}})

Ответы блогера (самый свежий — последний):
{{replies_text}}

Структурированный снимок (если есть):
{{structured_snapshot}}
{{operator_hints_block}}
Верни JSON: data_points (легаси), placement_offers (структурированные размещения), attribute_proposals (новые атрибуты вне реестра). Сохрани verbatim rawSnippet.`;

/**
 * Render operator hints into a fenced advisory block, or '' when none. Hints
 * are interpretation rules — NEVER a source of facts (operator-reanalyze-and-
 * markup safety: do not invent prices/reach absent from the source text).
 */
function operatorHintsBlock(hints: string[]): string {
  if (!hints || hints.length === 0) return '';
  const lines = hints.map((h) => `- ${h}`).join('\n');
  return `\nПОДСКАЗКИ ОПЕРАТОРА (advisory — правила интерпретации, НЕ источник фактов; не выдумывай цены/охваты, которых нет в тексте):\n${lines}\n`;
}

export const rateCardExtractor: Agent<RateCardExtractorInput, RateCardExtractorOutput> = {
  name: 'rate_card_extractor',
  description:
    'Извлекает из ответов блогера прайс по форматам как profile_data_point (rate.<format>) с confidence и verbatim rawSnippet.',
  inputSchema: rateCardExtractorInputSchema,
  outputSchema: rateCardExtractorOutputSchema,
  variables: ['channel_title', 'language', 'replies_text', 'structured_snapshot', 'operator_hints_block'],
  defaultModel: 'google/gemini-3-flash-preview',
  // 2200 mirrors the seed (v6): three representations + verbatim snippets
  // overrun a smaller budget for multi-format rate cards, truncating the JSON.
  defaultParams: { temperature: 0.1, max_tokens: 2200 },
  async run(input, ctx) {
    const replies = input.replies.length > 0
      ? input.replies
      : input.last_inbound
        ? [input.last_inbound]
        : [];
    const repliesText = replies.map((r, i) => `${i + 1}. ${r}`).join('\n');

    const out = await invokeJson({
      ctx,
      vars: {
        channel_title: input.channel_title,
        language: input.language,
        replies_text: repliesText || '(пусто)',
        structured_snapshot: input.structured_snapshot ?? {},
        operator_hints_block: operatorHintsBlock(input.operator_hints ?? []),
      },
      outputSchema: rateCardExtractorOutputSchema,
      fallbackSystemPrompt: FALLBACK_SYSTEM,
      fallbackUserPromptTemplate: FALLBACK_USER,
      tolerantArrayFields: {
        data_points: ProfileDataPointDraftZ,
        placement_offers: PlacementOfferDraftZ,
        attribute_proposals: PlacementAttributeProposalDraftZ,
      },
    });

    // Deterministic guards (harden-agency-sourcing-pipeline):
    // 1. Field MUST match `rate.<format>` where format is a plain
    //    `[a-z][a-z0-9_]*` token. The previous implementation blindly
    //    prepended `rate.` to anything (so `reach.story` accidentally
    //    becomes `rate.reach.story` and the roll-up reads it as a "format"
    //    with no price). Now:
    //      - bare `post` + numeric value → `rate.post`
    //      - `rate.post` → kept
    //      - `rate.reach.story` (multi-dot) → bucketed to `rate.other`
    //      - `reach.story` (other category) → DROPPED (it's not our scope)
    // 2. Preserve verbatim rawSnippet, backfilling from source text only
    //    when the model omitted it (provenance never lost).
    // 3. Keep low-confidence points (the spec wants the operator to see
    //    ambiguous facts; never threshold-drop here).
    const RATE_FORMAT_RE = /^rate\.[a-z][a-z0-9_]*$/;
    const PLAIN_FORMAT_RE = /^[a-z][a-z0-9_]*$/;
    const isNumeric = (v: unknown): boolean => {
      if (typeof v === 'number') return Number.isFinite(v);
      if (typeof v === 'string') return Number.isFinite(Number(v.replace(/[\s,]/g, '')));
      return false;
    };
    const sourceText = replies.join('\n');
    const data_points: typeof out.data_points = [];
    for (const dp of out.data_points) {
      const f = (dp.field ?? '').trim().toLowerCase();
      // Legacy price coercion: a `rate.*` value the model emitted as a Russian
      // price string ("50к", "1.2млн", "от 118000") would otherwise be dropped
      // by the numeric guard. Normalize it to a number through the shared
      // helper so the legacy compatibility stream coerces identically to the
      // structured offers (harden-reply-extraction D2). Non-coercible strings
      // keep their original value.
      const coerced =
        typeof dp.value === 'string' ? normalizePriceToken(dp.value) : null;
      const value = coerced !== null ? coerced : dp.value;
      let normalized: string | null = null;
      if (RATE_FORMAT_RE.test(f)) {
        normalized = f;
      } else if (PLAIN_FORMAT_RE.test(f) && isNumeric(value)) {
        normalized = `rate.${f}`;
      } else if (f.startsWith('rate.') && isNumeric(value)) {
        // multi-segment like `rate.zoom.lecture` or `rate.reach.story` —
        // we have a price, just don't know the canonical format. Bucket.
        normalized = 'rate.other';
      } else {
        // Not a rate field and not a numeric price — drop. Audience/reach
        // belongs to AudienceStatsExtractor.
        continue;
      }
      data_points.push({
        ...dp,
        field: normalized,
        value,
        rawSnippet:
          dp.rawSnippet && dp.rawSnippet.trim().length > 0 ? dp.rawSnippet : sourceText,
      });
    }

    // Structured multi-platform quotes often have explicit platform headers:
    // "Telegram — <url>" followed by "Фотопост — 47 000". If the LLM emits
    // generic `rate.post` / `rate.video` rows, the catalog loses the platform
    // context even though it is deterministic in the source text. Recover those
    // rows locally and let them supersede generic rows with the same price or
    // snippet.
    // Structured placement offers (entity-style-rate-cards). Build deterministic
    // offers from the source text and MERGE them with the LLM's
    // `placement_offers`: deterministic specific offers supersede generic LLM
    // ones with the same platform+kind+duration+price+snippet. Then validate
    // every offer's attributes against the active registry — unknown keys are
    // moved into `attribute_proposals` rather than kept as active attributes.
    const placementResult = mergePlacementOffers(
      out.placement_offers,
      extractPlacementOffersFromText(sourceText),
    );
    const attributeProposals = collectAttributeProposals(
      out.attribute_proposals,
      placementResult.unknownAttributes,
    );
    const placementOut = {
      placement_offers: placementResult.offers,
      attribute_proposals: attributeProposals,
    };

    const deterministic = extractRateCardDataPointsFromText(sourceText);
    if (deterministic.length === 0) {
      return {
        data_points,
        ...placementOut,
        ...(out.note !== undefined ? { note: out.note } : {}),
      };
    }

    const deterministicPrices = new Set(deterministic.map((dp) => String(dp.value)));
    const deterministicSnippets = new Set(
      deterministic.map((dp) => dp.rawSnippet.trim().toLowerCase()).filter(Boolean),
    );
    const deterministicFieldPrices = new Set(
      deterministic.map((dp) => `${dp.field}:${String(dp.value)}`),
    );
    const genericRateFields = new Set([
      'rate.integration',
      'rate.other',
      'rate.post',
      'rate.reels',
      'rate.shorts',
      'rate.story',
      'rate.video',
    ]);
    const remainingModelPoints = data_points.filter((dp) => {
      const snippet = dp.rawSnippet.trim().toLowerCase();
      if (snippet && deterministicSnippets.has(snippet)) return false;
      if (deterministicFieldPrices.has(`${dp.field}:${String(dp.value)}`)) return false;
      if (genericRateFields.has(dp.field) && deterministicPrices.has(String(dp.value))) return false;
      return true;
    });

    return {
      data_points: [...deterministic, ...remainingModelPoints],
      ...placementOut,
      ...(out.note !== undefined ? { note: out.note } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// Placement-offer post-processing helpers (entity-style-rate-cards 2.2).
// ---------------------------------------------------------------------------

const PLACEMENT_DEDUPE = (offer: PlacementOfferDraft): string => {
  const duration = offer.attributes.find((a) => a.key === 'duration')?.value ?? '';
  const tariff = offer.attributes.find((a) => a.key === 'tariff_name')?.value ?? '';
  const slot = offer.attributes.find((a) => a.key === 'slot')?.value ?? '';
  return `${(offer.platform ?? '').toLowerCase()}:${offer.kind.toLowerCase()}:${String(
    duration,
  ).toLowerCase()}:${String(tariff).toLowerCase()}:${String(slot).toLowerCase()}:${
    offer.price ?? ''
  }:${offer.rawSnippet.trim().toLowerCase()}`;
};

/**
 * Merge LLM-emitted placement offers with deterministic ones. Deterministic
 * offers (parsed from the verbatim source text) supersede LLM ones with the
 * same platform+kind+duration+price+rawSnippet key, or a generic LLM offer
 * (kind other/package, or no platform) that a specific deterministic offer
 * covers by price. Every offer's attributes are validated against the active
 * registry; unknown keys are stripped from the offer and surfaced for proposal.
 */
function mergePlacementOffers(
  llmOffers: PlacementOfferDraft[],
  deterministicOffers: PlacementOfferDraft[],
): { offers: PlacementOfferDraft[]; unknownAttributes: PlacementOfferDraft['attributes'] } {
  const detKeys = new Set(deterministicOffers.map(PLACEMENT_DEDUPE));
  const detPrices = new Set(
    deterministicOffers
      .filter((o) => typeof o.price === 'number')
      .map((o) => String(o.price)),
  );
  const detSnippets = new Set(
    deterministicOffers.map((o) => o.rawSnippet.trim().toLowerCase()).filter(Boolean),
  );

  const remainingLlm = llmOffers.filter((o) => {
    if (detKeys.has(PLACEMENT_DEDUPE(o))) return false;
    const snippet = o.rawSnippet.trim().toLowerCase();
    if (snippet && detSnippets.has(snippet)) return false;
    // Generic LLM offer the deterministic pass already covered by price.
    const generic = o.kind === 'other' || o.kind === 'package' || !o.platform;
    if (generic && typeof o.price === 'number' && detPrices.has(String(o.price))) return false;
    return true;
  });

  // Deterministic offers first (they are the more specific/structured rows).
  const merged = [...deterministicOffers, ...remainingLlm];

  const unknownAttributes: PlacementOfferDraft['attributes'] = [];
  const validatedOffers = merged.map((offer) => {
    const v = validateOfferAttributes(offer, PLACEMENT_ATTRIBUTE_REGISTRY_V1);
    unknownAttributes.push(...v.unknown);
    // Keep only valid (active, applicable, well-typed) attributes on the offer.
    return { ...offer, attributes: v.valid };
  });

  return { offers: validatedOffers, unknownAttributes };
}

/**
 * Build the final `attribute_proposals` list: the LLM's proposals plus
 * synthesized proposals for any unknown attribute keys that leaked onto offers.
 * Deduped by suggestedKey (case-insensitive).
 */
function collectAttributeProposals(
  llmProposals: PlacementAttributeProposalDraft[],
  unknownAttributes: PlacementOfferDraft['attributes'],
): PlacementAttributeProposalDraft[] {
  const byKey = new Map<string, PlacementAttributeProposalDraft>();
  for (const p of llmProposals) {
    byKey.set(p.suggestedKey.trim().toLowerCase(), p);
  }
  for (const attr of unknownAttributes) {
    const key = attr.key.trim().toLowerCase();
    if (!key || byKey.has(key)) continue;
    const suggestedType: PlacementAttributeProposalDraft['suggestedType'] = Array.isArray(
      attr.value,
    )
      ? 'string_list'
      : typeof attr.value === 'number'
        ? 'number'
        : typeof attr.value === 'boolean'
          ? 'boolean'
          : 'string';
    byKey.set(key, {
      suggestedKey: attr.key,
      suggestedType,
      applicableKinds: [],
      evidence: attr.rawSnippet ? [attr.rawSnippet] : [],
      confidence: attr.confidence,
      rationale: 'Attribute key not in active placement registry; routed to review.',
    });
  }
  return [...byKey.values()];
}
