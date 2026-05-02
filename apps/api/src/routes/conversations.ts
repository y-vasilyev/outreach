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
    return conversationsService.get(params.id);
  });

  app.get('/conversations/:id/messages', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return conversationsService.getMessages(params.id);
  });

  app.get('/conversations/:id/suggestions', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return conversationsService.getSuggestions(params.id);
  });

  app.post('/conversations/:id/messages', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = SendMessageInputZ.parse({ conversationId: params.id, ...(req.body as object) });
    return conversationsService.sendOperatorMessage({
      conversationId: params.id,
      text: body.text,
      fromSuggestionId: body.fromSuggestionId,
      scheduledAt: body.scheduledAt,
      operatorId: req.user.id,
    });
  });

  app.patch('/conversations/:id', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        mode: z.enum(['auto', 'assisted', 'manual']).optional(),
        status: z.enum(['active', 'paused', 'done', 'failed']).optional(),
      })
      .parse(req.body);
    if (body.mode) await conversationsService.setMode(params.id, body.mode);
    if (body.status) await conversationsService.setStatus(params.id, body.status);
    return conversationsService.get(params.id);
  });

  app.post('/conversations/:id/suggestions/:sid/approve', async (req) => {
    const params = z.object({ id: z.string(), sid: z.string() }).parse(req.params);
    const body = z
      .object({
        text: z.string().optional(),
        scheduledAt: z.string().datetime().optional(),
      })
      .parse(req.body ?? {});
    return conversationsService.approveSuggestion(params.sid, req.user.id, body.text, body.scheduledAt);
  });

  app.post('/conversations/:id/suggestions/:sid/reject', async (req) => {
    const params = z.object({ id: z.string(), sid: z.string() }).parse(req.params);
    return conversationsService.rejectSuggestion(params.sid);
  });

  /**
   * Re-run the AI suggestion pipeline on this conversation. Server picks
   * `on_inbound` (ReplyComposer) when there's a recent inbound to react
   * to, otherwise `outreach_first_message` (OpeningComposer). Old pending
   * suggestions are expired so the inbox shows the fresh batch only.
   */
  app.post('/conversations/:id/regenerate-suggestions', async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return conversationsService.regenerateSuggestions(params.id);
  });
}
