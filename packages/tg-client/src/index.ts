export { TgClient } from './TgClient.js';
export type { TgClientOptions } from './TgClient.js';
export { SessionManager, classifyTgError } from './SessionManager.js';
export type { SessionLoader } from './SessionManager.js';
export { RateLimiter } from './RateLimiter.js';
export { FloodGuard, floodGuard } from './FloodGuard.js';
export type {
  HistoryMessage,
  IncomingHandler,
  IncomingMessage,
  RateConsumeBlocked,
  RateConsumeOk,
  RateConsumeResult,
  RateKind,
  RateLimits,
  RateState,
  RecentPost,
  ResolvedChannel,
  ResolvedUser,
  SendMessageResult,
  TelegramClientHandle,
  TgAccountStatus,
  TgBootstrapSession,
  TgCredentials,
  TgProxyConfig,
  TgSessionRecord,
} from './types.js';
export { fetchHistorySinceImpl } from './methods/fetchHistorySince.js';
