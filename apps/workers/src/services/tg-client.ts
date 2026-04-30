import { TgClient } from '@nosquare/tg-client';
import { getPrisma, encryptString, decryptString, Prisma } from '@nosquare/db';
import { env } from '../env.js';
import { tgBootstrapFromEnv, tgProxyFromEnv } from './tg-config.js';
import { logger } from '../logger.js';

function isRecordNotFound(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

let _tg: TgClient | undefined;

export function getTgClient(): TgClient | null {
  if (_tg) return _tg;
  if (!env.TG_API_ID || !env.TG_API_HASH) return null;

  const proxy = tgProxyFromEnv();
  const bootstrap = tgBootstrapFromEnv();
  _tg = new TgClient({
    creds: { apiId: Number(env.TG_API_ID), apiHash: env.TG_API_HASH },
    defaultRateLimits: {
      msgPerMinute: 10,
      msgPerDay: 30,
      newContactsPerDay: 15,
    },
    ...(proxy ? { proxy } : {}),
    ...(bootstrap ? { bootstrap } : {}),
    sessionLoader: {
      load: async (id) => {
        const prisma = getPrisma();
        const a = await prisma.tgAccount.findUnique({ where: { id } });
        if (!a?.sessionEncrypted) return null;
        return decryptString(a.sessionEncrypted);
      },
      save: async (id, sessionString) => {
        const enc = await encryptString(sessionString);
        try {
          await getPrisma().tgAccount.update({
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
        try {
          await getPrisma().tgAccount.update({ where: { id }, data: { status } });
        } catch (err) {
          if (!isRecordNotFound(err)) throw err;
          logger.warn({ tgAccountId: id, status }, 'tg markStatus skipped: row not found');
        }
      },
      setCooldownUntil: async (id, until) => {
        try {
          await getPrisma().tgAccount.update({ where: { id }, data: { cooldownUntil: until } });
        } catch (err) {
          if (!isRecordNotFound(err)) throw err;
          logger.warn({ tgAccountId: id }, 'tg setCooldownUntil skipped: row not found');
        }
      },
    },
  });
  return _tg;
}
