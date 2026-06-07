import { describe, expect, it, vi } from 'vitest';
import { ScrapeCreatorsClient } from '../scrapecreators/Client.js';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
  } as Response;
}

describe('ScrapeCreatorsClient post metric normalization', () => {
  it('normalizes Instagram post metric field variants', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        items: [
          {
            id: 'ig1',
            caption: { text: 'hello https://example.com' },
            taken_at: 1_700_000_000,
            like_count: 123,
            comment_count: 7,
            play_count: 4567,
            save_count: 9,
            product_type: 'clips',
          },
        ],
      }),
    );
    const client = new ScrapeCreatorsClient({ apiKey: 'k', fetchImpl });

    const out = await client.getInstagramPosts('creator');
    expect(out.posts[0]).toMatchObject({
      id: 'ig1',
      metrics: { views: 4567, likes: 123, comments: 7, saves: 9 },
      media_kind: 'reels',
      urls: ['https://example.com'],
    });
  });

  it('normalizes YouTube video metric field variants', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        videos: [
          {
            videoId: 'yt1',
            title: 'Video',
            description: 'Desc',
            publishedAt: '2026-01-01T00:00:00Z',
            viewCount: '12000',
            likeCount: 300,
            commentCount: 20,
          },
        ],
      }),
    );
    const client = new ScrapeCreatorsClient({ apiKey: 'k', fetchImpl });

    const out = await client.getYoutubeVideos('@creator');
    expect(out.videos[0]).toMatchObject({
      id: 'yt1',
      metrics: { views: 12000, likes: 300, comments: 20 },
    });
  });

  it('keeps metrics empty when a source does not provide reliable fields', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ videos: [{ id: 'yt2', title: 'No metrics', description: '' }] }),
    );
    const client = new ScrapeCreatorsClient({ apiKey: 'k', fetchImpl });

    const out = await client.getYoutubeVideos('@creator');
    expect(out.videos[0]!.metrics).toEqual({});
  });
});
