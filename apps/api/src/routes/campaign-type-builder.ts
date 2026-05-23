import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BuildCampaignTypeInputZ,
  SaveCampaignTypeDraftInputZ,
} from '@nosquare/shared';

import { campaignTypeBuilderService } from '../services/campaign-type-builder.js';
import { requireFeature } from '../require-feature.js';

/**
 * Campaign-type builder endpoints (agency-sourcing-matching M3, task 3.5).
 *
 * Gated at request time by the `campaign_types` runtime flag (registered
 * unconditionally; the hook 404s when off). Admin only — the builder authors
 * live agent configs on save.
 */
export async function campaignTypeBuilderRoutes(app: FastifyInstance) {
  app.addHook('onRequest', requireFeature('campaign_types'));
  app.addHook('onRequest', app.authenticate);

  // 3.5: build a draft from a plain-language goal.
  app.post(
    '/campaign-type-builder/draft',
    { preHandler: [app.requireRole(['admin'])] },
    async (req) => {
      const body = BuildCampaignTypeInputZ.parse(req.body);
      return campaignTypeBuilderService.buildDraft(body);
    },
  );

  // 3.5: fetch a previously-built draft (output + per-agent test results).
  app.get(
    '/campaign-type-builder/draft/:draftId',
    { preHandler: [app.requireRole(['admin'])] },
    async (req) => {
      const params = z.object({ draftId: z.string() }).parse(req.params);
      return campaignTypeBuilderService.getDraft(params.draftId);
    },
  );

  // 3.5 + 3.4: save the reviewed draft → real campaign_type + agent_config rows.
  app.post(
    '/campaign-type-builder/save',
    { preHandler: [app.requireRole(['admin'])] },
    async (req) => {
      const body = SaveCampaignTypeDraftInputZ.parse(req.body);
      const actorId = (req.user as { id: string }).id;
      return campaignTypeBuilderService.saveDraft(body.draft, actorId);
    },
  );
}
