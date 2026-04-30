import { useEffect, useState, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, ArrowPathIcon, CheckIcon } from '@heroicons/react/24/outline';
import { PageHeader } from '../../components/PageHeader';
import { Tabs } from '../../components/Tabs';
import { Input } from '../../components/Input';
import { Select } from '../../components/Select';
import { Textarea } from '../../components/Textarea';
import { Switch } from '../../components/Switch';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { Spinner } from '../../components/Spinner';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { formatDateTime, formatMoney, formatNumber } from '../../lib/format';
import { cn } from '../../lib/cn';
import { AgentTestPanel } from './AgentTestPanel';
import type { LLMEndpoint } from '../endpoints/EndpointsPage';

interface AgentConfig {
  id: string;
  name: string;
  role?: string;
  description?: string;
  endpoint_id: string | null;
  endpoint?: { id: string; name: string };
  fallback_endpoint_id: string | null;
  model: string;
  system_prompt: string;
  user_prompt_template: string;
  params: Record<string, unknown>;
  enabled: boolean;
  variables?: string[];
  version: number;
  updated_at: string;
}

interface AgentRunHistory {
  id: string;
  agent_name: string;
  status: 'ok' | 'fallback' | 'failed';
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  created_at: string;
  endpoint_id?: string;
  model?: string;
  error?: string | null;
}

export function AgentDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<'config' | 'test' | 'history'>('config');

  const { data: agent, isLoading } = useQuery({
    queryKey: ['agent', id],
    queryFn: () => api.get<AgentConfig>(`/agents/${id}`),
    enabled: !!id,
  });

  const { data: endpoints = [] } = useQuery({
    queryKey: ['endpoints'],
    queryFn: () => api.get<LLMEndpoint[]>('/endpoints'),
  });

  return (
    <div>
      <PageHeader
        title={agent?.name ?? 'Agent'}
        description={agent?.description ?? agent?.role ?? 'Карточка агента'}
        breadcrumbs={
          <Link to="/agents" className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-700">
            <ArrowLeftIcon className="h-3.5 w-3.5" />
            Все агенты
          </Link>
        }
        actions={agent && <Badge tone="indigo">v{agent.version}</Badge>}
      />
      {isLoading || !agent ? (
        <div className="flex h-48 items-center justify-center">
          <Spinner className="text-brand-500" />
        </div>
      ) : (
        <div>
          <Tabs
            tabs={[
              { key: 'config', label: 'Config' },
              { key: 'test', label: 'Test' },
              { key: 'history', label: 'История' },
            ]}
            current={tab}
            onChange={(k) => setTab(k as typeof tab)}
          />
          <div className="mt-6">
            {tab === 'config' && (
              <ConfigForm
                agent={agent}
                endpoints={endpoints}
                onSaved={() => {
                  qc.invalidateQueries({ queryKey: ['agent', id] });
                  qc.invalidateQueries({ queryKey: ['agents'] });
                  toast.success('Конфиг сохранён', `Версия v${(agent.version ?? 0) + 1}`);
                }}
              />
            )}
            {tab === 'test' && <AgentTestPanel agent={agent} />}
            {tab === 'history' && <HistoryPanel agentId={agent.id} agentName={agent.name} />}
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigForm({
  agent,
  endpoints,
  onSaved,
}: {
  agent: AgentConfig;
  endpoints: LLMEndpoint[];
  onSaved: () => void;
}) {
  const toast = useToast();
  const [endpointId, setEndpointId] = useState(agent.endpoint_id ?? '');
  const [fallbackId, setFallbackId] = useState(agent.fallback_endpoint_id ?? '');
  const [model, setModel] = useState(agent.model);
  const [systemPrompt, setSystemPrompt] = useState(agent.system_prompt);
  const [userTemplate, setUserTemplate] = useState(agent.user_prompt_template);
  const [enabled, setEnabled] = useState(agent.enabled);
  const [paramsJson, setParamsJson] = useState(JSON.stringify(agent.params ?? {}, null, 2));
  const [paramsError, setParamsError] = useState<string | null>(null);

  useEffect(() => {
    setEndpointId(agent.endpoint_id ?? '');
    setFallbackId(agent.fallback_endpoint_id ?? '');
    setModel(agent.model);
    setSystemPrompt(agent.system_prompt);
    setUserTemplate(agent.user_prompt_template);
    setEnabled(agent.enabled);
    setParamsJson(JSON.stringify(agent.params ?? {}, null, 2));
  }, [agent]);

  const usedVars = useMemo(() => extractVars(`${systemPrompt}\n${userTemplate}`), [systemPrompt, userTemplate]);
  const missing = (agent.variables ?? []).filter((v) => !usedVars.has(v));

  const mut = useMutation({
    mutationFn: () => {
      let params: unknown = {};
      try {
        params = JSON.parse(paramsJson || '{}');
        setParamsError(null);
      } catch (e) {
        setParamsError((e as Error).message);
        throw e;
      }
      return api.patch<AgentConfig>(`/agents/${agent.id}`, {
        endpoint_id: endpointId || null,
        fallback_endpoint_id: fallbackId || null,
        model,
        system_prompt: systemPrompt,
        user_prompt_template: userTemplate,
        enabled,
        params,
      });
    },
    onSuccess: () => onSaved(),
    onError: (e: Error) => toast.error('Не удалось сохранить', e.message),
  });

  const epOptions = endpoints.map((e) => ({ value: e.id, label: `${e.name} (${e.provider})` }));

  return (
    <div className="space-y-6">
      <div className="card-padded">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Select
            label="Endpoint"
            value={endpointId}
            onChange={(e) => setEndpointId(e.target.value)}
            options={[{ value: '', label: '— не задан —' }, ...epOptions]}
          />
          <Select
            label="Fallback endpoint"
            value={fallbackId}
            onChange={(e) => setFallbackId(e.target.value)}
            options={[{ value: '', label: '— нет —' }, ...epOptions]}
          />
          <Input
            label="Модель"
            placeholder="yandexgpt / claude-haiku-4.5 / gpt-4o-mini"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            helpText="Текстовое поле — провайдер сам валидирует имя."
          />
          <div className="flex items-end">
            <Switch
              checked={enabled}
              onChange={setEnabled}
              label="Включён"
              description="Если выключен — агент возвращает fallback или роняет пайплайн."
            />
          </div>
        </div>
      </div>

      <div className="card-padded">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">System prompt</h3>
          <VarsHelp declared={agent.variables} used={usedVars} missing={missing} />
        </div>
        <Textarea
          rows={10}
          fontMono
          className="mt-3"
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
        />
        <div className="mt-2 text-xs text-slate-500">
          <PromptPreview text={systemPrompt} />
        </div>
      </div>

      <div className="card-padded">
        <h3 className="text-sm font-semibold text-slate-900">User prompt template</h3>
        <Textarea
          rows={8}
          fontMono
          className="mt-3"
          value={userTemplate}
          onChange={(e) => setUserTemplate(e.target.value)}
        />
        <div className="mt-2 text-xs text-slate-500">
          <PromptPreview text={userTemplate} />
        </div>
      </div>

      <div className="card-padded">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Params (JSON)</h3>
          <span className="text-xs text-slate-500">temperature, max_tokens, top_p, json_schema, специфичные…</span>
        </div>
        <Textarea
          rows={10}
          fontMono
          className="mt-3"
          value={paramsJson}
          onChange={(e) => setParamsJson(e.target.value)}
          error={paramsError ?? undefined}
        />
      </div>

      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-slate-500">Обновлён: {formatDateTime(agent.updated_at)}</div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => window.location.reload()} leftIcon={<ArrowPathIcon className="h-4 w-4" />}>
            Сбросить
          </Button>
          <Button onClick={() => mut.mutate()} loading={mut.isPending} leftIcon={<CheckIcon className="h-4 w-4" />}>
            Сохранить новую версию
          </Button>
        </div>
      </div>
    </div>
  );
}

function VarsHelp({
  declared,
  used,
  missing,
}: {
  declared?: string[];
  used: Set<string>;
  missing: string[];
}) {
  if (!declared || declared.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-slate-500">Vars:</span>
      {declared.map((v) => {
        const isUsed = used.has(v);
        return (
          <code
            key={v}
            className={cn(
              'rounded-md px-1.5 py-0.5 font-mono ring-1',
              isUsed
                ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                : 'bg-rose-50 text-rose-700 ring-rose-200',
            )}
          >
            {`{{${v}}}`}
          </code>
        );
      })}
      {missing.length > 0 && (
        <span className="text-rose-600">не использованы: {missing.length}</span>
      )}
    </div>
  );
}

function PromptPreview({ text }: { text: string }) {
  const parts = text.split(/(\{\{[a-zA-Z_][\w]*\}\})/g);
  if (parts.length <= 1) return null;
  return (
    <span>
      Подсветка переменных:{' '}
      {parts
        .filter((p) => /^\{\{[a-zA-Z_][\w]*\}\}$/.test(p))
        .map((p, i) => (
          <code key={i} className="mr-1 rounded bg-brand-50 px-1.5 py-0.5 font-mono text-[11px] text-brand-700 ring-1 ring-brand-200">
            {p}
          </code>
        ))}
    </span>
  );
}

function extractVars(s: string): Set<string> {
  const set = new Set<string>();
  const re = /\{\{([a-zA-Z_][\w]*)\}\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m[1]) set.add(m[1]);
  }
  return set;
}

function HistoryPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['agent-history', agentId],
    queryFn: () => api.get<AgentRunHistory[]>(`/agents/${agentId}/history?limit=50`),
  });
  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <Spinner className="text-brand-500" />
      </div>
    );
  }
  if (data.length === 0) {
    return (
      <div className="card">
        <div className="px-6 py-12 text-center text-sm text-slate-500">
          Пока нет запусков агента <code className="font-mono">{agentName}</code>.
        </div>
      </div>
    );
  }
  return (
    <div className="card overflow-hidden">
      <table className="min-w-full divide-y divide-slate-200">
        <thead className="bg-slate-50">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-500">Когда</th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-500">Статус</th>
            <th className="px-4 py-3 text-left text-xs font-semibold uppercase text-slate-500">Модель</th>
            <th className="px-4 py-3 text-right text-xs font-semibold uppercase text-slate-500">Tokens in/out</th>
            <th className="px-4 py-3 text-right text-xs font-semibold uppercase text-slate-500">Latency</th>
            <th className="px-4 py-3 text-right text-xs font-semibold uppercase text-slate-500">Cost</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {data.map((h) => (
            <tr key={h.id}>
              <td className="px-4 py-3 text-sm text-slate-700">{formatDateTime(h.created_at)}</td>
              <td className="px-4 py-3">
                <Badge tone={h.status === 'ok' ? 'emerald' : h.status === 'fallback' ? 'amber' : 'rose'}>
                  {h.status}
                </Badge>
              </td>
              <td className="px-4 py-3 font-mono text-xs text-slate-700">{h.model ?? '—'}</td>
              <td className="px-4 py-3 text-right text-sm text-slate-700">
                {formatNumber(h.tokens_in)} / {formatNumber(h.tokens_out)}
              </td>
              <td className="px-4 py-3 text-right text-sm text-slate-700">{h.latency_ms} мс</td>
              <td className="px-4 py-3 text-right text-sm text-slate-700">{formatMoney(h.cost_usd)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
