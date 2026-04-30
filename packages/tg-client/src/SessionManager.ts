import { AppError } from '@nosquare/shared/errors';
import { floodGuard } from './FloodGuard.js';
import type {
  IncomingHandler,
  IncomingMessage,
  RecentPost,
  ResolvedChannel,
  ResolvedUser,
  SendMessageResult,
  TelegramClientHandle,
  TgAccountStatus,
  TgBootstrapSession,
  TgCredentials,
  TgProxyConfig,
} from './types.js';

export interface SessionManagerOptions {
  proxy?: TgProxyConfig;
  bootstrap?: TgBootstrapSession;
  /**
   * Force GramJS to dial Telegram DCs on port 443 instead of the default 80.
   * Use this when the upstream SOCKS5 proxy blocks low ports (common with
   * residential rotating proxies that drop port-80 traffic to TG DCs).
   * GramJS itself only reaches 443 when `useWSS` is on, but `useWSS` is
   * incompatible with proxies, so we override the port at the session layer.
   */
  forcePort443?: boolean;
}

// We keep GramJS opaque — see CLAUDE.md "Do not let GramJS leak into routes".
// TODO: tighten types once we settle on a real tg-client API surface.
interface GramJSSession {
  save: () => string;
  dcId?: number;
  serverAddress?: string;
  port?: number;
  setDC?: (dcId: number, serverAddress: string, port: number) => void;
}

type GramJSClient = {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  getMe: () => Promise<unknown>;
  getEntity: (target: unknown) => Promise<unknown>;
  getMessages: (target: unknown, opts: { limit: number }) => Promise<unknown>;
  sendMessage: (
    target: unknown,
    opts: { message: string },
  ) => Promise<unknown>;
  invoke: (request: unknown) => Promise<unknown>;
  session: GramJSSession;
  sendCode?: (
    apiCreds: { apiId: number; apiHash: string },
    phone: string,
  ) => Promise<{ phoneCodeHash: string }>;
  addEventHandler: (
    handler: (event: unknown) => void | Promise<void>,
    builder: unknown,
  ) => void;
  removeEventHandler: (
    handler: (event: unknown) => void | Promise<void>,
    builder: unknown,
  ) => void;
};

export interface SessionLoader {
  /** Returns decrypted session string, or null if not yet authorized. */
  load(tgAccountId: string): Promise<string | null>;
  save(tgAccountId: string, sessionString: string): Promise<void>;
  markStatus(tgAccountId: string, status: TgAccountStatus): Promise<void>;
  setCooldownUntil(tgAccountId: string, until: Date | null): Promise<void>;
}

interface CachedClient {
  handle: TelegramClientHandle;
  client: GramJSClient | null;
}

/**
 * Holds long-lived `TelegramClient` instances per `tgAccountId`. One client
 * per account: GramJS is not safe to share across logical sessions, but a
 * single account multiplexes fine.
 */
export class SessionManager {
  private readonly cache = new Map<string, CachedClient>();
  private readonly pending = new Map<string, Promise<TelegramClientHandle>>();

  constructor(
    private readonly creds: TgCredentials,
    private readonly loader: SessionLoader,
    private readonly opts: SessionManagerOptions = {},
  ) {}

  async getClient(tgAccountId: string): Promise<TelegramClientHandle> {
    const cached = this.cache.get(tgAccountId);
    if (cached) return cached.handle;

    const inFlight = this.pending.get(tgAccountId);
    if (inFlight) return inFlight;

    const promise = this.create(tgAccountId).finally(() => {
      this.pending.delete(tgAccountId);
    });
    this.pending.set(tgAccountId, promise);
    return promise;
  }

  async invalidate(tgAccountId: string): Promise<void> {
    const cached = this.cache.get(tgAccountId);
    this.cache.delete(tgAccountId);
    if (!cached?.client) return;
    try {
      await cached.client.disconnect();
    } catch {
      /* swallow — disconnect is best-effort */
    }
  }

  private async create(tgAccountId: string): Promise<TelegramClientHandle> {
    if (!this.creds.apiId || !this.creds.apiHash) {
      throw new AppError(
        'CONFIG',
        'TG_API_ID / TG_API_HASH are not configured',
        500,
      );
    }

    let sessionString = await this.loader.load(tgAccountId);
    // Bootstrap fallback: if no DB session and an env-supplied session is
    // configured for this account, use it. We DO persist it back so the next
    // boot reads from the (encrypted) DB row.
    if (
      (!sessionString || sessionString.length === 0) &&
      this.opts.bootstrap &&
      this.opts.bootstrap.tgAccountId === tgAccountId
    ) {
      sessionString = this.opts.bootstrap.sessionString;
      try {
        await this.loader.save(tgAccountId, sessionString);
      } catch {
        /* save is best-effort during bootstrap */
      }
    }

    // Lazy GramJS import — only the call-sites that actually need a live
    // session pay the dep cost. Unit tests of unrelated parts don't load it.
    const tg = await loadGramJS();

    const session = new tg.StringSession(sessionString ?? '');
    const proxy = mapProxy(this.opts.proxy);
    const useFakeTls = !!(proxy && 'MTProxy' in proxy && proxy.host);
    const client = new tg.TelegramClient(
      session,
      this.creds.apiId,
      this.creds.apiHash,
      {
        connectionRetries: 5,
        ...(proxy ? { proxy } : {}),
      },
    ) as unknown as GramJSClient;

    // GramJS overrides `clientParams.connection` to its own
    // ConnectionTCPMTProxyAbridged whenever the proxy has `MTProxy` field
    // (telegramBaseClient.js:97). To inject our fake-TLS subclass we have to
    // patch `client._connection` *after* the constructor.
    if (useFakeTls) {
      const m = await import('./connection/FakeTlsConnection.js');
      const cls = await m.loadFakeTlsConnectionClass();
      (client as unknown as { _connection: unknown })._connection = cls;
    }

    // GramJS hardcodes port 80 whenever a proxy is set (useWSS is incompatible
    // with proxies). When `forcePort443` is requested, override the port on
    // the underlying session so GramJS dials :443 instead.
    if (this.opts.forcePort443) {
      const s = client.session;
      if (typeof s.setDC === 'function' && typeof s.dcId === 'number' && typeof s.serverAddress === 'string') {
        s.setDC(s.dcId, s.serverAddress, 443);
      }
    }

    let isAuthorized = false;
    if (sessionString && sessionString.length > 0) {
      try {
        await client.connect();
        await client.getMe(); // healthcheck
        isAuthorized = true;
      } catch (err) {
        // Connection failed or session was revoked.
        await this.loader.markStatus(tgAccountId, 'need_auth');
        try {
          await client.disconnect();
        } catch {
          /* ignore */
        }
        throw mapTgError(err, tgAccountId, this.loader);
      }
    } else {
      // No session yet — keep the client object around so the caller can
      // drive the auth flow via `startLogin`/`confirmCode`/`confirmPassword`.
      try {
        await client.connect();
      } catch (err) {
        throw mapTgError(err, tgAccountId, this.loader);
      }
    }

    const handle = this.buildHandle(tgAccountId, client, isAuthorized);
    this.cache.set(tgAccountId, { handle, client });
    return handle;
  }

  private buildHandle(
    tgAccountId: string,
    client: GramJSClient,
    isAuthorized: boolean,
  ): TelegramClientHandle {
    const loader = this.loader;
    const creds = this.creds;
    // Per-handle login state shared between startLogin/confirmCode/confirmPassword.
    const loginState: { phone?: string; phoneCodeHash?: string } = {};

    // Local fan-out for incoming-message subscribers. We register a single
    // GramJS event handler the first time someone subscribes, then dispatch
    // to local callbacks — keeps the surface independent of GramJS objects.
    const incomingSubs = new Set<IncomingHandler>();
    let gramJsBound = false;
    let gramJsHandler: ((event: unknown) => void) | null = null;
    let gramJsBuilder: unknown = null;
    const requireAuth = (): void => {
      if (!handle.isAuthorized) {
        throw new AppError(
          'UNAUTHORIZED',
          'TG account requires login',
          401,
        );
      }
    };

    const wrap = async <T>(op: () => Promise<T>): Promise<T> => {
      try {
        return await op();
      } catch (err) {
        throw mapTgError(err, tgAccountId, loader);
      }
    };

    const handle: TelegramClientHandle = {
      tgAccountId,
      isAuthorized,
      client,

      async getMe() {
        requireAuth();
        return wrap(async () => {
          const me = (await client.getMe()) as {
            id?: { toString(): string };
            username?: string;
          };
          return {
            id: me?.id ? me.id.toString() : '',
            username: me?.username,
          };
        });
      },

      async resolveChannel(handleStr: string) {
        requireAuth();
        return wrap(async () => {
          const tg = await loadGramJS();
          const entity = (await client.getEntity(handleStr)) as Record<
            string,
            unknown
          >;

          const full = (await client.invoke(
            new tg.Api.channels.GetFullChannel({
              channel: entity as unknown as never,
            }),
          )) as {
            fullChat?: {
              about?: string;
              participantsCount?: number;
              linkedChatId?: { toString(): string } | null;
            };
            chats?: Array<Record<string, unknown>>;
          };

          const fullChat = full.fullChat ?? {};
          const id = stringifyBigInt(entity.id);
          const accessHash = stringifyBigInt(entity.accessHash);
          const title =
            typeof entity.title === 'string' ? entity.title : '';
          const username =
            typeof entity.username === 'string' ? entity.username : handleStr;

          let linkedChat: ResolvedChannel['linkedChat'];
          const linkedId = fullChat.linkedChatId;
          if (linkedId && full.chats?.length) {
            const linkedRaw = full.chats.find(
              (c) => stringifyBigInt(c.id) === linkedId.toString(),
            );
            if (linkedRaw) {
              linkedChat = {
                id: stringifyBigInt(linkedRaw.id),
                accessHash: stringifyBigInt(linkedRaw.accessHash),
                handle:
                  typeof linkedRaw.username === 'string'
                    ? linkedRaw.username
                    : undefined,
              };
            }
          }

          const resolved: ResolvedChannel = {
            id,
            accessHash,
            handle: username,
            title,
            about: fullChat.about ?? '',
            participantsCount: fullChat.participantsCount,
            linkedChat,
            raw: full,
          };
          return resolved;
        });
      },

      async getRecentPosts(handleStr: string, limit: number) {
        requireAuth();
        return wrap(async () => {
          const messages = (await client.getMessages(handleStr, {
            limit,
          })) as Array<Record<string, unknown>>;
          return messages.map((m) => mapMessage(m));
        });
      },

      async resolveUser(usernameOrId: string) {
        requireAuth();
        return wrap(async () => {
          const entity = (await client.getEntity(usernameOrId)) as Record<
            string,
            unknown
          >;
          const resolved: ResolvedUser = {
            id: stringifyBigInt(entity.id),
            accessHash: stringifyBigInt(entity.accessHash),
            username:
              typeof entity.username === 'string'
                ? entity.username
                : undefined,
            firstName:
              typeof entity.firstName === 'string'
                ? entity.firstName
                : undefined,
            lastName:
              typeof entity.lastName === 'string'
                ? entity.lastName
                : undefined,
            isBot: entity.bot === true,
            raw: entity,
          };
          return resolved;
        });
      },

      async sendMessage(toUsernameOrId: string, text: string) {
        requireAuth();
        if (floodGuard.isCoolingDown(tgAccountId)) {
          const until = floodGuard.cooldownUntil(tgAccountId);
          throw new AppError(
            'RATE_LIMITED',
            `Account is in FloodWait cooldown${
              until ? ` until ${new Date(until).toISOString()}` : ''
            }`,
            429,
          );
        }
        return wrap(async () => {
          const result = (await client.sendMessage(toUsernameOrId, {
            message: text,
          })) as { id?: number | { toString(): string } };
          const tgMsgId =
            typeof result?.id === 'number'
              ? String(result.id)
              : stringifyBigInt(result?.id);
          return {
            tgMsgId,
            sentAt: new Date().toISOString(),
          } satisfies SendMessageResult;
        });
      },

      async startLogin(phone: string) {
        return wrap(async () => {
          if (typeof client.sendCode !== 'function') {
            throw new AppError(
              'INTERNAL',
              'Underlying client does not support sendCode',
              500,
            );
          }
          const res = await client.sendCode(
            { apiId: creds.apiId, apiHash: creds.apiHash },
            phone,
          );
          loginState.phone = phone;
          loginState.phoneCodeHash = res.phoneCodeHash;
          return { phoneCodeHash: res.phoneCodeHash };
        });
      },

      async confirmCode(phone, phoneCodeHash, code) {
        return wrap(async () => {
          const tg = await loadGramJS();
          try {
            await client.invoke(
              new tg.Api.auth.SignIn({
                phoneNumber: phone,
                phoneCodeHash,
                phoneCode: code,
              }),
            );
            const sessionString = client.session.save();
            handle.isAuthorized = true;
            await loader.save(tgAccountId, sessionString);
            await loader.markStatus(tgAccountId, 'idle');
            loginState.phone = phone;
            loginState.phoneCodeHash = phoneCodeHash;
            return { ok: true, needs2FA: false, sessionString };
          } catch (err) {
            const e = err as { message?: string; errorMessage?: string };
            const msg = e?.message ?? e?.errorMessage ?? '';
            if (/SESSION_PASSWORD_NEEDED/i.test(msg)) {
              loginState.phone = phone;
              loginState.phoneCodeHash = phoneCodeHash;
              return { ok: false, needs2FA: true };
            }
            throw err;
          }
        });
      },

      async confirmPassword(password) {
        return wrap(async () => {
          const tg = await loadGramJS();
          const passwordSrp = (await client.invoke(
            new tg.Api.account.GetPassword({}),
          )) as unknown;
          // GramJS exposes a helper `computeCheck` to derive SRP params.
          // Imported lazily to keep the surface minimal.
          const passwordMod = (await import(
            'telegram/Password.js'
          )) as unknown as {
            computeCheck: (
              srp: unknown,
              password: string,
            ) => Promise<unknown>;
          };
          const check = await passwordMod.computeCheck(passwordSrp, password);
          await client.invoke(
            new tg.Api.auth.CheckPassword({
              password: check as never,
            }),
          );
          const sessionString = client.session.save();
          handle.isAuthorized = true;
          await loader.save(tgAccountId, sessionString);
          await loader.markStatus(tgAccountId, 'idle');
          return { sessionString };
        });
      },

      subscribeIncoming(cb: IncomingHandler) {
        incomingSubs.add(cb);
        if (!gramJsBound) {
          // Lazy bind: only register the GramJS event handler when there's
          // at least one subscriber. Filtering to incoming private messages
          // keeps the volume low (no channel updates, no outgoing).
          void (async () => {
            try {
              const events = (await import(
                'telegram/events/index.js'
              )) as unknown as {
                NewMessage: new (params?: { incoming?: boolean; outgoing?: boolean }) => unknown;
              };
              gramJsBuilder = new events.NewMessage({ incoming: true, outgoing: false });
              gramJsHandler = (event: unknown) => {
                const msg = mapIncomingEvent(event, tgAccountId);
                if (!msg) return;
                for (const sub of incomingSubs) {
                  try {
                    void sub(msg);
                  } catch {
                    /* swallow — one subscriber's error must not stop others */
                  }
                }
              };
              client.addEventHandler(gramJsHandler, gramJsBuilder);
              gramJsBound = true;
            } catch {
              // Listener bind failed — leave subs registered; nothing fires.
              // Caller can retry by re-subscribing later.
            }
          })();
        }
        return () => {
          incomingSubs.delete(cb);
          if (incomingSubs.size === 0 && gramJsBound && gramJsHandler && gramJsBuilder) {
            try {
              client.removeEventHandler(gramJsHandler, gramJsBuilder);
            } catch {
              /* ignore */
            }
            gramJsBound = false;
            gramJsHandler = null;
            gramJsBuilder = null;
          }
        };
      },

      async disconnect() {
        try {
          await client.disconnect();
        } catch {
          /* ignore */
        }
      },
    };

    return handle;
  }
}

/**
 * Turn a GramJS `NewMessage` event into our wire-friendly `IncomingMessage`.
 * Returns `null` for events we don't care about (group/channel chats, bots,
 * empty-text service messages, our own outgoing echoes).
 */
function mapIncomingEvent(event: unknown, tgAccountId: string): IncomingMessage | null {
  const e = event as {
    message?: {
      id?: number | { toString(): string };
      message?: string;
      text?: string;
      out?: boolean;
      isPrivate?: boolean;
      peerId?: { className?: string; userId?: { toString(): string } };
      senderId?: { toString(): string };
      fromId?: { userId?: { toString(): string } };
      date?: number;
    };
    isPrivate?: boolean;
  };
  const m = e.message;
  if (!m) return null;
  // Only private (1-1) chats. Group/channel updates also flow through but we
  // don't manage them.
  const isPrivate = m.isPrivate === true || e.isPrivate === true || m.peerId?.className === 'PeerUser';
  if (!isPrivate) return null;
  // Defensively skip our own outgoing echoes that GramJS sometimes redelivers.
  if (m.out === true) return null;
  const text = typeof m.message === 'string' ? m.message : typeof m.text === 'string' ? m.text : '';
  if (!text) return null;
  // `senderId` is most reliable; fallback to `peerId.userId` then `fromId`.
  const fromTgUserId =
    m.senderId?.toString?.() ??
    m.peerId?.userId?.toString?.() ??
    m.fromId?.userId?.toString?.() ??
    '';
  if (!fromTgUserId) return null;
  const tgMsgId =
    typeof m.id === 'number'
      ? String(m.id)
      : typeof m.id === 'object' && m.id
        ? m.id.toString()
        : '';
  const dateNum = typeof m.date === 'number' ? m.date : 0;
  const receivedAt = dateNum
    ? new Date(dateNum * 1000).toISOString()
    : new Date().toISOString();
  return { tgAccountId, fromTgUserId, text, tgMsgId, receivedAt };
}

// ---------- helpers ----------

interface GramJSModule {
  TelegramClient: new (
    session: unknown,
    apiId: number,
    apiHash: string,
    opts: { connectionRetries: number; proxy?: GramJSProxy },
  ) => unknown;
  StringSession: new (session: string) => unknown;
  Api: {
    channels: {
      GetFullChannel: new (params: { channel: unknown }) => unknown;
    };
    auth: {
      SignIn: new (params: {
        phoneNumber: string;
        phoneCodeHash: string;
        phoneCode: string;
      }) => unknown;
      CheckPassword: new (params: { password: unknown }) => unknown;
    };
    account: {
      GetPassword: new (params: Record<string, never>) => unknown;
    };
    MessageEntityUrl: new (...args: unknown[]) => unknown;
    MessageEntityTextUrl: new (...args: unknown[]) => unknown;
  };
  errors: {
    FloodWaitError?: new (...args: unknown[]) => Error;
    RPCError?: new (...args: unknown[]) => Error;
  };
}

let gramJsCache: GramJSModule | undefined;

async function loadGramJS(): Promise<GramJSModule> {
  if (gramJsCache) return gramJsCache;
  // Dynamic import keeps GramJS out of the bundle for callers that never
  // touch a real session (unit tests, lint, type-check).
  const tg = (await import('telegram')) as unknown as {
    TelegramClient: GramJSModule['TelegramClient'];
    Api: GramJSModule['Api'];
    errors: GramJSModule['errors'];
  };
  const sessions = (await import('telegram/sessions/index.js')) as unknown as {
    StringSession: GramJSModule['StringSession'];
  };
  gramJsCache = {
    TelegramClient: tg.TelegramClient,
    StringSession: sessions.StringSession,
    Api: tg.Api,
    errors: tg.errors ?? {},
  };
  return gramJsCache;
}

type GramJSProxy =
  | {
      socksType: 4 | 5;
      ip: string;
      port: number;
      username?: string;
      password?: string;
      timeout?: number;
    }
  | {
      MTProxy: true;
      ip: string;
      port: number;
      secret: string;
      timeout?: number;
      /**
       * Non-standard field consumed by our `FakeTlsConnection`. Its presence
       * triggers fake-TLS handshake; the value is the SNI hostname encoded
       * inside the original `ee...` secret.
       */
      host?: string;
    };

/**
 * Normalize an MTProxy secret to the format GramJS accepts.
 *
 * Telegram clients accept three secret formats:
 *   - 32 hex chars (raw 16-byte secret, original format)
 *   - 34 hex chars starting with `dd` (random-padding mode)
 *   - 66+ hex chars starting with `ee` (fake-TLS: `ee` + 16-byte secret +
 *     variable-length SNI host bytes)
 *
 * Returns the 32-hex-char secret plus, for fake-TLS, the embedded SNI host so
 * `FakeTlsConnection` can run the TLS handshake.
 */
function normalizeMtproxySecret(raw: string): { secret: string; host?: string } {
  const s = raw.trim();
  if (/^[0-9a-f]+$/i.test(s)) {
    if (s.length === 32 || s.length === 34) return { secret: s };
    if (s.length > 34 && /^ee/i.test(s)) {
      return {
        secret: s.slice(2, 34),
        host: Buffer.from(s.slice(34), 'hex').toString('utf8'),
      };
    }
    return { secret: s };
  }
  try {
    const buf = Buffer.from(s, 'base64');
    if (buf.length === 16) return { secret: buf.toString('hex') };
    if (buf.length === 17 && buf[0] === 0xdd) return { secret: buf.toString('hex') };
    if (buf.length > 17 && buf[0] === 0xee) {
      return {
        secret: buf.subarray(1, 17).toString('hex'),
        host: buf.subarray(17).toString('utf8'),
      };
    }
  } catch {
    /* fallthrough */
  }
  return { secret: s };
}

function mapProxy(p: TgProxyConfig | undefined): GramJSProxy | undefined {
  if (!p) return undefined;
  if (p.type === 'socks5') {
    const out: GramJSProxy = { socksType: 5, ip: p.ip, port: p.port };
    if (p.username) (out as { username?: string }).username = p.username;
    if (p.password) (out as { password?: string }).password = p.password;
    if (p.timeoutSec) (out as { timeout?: number }).timeout = p.timeoutSec;
    return out;
  }
  const { secret, host } = normalizeMtproxySecret(p.secret);
  const out: GramJSProxy = {
    MTProxy: true,
    ip: p.ip,
    port: p.port,
    secret,
  };
  if (host) (out as { host?: string }).host = host;
  if (p.timeoutSec) (out as { timeout?: number }).timeout = p.timeoutSec;
  return out;
}

function stringifyBigInt(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'object' && value !== null) {
    const v = value as { toString?: () => string };
    if (typeof v.toString === 'function') return v.toString();
  }
  return String(value);
}

function mapMessage(m: Record<string, unknown>): RecentPost {
  const id =
    typeof m.id === 'number'
      ? m.id
      : Number(stringifyBigInt(m.id) || '0');
  const dateNum =
    typeof m.date === 'number' ? m.date : Number(stringifyBigInt(m.date) || '0');
  const dateIso = dateNum
    ? new Date(dateNum * 1000).toISOString()
    : new Date(0).toISOString();
  const text =
    typeof m.message === 'string'
      ? m.message
      : typeof m.text === 'string'
        ? m.text
        : '';

  const urls: string[] = [];
  const entities = Array.isArray(m.entities)
    ? (m.entities as Array<Record<string, unknown>>)
    : [];
  for (const e of entities) {
    const className =
      typeof e.className === 'string' ? e.className : undefined;
    const offset = typeof e.offset === 'number' ? e.offset : 0;
    const length = typeof e.length === 'number' ? e.length : 0;
    if (className === 'MessageEntityTextUrl' && typeof e.url === 'string') {
      urls.push(e.url);
    } else if (className === 'MessageEntityUrl' && text) {
      urls.push(text.slice(offset, offset + length));
    }
  }

  return { id, dateIso, text, urls };
}

/**
 * Maps a thrown GramJS error into a typed AppError, updating durable
 * account state on the way out.
 */
function mapTgError(
  err: unknown,
  tgAccountId: string,
  loader: SessionLoader,
): AppError {
  const e = err as {
    message?: string;
    seconds?: number;
    code?: number;
    errorMessage?: string;
    className?: string;
    name?: string;
  };
  const msg = e?.message ?? e?.errorMessage ?? 'unknown TG error';

  // FloodWait: GramJS exposes either `FloodWaitError` (with `seconds`)
  // or a generic RPCError whose message starts with `FLOOD_WAIT_`.
  const floodSeconds = extractFloodSeconds(e);
  if (floodSeconds !== null) {
    floodGuard.recordFloodWait(tgAccountId, floodSeconds, async (until) => {
      await loader.markStatus(tgAccountId, 'cooldown');
      await loader.setCooldownUntil(tgAccountId, until);
    });
    return new AppError('RATE_LIMITED', `FloodWait ${floodSeconds}s`, 429);
  }

  // 401/403 — session is dead.
  if (e?.code === 401 || e?.code === 403) {
    void loader.markStatus(tgAccountId, 'need_auth').catch(() => {
      /* ignore */
    });
    return new AppError('UNAUTHORIZED', `TG: ${msg}`, 401);
  }

  // AUTH_KEY_UNREGISTERED / SESSION_REVOKED / USER_DEACTIVATED
  if (
    typeof msg === 'string' &&
    /AUTH_KEY|SESSION_REVOKED|USER_DEACTIVATED/i.test(msg)
  ) {
    void loader.markStatus(tgAccountId, 'need_auth').catch(() => {
      /* ignore */
    });
    return new AppError('UNAUTHORIZED', `TG: ${msg}`, 401);
  }

  return new AppError('UPSTREAM_ERROR', `tg: ${msg}`, 502);
}

function extractFloodSeconds(e: {
  seconds?: number;
  message?: string;
  className?: string;
  name?: string;
}): number | null {
  if (typeof e.seconds === 'number' && e.seconds >= 0) return e.seconds;
  const sourceStrings = [e.message, e.className, e.name].filter(
    (s): s is string => typeof s === 'string',
  );
  for (const s of sourceStrings) {
    const m = /FLOOD_?WAIT(?:_|\s)?(\d+)/i.exec(s);
    if (m && m[1]) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
