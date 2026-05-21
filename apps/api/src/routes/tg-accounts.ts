import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CreateTgAccountInputZ, ConfirmCodeInputZ, ConfirmPasswordInputZ } from '@nosquare/shared';
import { tgAccountsService } from '../services/tg-accounts.js';
import { auditService } from '../services/audit.js';

export async function tgAccountsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', app.authenticate);

  app.get('/tg-accounts', { preHandler: [app.requireRole(['admin', 'operator', 'viewer'])] }, async () => {
    const list = await tgAccountsService.list();
    return list.map((a) => ({
      id: a.id,
      label: a.label,
      phone: a.phone,
      status: a.status,
      role: a.role,
      dailyMsgLimit: a.dailyMsgLimit,
      dailyNewContactLimit: a.dailyNewContactLimit,
      sentTodayMsg: a.sentTodayMsg,
      sentTodayNew: a.sentTodayNew,
      cooldownUntil: a.cooldownUntil?.toISOString() ?? null,
      warmupStage: a.warmupStage,
      tags: a.tags,
      notes: a.notes,
    }));
  });

  app.post('/tg-accounts', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const body = CreateTgAccountInputZ.parse(req.body);
    const a = await tgAccountsService.create(body);
    await auditService.log({
      userId: req.user.id,
      action: 'tg_account.create',
      targetType: 'tg_account',
      targetId: a.id,
    });
    return a;
  });

  app.patch('/tg-accounts/:id', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = z
      .object({
        label: z.string().optional(),
        tags: z.array(z.string()).optional(),
        notes: z.string().optional(),
        dailyMsgLimit: z.number().int().optional(),
        dailyNewContactLimit: z.number().int().optional(),
        role: z.enum(['parser', 'outreach', 'both']).optional(),
      })
      .parse(req.body);
    return tgAccountsService.update(params.id, body);
  });

  app.delete('/tg-accounts/:id', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    await tgAccountsService.remove(params.id);
    await auditService.log({
      userId: req.user.id,
      action: 'tg_account.delete',
      targetType: 'tg_account',
      targetId: params.id,
    });
    return { ok: true };
  });

  app.post('/tg-accounts/:id/login/start', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    return tgAccountsService.startLogin(params.id);
  });

  app.post('/tg-accounts/:id/login/confirm-code', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = ConfirmCodeInputZ.parse({ tgAccountId: params.id, ...(req.body as object) });
    return tgAccountsService.confirmCode(params.id, body.code);
  });

  app.post('/tg-accounts/:id/login/confirm-password', { preHandler: [app.requireRole(['admin'])] }, async (req) => {
    const params = z.object({ id: z.string() }).parse(req.params);
    const body = ConfirmPasswordInputZ.parse({ tgAccountId: params.id, ...(req.body as object) });
    return tgAccountsService.confirmPassword(params.id, body.password);
  });
}
