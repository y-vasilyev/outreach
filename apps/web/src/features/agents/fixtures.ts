export interface AgentTestFixture {
  key: string;
  label: string;
  input: unknown;
}

/**
 * Per-agent canned inputs for the dry-run test panel. Match the React
 * fixtures from the previous app so operators can re-run the same
 * baseline tests after we ported.
 */
export function fixturesFor(name: string): AgentTestFixture[] {
  if (name === 'channel_analyzer') {
    return [
      {
        key: 'tg-startup',
        label: 'TG: стартап-канал',
        input: {
          platform: 'telegram',
          title: 'Founders Diary',
          description: 'Заметки фаундера B2B SaaS. По рекламе → @ad_manager_x',
          links: ['https://example.com'],
          followers: 12500,
          recent_posts: [{ date: '2026-04-20', text: 'Запустили beta фичу для B2B', urls: [] }],
        },
      },
      {
        key: 'ig-lifestyle',
        label: 'IG: lifestyle',
        input: {
          platform: 'instagram',
          title: 'Anya Travels',
          description: 'travel + lifestyle. collabs: anya@example.com',
          links: ['https://anya.example.com'],
          followers: 84000,
          recent_posts: [],
        },
      },
    ];
  }
  if (name === 'contact_extractor') {
    return [
      {
        key: 'simple',
        label: 'Простой: один ad_manager',
        input: {
          platform: 'telegram',
          channel_title: 'Founders Diary',
          description: 'B2B SaaS. По рекламе писать @ad_manager_x',
          links: [],
          recent_posts_text: '',
          regex_candidates: [
            { type: 'tg_username', raw_value: '@ad_manager_x', context_snippet: 'По рекламе писать @ad_manager_x' },
          ],
        },
      },
    ];
  }
  if (name === 'opening_composer') {
    return [
      {
        key: 'b2b',
        label: 'B2B: founder',
        input: {
          channel_analysis: { topic: 'B2B SaaS', audience: 'founders/PMs', tone: 'casual' },
          contact: { type: 'tg_username', value: 'ad_manager_x', role_guess: 'ad_manager' },
          strategy: { approach: 'industry_fit', hook: 'B2B SaaS канал', why_them: 'релевантная аудитория' },
          campaign: { goal_text: '20 минут CustDev по продукту X', value_prop: 'доступ к бете + $30' },
        },
      },
    ];
  }
  if (name === 'safety_filter') {
    return [
      {
        key: 'clean',
        label: 'Чистый текст',
        input: {
          draft: 'Привет! Видел канал про B2B SaaS. Делаем продукт для онбординга, ищем 5 фаундеров на 20-минутное интервью. За время — доступ к бете и $30. Удобно ли?',
          channel_analysis: { topic: 'B2B SaaS' },
          contact: { type: 'tg_username' },
          campaign: { goal_text: 'CustDev', value_prop: '$30 + бета' },
        },
      },
      {
        key: 'salesy',
        label: 'Продажный (должен заблокировать)',
        input: {
          draft: 'Привет! Хотим разместить рекламу у вас, есть выгодное предложение, обсудим интеграцию?',
          channel_analysis: {},
          contact: {},
          campaign: { goal_text: 'CustDev', value_prop: '$30' },
        },
      },
    ];
  }
  if (name === 'intent_classifier') {
    return [
      { key: 'busy', label: 'Занят', input: { last_inbound: 'Спасибо, сейчас сильно занят, может позже', history_tail: [] } },
      { key: 'wants_money', label: 'Хочет денег за рекламу', input: { last_inbound: 'Прайс на рекламу пришлю', history_tail: [] } },
    ];
  }
  return [{ key: 'empty', label: 'Пустой', input: {} }];
}
