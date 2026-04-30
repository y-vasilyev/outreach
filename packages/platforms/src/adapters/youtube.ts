import { AppError } from '@nosquare/shared/errors';
import type {
  ChannelSnapshot,
  ChannelSnapshotPost,
  PlatformAdapter,
  ScrapeCtx,
} from '../types.js';

const YT_HANDLE_RE = /^@[a-zA-Z0-9._-]{3,30}$/;
const YT_CHANNEL_ID_RE = /^UC[a-zA-Z0-9_-]{20,30}$/;

export class YoutubeAdapter implements PlatformAdapter {
  readonly platform = 'youtube' as const;

  parseHandle(input: string): { handle: string } | null {
    if (typeof input !== 'string') return null;
    let s = input.trim();
    if (!s) return null;

    const hadProto = /^https?:\/\//i.test(s);
    s = s.replace(/^https?:\/\//i, '');
    s = s.replace(/^www\./i, '');
    s = s.replace(/^m\./i, '');

    // youtube.com/* or youtu.be/*
    let hadHost = false;
    if (s.startsWith('youtube.com/')) {
      s = s.slice('youtube.com/'.length);
      hadHost = true;
    } else if (s.startsWith('youtu.be/')) {
      s = s.slice('youtu.be/'.length);
      hadHost = true;
    } else if (hadProto) {
      // had a protocol but not a YouTube host
      return null;
    }

    s = s.split(/[?#]/)[0] ?? '';
    s = s.replace(/\/+$/, '');

    // channel/UC...
    if (s.startsWith('channel/')) {
      const id = s.slice('channel/'.length).split('/')[0] ?? '';
      if (YT_CHANNEL_ID_RE.test(id)) return { handle: id };
      return null;
    }

    // bare UC... id
    if (YT_CHANNEL_ID_RE.test(s)) {
      return { handle: s };
    }

    // @handle  (path-stripped: take first segment)
    if (s.startsWith('@')) {
      const first = s.split('/')[0] ?? '';
      if (YT_HANDLE_RE.test(first)) return { handle: first };
      return null;
    }

    // bare handle (no @) — only accept if no slash, then prefix '@'
    if (!hadHost && s.includes('/')) return null;
    const first = s.split('/')[0] ?? '';
    const candidate = `@${first}`;
    if (YT_HANDLE_RE.test(candidate)) return { handle: candidate };

    return null;
  }

  async scrapeChannel(handle: string, ctx: ScrapeCtx): Promise<ChannelSnapshot> {
    if (!ctx.scrapeCreators) {
      throw new AppError(
        'BAD_REQUEST',
        'YoutubeAdapter.scrapeChannel: ctx.scrapeCreators required',
        400,
      );
    }
    const sc = ctx.scrapeCreators;
    const [channel, videosRes] = await Promise.all([
      sc.getYoutubeChannel(handle),
      sc.getYoutubeVideos(handle, { limit: 12 }),
    ]);

    const posts: ChannelSnapshotPost[] = videosRes.videos.map((v) => ({
      id: v.id,
      date: v.published_at_iso,
      text: v.title ? `${v.title}\n\n${v.description}` : v.description,
      urls: v.urls,
    }));

    return {
      platform: 'youtube',
      externalId: channel.channel_id,
      handle: channel.handle || handle,
      title: channel.title ?? channel.handle ?? handle,
      description: channel.description ?? '',
      links: channel.links,
      followers: channel.subscriber_count,
      posts,
      raw: { channel: channel.raw, videos: videosRes.raw },
    };
  }
}
