import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConversationFiltersZ, SendMessageInputZ } from '@nosquare/shared';
import { conversationsService } from '../services/conversations.js';

export async function conversationsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/conversations', async (req) => {
    const q = ConversationFiltersZ.parse(req.query);
    return conversationsService.list(q);
  });

  app.get('/conversations/:id', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const c = await conversationsService.get(params.id);
    const messages = await conversationsService.getMessages(params.id);
    const suggestions = await conversationsService.getSuggestions(params.id);
    return { conversation: c, messages, suggestions };
  });

  app.get('/conversations/:id/messages', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return conversationsService.getMessages(params.id);
  });

  app.post('/conversations/:id/messages', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = SendMessageInputZ.parse({ conversationId: params.id, ...(req.body as object) });
    return conversationsService.sendOperatorMessage({
      conversationId: params.id,
      text: body.text,
      fromSuggestionId: body.fromSuggestionId,
      operatorId: req.user.id,
    });
  });

  app.patch('/conversations/:id', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({ mode: z.enum(['auto', 'assisted', 'manual']).optional() })
      .parse(req.body);
    if (body.mode) await conversationsService.setMode(params.id, body.mode);
    return conversationsService.get(params.id);
  });

  app.post('/conversations/:id/suggestions/:sid/approve', async (req) => {
    const params = z.object({ id: z.string(), sid: z.string() }).parse(req.params);
    return conversationsService.approveSuggestion(params.sid, req.user.id);
  });

  app.post('/conversations/:id/suggestions/:sid/reject', async (req) => {
    const params = z.object({ id: z.string(), sid: z.string() }).parse(req.params);
    return conversationsService.rejectSuggestion(params.sid);
  });
}
