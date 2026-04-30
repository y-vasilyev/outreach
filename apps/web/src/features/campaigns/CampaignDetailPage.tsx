import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftIcon, PlayIcon, PauseIcon, EyeIcon, PencilSquareIcon } from '@heroicons/react/24/outline';
import { PageHeader } from '../../components/PageHeader';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { StatusDot } from '../../components/StatusDot';
import { KeyValue } from '../../components/KeyValue';
import { Spinner } from '../../components/Spinner';
import { Modal } from '../../components/Modal';
import { CampaignForm } from './CampaignForm';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { formatNumber, formatPct } from '../../lib/format';
import type { Campaign } from './CampaignsPage';

interface PreviewItem {
  contactId: string;
  contactValue: string;
  channelTitle?: string;
  drafts: { text: string; riskScore?: number; rationale?: string }[];
  blocked?: { reasons: string[] };
}

export function CampaignDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const toast = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewItem[]>([]);

  const { data: campaign, isLoading } = useQuery({
    queryKey: ['campaign', id],
    queryFn: () => api.get<Campaign>(`/campaigns/${id}`),
    enabled: !!id,
  });

  const runMut = useMutation({
    mutationFn: () => api.post<void>(`/campaigns/${id}/run`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaign', id] });
      toast.success('Кампания запущена');
    },
  });
  const pauseMut = useMutation({
    mutationFn: () => api.post<void>(`/campaigns/${id}/pause`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['campaign', id] });
      toast.info('Кампания на паузе');
    },
  });
  const previewMut = useMutation({
    mutationFn: () => api.post<{ items: PreviewItem[] }>(`/campaigns/${id}/preview`, { limit: 5 }),
    onSuccess: (r) => {
      setPreview(r.items ?? []);
      setPreviewOpen(true);
    },
    onError: (e: Error) => toast.error('Не удалось собрать превью', e.message),
  });

  if (isLoading || !campaign) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Spinner className="text-brand-500" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={campaign.name}
        description={campaign.goalText}
        breadcrumbs={
          <Link to="/campaigns" className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-700">
            <ArrowLeftIcon className="h-3.5 w-3.5" />
            Все кампании
          </Link>
        }
        actions={
          <>
            <Button variant="secondary" leftIcon={<EyeIcon className="h-4 w-4" />} onClick={() => previewMut.mutate()} loading={previewMut.isPending}>
              Превью первых сообщений
            </Button>
            <Button variant="secondary" leftIcon={<PencilSquareIcon className="h-4 w-4" />} onClick={() => setEditOpen(true)}>
              Редактировать
            </Button>
            {campaign.status === 'running' ? (
              <Button leftIcon={<PauseIcon className="h-4 w-4" />} onClick={() => pauseMut.mutate()}>
                Пауза
              </Button>
            ) : (
              <Button leftIcon={<PlayIcon className="h-4 w-4" />} onClick={() => runMut.mutate()}>
                Запустить
              </Button>
            )}
          </>
        }
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="card-padded lg:col-span-2">
          <div className="flex items-center gap-2">
            <StatusDot status={campaign.status} />
            <Badge tone={campaign.defaultMode === 'auto' ? 'indigo' : campaign.defaultMode === 'assisted' ? 'violet' : 'amber'}>
              mode: {campaign.defaultMode}
            </Badge>
          </div>
          <KeyValue
            className="mt-4"
            items={[
              { label: 'Goal', value: campaign.goalText },
              { label: 'Value-prop', value: campaign.valueProp },
              {
                label: 'Outreach pool',
                value: campaign.outreachAccountPool?.length
                  ? `${campaign.outreachAccountPool.length} аккаунтов`
                  : 'не задан',
              },
              {
                label: 'Schedule',
                value: campaign.schedule
                  ? `${campaign.schedule.workHours ? `${campaign.schedule.workHours.start}–${campaign.schedule.workHours.end}` : '—'} · ${campaign.schedule.tz ?? 'UTC'} · до ${campaign.schedule.maxPerDayPerAccount ?? '—'}/акк`
                  : '—',
              },
            ]}
          />
          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Sent" value={formatNumber(campaign.metrics?.sent ?? 0)} />
            <Stat label="Replies" value={formatNumber(campaign.metrics?.replies ?? 0)} />
            <Stat label="Reply-rate" value={formatPct(campaign.metrics?.replyRate ?? 0)} />
            <Stat label="Qualified" value={formatNumber(campaign.metrics?.qualified ?? 0)} />
          </div>
        </div>
        <div className="card-padded">
          <h3 className="text-sm font-semibold text-slate-900">Target filter</h3>
          <pre className="mt-3 max-h-72 overflow-auto rounded-xl bg-slate-50 p-3 font-mono text-[11px] text-slate-700 ring-1 ring-slate-200 scrollbar-thin">
            {JSON.stringify(campaign.targetFilter ?? {}, null, 2)}
          </pre>
          <h3 className="mt-5 text-sm font-semibold text-slate-900">Agent overrides</h3>
          <pre className="mt-3 max-h-48 overflow-auto rounded-xl bg-slate-50 p-3 font-mono text-[11px] text-slate-700 ring-1 ring-slate-200 scrollbar-thin">
            {JSON.stringify(campaign.agentOverrides ?? {}, null, 2)}
          </pre>
        </div>
      </div>

      <CampaignForm
        open={editOpen}
        onClose={() => setEditOpen(false)}
        campaign={campaign}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['campaign', id] });
          qc.invalidateQueries({ queryKey: ['campaigns'] });
          setEditOpen(false);
        }}
      />

      <Modal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        size="xl"
        title="Превью первых сообщений"
        description="Драфты от OpeningComposer + проверка SafetyFilter. Кампания не запущена."
        footer={
          <Button variant="secondary" onClick={() => setPreviewOpen(false)}>
            Закрыть
          </Button>
        }
      >
        <div className="space-y-4">
          {preview.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-500">Нет кандидатов под текущий фильтр.</div>
          ) : (
            preview.map((p) => (
              <div key={p.contactId} className="rounded-xl border border-slate-200 p-4">
                <div className="flex items-center justify-between">
                  <div className="font-mono text-sm font-semibold text-slate-900">{p.contactValue}</div>
                  {p.channelTitle && (
                    <div className="text-xs text-slate-500">{p.channelTitle}</div>
                  )}
                </div>
                <div className="mt-3 space-y-2">
                  {p.drafts.map((d, idx) => (
                    <div key={idx} className="rounded-lg bg-slate-50 p-3 ring-1 ring-slate-200">
                      <div className="text-sm whitespace-pre-wrap text-slate-800">{d.text}</div>
                      {d.riskScore !== undefined && (
                        <div className="mt-2 text-xs text-slate-500">
                          risk: {(d.riskScore * 100).toFixed(0)}%
                          {d.rationale && ` · ${d.rationale}`}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {p.blocked && (
                  <div className="mt-2 text-xs text-rose-600">
                    Заблокировано SafetyFilter: {p.blocked.reasons.join(', ')}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </Modal>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-4 py-3 ring-1 ring-slate-200">
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-slate-900 tabular-nums">{value}</div>
    </div>
  );
}
