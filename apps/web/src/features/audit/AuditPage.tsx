import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { PageHeader } from '../../components/PageHeader';
import { Input } from '../../components/Input';
import { Select } from '../../components/Select';
import { DataTable, type Column } from '../../components/DataTable';
import { Badge } from '../../components/Badge';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

interface AuditEntry {
  id: string;
  user_id: string | null;
  user?: { email: string; name?: string };
  action: string;
  target_type: string;
  target_id: string;
  payload?: Record<string, unknown> | null;
  created_at: string;
}

export function AuditPage() {
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');

  const { data = [], isLoading } = useQuery({
    queryKey: ['audit', { search, action }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (search) qs.set('search', search);
      if (action) qs.set('action', action);
      return api.get<AuditEntry[]>(`/audit?${qs.toString()}`);
    },
    refetchInterval: 60_000,
  });

  const columns: Column<AuditEntry>[] = [
    {
      key: 'created',
      header: 'Когда',
      cell: (e) => <span className="text-xs text-slate-500">{formatDateTime(e.created_at)}</span>,
      width: '180px',
    },
    {
      key: 'user',
      header: 'Кто',
      cell: (e) => (
        <span className="text-sm text-slate-700">{e.user?.email ?? e.user_id ?? 'system'}</span>
      ),
    },
    {
      key: 'action',
      header: 'Действие',
      cell: (e) => <Badge tone={actionTone(e.action)}>{e.action}</Badge>,
    },
    {
      key: 'target',
      header: 'Объект',
      cell: (e) => (
        <div>
          <div className="text-sm font-medium text-slate-700">{e.target_type}</div>
          <div className="font-mono text-[11px] text-slate-500">{e.target_id}</div>
        </div>
      ),
    },
    {
      key: 'payload',
      header: 'Payload',
      cell: (e) =>
        e.payload ? (
          <code className="line-clamp-1 max-w-sm font-mono text-[11px] text-slate-600">
            {JSON.stringify(e.payload)}
          </code>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Аудит"
        description="Все опасные действия операторов и системных процессов."
      />
      <div className="card mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Input
            placeholder="Поиск по target_id / user…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leftIcon={<MagnifyingGlassIcon className="h-4 w-4" />}
          />
          <Select
            value={action}
            onChange={(e) => setAction(e.target.value)}
            options={[
              { value: '', label: 'Любое действие' },
              { value: 'login', label: 'login' },
              { value: 'channel.import', label: 'channel.import' },
              { value: 'campaign.run', label: 'campaign.run' },
              { value: 'campaign.pause', label: 'campaign.pause' },
              { value: 'agent.update', label: 'agent.update' },
              { value: 'tg-account.create', label: 'tg-account.create' },
              { value: 'conversation.escalate', label: 'conversation.escalate' },
            ]}
          />
        </div>
      </div>
      <DataTable
        columns={columns}
        rows={data}
        loading={isLoading}
        rowKey={(r) => r.id}
        emptyTitle="Записей пока нет"
      />
    </div>
  );
}

function actionTone(a: string): 'sky' | 'indigo' | 'emerald' | 'amber' | 'rose' | 'slate' {
  if (a.startsWith('login')) return 'slate';
  if (a.includes('delete')) return 'rose';
  if (a.includes('pause')) return 'amber';
  if (a.includes('run') || a.includes('start')) return 'emerald';
  if (a.includes('update') || a.includes('patch')) return 'sky';
  return 'indigo';
}
