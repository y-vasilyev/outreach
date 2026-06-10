import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isAppError } from '@nosquare/shared/errors';
import {
  loadActiveRegistry,
  validateOfferAttributes,
  missingRequiredAttributes,
  type PlacementOfferDraft,
} from '@nosquare/shared';

/**
 * Placement-attribute review service (entity-style-rate-cards, Section 4.3/4.4).
 * Approving a `proposed` row flips it to `active` (and stamps the reviewer), at
 * which point it joins the active registry via `loadActiveRegistry`. Rejecting
 * flips to `rejected`. Pure-mock test: only the service decision logic + the
 * registry consequence are exercised here.
 */

const mocks = vi.hoisted(() => {
  const prisma = {
    placementAttribute: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  return { prisma };
});

vi.mock('@nosquare/db', () => ({ getPrisma: () => mocks.prisma }));

import { placementAttributesService } from '../placement-attributes.js';

const REVIEWER = 'usr_admin';
const NOW = new Date('2026-06-05T12:00:00.000Z');

function proposalRow(over: Record<string, unknown> = {}) {
  return {
    id: 'pa_1',
    key: 'exclusivity',
    valueType: 'boolean',
    description: 'Эксклюзивность размещения',
    applicableKinds: ['post'],
    enumValues: [],
    requiredForKinds: ['post'],
    status: 'proposed',
    evidence: ['только у нас, эксклюзив'],
    confidence: 0.7,
    rationale: 'blogger mentioned exclusivity',
    sourceMessageId: 'msg_1',
    proposedByRunId: 'run_1',
    reviewedById: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('placementAttributesService.review', () => {
  it('approve flips proposed → active and stamps the reviewer', async () => {
    mocks.prisma.placementAttribute.findUnique.mockResolvedValueOnce(proposalRow());
    mocks.prisma.placementAttribute.update.mockResolvedValueOnce(
      proposalRow({ status: 'active', reviewedById: REVIEWER }),
    );

    const out = await placementAttributesService.approve('pa_1', REVIEWER);

    expect(out.status).toBe('active');
    expect(out.reviewedById).toBe(REVIEWER);
    expect(mocks.prisma.placementAttribute.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pa_1' },
        data: { status: 'active', reviewedById: REVIEWER },
      }),
    );
  });

  it('reject flips proposed → rejected', async () => {
    mocks.prisma.placementAttribute.findUnique.mockResolvedValueOnce(proposalRow());
    mocks.prisma.placementAttribute.update.mockResolvedValueOnce(
      proposalRow({ status: 'rejected', reviewedById: REVIEWER }),
    );
    const out = await placementAttributesService.reject('pa_1', REVIEWER);
    expect(out.status).toBe('rejected');
  });

  it('404 when the proposal does not exist', async () => {
    mocks.prisma.placementAttribute.findUnique.mockResolvedValueOnce(null);
    await expect(placementAttributesService.approve('missing', REVIEWER)).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.code === 'NOT_FOUND',
    );
  });

  it('409 when reviewing an already-decided proposal', async () => {
    mocks.prisma.placementAttribute.findUnique.mockResolvedValueOnce(
      proposalRow({ status: 'active' }),
    );
    await expect(placementAttributesService.approve('pa_1', REVIEWER)).rejects.toSatisfy(
      (e: unknown) => isAppError(e) && e.statusCode === 409,
    );
    expect(mocks.prisma.placementAttribute.update).not.toHaveBeenCalled();
  });
});

describe('approved attribute joins the active registry', () => {
  it('after approval, the key is required + accepted by validation', async () => {
    // Simulate the post-approval DB state: the row is now `active` and required
    // for post. The active-registry loader must surface it.
    mocks.prisma.placementAttribute.findMany.mockResolvedValueOnce([
      {
        key: 'exclusivity',
        valueType: 'boolean',
        description: 'Эксклюзивность размещения',
        applicableKinds: ['post'],
        enumValues: [],
        requiredForKinds: ['post'],
        status: 'active',
      },
    ]);

    const registry = await placementAttributesService.activeRegistry();
    expect(registry.some((e) => e.key === 'exclusivity')).toBe(true);

    const offerMissing: PlacementOfferDraft = {
      kind: 'post',
      platform: 'telegram',
      price: 15000,
      currency: 'RUB',
      rawPrice: '',
      confidence: 0.9,
      rawSnippet: 'пост 15000',
      attributes: [
        { key: 'delete_policy', value: 'permanent', confidence: 1, rawSnippet: '' },
        { key: 'duration', value: 'day', confidence: 1, rawSnippet: '' },
      ],
    };
    // Now that `exclusivity` is active+required, it shows up as missing.
    expect(missingRequiredAttributes(offerMissing, registry)).toContain('exclusivity');

    // And an offer carrying it is validated as a real, accepted fact.
    const offerWith: PlacementOfferDraft = {
      ...offerMissing,
      attributes: [
        ...offerMissing.attributes,
        { key: 'exclusivity', value: true, confidence: 1, rawSnippet: '' },
      ],
    };
    const v = validateOfferAttributes(offerWith, registry);
    expect(v.valid.some((a) => a.key === 'exclusivity')).toBe(true);
    expect(v.unknown.some((a) => a.key === 'exclusivity')).toBe(false);
    expect(missingRequiredAttributes(offerWith, registry)).not.toContain('exclusivity');
  });

  it('loadActiveRegistry ignores non-active rows', () => {
    const registry = loadActiveRegistry([
      {
        key: 'exclusivity',
        valueType: 'boolean',
        applicableKinds: ['post'],
        requiredForKinds: ['post'],
        status: 'proposed',
      },
    ]);
    expect(registry.some((e) => e.key === 'exclusivity')).toBe(false);
  });
});
