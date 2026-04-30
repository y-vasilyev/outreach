import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ContactFiltersZ, ContactStatusZ, RoleGuessZ, ContactTypeZ } from '@nosquare/shared';
import { contactsService } from '../services/contacts.js';

export async function contactsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/contacts', async (req) => {
    const q = ContactFiltersZ.parse(req.query);
    return contactsService.list(q);
  });

  app.patch('/contacts/:id', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        status: ContactStatusZ.optional(),
        tags: z.array(z.string()).optional(),
        // Operator override fields. Setting any of these flips
        // `extractedBy` to `manual` so the worker won't perturb them.
        roleGuess: RoleGuessZ.optional(),
        confidence: z.number().min(0).max(1).optional(),
        value: z.string().min(1).max(500).optional(),
        label: z.string().max(200).nullable().optional(),
        type: ContactTypeZ.optional(),
      })
      .parse(req.body);
    return contactsService.update(params.id, body);
  });

  app.get('/contacts/:id/draft', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return contactsService.draft(params.id);
  });

  /**
   * Re-run the LLM contact_extractor on the parent channel. The worker's
   * upsert refreshes the contact's roleGuess / confidence / rationale; rows
   * marked `extractedBy: 'manual'` are skipped so operator overrides survive.
   */
  app.post('/contacts/:id/re-extract', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return contactsService.reExtract(params.id);
  });

  /**
   * Start a one-off ai-assisted conversation with this contact right now,
   * without waiting for the campaign-dispatcher tick. Either pin to an
   * existing campaign (we pull goal/value/mode from it) or pass goal/value
   * inline. The opener generation is async; the response returns the
   * conversation id so the UI can deep-link to /inbox/:id.
   */
  app.post('/contacts/:id/start-conversation', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        tgAccountId: z.string().min(1),
        campaignId: z.string().optional(),
        goalText: z.string().max(2000).optional(),
        valueProp: z.string().max(2000).optional(),
        mode: z.enum(['auto', 'assisted', 'manual']).optional(),
      })
      .parse(req.body);
    return contactsService.startConversation(params.id, body);
  });
}
