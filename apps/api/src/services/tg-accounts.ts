import { getPrisma, encryptString, decryptString, Prisma } from '@nosquare/db';
import { Errors } from '@nosquare/shared';
import { TgClient } from '@nosquare/tg-client';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { tgBootstrapFromEnv, tgProxyFromEnv } from './tg-config.js';

function isRecordNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

let _tgClient: TgClient | undefined;

export function getTgClient(): TgClient {
  if (!_tgClient) {
    if (!env.TG_API_ID || !env.TG_API_HASH) {
      throw Errors.badRequest('TG_API_ID/TG_API_HASH not configured');
    }
    const proxy = tgProxyFromEnv();
    const bootstrap = tgBootstrapFromEnv();
    _tgClient = new TgClient({
      creds: { apiId: Number(env.TG_API_ID), apiHash: env.TG_API_HASH },
      defaultRateLimits: {
        msgPerMinute: 10,
        msgPerDay: 30,
        newContactsPerDay: 15,
      },
      ...(proxy ? { proxy } : {}),
      ...(bootstrap ? { bootstrap } : {}),
      ...(env.TG_PROXY_FORCE_PORT_443 ? { forcePort443: true } : {}),
      sessionLoader: {
        load: async (id) => {
          const prisma = getPrisma();
          const a = await prisma.tgAccount.findUnique({ where: { id } });
          if (!a?.sessionEncrypted) return null;
          return decryptString(a.sessionEncrypted);
        },
        save: async (id, sessionString) => {
          const enc = await encryptString(sessionString);
          const prisma = getPrisma();
          try {
            await prisma.tgAccount.update({
              where: { id },
              data: { sessionEncrypted: enc, status: 'active' },
            });
          } catch (err) {
            if (!isRecordNotFound(err)) throw err;
            logger.warn(
              { tgAccountId: id },
              'tg session save skipped: tg_account row not found (bootstrap-only session?)',
            );
          }
        },
        markStatus: async (id, status) => {
          const prisma = getPrisma();
          try {
            await prisma.tgAccount.update({ where: { id }, data: { status } });
          } catch (err) {
            if (!isRecordNotFound(err)) throw err;
            logger.warn({ tgAccountId: id, status }, 'tg markStatus skipped: row not found');
          }
        },
        setCooldownUntil: async (id, until) => {
          const prisma = getPrisma();
          try {
            await prisma.tgAccount.update({ where: { id }, data: { cooldownUntil: until } });
          } catch (err) {
            if (!isRecordNotFound(err)) throw err;
            logger.warn({ tgAccountId: id }, 'tg setCooldownUntil skipped: row not found');
          }
        },
      },
    });
  }
  return _tgClient;
}

export const tgAccountsService = {
  async list() {
    const prisma = getPrisma();
    return prisma.tgAccount.findMany({ orderBy: { createdAt: 'desc' } });
  },

  async create(input: {
    label: string;
    phone: string;
    role: 'parser' | 'outreach' | 'both';
    dailyMsgLimit?: number;
    dailyNewContactLimit?: number;
    tags?: string[];
    notes?: string;
  }) {
    const prisma = getPrisma();
    return prisma.tgAccount.create({
      data: {
        label: input.label,
        phone: input.phone,
        role: input.role,
        dailyMsgLimit: input.dailyMsgLimit ?? 30,
        dailyNewContactLimit: input.dailyNewContactLimit ?? 15,
        tags: input.tags ?? [],
        notes: input.notes ?? null,
      },
    });
  },

  async update(id: string, patch: Partial<{ label: string; tags: string[]; notes: string; dailyMsgLimit: number; dailyNewContactLimit: number; role: 'parser' | 'outreach' | 'both' }>) {
    const prisma = getPrisma();
    return prisma.tgAccount.update({ where: { id }, data: patch });
  },

  async remove(id: string) {
    const prisma = getPrisma();
    await prisma.tgAccount.delete({ where: { id } });
  },

  async startLogin(id: string) {
    const prisma = getPrisma();
    const a = await prisma.tgAccount.findUnique({ where: { id } });
    if (!a) throw Errors.notFound('tg-account', id);
    const tg = getTgClient();
    const handle = await tg.for(id);
    const { phoneCodeHash } = await handle.startLogin(a.phone);
    await prisma.tgAccount.update({ where: { id }, data: { loginPhoneCodeHash: phoneCodeHash } });
    return { ok: true };
  },

  async confirmCode(id: string, code: string) {
    const prisma = getPrisma();
    const a = await prisma.tgAccount.findUnique({ where: { id } });
    if (!a) throw Errors.notFound('tg-account', id);
    if (!a.loginPhoneCodeHash) throw Errors.badRequest('login flow not started');
    const tg = getTgClient();
    const handle = await tg.for(id);
    const r = await handle.confirmCode(a.phone, a.loginPhoneCodeHash, code);
    if (r.ok && r.sessionString) {
      const enc = await encryptString(r.sessionString);
      await prisma.tgAccount.update({
        where: { id },
        data: { sessionEncrypted: enc, status: 'active', loginPhoneCodeHash: null },
      });
      return { ok: true, needs2FA: false };
    }
    if (r.needs2FA) return { ok: false, needs2FA: true };
    throw Errors.badRequest('login failed');
  },

  async confirmPassword(id: string, password: string) {
    const prisma = getPrisma();
    const a = await prisma.tgAccount.findUnique({ where: { id } });
    if (!a) throw Errors.notFound('tg-account', id);
    const tg = getTgClient();
    const handle = await tg.for(id);
    const r = await handle.confirmPassword(password);
    const enc = await encryptString(r.sessionString);
    await prisma.tgAccount.update({
      where: { id },
      data: { sessionEncrypted: enc, status: 'active', loginPhoneCodeHash: null },
    });
    return { ok: true };
  },
};
