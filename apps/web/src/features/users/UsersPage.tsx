import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, TrashIcon, PencilSquareIcon } from '@heroicons/react/24/outline';
import { PageHeader } from '../../components/PageHeader';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { DataTable, type Column } from '../../components/DataTable';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { UserForm } from './UserForm';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { formatDateTime } from '../../lib/format';

export interface UserRow {
  id: string;
  email: string;
  name?: string;
  role: 'admin' | 'operator' | 'viewer';
  created_at: string;
  updated_at: string;
}

export function UsersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [deleteFor, setDeleteFor] = useState<UserRow | null>(null);

  const { data = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => api.get<UserRow[]>('/users'),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.del<void>(`/users/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success('Пользователь удалён');
      setDeleteFor(null);
    },
  });

  const columns: Column<UserRow>[] = [
    {
      key: 'user',
      header: 'Пользователь',
      cell: (u) => (
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
            {u.email.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="truncate font-medium text-slate-900">{u.name || u.email}</div>
            <div className="truncate text-xs text-slate-500">{u.email}</div>
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: 'Роль',
      cell: (u) => (
        <Badge tone={u.role === 'admin' ? 'indigo' : u.role === 'operator' ? 'sky' : 'slate'}>{u.role}</Badge>
      ),
    },
    {
      key: 'created',
      header: 'Создан',
      cell: (u) => <span className="text-xs text-slate-500">{formatDateTime(u.created_at)}</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (u) => (
        <div className="flex items-center justify-end gap-1">
          <button
            className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100"
            onClick={() => {
              setEditing(u);
              setFormOpen(true);
            }}
          >
            <PencilSquareIcon className="h-4 w-4" />
          </button>
          <button
            className="rounded-lg p-1.5 text-rose-500 hover:bg-rose-50"
            onClick={() => setDeleteFor(u)}
          >
            <TrashIcon className="h-4 w-4" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Пользователи"
        description="Операторы и роли. Admin может всё, operator ведёт диалоги, viewer только смотрит."
        actions={
          <Button leftIcon={<PlusIcon className="h-4 w-4" />} onClick={() => { setEditing(null); setFormOpen(true); }}>
            Добавить пользователя
          </Button>
        }
      />
      <DataTable
        columns={columns}
        rows={data}
        loading={isLoading}
        rowKey={(r) => r.id}
        emptyTitle="Пользователей пока нет"
        emptyDescription="Создайте операторов, чтобы передавать им подсказки и эскалации."
      />
      <UserForm
        open={formOpen}
        onClose={() => setFormOpen(false)}
        user={editing}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['users'] });
          setFormOpen(false);
        }}
      />
      <ConfirmDialog
        open={!!deleteFor}
        onClose={() => setDeleteFor(null)}
        onConfirm={() => deleteFor && delMut.mutate(deleteFor.id)}
        title="Удалить пользователя?"
        description={`Учётка "${deleteFor?.email}" будет удалена. Связанные действия в audit_log сохраняются.`}
        confirmLabel="Удалить"
        destructive
        loading={delMut.isPending}
      />
    </div>
  );
}
