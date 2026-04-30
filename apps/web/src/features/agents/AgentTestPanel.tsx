import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { PlayIcon } from '@heroicons/react/24/outline';
import { Select } from '../../components/Select';
import { Textarea } from '../../components/Textarea';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { formatMoney, formatNumber } from '../../lib/format';

interface AgentRef {
  id: string;
  name: string;
}

interface TestResp {
  output: unknown;
  tokens_in?: number;
  tokens_out?: number;
  latency_ms?: number;
  cost_usd?: number;
  status: 'ok' | 'fallback' | 'failed';
  error?: string;
}

export function AgentTestPanel({ agent }: { agent: AgentRef }) {
  const toast = useToast();
  const fixtures = useMemo(() => fixturesFor(agent.name), [agent.name]);
  const [fixtureKey, setFixtureKey] = useState(fixtures[0]?.key ?? 'custom');
  const [inputJson, setInputJson] = useState(JSON.stringify(fixtures[0]?.input ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TestResp | null>(null);

  useEffect(() => {
    const f = fixtures.find((x) => x.key === fixtureKey);
    if (f) setInputJson(JSON.stringify(f.input, null, 2));
  }, [fixtureKey, fixtures]);

  const mut = useMutation({
    mutationFn: () => {
      let payload: unknown;
      try {
        payload = JSON.parse(inputJson || '{}');
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
      setError(null);
      return api.post<TestResp>(`/agents/${agent.id}/test`, { input: payload, dry_run: true });
    },
    onSuccess: (r) => {
      setResult(r);
      if (r.status === 'failed') toast.error('Запуск упал', r.error);
    },
    onError: (e: Error) => toast.error('Ошибка теста', e.message),
  });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="card-padded">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-900">Input</h3>
          <Select
            value={fixtureKey}
            onChange={(e) => setFixtureKey(e.target.value)}
            options={[
              ...fixtures.map((f) => ({ value: f.key, label: f.label })),
              { value: 'custom', label: 'custom' },
            ]}
            className="w-44"
          />
        </div>
        <Textarea
          rows={18}
          fontMono
          className="mt-3"
          value={inputJson}
          onChange={(e) => {
            setFixtureKey('custom');
            setInputJson(e.target.value);
          }}
          error={error ?? undefined}
        />
        <div className="mt-4 flex justify-end">
          <Button leftIcon={<PlayIcon className="h-4 w-4" />} onClick={() => mut.mutate()} loading={mut.isPending}>
            Запустить (dry-run)
          </Button>
        </div>
      </div>
      <div className="card-padded">
        <h3 className="text-sm font-semibold text-slate-900">Output</h3>
        {result ? (
          <>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
              <Badge tone={result.status === 'ok' ? 'emerald' : result.status === 'fallback' ? 'amber' : 'rose'}>
                {result.status}
              </Badge>
              {result.tokens_in !== undefined && (
                <Badge tone="slate">
                  tokens {formatNumber(result.tokens_in)}/{formatNumber(result.tokens_out ?? 0)}
                </Badge>
              )}
              {result.latency_ms !== undefined && <Badge tone="slate">{result.latency_ms} мс</Badge>}
              {result.cost_usd !== undefined && <Badge tone="slate">{formatMoney(result.cost_usd)}</Badge>}
            </div>
            <pre className="mt-3 max-h-[420px] overflow-auto rounded-xl bg-slate-900 p-4 font-mono text-[12px] text-slate-100 scrollbar-thin">
              {JSON.stringify(result.output, null, 2)}
            </pre>
            {result.error && <div className="mt-3 text-xs text-rose-600">{result.error}</div>}
          </>
        ) : (
          <div className="mt-6 flex h-64 items-center justify-center rounded-xl bg-slate-50 text-sm text-slate-500 ring-1 ring-slate-200">
            Запустите тест, чтобы увидеть результат
          </div>
        )}
      </div>
    </div>
  );
}

interface Fixture {
  key: string;
  label: string;
  input: unknown;
}

function fixturesFor(name: string): Fixture[] {
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
          recent_posts: [
            { date: '2026-04-20', text: 'Запустили beta фичу для B2B', urls: [] },
          ],
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
      {
        key: 'busy',
        label: 'Занят',
        input: { last_inbound: 'Спасибо, сейчас сильно занят, может позже', history_tail: [] },
      },
      {
        key: 'wants_money',
        label: 'Хочет денег за рекламу',
        input: { last_inbound: 'Прайс на рекламу пришлю', history_tail: [] },
      },
    ];
  }
  return [
    {
      key: 'empty',
      label: 'Пустой',
      input: {},
    },
  ];
}
