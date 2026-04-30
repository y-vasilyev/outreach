const SECRET_KEYS = new Set([
  'api_key',
  'apiKey',
  'authorization',
  'auth',
  'password',
  'password_hash',
  'session',
  'session_encrypted',
  'config_encrypted',
  'auth_encrypted',
  'token',
  'access_token',
  'refresh_token',
  'jwt',
  'secret',
  'encryption_key',
  'tg_api_hash',
]);

/**
 * Redact sensitive fields from an object before logging.
 */
export function redact<T>(input: T, extraKeys: string[] = []): T {
  const banned = new Set([...SECRET_KEYS, ...extraKeys.map((k) => k.toLowerCase())]);
  return walk(input, banned) as T;
}

function walk(v: unknown, banned: Set<string>): unknown {
  if (v == null) return v;
  if (Array.isArray(v)) return v.map((x) => walk(x, banned));
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (banned.has(k.toLowerCase())) {
        o[k] = '[REDACTED]';
      } else {
        o[k] = walk(val, banned);
      }
    }
    return o;
  }
  return v;
}

export function redactString(s: string): string {
  return s
    .replace(/(api[_-]?key\s*[:=]\s*)([\w.\-]+)/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)([\w.\-]+)/gi, '$1[REDACTED]');
}
