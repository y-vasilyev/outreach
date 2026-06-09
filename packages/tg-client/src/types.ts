export interface TgCredentials {
  apiId: number;
  apiHash: string;
}

/**
 * Network proxy for the underlying GramJS client. Supports SOCKS5 (with
 * optional auth) and MTProxy. Translated to GramJS `proxy` option at the
 * TelegramClient construction site.
 */
export type TgProxyConfig =
  | {
      type: 'socks5';
      ip: string;
      port: number;
      username?: string;
      password?: string;
      /** SOCKS connect timeout in seconds. GramJS defaults to 5 if omitted. */
      timeoutSec?: number;
    }
  | {
      type: 'mtproxy';
      ip: string;
      port: number;
      secret: string;
      timeoutSec?: number;
    };

/**
 * Optional bootstrap: when no session is loaded for `tgAccountId`, fall back
 * to this pre-existing session string (e.g. one supplied via env). Useful for
 * an "env parser account" that the platform team hands over a ready GramJS
 * session for, without going through the UI login wizard.
 */
export interface TgBootstrapSession {
  tgAccountId: string;
  sessionString: string;
}

export interface TgSessionRecord {
  tgAccountId: string;
  /** Decrypted by caller. Empty string means "no session yet". */
  sessionString: string;
}

export interface ResolvedChannel {
  /** BigInt as string. */
  id: string;
  accessHash: string;
  handle: string;
  title: string;
  about: string;
  participantsCount?: number;
  language?: string;
  linkedChat?: { id: string; accessHash: string; handle?: string };
  raw: unknown;
}

export interface RecentPost {
  id: number;
  dateIso: string;
  text: string;
  urls: string[];
  metrics?: {
    views?: number;
    forwards?: number;
    reactions?: number;
  };
}

export interface ResolvedUser {
  id: string;
  accessHash: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  isBot: boolean;
  raw: unknown;
}

export interface SendMessageResult {
  tgMsgId: string;
  sentAt: string;
}

/**
 * One historical message recovered via `fetchHistorySince`. Same wire
 * shape as IncomingMessage so the on-open sync path can hand it
 * straight to the same persistence helper that `tg-listen` uses.
 *
 * `direction` distinguishes our own outbound echoes from contact
 * messages — the sync should persist only inbound, but we surface
 * outbound too so callers can update their local view if needed.
 */
export interface HistoryMessage {
  tgAccountId: string;
  /** TG user id of the OTHER party in the 1-1 chat. */
  peerTgUserId: string;
  /** TG user id of whoever sent this message (== peerTgUserId for inbound, our id for outbound). */
  fromTgUserId: string;
  text: string;
  tgMsgId: string;
  /** ISO timestamp of when TG says the message was sent. */
  sentAt: string;
  /** True when the message was sent by our account (outbound echo from history). */
  out: boolean;
  fromUsername?: string;
  fromFirstName?: string;
  fromLastName?: string;
  /**
   * Lightweight media metadata for history backfill. Mirrors IncomingMessage so
   * API sync can surface media-only replies that the push listener missed.
   */
  media?: IncomingMedia;
}

export interface IncomingMessage {
  tgAccountId: string;
  fromTgUserId: string;
  text: string;
  tgMsgId: string;
  receivedAt: string;
  /**
   * Sender profile fields lifted off the GramJS `NewMessage` event. They're
   * usually present because the same Updates envelope ships the user entity
   * alongside the message — so we read them sync without a separate
   * `users.GetUsers` round-trip (which fails for users we haven't touched
   * recently because GramJS doesn't have their access_hash cached). When
   * absent (rare — bots, deleted accounts), the consumer falls back to a
   * plain by-id lookup.
   */
  fromUsername?: string;
  fromFirstName?: string;
  fromLastName?: string;
  /**
   * GramJS access_hash lifted off the inline sender entity. Persisting it on
   * the Contact lets us build an explicit InputPeerUser later (sync, read-ack)
   * without depending on the session-level entity cache, which is the root
   * cause of the "Could not find the input entity" failure mode.
   */
  fromAccessHash?: string;
  /**
   * Lightweight media metadata lifted off the GramJS message when the inbound
   * carries a photo/document. We deliberately do NOT download the bytes here
   * (the listener stays sync + light, and GramJS byte-download needs an async
   * round-trip + access_hash). Consumers behind ENABLE_OBJECT_STORAGE record a
   * `media_asset` row from this metadata and degrade when bytes are absent.
   */
  media?: IncomingMedia;
}

/** Minimal, GramJS-version-agnostic view of an inbound message's media. */
export interface IncomingMedia {
  /** GramJS media className, e.g. `MessageMediaPhoto` / `MessageMediaDocument`. */
  className: string;
  /** Coarse kind for the media_asset row. */
  kind: 'image' | 'video' | 'document' | 'other';
  /** MIME type when present (documents carry it; photos usually don't). */
  mime?: string;
  /** Declared size in bytes when present. */
  bytes?: number;
  /** Original file name when present (documents). */
  fileName?: string;
}

export type IncomingHandler = (msg: IncomingMessage) => void | Promise<void>;

export type TgAccountStatus =
  | 'idle'
  | 'active'
  | 'cooldown'
  | 'banned'
  | 'need_auth';

export interface RateLimits {
  msgPerMinute: number;
  msgPerDay: number;
  newContactsPerDay: number;
}

export interface RateConsumeOk {
  ok: true;
}

export interface RateConsumeBlocked {
  ok: false;
  retryAfterMs: number;
}

export type RateConsumeResult = RateConsumeOk | RateConsumeBlocked;

export type RateKind = 'msg' | 'newContact';

export interface RateState {
  msgInMinute: number;
  msgInDay: number;
  newContactsInDay: number;
}

/**
 * Opaque handle to an underlying Telegram user-account session.
 * Implementations wrap GramJS `TelegramClient`. Consumers must NOT
 * touch `client` directly — call the higher-level methods instead.
 */
export interface TelegramClientHandle {
  tgAccountId: string;
  isAuthorized: boolean;
  /**
   * Underlying GramJS `TelegramClient` instance. Kept opaque to
   * limit blast radius; do not depend on it from outside this package.
   */
  client: unknown;

  // High-level methods.
  getMe(): Promise<{ id: string; username?: string }>;
  resolveChannel(handle: string): Promise<ResolvedChannel>;
  getRecentPosts(handle: string, limit: number): Promise<RecentPost[]>;
  resolveUser(usernameOrId: string): Promise<ResolvedUser>;
  sendMessage(toUsernameOrId: string, text: string): Promise<SendMessageResult>;

  /**
   * Fetch the most recent messages from the 1-1 chat with `peerKey`,
   * bounded to `limit` (≤ 50) descending. When `sinceTgMsgId` is
   * provided, returns only messages strictly newer than that id. Used
   * by the on-open conversation-sync path to backfill messages
   * received while the workers were offline.
   *
   * Wraps `messages.getHistory` (or GramJS `client.getMessages`,
   * which is the equivalent helper). Results are mapped to the
   * `HistoryMessage` wire shape so consumers don't depend on the
   * GramJS Message class.
   */
  fetchHistorySince(opts: {
    peerKey: string;
    /**
     * When supplied, the client builds an `Api.InputPeerUser` from this pair
     * and uses it instead of resolving `peerKey` against the session entity
     * cache. Bypasses the "Could not find the input entity" failure on cold
     * sessions.
     */
    inputPeer?: { tgUserId: string; accessHash: string };
    sinceTgMsgId?: string;
    limit?: number;
  }): Promise<HistoryMessage[]>;

  /**
   * Mark the 1-1 chat with `peerKey` as read up to (and including) `maxTgMsgId`
   * — i.e. send the blue-double-check read receipt to the contact. Omit
   * `maxTgMsgId` to ack everything currently visible. Wraps
   * `messages.ReadHistory`. Best-effort: returns `false` if the entity can't
   * be resolved or the call fails (never throws to the caller).
   */
  markRead(opts: {
    peerKey: string;
    inputPeer?: { tgUserId: string; accessHash: string };
    maxTgMsgId?: string;
  }): Promise<boolean>;

  /**
   * Download the media bytes of an inbound 1-1 message by its tg message id.
   * Returns the raw bytes, or `null` when the message / its media can't be
   * resolved (e.g. the message scrolled out of the access window, or it had no
   * downloadable media). NEVER throws on a "no bytes" condition — callers in
   * the inbound path treat `null` as "honest pending" (record a metadata-only
   * media_asset, no dead presigned URL). Wraps GramJS `downloadMedia`.
   */
  downloadInboundMedia(opts: {
    peerKey: string;
    tgMsgId: string;
  }): Promise<Uint8Array | null>;

  /**
   * Download the media bytes of a PUBLIC channel post by handle + post id
   * (blogger-profile-who-is-this). Used to store a post-example preview image
   * for the catalog. Same best-effort contract as `downloadInboundMedia`:
   * returns the photo bytes, or `null` when the post / its media can't be
   * resolved; NEVER throws. Parser-account / public-data only.
   */
  downloadPublicPostMedia(opts: {
    handle: string;
    postId: string;
  }): Promise<Uint8Array | null>;

  /**
   * Subscribe to incoming TG private messages on this session. Returns an
   * unsubscribe function. Only fires for `direct` messages from users (not
   * channels/groups). Call repeatedly to register multiple consumers.
   *
   * Implementation note: wires `GramJS.events.NewMessage({ incoming: true })`
   * under the hood. No-op until the session is authorized.
   */
  subscribeIncoming(cb: IncomingHandler): () => void;

  // Auth flow.
  startLogin(phone: string): Promise<{ phoneCodeHash: string }>;
  confirmCode(
    phone: string,
    phoneCodeHash: string,
    code: string,
  ): Promise<{ ok: boolean; needs2FA: boolean; sessionString?: string }>;
  confirmPassword(password: string): Promise<{ sessionString: string }>;

  disconnect(): Promise<void>;
}
