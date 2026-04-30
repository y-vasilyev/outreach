import type { FastifyInstance } from 'fastify';
import { ContactFiltersZ } from '@nosquare/shared';
import { contactsService } from '../services/contacts.js';

export async function contactsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/contacts', async (req) => {
    const q = ContactFiltersZ.parse(req.query);
    return contactsService.list(q);
  });
}
