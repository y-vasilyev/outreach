import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PlacementAttributeReviewDecisionZ } from '@nosquare/shared';

import { placementAttributesService } from '../services/placement-attributes.js';

/**
 * Placement-attribute proposal review endpoints (entity-style-rate-cards,
 * Section 4.3). Admin-only. Since harden-reply-extraction made structured
 * extraction the canonical write path, attribute proposals are ALWAYS persisted
 * regardless of the `structured_placement_offers` flag — so the review route is
 * no longer flag-gated (the flag now governs matching/planner preference only).
 * Operators can curate the vocabulary extraction produces at any time.
 *
 *   GET  /placement-attributes/proposals       — list `status='proposed'` rows
 *   GET  /placement-attributes/active-registry  — v1 ∪ approved active registry
 *   POST /placement-attributes/:id/review       — { decision: 'approve'|'reject' }
 *
 * Approving a proposal flips it to `status='active'`, which makes it part of
 * the active registry the planner + extraction load on the next tick.
 */
export async function placementAttributesRoutes(app: FastifyInstance) {
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
