import { describe, expect, it } from 'vitest';
import { TelegramAdapter } from '../adapters/telegram.js';
import { InstagramAdapter } from '../adapters/instagram.js';
import { YoutubeAdapter } from '../adapters/youtube.js';

describe('TelegramAdapter.parseHandle', () => {
  const tg = new TelegramAdapter();

  it.each([
    ['@durovschannel', 'durovschannel'],
    ['durovschannel', 'durovschannel'],
    ['t.me/durovschannel', 'durovschannel'],
    ['https://t.me/durovschannel', 'durovschannel'],
    ['https://t.me/durovschannel/', 'durovschannel'],
    ['https://t.me/durovschannel/123', 'durovschannel'],
    ['https://telegram.me/durovschannel', 'durovschannel'],
    ['tg://resolve?domain=durovschannel', 'durovschannel'],
    ['  @durovschannel  ', 'durovschannel'],
    ['https://www.t.me/durovschannel', 'durovschannel'],
  ])('parses %s -> %s', (input, expected) => {
    expect(tg.parseHandle(input)).toEqual({ handle: expected });
  });

  it.each([
    '',
    '   ',
    '@bad', // too short
    'too', // too short (<5)
    'a'.repeat(33), // too long
    'has spaces',
    'with-dash',
    'https://t.me/joinchat/ABC123',
    'https://t.me/+ABC123',
    'tg://resolve?domain=', // empty
    'tg://resolve?something=else',
    'http://t.me/',
  ])('rejects %s', (input) => {
    expect(tg.parseHandle(input)).toBeNull();
  });
});

describe('InstagramAdapter.parseHandle', () => {
  const ig = new InstagramAdapter();

  it.each([
    ['nasa', 'nasa'],
    ['@nasa', 'nasa'],
    ['NASA', 'nasa'],
    ['instagram.com/nasa', 'nasa'],
    ['instagram.com/nasa/', 'nasa'],
    ['https://instagram.com/nasa/', 'nasa'],
    ['https://www.instagram.com/nasa', 'nasa'],
    ['https://www.instagram.com/nasa?hl=en', 'nasa'],
    ['https://m.instagram.com/nasa', 'nasa'],
    ['user.name', 'user.name'],
    ['user_name_123', 'user_name_123'],
  ])('parses %s -> %s', (input, expected) => {
    expect(ig.parseHandle(input)).toEqual({ handle: expected });
  });

  it.each([
    '',
    '   ',
    'has spaces',
    'has/slash/in/middle',
    'a'.repeat(31),
    'with-dash',
    'https://instagram.com/',
    'no@bracket',
  ])('rejects %s', (input) => {
    expect(ig.parseHandle(input)).toBeNull();
  });
});

describe('YoutubeAdapter.parseHandle', () => {
  const yt = new YoutubeAdapter();

  it.each([
    ['@mkbhd', '@mkbhd'],
    ['mkbhd', '@mkbhd'],
    ['youtube.com/@mkbhd', '@mkbhd'],
    ['https://www.youtube.com/@mkbhd', '@mkbhd'],
    ['https://youtube.com/@mkbhd/videos', '@mkbhd'],
    ['https://m.youtube.com/@mkbhd', '@mkbhd'],
    [
      'youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ',
      'UCBJycsmduvYEL83R_U4JriQ',
    ],
    [
      'https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ',
      'UCBJycsmduvYEL83R_U4JriQ',
    ],
    ['UCBJycsmduvYEL83R_U4JriQ', 'UCBJycsmduvYEL83R_U4JriQ'],
  ])('parses %s -> %s', (input, expected) => {
    expect(yt.parseHandle(input)).toEqual({ handle: expected });
  });

  it.each([
    '',
    '   ',
    '@x', // too short
    'channel/NOT_UC_PREFIX',
    'youtube.com/channel/short',
    'has spaces',
    'https://youtube.com/',
  ])('rejects %s', (input) => {
    expect(yt.parseHandle(input)).toBeNull();
  });
});
