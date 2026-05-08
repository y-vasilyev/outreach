import type {
  HistoryMessage,
  RecentPost,
  ResolvedChannel,
  ResolvedUser,
  SendMessageResult,
  TelegramClientHandle,
} from '../src/types.js';

/**
 * Returns a fake `TelegramClientHandle` that responds to every method with
 * canned data. Used by integration tests of consumer packages — they should
 * never need a real GramJS client.
 */
export function mockTelegramClientHandle(
  tgAccountId: string,
  overrides: Partial<TelegramClientHandle> = {},
): TelegramClientHandle {
  const defaultChannel: ResolvedChannel = {
    id: '1001234567890',
    accessHash: '987654321',
    handle: 'mock_channel',
    title: 'Mock Channel',
    about:
      'Реклама @ad_manager_mock | Контакт: ads@example.com | https://t.me/+mockinvite',
    participantsCount: 12345,
    language: 'ru',
    raw: { mock: true },
  };

  const defaultPosts: RecentPost[] = [
    {
      id: 1,
      dateIso: '2025-01-01T12:00:00.000Z',
      text: 'Hello world https://example.com',
      urls: ['https://example.com'],
    },
    {
      id: 2,
      dateIso: '2025-01-02T12:00:00.000Z',
      text: 'Second post',
      urls: [],
    },
  ];

  const defaultUser: ResolvedUser = {
    id: '999000111',
    accessHash: '555444333',
    username: 'mock_user',
    firstName: 'Mock',
    lastName: 'User',
    isBot: false,
    raw: { mock: true },
  };

  const handle: TelegramClientHandle = {
    tgAccountId,
    isAuthorized: true,
    client: { mock: true },

    async getMe() {
      return { id: '111222333', username: 'mock_self' };
    },

    async resolveChannel(handleStr: string) {
      return { ...defaultChannel, handle: handleStr || defaultChannel.handle };
    },

    async getRecentPosts(_handleStr: string, limit: number) {
      return defaultPosts.slice(0, Math.max(0, limit));
    },

    async resolveUser(_usernameOrId: string) {
      return defaultUser;
    },

    async sendMessage(
      _toUsernameOrId: string,
      _text: string,
    ): Promise<SendMessageResult> {
      return {
        tgMsgId: String(Math.floor(Math.random() * 1_000_000)),
        sentAt: new Date().toISOString(),
      };
    },

    async fetchHistorySince(_opts: {
      peerKey: string;
      sinceTgMsgId?: string;
      limit?: number;
    }): Promise<HistoryMessage[]> {
      // Empty by default — overrides supply concrete fixtures.
      return [];
    },

    async startLogin(_phone: string) {
      return { phoneCodeHash: 'mock_phone_code_hash' };
    },

    async confirmCode(_phone, _phoneCodeHash, _code) {
      return {
        ok: true,
        needs2FA: false,
        sessionString: 'mock_session_string',
      };
    },

    async confirmPassword(_password) {
      return { sessionString: 'mock_session_string' };
    },

    async disconnect() {
      /* no-op */
    },

    ...overrides,
  };

  return handle;
}
