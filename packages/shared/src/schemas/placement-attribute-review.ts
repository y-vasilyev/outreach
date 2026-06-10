import { z } from 'zod';

import {
  PlacementAttributeTypeZ,
  type PlacementAttributeRegistryEntry,
} from './placement-offer.js';
import {
  mergeRegistry,
  PLACEMENT_ATTRIBUTE_REGISTRY_V1,
} from '../placement-offers.js';

/**
 * Placement-attribute operator/admin review surface (entity-style-rate-cards,
 * Section 4.3).
 *
 * Extraction (Section 2) writes `placement_attribute` rows with
 * `status='proposed'` for commercially relevant terms the active registry does
 * not yet cover. An operator/admin reviews them: APPROVE flips the row to
 * `status='active'` (so it joins the active registry via `loadActiveRegistry`),
 * REJECT flips it to `status='rejected'`. Nothing here is contact-facing.
 *
 * These are the API response/request schemas + the active-registry loader. The
 * underlying attribute/offer schemas live in `placement-offer.ts`; this file
 * only composes them for the review path (it does not edit them).
 */

/** Lifecycle of a `placement_attribute` row (DB `status` column). */
export const PlacementAttributeStatusZ = z.enum(['active', 'proposed', 'rejected', 'superseded']);
export type PlacementAttributeStatus = z.infer<typeof PlacementAttributeStatusZ>;

/**
 * One reviewable attribute proposal as returned by the API. Mirrors the
 * `placement_attribute` row, with Decimal/Date normalised to JSON-safe types at
 * the boundary (confidence → number, timestamps → ISO strings).
 */
export const PlacementAttributeReviewItemZ = z.object({
  id: z.string(),
  key: z.string().min(1),
  valueType: PlacementAttributeTypeZ,
  description: z.string().default(''),
  applicableKinds: z.array(z.string()).default([]),
  enumValues: z.array(z.string()).default([]),
  requiredForKinds: z.array(z.string()).default([]),
  status: PlacementAttributeStatusZ,
  evidence: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0),
  rationale: z.string().default(''),
  sourceMessageId: z.string().nullable().default(null),
  proposedByRunId: z.string().nullable().default(null),
  reviewedById: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PlacementAttributeReviewItem = z.infer<typeof PlacementAttributeReviewItemZ>;

export const PlacementAttributeReviewListZ = z.object({
  items: z.array(PlacementAttributeReviewItemZ),
  total: z.number().int().nonnegative(),
});
export type PlacementAttributeReviewList = z.infer<typeof PlacementAttributeReviewListZ>;

/** Review decision body for `POST /placement-attributes/:id/review`. */
export const PlacementAttributeReviewDecisionZ = z.object({
  decision: z.enum(['approve', 'reject']),
});
export type PlacementAttributeReviewDecision = z.infer<
  typeof PlacementAttributeReviewDecisionZ
>;

/**
 * The shape of a persisted `placement_attribute` row the loader needs. Kept
 * structural (not a Prisma import) so the pure shared layer stays IO-free —
 * the service passes the rows it reads from Prisma.
 */
export interface PlacementAttributeRow {
  key: string;
  valueType: string;
  description?: string | null;
  applicableKinds?: string[] | null;
  enumValues?: string[] | null;
  requiredForKinds?: string[] | null;
  status: string;
}

const VALUE_TYPES = new Set(['string', 'number', 'boolean', 'enum', 'string_list']);

/**
 * Build the ACTIVE placement-attribute registry: the v1 constant merged with
 * the DB's `status='active'` rows (operator-approved proposals win on key
 * collision via `mergeRegistry`). Rows that are not active, or whose
 * `valueType` is not a known attribute type, are ignored.
 *
 * This is the single merge used by both the planner-input builder (worker) and
 * the review service so approving a proposal really does extend the registry
 * the next extraction/validation sees.
 */
export function loadActiveRegistry(
  rows: ReadonlyArray<PlacementAttributeRow>,
): PlacementAttributeRegistryEntry[] {
  const overrides: PlacementAttributeRegistryEntry[] = [];
  for (const row of rows) {
    if (row.status !== 'active') continue;
    if (!VALUE_TYPES.has(row.valueType)) continue;
    overrides.push({
      key: row.key,
      valueType: row.valueType as PlacementAttributeRegistryEntry['valueType'],
      description: row.description?.trim() || row.key,
      applicableKinds: row.applicableKinds ?? [],
      ...(row.enumValues && row.enumValues.length > 0 ? { enumValues: row.enumValues } : {}),
      requiredForKinds: row.requiredForKinds ?? [],
      active: true,
    });
  }
  return mergeRegistry(PLACEMENT_ATTRIBUTE_REGISTRY_V1, overrides);
}

/**
 * Required attribute keys derived from the active registry — the keys the
 * planner should chase across all kinds. (The planner additionally narrows by
 * each offer's `kind` via `missingRequiredAttributes`; this is the union it
 * passes as `required_attribute_keys`.)
 */
export function activeRequiredAttributeKeys(
  registry: ReadonlyArray<PlacementAttributeRegistryEntry>,
): string[] {
  const keys = new Set<string>();
  for (const e of registry) {
    if (e.active && e.requiredForKinds.length > 0) keys.add(e.key);
  }
  return [...keys];
}
