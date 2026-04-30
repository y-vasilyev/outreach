import { platformRegistry } from './registry.js';
import { TelegramAdapter } from './adapters/telegram.js';
import { InstagramAdapter } from './adapters/instagram.js';
import { YoutubeAdapter } from './adapters/youtube.js';
import type { ScrapeCreatorsClient } from './scrapecreators/Client.js';
import type { TgScrapeClient } from './types.js';

export * from './types.js';
export type { TgScrapeClient } from './types.js';
export { platformRegistry } from './registry.js';
export type { PlatformRegistry } from './registry.js';
export { TelegramAdapter } from './adapters/telegram.js';
export { InstagramAdapter } from './adapters/instagram.js';
export { YoutubeAdapter } from './adapters/youtube.js';
export {
  ScrapeCreatorsClient,
  type ScrapeCreatorsClientOptions,
  type InstagramProfile,
  type InstagramPost,
  type InstagramPostsResult,
  type YoutubeChannel,
  type YoutubeVideo,
  type YoutubeVideosResult,
} from './scrapecreators/Client.js';

/**
 * Register the default set of platform adapters into the global registry.
 *
 * Adapters are stateless — the optional `tgClient` / `scrapeCreators` clients
 * passed here are NOT bound to the adapters themselves; they are forwarded
 * via `ScrapeCtx` per call. We accept them here purely for future ergonomics
 * (callers can pass `undefined` and supply per-call ctx).
 */
export function registerDefaults(
  _opts: {
    tgClient?: TgScrapeClient;
    scrapeCreators?: ScrapeCreatorsClient;
  } = {},
): void {
  platformRegistry.register(new TelegramAdapter());
  platformRegistry.register(new InstagramAdapter());
  platformRegistry.register(new YoutubeAdapter());
}
