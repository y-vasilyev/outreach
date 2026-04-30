export interface TgCredentials {
  apiId: number;
  apiHash: string;
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

export interface IncomingMessage {
  tgAccountId: string;
  fromTgUserId: string;
  text: string;
  tgMsgId: string;
  receivedAt: string;
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
