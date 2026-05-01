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
        // Healthcheck. Bounded by a hard timeout — through some MTProxy
        // setups `getMe()` can stall for minutes, which delays binding
        // the NewMessage event handler and causes us to miss every
        // update pushed during the hang. If the call times out we trust
        // the persisted session is still valid; the next real call
        // (sendMessage/getEntity/etc.) will surface a real auth error
        // if it isn't, and `markStatus('need_auth')` will fire then.
        const HEALTHCHECK_MS = 10_000;
        await Promise.race([
          client.getMe().then(() => {
            isAuthorized = true;
          }),
          new Promise<void>((_, reject) =>
            setTimeout(
              () => reject(new Error(`getMe healthcheck timed out after ${HEALTHCHECK_MS}ms`)),
              HEALTHCHECK_MS,
            ),
          ),
        ]).catch((err) => {
          // Soft-fail the healthcheck. We still treat the session as
          // authorized so the listener can bind. Real failures will
          // surface on first use.
          isAuthorized = true;
          console.warn(
            `[tg-client] healthcheck soft-failed for tgAccountId=${tgAccountId}: ${(err as Error).message} — proceeding anyway`,
          );
        });
      } catch (err) {
        // Connection itself failed.
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
    // Long-poll bookkeeping. With unidirectional MTProxy fake-TLS the DC
    // never push-delivers updates to us; we have to actively pull via
    // `updates.GetDifference`. Started lazily alongside the GramJS event
    // handler. Both paths feed `dispatchIncoming`, and the worker dedupes
    // by tgMsgId so duplicate deliveries are harmless.
    let pollAbort = false;
    let pollTimer: NodeJS.Timeout | null = null;
    const dispatchIncoming = (m: unknown): void => {
      // DEBUG: when polling vs. push, the message shape is slightly
      // different (no `isPrivate`, no `_sender`, etc.). Log the discriminating
      // fields so we can tell if our filter rejects polled messages.
      try {
        const mm = m as {
          className?: string;
          out?: boolean;
          peerId?: { className?: string; userId?: { toString?(): string } };
          senderId?: { toString?(): string };
          fromId?: { className?: string; userId?: { toString?(): string } };
          message?: unknown;
        };
        console.log(
          `[tg-client] dispatchIncoming tgAccountId=${tgAccountId} ` +
            `cls=${mm?.className ?? '?'} out=${mm?.out === true} ` +
            `peer=${mm?.peerId?.className ?? '?'} ` +
            `peerUserId=${mm?.peerId?.userId?.toString?.() ?? '-'} ` +
            `senderId=${mm?.senderId?.toString?.() ?? '-'} ` +
            `fromId=${mm?.fromId?.userId?.toString?.() ?? '-'} ` +
            `textType=${typeof mm?.message}`,
        );
      } catch {
        /* never let logging break the handler */
      }
      const msg = mapIncomingEvent({ message: m }, tgAccountId);
      if (!msg) {
        console.log(`[tg-client] dispatchIncoming: filtered out (mapIncomingEvent → null)`);
        return;
      }
      console.log(
        `[tg-client] dispatchIncoming → forwarding to ${incomingSubs.size} sub(s) ` +
          `fromTgUserId=${msg.fromTgUserId} textLen=${msg.text.length}`,
      );
      for (const sub of incomingSubs) {
        try {
          void sub(msg);
        } catch {
          /* swallow — one subscriber's error must not stop others */
        }
      }
    };

    /**
     * Long-poll loop — the proxy-friendly receive path. Every 3s we ask the
     * DC "what's new since `state`?" via `updates.GetDifference`. Returns a
     * batch of new messages we then route through dispatchIncoming, same
     * as a push-delivered NewMessage.
     *
     * Implementation notes:
     * - Bookkeeping is `pts`/`date`/`qts` (channel `pts` we ignore — only
     *   relevant for channel updates, which we don't process).
     * - DifferenceTooLong means the diff is too big; we just bump pts and
     *   continue, accepting that we missed an unspecified slice (operator
     *   would refresh the inbox).
     * - All errors are logged and the loop keeps going. Stopped only when
     *   the last subscriber unsubscribes.
     */
    const startUpdatePoll = (): void => {
      if (pollTimer) return;
      pollAbort = false;
      let pts = 0;
      let date = 0;
      let qts = 0;
      let initialised = false;
      const POLL_INTERVAL_MS = 3_000;

      const init = async (): Promise<void> => {
        try {
          const tg = await loadGramJS();
          // The base GramJSModule type only enumerates Api ctors we use
          // elsewhere; for the polling path we reach into Api.updates ad-hoc.
          const ApiU = (tg.Api as unknown as {
            updates: {
              GetState: new () => unknown;
              GetDifference: new (params: {
                pts: number;
                date: number;
                qts: number;
              }) => unknown;
            };
          }).updates;
          const state = (await client.invoke(new ApiU.GetState())) as {
            pts?: number;
            date?: number;
            qts?: number;
          };
          pts = state.pts ?? 0;
          date = state.date ?? 0;
          qts = state.qts ?? 0;
          initialised = true;
          console.log(
            `[tg-client] update-poll initialised tgAccountId=${tgAccountId} pts=${pts} qts=${qts}`,
          );
        } catch (err) {
          console.warn(
            `[tg-client] update-poll init failed tgAccountId=${tgAccountId}:`,
            (err as Error).message,
          );
        }
      };

      const tickOnce = async (): Promise<void> => {
        if (!initialised) {
          await init();
          return;
        }
        try {
          const tg = await loadGramJS();
          const ApiU = (tg.Api as unknown as {
            updates: {
              GetDifference: new (params: {
                pts: number;
                date: number;
                qts: number;
              }) => unknown;
            };
          }).updates;
          const diff = (await client.invoke(
            new ApiU.GetDifference({ pts, date, qts }),
          )) as {
            className?: string;
            newMessages?: unknown[];
            otherUpdates?: unknown[];
            state?: { pts?: number; date?: number; qts?: number };
            intermediateState?: { pts?: number; date?: number; qts?: number };
            pts?: number;
            date?: number;
          };
          const cls = diff.className;
          if (cls === 'updates.DifferenceEmpty') {
            if (typeof diff.date === 'number') date = diff.date;
            return;
          }
          if (cls === 'updates.Difference' || cls === 'updates.DifferenceSlice') {
            const messages = Array.isArray(diff.newMessages) ? diff.newMessages : [];
            const others = Array.isArray((diff as { otherUpdates?: unknown[] }).otherUpdates)
              ? ((diff as { otherUpdates: unknown[] }).otherUpdates)
              : [];
            if (messages.length > 0 || others.length > 0) {
              const otherTypes = others
                .map((u) => (u as { className?: string })?.className ?? '?')
                .join(',');
              console.log(
                `[tg-client] update-poll tgAccountId=${tgAccountId} batch=${messages.length}` +
                  (others.length > 0 ? ` other=${others.length}[${otherTypes}]` : ''),
              );
            }
            for (const m of messages) {
              try {
                dispatchIncoming(m);
              } catch (err) {
                console.warn(
                  `[tg-client] update-poll dispatch failed:`,
                  (err as Error).message,
                );
              }
            }
            // Some 1-1 inbound messages arrive via otherUpdates as
            // UpdateNewMessage / UpdateShortMessage. Convert + dispatch.
            for (const u of others) {
              try {
                const inner = extractMessageFromUpdate(u);
                if (inner) dispatchIncoming(inner);
              } catch (err) {
                console.warn(
                  `[tg-client] update-poll otherUpdate dispatch failed:`,
                  (err as Error).message,
                );
              }
            }
            const next = diff.intermediateState ?? diff.state;
            if (next) {
              if (typeof next.pts === 'number') pts = next.pts;
              if (typeof next.date === 'number') date = next.date;
              if (typeof next.qts === 'number') qts = next.qts;
            }
            return;
          }
          if (cls === 'updates.DifferenceTooLong') {
            if (typeof diff.pts === 'number') pts = diff.pts;
            return;
          }
        } catch (err) {
          console.warn(
            `[tg-client] update-poll tick failed tgAccountId=${tgAccountId}:`,
            (err as Error).message,
          );
        }
      };

      const loop = async (): Promise<void> => {
        while (!pollAbort) {
          await tickOnce();
          if (pollAbort) break;
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
      };
      pollTimer = setTimeout(() => {
        void loop();
      }, 0);
    };
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
          //
          // We use console.* directly here because SessionManager doesn't
          // own the parent app's logger — diagnostic visibility matters
          // more than log shape during the bring-up of the listener path.
          void (async () => {
            try {
              const events = (await import(
                'telegram/events/index.js'
              )) as unknown as {
                NewMessage: new (params?: { incoming?: boolean; outgoing?: boolean }) => unknown;
                Raw: new (params: { types?: unknown[]; func?: unknown }) => unknown;
              };
              // DEBUG: a Raw handler fires for every update GramJS receives,
              // not just NewMessage. Lets us tell apart "GramJS isn't getting
              // updates from the DC at all" (raw silent) vs. "the
              // NewMessage filter is dropping our messages" (raw fires but
              // NewMessage doesn't). The Raw constructor requires the
              // params object — { types: [], func: undefined } means "all
              // updates, no extra predicate".
              try {
                const rawBuilder = new events.Raw({ types: [], func: undefined });
                client.addEventHandler((update: unknown) => {
                  const u = update as { className?: string };
                  console.log(
                    `[tg-client] raw update tgAccountId=${tgAccountId} type=${u?.className ?? '?'}`,
                  );
                }, rawBuilder);
                console.log(`[tg-client] raw debug handler bound for tgAccountId=${tgAccountId}`);
              } catch (err) {
                console.error(`[tg-client] raw debug bind failed:`, err);
              }
              gramJsBuilder = new events.NewMessage({ incoming: true, outgoing: false });
              gramJsHandler = (event: unknown) => {
                // Trace EVERY delivery so we can tell sync filtering
                // (private/outgoing/text) apart from "GramJS never fired".
                try {
                  const e = event as {
                    message?: {
                      out?: boolean;
                      isPrivate?: boolean;
                      peerId?: { className?: string };
                      message?: string;
                    };
                  };
                  const m = e.message;
                  console.log(
                    `[tg-client] gramjs newmessage tgAccountId=${tgAccountId} ` +
                      `out=${m?.out === true} isPrivate=${m?.isPrivate === true} ` +
                      `peer=${m?.peerId?.className ?? '?'} ` +
                      `textLen=${typeof m?.message === 'string' ? m.message.length : 0}`,
                  );
                } catch {
                  /* never let logging break the handler */
                }
                const e = event as { message?: unknown };
                if (e.message) dispatchIncoming(e.message);
              };
              client.addEventHandler(gramJsHandler, gramJsBuilder);
              gramJsBound = true;
              console.log(`[tg-client] addEventHandler bound for tgAccountId=${tgAccountId}`);

              // Kick off the long-poll loop. Required because some MTProxy
              // setups (notably fake-TLS) accept our outbound MTProto
              // requests but never push updates back — so even a perfectly
              // bound NewMessage handler stays silent. Polling
              // updates.GetDifference is the unidirectional-friendly path.
              startUpdatePoll();
            } catch (err) {
              console.error(
                `[tg-client] subscribeIncoming bind failed for tgAccountId=${tgAccountId}:`,
                err,
              );
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
            // Last subscriber gone — stop the long-poll loop too.
            pollAbort = true;
            pollTimer = null;
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
interface SenderEntity {
  username?: string;
  firstName?: string;
  lastName?: string;
}

/**
 * GetDifference returns most messages in `newMessages`, but private 1-1
 * inbound chats sometimes arrive as `UpdateShortMessage` /
 * `UpdateShortChatMessage` / `UpdateNewMessage` in `otherUpdates`. Pull a
 * Message-shaped object out so the same dispatch path handles them.
 *
 * UpdateShortMessage is the slim form: it has `userId` (the OTHER party in
 * a private chat), `out` (true if we sent it), `message`, `id`, `date`. We
 * synthesise `peerId.userId = userId`, and for `out=false` we set
 * `senderId = userId` so mapIncomingEvent finds the sender. For `out=true`
 * we leave senderId empty — mapIncomingEvent will still skip via the
 * `m.out === true` check.
 */
function extractMessageFromUpdate(u: unknown): Record<string, unknown> | null {
  const upd = u as {
    className?: string;
    message?: unknown;
    userId?: { toString?(): string } | string | number | null;
    fromId?: { userId?: { toString?(): string } } | null;
    out?: boolean;
    id?: number | { toString(): string };
    date?: number;
  };
  const cls = upd.className;
  if (cls === 'UpdateNewMessage' || cls === 'UpdateNewChannelMessage') {
    // `message` here is the inner Message object — return it directly.
    return upd.message && typeof upd.message === 'object'
      ? (upd.message as Record<string, unknown>)
      : null;
  }
  if (cls === 'UpdateShortMessage') {
    // Slim 1-1 private inbound. Synthesise enough fields for mapIncomingEvent.
    const otherId =
      typeof upd.userId === 'object' && upd.userId !== null
        ? (upd.userId as { toString?(): string }).toString?.()
        : typeof upd.userId === 'string' || typeof upd.userId === 'number'
          ? String(upd.userId)
          : undefined;
    if (!otherId) return null;
    const out = upd.out === true;
    return {
      out,
      message: upd.message,
      id: upd.id,
      date: upd.date,
      peerId: { className: 'PeerUser', userId: { toString: () => otherId } },
      // For inbound the sender IS the other user. For outbound we leave
      // empty; mapIncomingEvent's `out` check filters that case anyway.
      ...(out
        ? {}
        : {
            senderId: { toString: () => otherId },
            fromId: { className: 'PeerUser', userId: { toString: () => otherId } },
          }),
      isPrivate: true,
    };
  }
  return null;
}

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
      sender?: SenderEntity | null;
      _sender?: SenderEntity | null;
    };
    _sender?: SenderEntity | null;
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
  // Sender entity hangs off the message in several places depending on
  // the GramJS version. We deliberately stay sync here — making the
  // handler async (so we could `await m.getSender()`) silently broke
  // event delivery in this GramJS build. If the inline sender is
  // missing we fall through with no profile fields; the worker has its
  // own backfill path.
  const sender: SenderEntity | null | undefined = m.sender ?? m._sender ?? e._sender;
  const fromUsername =
    typeof sender?.username === 'string' && sender.username ? sender.username : undefined;
  const fromFirstName =
    typeof sender?.firstName === 'string' && sender.firstName ? sender.firstName : undefined;
  const fromLastName =
    typeof sender?.lastName === 'string' && sender.lastName ? sender.lastName : undefined;
  return {
    tgAccountId,
    fromTgUserId,
    text,
    tgMsgId,
    receivedAt,
    ...(fromUsername !== undefined && { fromUsername }),
    ...(fromFirstName !== undefined && { fromFirstName }),
    ...(fromLastName !== undefined && { fromLastName }),
  };
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
 * Telegram error names that mean "this specific peer is unreachable" — the
 * SESSION is fine, but the message can't be delivered to this contact and
 * never will be. The send worker translates these into a permanent failure
 * (no BullMQ retry) and marks the contact as `unreachable`.
 *
 * Importantly: USER_DEACTIVATED ≠ INPUT_USER_DEACTIVATED.
 *   - USER_DEACTIVATED → OUR account was deactivated (session-dead).
 *   - INPUT_USER_DEACTIVATED → the recipient deleted their TG account.
 * Only the former should kill the session.
 */
const PEER_PERMANENT_RE =
  /^(?:CHAT_WRITE_FORBIDDEN|USER_PRIVACY_RESTRICTED|USER_IS_BLOCKED|YOU_BLOCKED_USER|USER_BANNED_IN_CHANNEL|USER_BANNED_IN_GROUP|INPUT_USER_DEACTIVATED|PEER_ID_INVALID|USER_NOT_MUTUAL_CONTACT|USER_INVALID|USERNAME_INVALID|USERNAME_NOT_OCCUPIED)\b/i;

/** Errors that prove the SESSION itself is dead (re-auth required). */
const SESSION_DEAD_RE =
  /\b(?:AUTH_KEY_UNREGISTERED|AUTH_KEY_INVALID|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED_BAN|USER_DEACTIVATED|AUTH_KEY_DUPLICATED)\b/i;

/**
 * Classify a TG error message. Exported so tg-send can check
 * `classifyTgError(err) === 'peer_permanent'` without reaching into
 * AppError details.
 */
export function classifyTgError(
  err: unknown,
): 'flood' | 'session_dead' | 'peer_permanent' | 'transient' {
  const e = err as { message?: string; errorMessage?: string };
  const msg = e?.message ?? e?.errorMessage ?? '';
  if (extractFloodSeconds(err as Parameters<typeof extractFloodSeconds>[0]) !== null) {
    return 'flood';
  }
  if (PEER_PERMANENT_RE.test(msg)) return 'peer_permanent';
  if (SESSION_DEAD_RE.test(msg)) return 'session_dead';
  return 'transient';
}

/**
 * Maps a thrown GramJS error into a typed AppError, updating durable
 * account state on the way out.
 *
 * Crucially, peer-level 403s like `CHAT_WRITE_FORBIDDEN` (recipient
 * blocked us / privacy-restricted / deactivated) MUST NOT mark the
 * account as `need_auth` — the session is fine, just this conversation
 * is undeliverable. They surface as `TG_PEER_FORBIDDEN` so the sender
 * worker can degrade the contact + conversation without killing the
 * whole TG account.
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

  // Peer-permanent: the SESSION is fine, the SPECIFIC peer can't be
  // messaged (blocked / privacy / deactivated / bad username / etc.).
  // Do NOT touch account status here — that's exactly the bug we had
  // before, where one blocked recipient nuked the whole account.
  if (typeof msg === 'string' && PEER_PERMANENT_RE.test(msg)) {
    return new AppError('TG_PEER_FORBIDDEN', `TG: ${msg}`, 403);
  }

  // Real session-dead errors (AUTH_KEY_*, SESSION_REVOKED, our account
  // deactivated). These DO require re-auth.
  if (typeof msg === 'string' && SESSION_DEAD_RE.test(msg)) {
    void loader.markStatus(tgAccountId, 'need_auth').catch(() => {
      /* ignore */
    });
    return new AppError('UNAUTHORIZED', `TG: ${msg}`, 401);
  }

  // 401 from MTProto without a known message pattern — treat as session
  // dead (conservative). 403 alone is no longer enough — the
  // peer-permanent check above already caught the legit per-peer cases.
  if (e?.code === 401) {
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
