import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PlacementAttributeReviewDecisionZ } from '@nosquare/shared';

import { placementAttributesService } from '../services/placement-attributes.js';
import { requireFeature } from '../require-feature.js';

/**
 * Placement-attribute proposal review endpoints (entity-style-rate-cards,
 * Section 4.3). Admin-only and gated at request time by the
 * `structured_placement_offers` runtime flag (404 when off — same as a truly
 * unregistered route, via `requireFeature`).
 *
 *   GET  /placement-attributes/proposals       — list `status='proposed'` rows
 *   GET  /placement-attributes/active-registry  — v1 ∪ approved active registry
 *   POST /placement-attributes/:id/review       — { decision: 'approve'|'reject' }
 *
 * Approving a proposal flips it to `status='active'`, which makes it part of
 * the active registry the planner + extraction load on the next tick.
 */
export async function placementAttributesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireFeature('structured_placement_offers'));
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/placement-attributes/proposals',
    { preHandler: [app.requireRole(['admin'])] },
    async () => placementAttributesService.listProposals(),
  );

  app.get(
    '/placement-attributes/active-registry',
    { preHandler: [app.requireRole(['admin'])] },
    async () => placementAttributesService.activeRegistry(),
  );

  app.post(
    '/placement-attributes/:id/review',
    { preHandler: [app.requireRole(['admin'])] },
    async (req) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const { decision } = PlacementAttributeReviewDecisionZ.parse(req.body);
      const reviewerId = (req.user as { id: string }).id;
      return decision === 'approve'
        ? placementAttributesService.approve(id, reviewerId)
        : placementAttributesService.reject(id, reviewerId);
    },
  );
}
