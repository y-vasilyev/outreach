import { AppError } from '@nosquare/shared/errors';
import type {
  ChannelSnapshot,
  ChannelSnapshotPost,
  PlatformAdapter,
  ScrapeCtx,
} from '../types.js';

const TG_HANDLE_RE = /^[a-zA-Z0-9_]{5,32}$/;

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = 'telegram' as const;

  parseHandle(input: string): { handle: string } | null {
    if (typeof input !== 'string') return null;
    let s = input.trim();
    if (!s) return null;

    // tg://resolve?domain=name
    if (/^tg:\/\//i.test(s)) {
      const m = s.match(/[?&]domain=([a-zA-Z0-9_]+)/i);
      if (m && m[1] && TG_HANDLE_RE.test(m[1])) return { handle: m[1] };
      return null;
    }

    const hadProto = /^https?:\/\//i.test(s);
    s = s.replace(/^https?:\/\//i, '');
    s = s.replace(/^www\./i, '');

    let hadHost = false;
    if (s.startsWith('t.me/')) {
      s = s.slice('t.me/'.length);
      hadHost = true;
    } else if (s.startsWith('telegram.me/')) {
      s = s.slice('telegram.me/'.length);
      hadHost = true;
    } else if (s.startsWith('telegram.dog/')) {
      s = s.slice('telegram.dog/'.length);
      hadHost = true;
    } else if (hadProto) {
      return null;
    }

    if (s.startsWith('@')) s = s.slice(1);

    s = s.split(/[?#]/)[0] ?? '';
    s = s.replace(/\/+$/, '');

    let first: string;
    if (hadHost) {
      first = s.split('/')[0] ?? '';
    } else {
      if (s.includes('/')) return null;
      first = s;
    }

    // joinchat/private invite links: not a public channel handle
    if (!first || first === 'joinchat' || first.startsWith('+')) return null;
    if (!TG_HANDLE_RE.test(first)) return null;
    return { handle: first };
  }

  async scrapeChannel(handle: string, ctx: ScrapeCtx): Promise<ChannelSnapshot> {
    if (!ctx.tgClient) {
      throw new AppError(
        'BAD_REQUEST',
        'TelegramAdapter.scrapeChannel: ctx.tgClient required',
        400,
      );
    }
    const tg = ctx.tgClient;

    const [channel, posts] = await Promise.all([
      tg.resolveChannel(handle),
      tg.getRecentPosts(handle, 12),
    ]);

    const snapshotPosts: ChannelSnapshotPost[] = posts.map((p) => ({
      id: String(p.id),
      date: p.dateIso,
      text: p.text,
      urls: p.urls,
    }));

    return {
      platform: 'telegram',
      externalId: String(channel.id),
      handle,
      title: channel.title ?? handle,
      description: channel.about ?? '',
      // TG channel public links live inside `about` — leave to ContactExtractor.
      links: [],
      followers: channel.participantsCount,
      language: channel.language,
      posts: snapshotPosts,
      raw: { channel, posts },
    };
  }
}
