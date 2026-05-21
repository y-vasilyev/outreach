import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConversationFiltersZ, SendMessageInputZ } from '@nosquare/shared';
import { conversationsService } from '../services/conversations.js';
import { syncOneWithBudget } from '../services/conversation-sync.js';

export async function conversationsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/conversations', { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] }, async (req) => {
    const q = ConversationFiltersZ.parse(req.query);
    return conversationsService.list(q);
  });

  app.get('/conversations/:id', { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    // Pull any messages the workers missed while offline before
    // responding. Hard 1500ms budget — if sync is slow we return the
    // current DB state and let the rest finish in the background; the
    // UI picks up newly-persisted messages via the realtime
    // `message.new` event regardless. See chat-autonomous-modes
    // design.md Decision 4.
    await syncOneWithBudget(params.id);
    return conversationsService.get(params.id);
  });

  app.get('/conversations/:id/messages', { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return conversationsService.getMessages(params.id);
  });

  app.get('/conversations/:id/suggestions', { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return conversationsService.getSuggestions(params.id);
  });

  app.post('/conversations/:id/messages', { preHandler: [app.requireRole(['admin', 'operator'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = SendMessageInputZ.parse({ conversationId: params.id, ...(req.body as object) });
    if (body.bypassSafety && req.user.role !== 'admin') {
      throw app.httpErrors.forbidden('Only admin can bypass SafetyFilter');
    }
    return conversationsService.sendOperatorMessage({
      conversationId: params.id,
      text: body.text,
      fromSuggestionId: body.fromSuggestionId,
      scheduledAt: body.scheduledAt,
      bypassSafety: body.bypassSafety,
      operatorId: req.user.id,
    });
  });

  app.patch('/conversations/:id', { preHandler: [app.requireRole(['admin', 'operator'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        mode: z.enum(['auto', 'semi_auto', 'assisted', 'manual']).optional(),
        status: z.enum(['active', 'paused', 'done', 'failed']).optional(),
      })
      .parse(req.body);
    // Migration shim — when LEGACY_AUTO_MEANS_SEMI_AUTO=1 the API
    // accepts the legacy `auto` value (which previously meant
    // "auto-send when safe, otherwise suggest") and stores it as
    // `semi_auto`. Off by default; remove with task 8.4 once external
    // callers have caught up.
    let mode = body.mode;
    if (mode === 'auto' && process.env.LEGACY_AUTO_MEANS_SEMI_AUTO === '1') {
      mode = 'semi_auto';
    }
    if (mode) await conversationsService.setMode(params.id, mode);
    if (body.status) await conversationsService.setStatus(params.id, body.status);
    return conversationsService.get(params.id);
  });

  app.post('/conversations/:id/suggestions/:sid/approve', { preHandler: [app.requireRole(['admin', 'operator'])] }, async (req) => {
    const params = z.object({ id: z.string(), sid: z.string() }).parse(req.params);
    const body = z
      .object({
        text: z.string().optional(),
        scheduledAt: z.string().datetime().optional(),
      })
      .parse(req.body ?? {});
    return conversationsService.approveSuggestion(params.sid, req.user.id, body.text, body.scheduledAt);
  });

  app.post('/conversations/:id/suggestions/:sid/reject', { preHandler: [app.requireRole(['admin', 'operator'])] }, async (req) => {
    const params = z.object({ id: z.string(), sid: z.string() }).parse(req.params);
    return conversationsService.rejectSuggestion(params.sid);
  });

  /**
   * Re-run the AI suggestion pipeline on this conversation. Server picks
   * `on_inbound` (ReplyComposer) when there's a recent inbound to react
   * to, otherwise `outreach_first_message` (OpeningComposer). Old pending
   * suggestions are expired so the inbox shows the fresh batch only.
   */
  app.post('/conversations/:id/regenerate-suggestions', { preHandler: [app.requireRole(['admin', 'operator'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return conversationsService.regenerateSuggestions(params.id);
  });
}
