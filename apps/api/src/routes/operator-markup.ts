import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  ExtractionHintInputZ,
  ExtractionHintPatchZ,
  OperatorDataPointWriteZ,
  ReanalyzeRequestZ,
} from '@nosquare/shared';

import { operatorMarkupService } from '../services/operator-markup.js';
import { requireFeature } from '../require-feature.js';

/**
 * Operator re-analysis + markup routes (operator-reanalyze-and-markup).
 * Re-run extraction, correct profile data points, and manage extraction hints.
 * Operator/admin only, and behind the `agency_sourcing` feature (these surfaces
 * only make sense for the agency-sourcing catalog pipeline).
 */
export async function operatorMarkupRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireFeature('agency_sourcing'));
  app.addHook('onRequest', app.authenticate);

  // Re-run extraction for one inbound message (supersede prior rows).
  app.post(
    '/conversations/:id/messages/:mid/reanalyze',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req) => {
      const { id, mid } = z.object({ id: z.string().min(1), mid: z.string().min(1) }).parse(req.params);
      const { supersede } = ReanalyzeRequestZ.parse(req.body ?? {});
      return operatorMarkupService.reanalyzeMessage(id, mid, supersede);
    },
  );

  // Operator-origin data point write / delete (re-rolls the profile).
  app.post(
    '/blogger-profiles/:id/data-points',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const body = OperatorDataPointWriteZ.parse(req.body);
      return operatorMarkupService.writeDataPoint(id, body);
    },
  );

  app.delete(
    '/blogger-profiles/:id/data-points/:dpid',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req) => {
      const { id, dpid } = z.object({ id: z.string().min(1), dpid: z.string().min(1) }).parse(req.params);
      return operatorMarkupService.deleteDataPoint(id, dpid);
    },
  );

  // Extraction-hint CRUD.
  app.get(
    '/extraction-hints',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req) => {
      const q = z
        .object({ channelId: z.string().optional(), conversationId: z.string().optional() })
        .parse(req.query);
      return operatorMarkupService.listHints(q);
    },
  );

  app.post(
    '/extraction-hints',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req) => {
      const body = ExtractionHintInputZ.parse(req.body);
      const createdById = (req.user as { id?: string } | undefined)?.id ?? null;
      return operatorMarkupService.createHint(body, createdById);
    },
  );

  app.patch(
    '/extraction-hints/:id',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      const patch = ExtractionHintPatchZ.parse(req.body);
      return operatorMarkupService.updateHint(id, patch);
    },
  );

  app.delete(
    '/extraction-hints/:id',
    { preHandler: [app.requireRole(['admin', 'operator'])] },
    async (req) => {
      const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
      return operatorMarkupService.deleteHint(id);
    },
  );
}
