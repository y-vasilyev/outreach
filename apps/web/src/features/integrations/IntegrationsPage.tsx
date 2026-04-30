import { useState, useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircleIcon, ExclamationTriangleIcon, BoltIcon, KeyIcon } from '@heroicons/react/24/outline';
import { PageHeader } from '../../components/PageHeader';
import { Input } from '../../components/Input';
import { Button } from '../../components/Button';
import { Switch } from '../../components/Switch';
import { Badge } from '../../components/Badge';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { cn } from '../../lib/cn';

interface Integration {
  kind: string;
  enabled: boolean;
  status: 'ok' | 'error' | 'unknown' | string;
  last_check_at: string | null;
  config: { api_key?: string; base_url?: string; quota_used?: number; quota_limit?: number };
}

const kinds = [
  {
    key: 'scrapecreators',
    title: 'ScrapeCreators',
    description: 'REST API для скрейпа Instagram и YouTube. Используется адаптерами IG/YT.',
    fields: ['api_key', 'base_url'] as const,
  },
];

export function IntegrationsPage() {
  return (
    <div>
      <PageHeader
        title="Интеграции"
        description="Внешние API для скрейпа и обогащения данных. Ключи хранятся зашифрованными."
      />
      <div className="space-y-5">
        {kinds.map((k) => (
          <IntegrationCard key={k.key} kind={k.key} title={k.title} description={k.description} />
        ))}
      </div>
    </div>
  );
}

function IntegrationCard({ kind, title, description }: { kind: string; title: string; description: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data, isLoading } = useQuery({
    queryKey: ['integration', kind],
    queryFn: () => api.get<Integration>(`/integrations/${kind}`),
  });
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.scrapecreators.com');
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (data) {
      setApiKey(data.config?.api_key ?? '');
      setBaseUrl(data.config?.base_url ?? 'https://api.scrapecreators.com');
      setEnabled(data.enabled);
    }
  }, [data]);

  const saveMut = useMutation({
    mutationFn: () =>
      api.put<Integration>(`/integrations/${kind}`, {
        enabled,
        config: { api_key: apiKey, base_url: baseUrl },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['integration', kind] });
      toast.success('Интеграция сохранена');
    },
    onError: (e: Error) => toast.error('Не удалось сохранить', e.message),
  });

  const testMut = useMutation({
    mutationFn: () => api.post<{ ok: boolean; latency_ms?: number; error?: string }>(`/integrations/${kind}/test`, {}),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['integration', kind] });
      if (r.ok) toast.success('Коннект OK', r.latency_ms ? `${r.latency_ms} мс` : undefined);
      else toast.error('Коннект не прошёл', r.error);
    },
    onError: (e: Error) => toast.error('Ошибка проверки', e.message),
  });

  const statusTone =
    data?.status === 'ok' ? 'emerald' : data?.status === 'error' ? 'rose' : 'gray';

  return (
    <div className="card-padded">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-slate-900">{title}</h2>
            <Badge tone={statusTone} dot>
              {data?.status ?? 'unknown'}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-slate-500">{description}</p>
          {data?.last_check_at && (
            <p className="mt-1 text-xs text-slate-400">
              Последняя проверка: {formatDateTime(data.last_check_at)}
            </p>
          )}
        </div>
        <Switch checked={enabled} onChange={setEnabled} label="Включено" />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2">
        <Input
          label="API ключ"
          type="password"
          placeholder="sk-..."
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          leftIcon={<KeyIcon className="h-4 w-4" />}
        />
        <Input
          label="Base URL"
          placeholder="https://api.scrapecreators.com"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>

      {data?.config?.quota_limit && (
        <div className="mt-4 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span>Квота</span>
            <span>
              {data.config.quota_used ?? 0} / {data.config.quota_limit}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-200">
            <div
              className={cn(
                'h-full',
                (data.config.quota_used ?? 0) / data.config.quota_limit > 0.8 ? 'bg-rose-500' : 'bg-brand-500',
              )}
              style={{
                width: `${Math.min(100, ((data.config.quota_used ?? 0) / data.config.quota_limit) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      <div className="mt-5 flex items-center justify-end gap-2">
        <Button
          variant="secondary"
          leftIcon={<BoltIcon className="h-4 w-4" />}
          loading={testMut.isPending}
          onClick={() => testMut.mutate()}
          disabled={isLoading || !apiKey}
        >
          Проверить коннект
        </Button>
        <Button onClick={() => saveMut.mutate()} loading={saveMut.isPending} disabled={isLoading}>
          Сохранить
        </Button>
      </div>

      {data?.status === 'error' && (
        <div className="mt-4 flex items-start gap-3 rounded-xl bg-rose-50 p-3 text-sm text-rose-700 ring-1 ring-rose-200">
          <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>Сервис вернул ошибку при последней проверке. Проверьте ключ и квоту.</div>
        </div>
      )}
      {data?.status === 'ok' && (
        <div className="mt-4 flex items-start gap-3 rounded-xl bg-emerald-50 p-3 text-sm text-emerald-700 ring-1 ring-emerald-200">
          <CheckCircleIcon className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <div>Коннект работает.</div>
        </div>
      )}
    </div>
  );
}
