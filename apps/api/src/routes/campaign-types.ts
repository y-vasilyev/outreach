import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CreateCampaignTypeInputZ,
  UpdateCampaignTypeInputZ,
} from '@nosquare/shared';
import { campaignTypesService } from '../services/campaign-types.js';
import { requireFeature } from '../require-feature.js';
import { auditService } from '../services/audit.js';

export async function campaignTypesRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireFeature('campaign_types'));
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/campaign-types',
    { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] },
    async () => campaignTypesService.list(),
  );

  app.get(
    '/campaign-types/:id',
    { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] },
    async (req) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      return campaignTypesService.get(params.id);
    },
  );

  app.post(
    '/campaign-types',
    { preHandler: [app.requireRole(['admin'])] },
    async (req) => {
      const body = CreateCampaignTypeInputZ.parse(req.body);
      const created = await campaignTypesService.create(body);
      await auditService.log({
        userId: (req.user as { id: string }).id,
        action: 'campaign_type.create',
        targetType: 'campaign_type',
        targetId: created.id,
        payload: { key: created.key },
      });
      return created;
    },
  );

  app.patch(
    '/campaign-types/:id',
    { preHandler: [app.requireRole(['admin'])] },
    async (req) => {
      const params = z.object({ id: z.string() }).parse(req.params);
      const patch = UpdateCampaignTypeInputZ.partial().parse({ ...(req.body as object), id: params.id });
      const updated = await campaignTypesService.update(params.id, patch);
      await auditService.log({
        userId: (req.user as { id: string }).id,
        action: 'campaign_type.update',
        targetType: 'campaign_type',
        targetId: updated.id,
        payload: { key: updated.key },
      });
      return updated;
    },
  );
}
