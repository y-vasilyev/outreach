import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, PencilSquareIcon, TrashIcon, BoltIcon } from '@heroicons/react/24/outline';
import { PageHeader } from '../../components/PageHeader';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { Switch } from '../../components/Switch';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { EmptyState } from '../../components/EmptyState';
import { Spinner } from '../../components/Spinner';
import { EndpointForm } from './EndpointForm';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import { cn } from '../../lib/cn';

export interface LLMEndpoint {
  id: string;
  name: string;
  provider: 'yandex' | 'openrouter' | 'openai_compat';
  base_url: string;
  default_headers?: Record<string, string>;
  rate_limit_rpm?: number | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export function EndpointsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<LLMEndpoint | null>(null);
  const [deleteFor, setDeleteFor] = useState<LLMEndpoint | null>(null);

  const { data: endpoints = [], isLoading } = useQuery({
    queryKey: ['endpoints'],
    queryFn: () => api.get<LLMEndpoint[]>('/endpoints'),
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<LLMEndpoint>(`/endpoints/${id}`, { enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['endpoints'] }),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.del<void>(`/endpoints/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['endpoints'] });
      toast.success('Endpoint удалён');
      setDeleteFor(null);
    },
    onError: (e: Error) => toast.error('Не удалось удалить', e.message),
  });

  const testMut = useMutation({
    mutationFn: (id: string) => api.post<{ ok: boolean; latency_ms?: number; error?: string }>(`/endpoints/${id}/test`, {}),
    onSuccess: (r) => {
      if (r.ok) toast.success('Endpoint отвечает', r.latency_ms ? `${r.latency_ms} мс` : undefined);
      else toast.error('Endpoint не отвечает', r.error);
    },
  });

  return (
    <div>
      <PageHeader
        title="LLM endpoints"
        description="Подключения к Yandex Foundation Models, OpenRouter, self-hosted (OpenAI-compat)."
        actions={
          <Button leftIcon={<PlusIcon className="h-4 w-4" />} onClick={() => { setEditing(null); setFormOpen(true); }}>
            Добавить endpoint
          </Button>
        }
      />
      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Spinner className="text-brand-500" />
        </div>
      ) : endpoints.length === 0 ? (
        <div className="card">
          <EmptyState
            title="Endpoint-ов ещё нет"
            description="Создайте подключение к Yandex или OpenRouter, чтобы агенты могли работать."
            action={
              <Button leftIcon={<PlusIcon className="h-4 w-4" />} onClick={() => setFormOpen(true)}>
                Добавить
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {endpoints.map((e) => (
            <div key={e.id} className="card-padded">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate text-base font-semibold text-slate-900">{e.name}</h3>
                    <Badge tone={providerTone(e.provider)}>{e.provider}</Badge>
                    {!e.enabled && <Badge tone="gray">disabled</Badge>}
                  </div>
                  <div className="mt-1 truncate font-mono text-xs text-slate-500">{e.base_url}</div>
                </div>
                <Switch
                  checked={e.enabled}
                  onChange={(v) => toggleMut.mutate({ id: e.id, enabled: v })}
                />
              </div>
              <div className="mt-4 flex items-center gap-4 text-xs text-slate-500">
                <div>
                  RPM: <span className="font-medium text-slate-700">{e.rate_limit_rpm ?? '—'}</span>
                </div>
                <div>Обновлён: {formatDateTime(e.updated_at)}</div>
              </div>
              <div className="mt-5 flex items-center justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<BoltIcon className="h-4 w-4" />}
                  loading={testMut.isPending}
                  onClick={() => testMut.mutate(e.id)}
                >
                  Тест
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  leftIcon={<PencilSquareIcon className="h-4 w-4" />}
                  onClick={() => {
                    setEditing(e);
                    setFormOpen(true);
                  }}
                >
                  Редактировать
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={cn('text-rose-600 hover:bg-rose-50')}
                  leftIcon={<TrashIcon className="h-4 w-4" />}
                  onClick={() => setDeleteFor(e)}
                >
                  Удалить
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      <EndpointForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        endpoint={editing}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['endpoints'] });
          setFormOpen(false);
        }}
      />
      <ConfirmDialog
        open={!!deleteFor}
        onClose={() => setDeleteFor(null)}
        onConfirm={() => deleteFor && delMut.mutate(deleteFor.id)}
        title="Удалить endpoint?"
        description={`Endpoint "${deleteFor?.name}" перестанет работать. Агенты, использующие его, упадут на fallback или ошибку.`}
        confirmLabel="Удалить"
        destructive
        loading={delMut.isPending}
      />
    </div>
  );
}

function providerTone(p: string): 'emerald' | 'sky' | 'violet' | 'gray' {
  if (p === 'yandex') return 'emerald';
  if (p === 'openrouter') return 'sky';
  if (p === 'openai_compat') return 'violet';
  return 'gray';
}
