import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PlusIcon, PlayIcon, PauseIcon } from '@heroicons/react/24/outline';
import { PageHeader } from '../../components/PageHeader';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { StatusDot } from '../../components/StatusDot';
import { EmptyState } from '../../components/EmptyState';
import { Spinner } from '../../components/Spinner';
import { CampaignForm } from './CampaignForm';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { formatNumber, formatRelative, formatPct, truncate } from '../../lib/format';

export interface Campaign {
  id: string;
  name: string;
  goal_text: string;
  value_prop: string;
  status: 'draft' | 'running' | 'paused' | 'finished';
  default_mode: 'auto' | 'assisted' | 'manual';
  target_filter?: Record<string, unknown>;
  outreach_account_pool?: string[];
  schedule?: { tz?: string; work_hours?: string; days?: string[]; max_per_day_per_account?: number };
  agent_overrides?: Record<string, unknown>;
  metrics?: { sent: number; replies: number; reply_rate: number; qualified: number };
  created_at: string;
  updated_at: string;
}

export function CampaignsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Campaign | null>(null);

  const { data: campaigns = [], isLoading } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => api.get<Campaign[]>('/campaigns'),
  });

  const runMut = useMutation({
    mutationFn: (id: string) => api.post<void>(`/campaigns/${id}/run`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      toast.success('Кампания запущена');
    },
  });
  const pauseMut = useMutation({
    mutationFn: (id: string) => api.post<void>(`/campaigns/${id}/pause`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaigns'] });
      toast.info('Кампания на паузе');
    },
  });

  return (
    <div>
      <PageHeader
        title="Кампании"
        description="CustDev-кампании: цель, value-prop, фильтр сегмента, расписание, агент-оверрайды."
        actions={
          <Button leftIcon={<PlusIcon className="h-4 w-4" />} onClick={() => { setEditing(null); setFormOpen(true); }}>
            Новая кампания
          </Button>
        }
      />
      {isLoading ? (
        <div className="flex h-48 items-center justify-center">
          <Spinner className="text-brand-500" />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="card">
          <EmptyState
            title="Кампаний пока нет"
            description="Создайте первую: цель — CustDev по продукту, фильтр — каналы и роли."
            action={
              <Button leftIcon={<PlusIcon className="h-4 w-4" />} onClick={() => setFormOpen(true)}>
                Создать
              </Button>
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {campaigns.map((c) => (
            <div key={c.id} className="card-padded">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link to={`/campaigns/${c.id}`} className="text-base font-semibold text-slate-900 hover:text-brand-700">
                    {c.name}
                  </Link>
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <StatusDot status={c.status} />
                    <Badge tone={c.default_mode === 'auto' ? 'indigo' : c.default_mode === 'assisted' ? 'violet' : 'amber'}>
                      mode: {c.default_mode}
                    </Badge>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {c.status === 'running' ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      leftIcon={<PauseIcon className="h-4 w-4" />}
                      onClick={() => pauseMut.mutate(c.id)}
                    >
                      Пауза
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      leftIcon={<PlayIcon className="h-4 w-4" />}
                      onClick={() => runMut.mutate(c.id)}
                    >
                      Запустить
                    </Button>
                  )}
                </div>
              </div>
              <p className="mt-3 line-clamp-2 text-sm text-slate-600">{c.goal_text}</p>
              <div className="mt-2 text-xs text-slate-500">
                value-prop: <span className="text-slate-700">{truncate(c.value_prop, 100)}</span>
              </div>
              <div className="mt-4 grid grid-cols-4 gap-3">
                <Stat label="Sent" value={formatNumber(c.metrics?.sent ?? 0)} />
                <Stat label="Replies" value={formatNumber(c.metrics?.replies ?? 0)} />
                <Stat label="Reply-rate" value={formatPct(c.metrics?.reply_rate ?? 0)} />
                <Stat label="Qualified" value={formatNumber(c.metrics?.qualified ?? 0)} />
              </div>
              <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
                <span>Обновлена {formatRelative(c.updated_at)}</span>
                <Link to={`/campaigns/${c.id}`} className="font-medium text-brand-600 hover:text-brand-500">
                  Подробнее →
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
      <CampaignForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        campaign={editing}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['campaigns'] });
          setFormOpen(false);
        }}
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2 ring-1 ring-slate-200">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="text-sm font-semibold text-slate-900 tabular-nums">{value}</div>
    </div>
  );
}
