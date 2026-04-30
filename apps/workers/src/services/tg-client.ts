import { TgClient } from '@nosquare/tg-client';
import { getPrisma, encryptString, decryptString } from '@nosquare/db';
import { env } from '../env.js';
import { tgBootstrapFromEnv, tgProxyFromEnv } from './tg-config.js';

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
        await getPrisma().tgAccount.update({
          where: { id },
          data: { sessionEncrypted: enc, status: 'active' },
        });
      },
      markStatus: async (id, status) => {
        await getPrisma().tgAccount.update({ where: { id }, data: { status } });
      },
      setCooldownUntil: async (id, until) => {
        await getPrisma().tgAccount.update({ where: { id }, data: { cooldownUntil: until } });
      },
    },
  });
  return _tg;
}
