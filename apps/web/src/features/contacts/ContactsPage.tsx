import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { PageHeader } from '../../components/PageHeader';
import { Input } from '../../components/Input';
import { Select } from '../../components/Select';
import { DataTable, type Column } from '../../components/DataTable';
import { Badge } from '../../components/Badge';
import { StatusDot } from '../../components/StatusDot';
import { api } from '../../lib/api';
import { formatRelative } from '../../lib/format';

export interface Contact {
  id: string;
  channelId: string;
  channel?: { id: string; title?: string; handle?: string; platform?: string };
  type: 'tg_username' | 'tg_phone' | 'tg_link' | 'email' | 'website' | 'web_form' | 'other';
  value: string;
  rawValue?: string;
  label?: string | null;
  roleGuess: 'owner' | 'ad_manager' | 'generic' | 'bot' | 'unknown';
  confidence: number;
  reachability: 'reachable_tg' | 'manual' | 'unreachable';
  status: 'new' | 'qualified' | 'disqualified' | 'contacted' | 'active' | 'finished' | 'invalid' | 'blocked';
  tags?: string[];
  tgUserId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export function ContactsPage() {
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [reach, setReach] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['contacts', { search, type, role, status, reach }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (search) qs.set('q', search);
      if (type) qs.set('type', type);
      if (role) qs.set('roleGuess', role);
      if (status) qs.set('status', status);
      if (reach) qs.set('reachability', reach);
      return api.get<{ items: Contact[]; total: number } | Contact[]>(`/contacts?${qs.toString()}`);
    },
  });

  const contacts = useMemo<Contact[]>(() => {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return data.items;
  }, [data]);

  const columns: Column<Contact>[] = [
    {
      key: 'value',
      header: 'Контакт',
      cell: (c) => (
        <div className="min-w-0">
          <div className="truncate font-mono text-sm font-medium text-slate-900">{c.value}</div>
          {c.label && <div className="truncate text-xs text-slate-500">«{c.label}»</div>}
        </div>
      ),
    },
    {
      key: 'type',
      header: 'Тип',
      cell: (c) => <Badge tone={typeTone(c.type)}>{c.type}</Badge>,
    },
    {
      key: 'role',
      header: 'Роль',
      cell: (c) => <Badge tone={roleTone(c.roleGuess)}>{c.roleGuess}</Badge>,
    },
    {
      key: 'channel',
      header: 'Канал',
      cell: (c) => (
        <div className="min-w-0">
          <div className="truncate text-sm text-slate-700">{c.channel?.title || c.channel?.handle || '—'}</div>
          <div className="truncate text-xs text-slate-500">{c.channel?.platform}</div>
        </div>
      ),
    },
    {
      key: 'reach',
      header: 'Канал связи',
      cell: (c) => (
        <Badge tone={c.reachability === 'reachable_tg' ? 'emerald' : c.reachability === 'manual' ? 'amber' : 'gray'}>
          {c.reachability}
        </Badge>
      ),
    },
    {
      key: 'confidence',
      header: 'Confidence',
      align: 'right',
      cell: (c) => (
        <div className="flex items-center justify-end gap-2">
          <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full bg-brand-500"
              style={{ width: `${Math.min(100, c.confidence * 100)}%` }}
            />
          </div>
          <span className="text-xs tabular-nums text-slate-600">{(c.confidence * 100).toFixed(0)}%</span>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      cell: (c) => <StatusDot status={c.status} />,
    },
    {
      key: 'updated',
      header: 'Обновлён',
      cell: (c) => <span className="text-xs text-slate-500">{formatRelative(c.updatedAt)}</span>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="Контакты"
        description="Все извлечённые контакты с приоритетом и статусом."
      />

      <div className="card mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-5">
          <Input
            placeholder="Поиск по value / label"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leftIcon={<MagnifyingGlassIcon className="h-4 w-4" />}
          />
          <Select
            value={type}
            onChange={(e) => setType(e.target.value)}
            options={[
              { value: '', label: 'Любой тип' },
              { value: 'tg_username', label: 'tg_username' },
              { value: 'tg_link', label: 'tg_link' },
              { value: 'email', label: 'email' },
              { value: 'website', label: 'website' },
              { value: 'web_form', label: 'web_form' },
              { value: 'other', label: 'other' },
            ]}
          />
          <Select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            options={[
              { value: '', label: 'Любая роль' },
              { value: 'owner', label: 'owner' },
              { value: 'ad_manager', label: 'ad_manager' },
              { value: 'generic', label: 'generic' },
              { value: 'bot', label: 'bot' },
              { value: 'unknown', label: 'unknown' },
            ]}
          />
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'Любой статус' },
              { value: 'new', label: 'new' },
              { value: 'qualified', label: 'qualified' },
              { value: 'contacted', label: 'contacted' },
              { value: 'active', label: 'active' },
              { value: 'finished', label: 'finished' },
              { value: 'invalid', label: 'invalid' },
              { value: 'blocked', label: 'blocked' },
              { value: 'disqualified', label: 'disqualified' },
            ]}
          />
          <Select
            value={reach}
            onChange={(e) => setReach(e.target.value)}
            options={[
              { value: '', label: 'Любая связь' },
              { value: 'reachable_tg', label: 'reachable_tg' },
              { value: 'manual', label: 'manual' },
              { value: 'unreachable', label: 'unreachable' },
            ]}
          />
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={contacts}
        loading={isLoading}
        rowKey={(r) => r.id}
        emptyTitle="Контактов нет"
        emptyDescription="Загрузите каналы — после успешного скрейпа агент извлечёт контакты автоматически."
      />
    </div>
  );
}

function typeTone(t: string): 'sky' | 'indigo' | 'amber' | 'gray' {
  if (t.startsWith('tg_')) return 'sky';
  if (t === 'email') return 'indigo';
  if (t === 'website' || t === 'web_form') return 'amber';
  return 'gray';
}

function roleTone(r: string): 'indigo' | 'emerald' | 'slate' | 'amber' | 'gray' {
  if (r === 'ad_manager') return 'indigo';
  if (r === 'owner') return 'emerald';
  if (r === 'bot') return 'amber';
  if (r === 'generic') return 'slate';
  return 'gray';
}
