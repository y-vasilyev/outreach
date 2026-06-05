import { getPrisma } from '@nosquare/db';
import {
  Errors,
  loadActiveRegistry,
  type PlacementAttributeRegistryEntry,
  type PlacementAttributeReviewItem,
  type PlacementAttributeReviewList,
} from '@nosquare/shared';

/**
 * Placement-attribute proposal review service (entity-style-rate-cards,
 * Section 4.3).
 *
 * Extraction writes `placement_attribute` rows with `status='proposed'` for
 * commercially relevant terms the active registry does not cover. An operator/
 * admin reviews them here:
 *   - APPROVE → `status='active'` (joins the active registry; the planner +
 *     extraction then treat the key as a known, validated attribute), stamps
 *     `reviewedById`.
 *   - REJECT → `status='rejected'`, stamps `reviewedById`.
 *
 * Approval is what makes `loadActiveRegistry` include the row — see
 * `buildPlannerPlacementInputs` in the worker, which loads `status='active'`
 * rows on every planner tick. Nothing here is contact-facing.
 */

type PlacementAttributeDbRow = {
  id: string;
  key: string;
  valueType: string;
  description: string;
  applicableKinds: string[];
  enumValues: string[];
  requiredForKinds: string[];
  status: string;
  evidence: unknown;
  confidence: { toString(): string } | number | null;
  rationale: string;
  sourceMessageId: string | null;
  proposedByRunId: string | null;
  reviewedById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const VALUE_TYPES = new Set(['string', 'number', 'boolean', 'enum', 'string_list']);

function readEvidence(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

function serialize(row: PlacementAttributeDbRow): PlacementAttributeReviewItem {
  // `valueType` / `status` are free strings in the DB; clamp them to the known
  // unions at the read boundary so the response schema stays honest.
  const valueType = VALUE_TYPES.has(row.valueType) ? row.valueType : 'string';
  const status =
    row.status === 'active' || row.status === 'proposed' || row.status === 'rejected'
      ? row.status
      : 'proposed';
  return {
    id: row.id,
    key: row.key,
    valueType: valueType as PlacementAttributeReviewItem['valueType'],
    description: row.description ?? '',
    applicableKinds: row.applicableKinds ?? [],
    enumValues: row.enumValues ?? [],
    requiredForKinds: row.requiredForKinds ?? [],
    status,
    evidence: readEvidence(row.evidence),
    confidence: row.confidence == null ? 0 : Number(row.confidence),
    rationale: row.rationale ?? '',
    sourceMessageId: row.sourceMessageId ?? null,
    proposedByRunId: row.proposedByRunId ?? null,
    reviewedById: row.reviewedById ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const SELECT = {
  id: true,
  key: true,
  valueType: true,
  description: true,
  applicableKinds: true,
  enumValues: true,
  requiredForKinds: true,
  status: true,
  evidence: true,
  confidence: true,
  rationale: true,
  sourceMessageId: true,
  proposedByRunId: true,
  reviewedById: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const placementAttributesService = {
  /** List proposals awaiting review (`status='proposed'`), newest first. */
  async listProposals(): Promise<PlacementAttributeReviewList> {
    const prisma = getPrisma();
    const rows = (await prisma.placementAttribute.findMany({
      where: { status: 'proposed' },
      orderBy: { createdAt: 'desc' },
      select: SELECT,
    })) as PlacementAttributeDbRow[];
    return { items: rows.map(serialize), total: rows.length };
  },

  /**
   * Approve a proposal: flip it to `status='active'` and stamp the reviewer.
   * Only a `proposed` row can be approved (idempotency / safety) — anything
   * else is a 409. Returns the updated, serialized item.
   */
  async approve(id: string, reviewerId: string): Promise<PlacementAttributeReviewItem> {
    return this.review(id, reviewerId, 'active');
  },

  /** Reject a proposal: flip it to `status='rejected'` and stamp the reviewer. */
  async reject(id: string, reviewerId: string): Promise<PlacementAttributeReviewItem> {
    return this.review(id, reviewerId, 'rejected');
  },

  async review(
    id: string,
    reviewerId: string,
    nextStatus: 'active' | 'rejected',
  ): Promise<PlacementAttributeReviewItem> {
    const prisma = getPrisma();
    const existing = (await prisma.placementAttribute.findUnique({
      where: { id },
      select: SELECT,
    })) as PlacementAttributeDbRow | null;
    if (!existing) throw Errors.notFound('placement_attribute', id);
    if (existing.status !== 'proposed') {
      throw Errors.conflict(
        `placement_attribute ${id} is '${existing.status}', only 'proposed' can be reviewed`,
      );
    }
    const updated = (await prisma.placementAttribute.update({
      where: { id },
      data: { status: nextStatus, reviewedById: reviewerId },
      select: SELECT,
    })) as PlacementAttributeDbRow;
    return serialize(updated);
  },

  /**
   * The active registry as the planner/extraction see it: v1 constant merged
   * with the DB's `status='active'` rows. Exposed for admin inspection /
   * downstream reuse (same merge `buildPlannerPlacementInputs` uses).
   */
  async activeRegistry(): Promise<PlacementAttributeRegistryEntry[]> {
    const prisma = getPrisma();
    const rows = await prisma.placementAttribute.findMany({
      where: { status: 'active' },
      select: {
        key: true,
        valueType: true,
        description: true,
        applicableKinds: true,
        enumValues: true,
        requiredForKinds: true,
        status: true,
      },
    });
    return loadActiveRegistry(rows);
  },
};
