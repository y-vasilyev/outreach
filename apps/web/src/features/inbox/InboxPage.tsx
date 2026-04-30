import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { Input } from '../../components/Input';
import { Select } from '../../components/Select';
import { ConversationList, type ConversationListItem } from './ConversationList';
import { ConversationView } from './ConversationView';
import { EmptyState } from '../../components/EmptyState';
import { api } from '../../lib/api';

export function InboxPage() {
  const { conversationId } = useParams<{ conversationId?: string }>();
  const nav = useNavigate();
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState('');
  const [status, setStatus] = useState('');

  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations', { search, mode, status }],
    queryFn: () => {
      const qs = new URLSearchParams();
      if (search) qs.set('q', search);
      if (mode) qs.set('mode', mode);
      if (status) qs.set('status', status);
      return api.get<ConversationListItem[]>(`/conversations?${qs.toString()}`);
    },
    refetchInterval: 30_000,
  });

  const current = useMemo(
    () => conversations.find((c) => c.id === conversationId) ?? null,
    [conversations, conversationId],
  );

  useEffect(() => {
    if (!conversationId && conversations[0]) {
      nav(`/inbox/${conversations[0].id}`, { replace: true });
    }
  }, [conversationId, conversations, nav]);

  return (
    <div className="-mx-4 -my-6 flex h-[calc(100vh-3.5rem)] md:-mx-6 md:-my-8">
      <aside className="flex w-80 flex-shrink-0 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
          <h1 className="text-base font-semibold text-slate-900">Диалоги</h1>
          <span className="text-xs text-slate-500">{conversations.length}</span>
        </div>
        <div className="space-y-2 border-b border-slate-200 px-3 py-3">
          <Input
            placeholder="Поиск…"
            leftIcon={<MagnifyingGlassIcon className="h-4 w-4" />}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="flex gap-2">
            <Select
              className="flex-1"
              value={mode}
              onChange={(e) => setMode(e.target.value)}
              options={[
                { value: '', label: 'Все режимы' },
                { value: 'auto', label: 'auto' },
                { value: 'assisted', label: 'assisted' },
                { value: 'manual', label: 'manual' },
              ]}
            />
            <Select
              className="flex-1"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              options={[
                { value: '', label: 'Любой' },
                { value: 'active', label: 'Active' },
                { value: 'paused', label: 'Paused' },
                { value: 'done', label: 'Done' },
                { value: 'failed', label: 'Failed' },
              ]}
            />
          </div>
        </div>
        <ConversationList
          items={conversations}
          activeId={conversationId}
          onPick={(id) => nav(`/inbox/${id}`)}
        />
      </aside>
      <main className="flex min-w-0 flex-1 flex-col bg-slate-50">
        {current ? (
          <ConversationView conversation={current} />
        ) : (
          <div className="flex h-full items-center justify-center">
            <EmptyState
              title="Выберите диалог"
              description="Слева — список входящих и исходящих CustDev-диалогов."
            />
          </div>
        )}
      </main>
    </div>
  );
}
