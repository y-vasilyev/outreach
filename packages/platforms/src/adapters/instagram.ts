import { AppError } from '@nosquare/shared/errors';
import type {
  ChannelSnapshot,
  ChannelSnapshotPost,
  PlatformAdapter,
  ScrapeCtx,
} from '../types.js';

const IG_HANDLE_RE = /^[a-zA-Z0-9._]{1,30}$/;

export class InstagramAdapter implements PlatformAdapter {
  readonly platform = 'instagram' as const;

  parseHandle(input: string): { handle: string } | null {
    if (typeof input !== 'string') return null;
    let s = input.trim();
    if (!s) return null;

    // Strip URL prefixes
    const hadProto = /^https?:\/\//i.test(s);
    s = s.replace(/^https?:\/\//i, '');
    s = s.replace(/^www\./i, '');
    let hadHost = false;
    if (s.startsWith('instagram.com/')) {
      s = s.slice('instagram.com/'.length);
      hadHost = true;
    } else if (s.startsWith('m.instagram.com/')) {
      s = s.slice('m.instagram.com/'.length);
      hadHost = true;
    } else if (hadProto) {
      // had a protocol but not an instagram host
      return null;
    }

    // Strip leading @
    if (s.startsWith('@')) s = s.slice(1);

    // Strip query/hash and trailing slash
    s = s.split(/[?#]/)[0] ?? '';
    s = s.replace(/\/+$/, '');

    let candidate: string;
    if (hadHost) {
      // path may contain extra segments; take the first one as the username
      candidate = s.split('/')[0] ?? '';
    } else {
      // bare input must not contain a slash
      if (s.includes('/')) return null;
      candidate = s;
    }

    if (!candidate) return null;
    if (!IG_HANDLE_RE.test(candidate)) return null;
    return { handle: candidate.toLowerCase() };
  }

  async scrapeChannel(handle: string, ctx: ScrapeCtx): Promise<ChannelSnapshot> {
    if (!ctx.scrapeCreators) {
      throw new AppError(
        'BAD_REQUEST',
        'InstagramAdapter.scrapeChannel: ctx.scrapeCreators required',
        400,
      );
    }
    const sc = ctx.scrapeCreators;
    const [profile, postsRes] = await Promise.all([
      sc.getInstagramProfile(handle),
      sc.getInstagramPosts(handle, { limit: 12 }),
    ]);

    const posts: ChannelSnapshotPost[] = postsRes.posts.map((p) => ({
      id: p.id,
      date: p.taken_at_iso,
      text: p.caption,
      urls: p.urls,
    }));

    const links = profile.external_url ? [profile.external_url] : [];

    return {
      platform: 'instagram',
      externalId: profile.user_id,
      handle: profile.username || handle,
      title: profile.full_name || profile.username || handle,
      description: profile.biography ?? '',
      links,
      followers: profile.follower_count,
      posts,
      raw: { profile: profile.raw, posts: postsRes.raw },
    };
  }
}
