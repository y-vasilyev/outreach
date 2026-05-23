import { FloodGuard, floodGuard as defaultFloodGuard } from './FloodGuard.js';
import { RateLimiter } from './RateLimiter.js';
import { SessionManager, type SessionLoader } from './SessionManager.js';
import type {
  RateLimits,
  TelegramClientHandle,
  TgBootstrapSession,
  TgCredentials,
  TgProxyConfig,
} from './types.js';

export interface TgClientOptions {
  creds: TgCredentials;
  sessionLoader: SessionLoader;
  defaultRateLimits: RateLimits;
  /** Optional SOCKS5 / MTProxy. Same proxy is used for every account. */
  proxy?: TgProxyConfig;
  /** Optional pre-existing session string used for a specific account id. */
  bootstrap?: TgBootstrapSession;
  /** Force GramJS to connect to Telegram DCs on port 443 instead of 80. */
  forcePort443?: boolean;
  /** Optional override (mainly for tests). Defaults to the process singleton. */
  floodGuard?: FloodGuard;
}

/**
 * High-level facade. Owns the SessionManager and per-account RateLimiter
 * instances; consumers (platforms adapter, tg-send / tg-listen workers) talk
 * only to this class — never to GramJS directly.
 */
export class TgClient {
  public readonly floodGuard: FloodGuard;

  private readonly sessions: SessionManager;
  private readonly defaults: RateLimits;
  private readonly limiters = new Map<string, RateLimiter>();

  constructor(opts: TgClientOptions) {
    this.sessions = new SessionManager(opts.creds, opts.sessionLoader, {
      proxy: opts.proxy,
      bootstrap: opts.bootstrap,
      forcePort443: opts.forcePort443,
    });
    this.defaults = { ...opts.defaultRateLimits };
    this.floodGuard = opts.floodGuard ?? defaultFloodGuard;
  }

  /**
   * Returns a (possibly cached) authorized handle for `tgAccountId`.
   * The promise rejects with `AppError('UNAUTHORIZED')` if the account
   * has no live session, or `AppError('CONFIG')` if creds are missing.
   */
  async for(tgAccountId: string): Promise<TelegramClientHandle> {
    return this.sessions.getClient(tgAccountId);
  }

  /**
   * Per-account rate limiter. Lazily created on first access using the
   * defaults supplied to the constructor; live-update via
   * `tgClient.rateLimiter(id).setLimits({ ... })`.
   */
  rateLimiter(tgAccountId: string): RateLimiter {
    let rl = this.limiters.get(tgAccountId);
    if (!rl) {
      rl = new RateLimiter(this.defaults);
      this.limiters.set(tgAccountId, rl);
    }
    return rl;
  }

  /** Drops the cached client for `tgAccountId` (e.g. after a ban). */
  async invalidate(tgAccountId: string): Promise<void> {
    await this.sessions.invalidate(tgAccountId);
  }
}
