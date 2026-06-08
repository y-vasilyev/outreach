import { z } from 'zod';
import { normalizePriceToken } from '../price.js';
import { PlacementOfferDraftZ } from './placement-offer.js';

/**
 * Operator re-analysis + markup schemas (operator-reanalyze-and-markup).
 */

/** Re-run extraction for one message; supersede defaults true (the point of it). */
export const ReanalyzeRequestZ = z.object({
  supersede: z.boolean().default(true),
});
export type ReanalyzeRequest = z.infer<typeof ReanalyzeRequestZ>;

// Fields an operator may write, with the value shape the roll-up actually
// consumes. Anything else is rejected so an operator can't write a value the
// roll-up would silently drop (codex review).
const NUMERIC_FIELD_RE =
  /^(reach|avg_views|views\.avg|rate\.[a-z0-9_]+|audience\.subscribers\.[a-z0-9_]+)$/;
const SHARE_FIELD_RE = /^audience\.(geo|age|gender)$/;

/** True when `field` is operator-editable. */
export function isOperatorEditableField(field: string): boolean {
  const f = field.trim();
  return NUMERIC_FIELD_RE.test(f) || SHARE_FIELD_RE.test(f) || f === 'placement.offer';
}

/**
 * Coerce an operator-written value into the shape the roll-up consumes, or
 * return `undefined` when it is invalid for the field. Numeric fields accept a
 * number or a price-like string ("50к"); `placement.offer` a validated offer;
 * `audience.*` a label→number record.
 */
export function coerceOperatorValue(field: string, value: unknown): unknown | undefined {
  const f = field.trim();
  if (NUMERIC_FIELD_RE.test(f)) {
    const n =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? normalizePriceToken(value)
          : null;
    return n !== null && Number.isFinite(n) ? n : undefined;
  }
  if (f === 'placement.offer') {
    const parsed = PlacementOfferDraftZ.safeParse(value);
    return parsed.success ? parsed.data : undefined;
  }
  if (SHARE_FIELD_RE.test(f)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const rec = value as Record<string, unknown>;
    const ok = Object.values(rec).every((x) => typeof x === 'number' && Number.isFinite(x));
    return ok && Object.keys(rec).length > 0 ? rec : undefined;
  }
  return undefined;
}

export const OperatorDataPointWriteZ = z
  .object({
    field: z.string().min(1),
    value: z.unknown(),
    unit: z.string().optional(),
  })
  .superRefine((v, ctx) => {
    if (!isOperatorEditableField(v.field)) {
      ctx.addIssue({ code: 'custom', message: `field "${v.field}" is not operator-editable` });
      return;
    }
    if (coerceOperatorValue(v.field, v.value) === undefined) {
      ctx.addIssue({ code: 'custom', message: `value is invalid for field "${v.field}"` });
    }
  });
export type OperatorDataPointWrite = z.infer<typeof OperatorDataPointWriteZ>;

export const ExtractionHintScopeZ = z.enum(['global', 'channel', 'conversation']);
export type ExtractionHintScope = z.infer<typeof ExtractionHintScopeZ>;

const HINT_MAX = 500;

export const ExtractionHintInputZ = z
  .object({
    scope: ExtractionHintScopeZ,
    channelId: z.string().nullable().optional(),
    conversationId: z.string().nullable().optional(),
    targetField: z.string().nullable().optional(),
    guidance: z.string().min(1).max(HINT_MAX),
    exampleInput: z.string().max(HINT_MAX).nullable().optional(),
    exampleOutput: z.string().max(HINT_MAX).nullable().optional(),
    active: z.boolean().default(true),
  })
  .superRefine((v, ctx) => {
    if (v.scope === 'channel' && !v.channelId) {
      ctx.addIssue({ code: 'custom', message: 'channel-scoped hint requires channelId' });
    }
    if (v.scope === 'conversation' && !v.conversationId) {
      ctx.addIssue({ code: 'custom', message: 'conversation-scoped hint requires conversationId' });
    }
  });
export type ExtractionHintInput = z.infer<typeof ExtractionHintInputZ>;

/** Partial patch for updating a hint (no cross-field refine — fields independent). */
export const ExtractionHintPatchZ = z.object({
  scope: ExtractionHintScopeZ.optional(),
  channelId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  targetField: z.string().nullable().optional(),
  guidance: z.string().min(1).max(HINT_MAX).optional(),
  exampleInput: z.string().max(HINT_MAX).nullable().optional(),
  exampleOutput: z.string().max(HINT_MAX).nullable().optional(),
  active: z.boolean().optional(),
});
export type ExtractionHintPatch = z.infer<typeof ExtractionHintPatchZ>;

export const ExtractionHintZ = z.object({
  id: z.string(),
  scope: ExtractionHintScopeZ,
  channelId: z.string().nullable(),
  conversationId: z.string().nullable(),
  targetField: z.string().nullable(),
  guidance: z.string(),
  exampleInput: z.string().nullable(),
  exampleOutput: z.string().nullable(),
  active: z.boolean(),
  createdById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExtractionHint = z.infer<typeof ExtractionHintZ>;

/** Max hints + length passed into a single extraction (safety/prompt budget). */
export const EXTRACTION_HINT_LIMIT = 10;
export const EXTRACTION_HINT_MAX_CHARS = HINT_MAX;

/** Render persisted hints into the compact `operator_hints: string[]` agents read. */
export function hintsToOperatorStrings(
  hints: Array<Pick<ExtractionHint, 'guidance' | 'exampleInput' | 'exampleOutput' | 'targetField'>>,
): string[] {
  return hints.slice(0, EXTRACTION_HINT_LIMIT).map((h) => {
    let s = h.targetField ? `[${h.targetField}] ${h.guidance}` : h.guidance;
    if (h.exampleInput && h.exampleOutput) {
      s += ` (пример: «${h.exampleInput}» → ${h.exampleOutput})`;
    }
    return s.slice(0, EXTRACTION_HINT_MAX_CHARS);
  });
}
