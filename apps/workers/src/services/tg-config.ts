import type { TgBootstrapSession, TgProxyConfig } from '@nosquare/tg-client';
import { env } from '../env.js';

export function tgProxyFromEnv(): TgProxyConfig | undefined {
  const t = env.TG_PROXY_TYPE;
  if (!t) return undefined;
  if (!env.TG_PROXY_IP || !env.TG_PROXY_PORT) return undefined;
  if (t === 'socks5') {
    return {
      type: 'socks5',
      ip: env.TG_PROXY_IP,
      port: env.TG_PROXY_PORT,
      ...(env.TG_PROXY_USERNAME ? { username: env.TG_PROXY_USERNAME } : {}),
      ...(env.TG_PROXY_PASSWORD ? { password: env.TG_PROXY_PASSWORD } : {}),
    };
  }
  return {
    type: 'mtproxy',
    ip: env.TG_PROXY_IP,
    port: env.TG_PROXY_PORT,
    secret: env.TG_PROXY_SECRET ?? '',
  };
}

export function tgBootstrapFromEnv(): TgBootstrapSession | undefined {
  if (!env.TG_SESSION_STRING) return undefined;
  return {
    tgAccountId: env.TG_BOOTSTRAP_ACCOUNT_ID,
    sessionString: env.TG_SESSION_STRING,
  };
}
