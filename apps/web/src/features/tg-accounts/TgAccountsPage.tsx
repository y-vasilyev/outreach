import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, ArrowPathIcon, PhoneIcon, TrashIcon, KeyIcon } from '@heroicons/react/24/outline';
import { PageHeader } from '../../components/PageHeader';
import { Button } from '../../components/Button';
import { DataTable, type Column } from '../../components/DataTable';
import { Badge } from '../../components/Badge';
import { StatusDot } from '../../components/StatusDot';
import { Dropdown } from '../../components/Dropdown';
import { TgAccountForm } from './TgAccountForm';
import { TgLoginDialog } from './TgLoginDialog';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { api } from '../../lib/api';
import { useToast } from '../../components/Toast';
import { formatNumber, formatRelative } from '../../lib/format';

export interface TgAccount {
  id: string;
  label: string;
  phone: string;
  status: 'idle' | 'active' | 'cooldown' | 'banned' | 'need_auth';
  role: 'parser' | 'outreach' | 'both';
  dailyMsgLimit: number;
  dailyNewContactLimit: number;
  sentTodayMsg: number;
  sentTodayNew: number;
  warmupStage: number;
  warmupStartedAt?: string | null;
  cooldownUntil: string | null;
  tags: string[];
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export function TgAccountsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<TgAccount | null>(null);
  const [loginFor, setLoginFor] = useState<TgAccount | null>(null);
  const [deleteFor, setDeleteFor] = useState<TgAccount | null>(null);

  const { data: accounts = [], isLoading } = useQuery({
    queryKey: ['tg-accounts'],
    queryFn: () => api.get<TgAccount[]>('/tg-accounts'),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.del<void>(`/tg-accounts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tg-accounts'] });
      toast.success('Аккаунт удалён');
      setDeleteFor(null);
    },
    onError: (e: Error) => toast.error('Не удалось удалить', e.message),
  });

  const columns: Column<TgAccount>[] = [
    {
      key: 'label',
      header: 'Аккаунт',
      cell: (r) => (
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700">
            {r.label.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="font-medium text-slate-900">{r.label}</div>
            <div className="text-xs text-slate-500">{r.phone}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Роль',
      cell: (r) => (
        <Badge tone={r.role === 'parser' ? 'sky' : r.role === 'outreach' ? 'indigo' : 'violet'}>
          {r.role}
        </Badge>
      ),
    },
    {
      key: 'status',
      header: 'Статус',
      cell: (r) => (
        <div className="flex items-center gap-2">
          <StatusDot status={r.status} />
          {r.status === 'cooldown' && r.cooldownUntil && (
            <span className="text-xs text-slate-500">до {formatRelative(r.cooldownUntil)}</span>
          )}
        </div>
      ),
    },
    {
      key: 'warmup',
      header: 'Warmup',
      cell: (r) => (
        <div className="flex items-center gap-2">
          <div className="flex h-1.5 w-24 overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full bg-brand-500"
              style={{ width: `${Math.min(100, ((r.warmupStage || 0) / 4) * 100)}%` }}
            />
          </div>
          <span className="text-xs text-slate-500">{r.warmupStage}/4</span>
        </div>
      ),
    },
    {
      key: 'limits',
      header: 'Лимит / сегодня',
      cell: (r) => (
        <div className="text-xs text-slate-600">
          <div>
            msg <span className="font-medium text-slate-900">{formatNumber(r.sentTodayMsg)}</span> /{' '}
            {formatNumber(r.dailyMsgLimit)}
          </div>
          <div>
            new <span className="font-medium text-slate-900">{formatNumber(r.sentTodayNew)}</span> /{' '}
            {formatNumber(r.dailyNewContactLimit)}
          </div>
        </div>
      ),
    },
    {
      key: 'tags',
      header: 'Тэги',
      cell: (r) =>
        r.tags?.length ? (
          <div className="flex flex-wrap gap-1">
            {r.tags.map((t) => (
              <Badge key={t} tone="slate">
                {t}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        ),
    },
    {
      key: 'updated',
      header: 'Обновлён',
      cell: (r) => <span className="text-xs text-slate-500">{formatRelative(r.updatedAt)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <Dropdown
          trigger={
            <button className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
              <ArrowPathIcon className="h-4 w-4" />
            </button>
          }
          items={[
            {
              label: r.status === 'need_auth' ? 'Войти заново' : 'Релогин',
              icon: <KeyIcon className="h-4 w-4" />,
              onClick: () => setLoginFor(r),
            },
            {
              label: 'Редактировать',
              icon: <PhoneIcon className="h-4 w-4" />,
              onClick: () => {
                setEditing(r);
                setFormOpen(true);
              },
            },
            {
              label: 'Удалить',
              icon: <TrashIcon className="h-4 w-4" />,
              variant: 'danger',
              onClick: () => setDeleteFor(r),
            },
          ]}
        />
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="TG аккаунты"
        description="Парсер и outreach-аккаунты, лимиты, статусы, прогресс прогрева."
        actions={
          <Button leftIcon={<PlusIcon className="h-4 w-4" />} onClick={() => { setEditing(null); setFormOpen(true); }}>
            Добавить аккаунт
          </Button>
        }
      />
      <DataTable
        columns={columns}
        rows={accounts}
        loading={isLoading}
        rowKey={(r) => r.id}
        emptyTitle="Аккаунтов ещё нет"
        emptyDescription="Добавьте парсер-аккаунт для скрейпа и outreach-аккаунт для отправки."
        emptyAction={
          <Button leftIcon={<PlusIcon className="h-4 w-4" />} onClick={() => setFormOpen(true)}>
            Добавить
          </Button>
        }
      />
      <TgAccountForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        account={editing}
        onSaved={(acc) => {
          qc.invalidateQueries({ queryKey: ['tg-accounts'] });
          if (!editing && acc) setLoginFor(acc);
          setFormOpen(false);
        }}
      />
      {loginFor && (
        <TgLoginDialog
          open={!!loginFor}
          onClose={() => setLoginFor(null)}
          account={loginFor}
          onDone={() => {
            qc.invalidateQueries({ queryKey: ['tg-accounts'] });
            setLoginFor(null);
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleteFor}
        onClose={() => setDeleteFor(null)}
        onConfirm={() => deleteFor && delMut.mutate(deleteFor.id)}
        title="Удалить TG аккаунт?"
        description={`Аккаунт "${deleteFor?.label}" будет отключён. Активные диалоги перейдут в режим manual.`}
        confirmLabel="Удалить"
        destructive
        loading={delMut.isPending}
      />
    </div>
  );
}
