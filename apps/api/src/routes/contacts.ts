import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ContactFiltersZ, ContactStatusZ } from '@nosquare/shared';
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
      .object({ status: ContactStatusZ.optional(), tags: z.array(z.string()).optional() })
      .parse(req.body);
    return contactsService.update(params.id, body);
  });

  app.get('/contacts/:id/draft', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return contactsService.draft(params.id);
  });
}
