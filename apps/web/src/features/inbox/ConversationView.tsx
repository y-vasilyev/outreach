import { useEffect, useMemo, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ChatBubbleLeftRightIcon,
  HashtagIcon,
  IdentificationIcon,
  EllipsisHorizontalIcon,
} from '@heroicons/react/24/outline';
import { Spinner } from '../../components/Spinner';
import { Badge } from '../../components/Badge';
import { StatusDot } from '../../components/StatusDot';
import { Dropdown } from '../../components/Dropdown';
import { ModeBadge } from './ModeBadge';
import { MessageBubble, type ChatMessage } from './MessageBubble';
import { SuggestionTray, type Suggestion } from './SuggestionTray';
import { useToast } from '../../components/Toast';
import { useRoom } from '../../lib/socket';
import { api } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import type { ConversationListItem } from './ConversationList';

interface Props {
  conversation: ConversationListItem;
}

interface ConversationDetail extends ConversationListItem {
  summary?: string;
  meta?: Record<string, unknown>;
  tg_account?: { label: string; phone: string };
  contact?: ConversationListItem['contact'];
}

export function ConversationView({ conversation }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const cId = conversation.id;
  const room = `conversation:${cId}`;

  const { data: details } = useQuery({
    queryKey: ['conversation', cId],
    queryFn: () => api.get<ConversationDetail>(`/conversations/${cId}`),
  });
  const { data: messages = [], isLoading: msgsLoading } = useQuery({
    queryKey: ['conversation-messages', cId],
    queryFn: () => api.get<ChatMessage[]>(`/conversations/${cId}/messages`),
  });
  const { data: suggestions = [] } = useQuery({
    queryKey: ['conversation-suggestions', cId],
    queryFn: () => api.get<Suggestion[]>(`/conversations/${cId}/suggestions`),
  });

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, cId]);

  useRoom(room, 'message.new', () => {
    qc.invalidateQueries({ queryKey: ['conversation-messages', cId] });
    qc.invalidateQueries({ queryKey: ['conversations'] });
  });
  useRoom(room, 'suggestion.new', () => {
    qc.invalidateQueries({ queryKey: ['conversation-suggestions', cId] });
  });
  useRoom(room, 'mode.changed', () => {
    qc.invalidateQueries({ queryKey: ['conversation', cId] });
  });

  const modeMut = useMutation({
    mutationFn: (mode: 'auto' | 'assisted' | 'manual') =>
      api.patch<void>(`/conversations/${cId}`, { mode }),
    onSuccess: (_v, mode) => {
      qc.invalidateQueries({ queryKey: ['conversation', cId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
      toast.success(`Режим: ${mode}`);
    },
  });
  const statusMut = useMutation({
    mutationFn: (status: 'active' | 'paused' | 'done' | 'failed') =>
      api.patch<void>(`/conversations/${cId}`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation', cId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
    },
  });

  const c: ConversationDetail = details ?? conversation;
  const handle = c.contact?.channel?.handle ?? c.contact?.value ?? '—';
  const title = c.contact?.channel?.title ?? c.contact?.value ?? 'Без названия';
  const initials = title.slice(0, 2).toUpperCase();

  const dayGroups = useMemo(() => groupByDay(messages), [messages]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-sm font-semibold text-slate-700">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-900">{title}</div>
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="truncate font-mono">{handle}</span>
              {c.contact?.role_guess && <Badge tone="slate">{c.contact.role_guess}</Badge>}
              {c.tg_account && (
                <span className="flex items-center gap-1">
                  <span className="text-slate-300">·</span>
                  <Badge tone="sky">{c.tg_account.label}</Badge>
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <StatusDot status={c.status} />
          <ModeBadge mode={c.mode} />
          {c.campaign && (
            <Link
              to={`/campaigns/${c.campaign.id}`}
              className="hidden truncate text-xs text-brand-600 hover:text-brand-500 sm:inline"
            >
              {c.campaign.name}
            </Link>
          )}
          <Dropdown
            trigger={
              <button className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100">
                <EllipsisHorizontalIcon className="h-5 w-5" />
              </button>
            }
            items={[
              {
                label: 'Режим: auto',
                icon: <ChatBubbleLeftRightIcon className="h-4 w-4" />,
                onClick: () => modeMut.mutate('auto'),
              },
              {
                label: 'Режим: assisted',
                icon: <ChatBubbleLeftRightIcon className="h-4 w-4" />,
                onClick: () => modeMut.mutate('assisted'),
              },
              {
                label: 'Режим: manual',
                icon: <ChatBubbleLeftRightIcon className="h-4 w-4" />,
                onClick: () => modeMut.mutate('manual'),
              },
              {
                label: 'Поставить на паузу',
                onClick: () => statusMut.mutate('paused'),
              },
              {
                label: 'Закрыть как done',
                onClick: () => statusMut.mutate('done'),
              },
              {
                label: 'Открыть контакт',
                icon: <IdentificationIcon className="h-4 w-4" />,
                href: '/contacts',
              },
              {
                label: 'Открыть канал',
                icon: <HashtagIcon className="h-4 w-4" />,
                href: '/channels',
              },
            ]}
          />
        </div>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 scrollbar-thin">
        {msgsLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="text-brand-500" />
          </div>
        ) : messages.length === 0 ? (
          <div className="mx-auto max-w-md rounded-xl bg-white p-6 text-center text-sm text-slate-500 ring-1 ring-slate-200">
            В диалоге пока нет сообщений. Когда придёт первое — оно появится здесь.
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-4">
            {dayGroups.map((g) => (
              <div key={g.day} className="space-y-3">
                <div className="my-2 flex items-center justify-center">
                  <span className="rounded-full bg-slate-200 px-3 py-0.5 text-[11px] font-medium text-slate-600">
                    {g.day}
                  </span>
                </div>
                {g.items.map((m) => (
                  <MessageBubble key={m.id} msg={m} />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {c.summary && (
        <div className="border-t border-slate-200 bg-amber-50/50 px-4 py-2 text-xs text-amber-800">
          <span className="font-semibold">Summary:</span> {c.summary}
        </div>
      )}

      <SuggestionTray
        conversationId={cId}
        suggestions={suggestions}
        onModeChange={(m) => modeMut.mutate(m)}
      />

      {c.last_inbound_at && (
        <div className="hidden">last inbound: {formatRelative(c.last_inbound_at)}</div>
      )}
    </div>
  );
}

function groupByDay(msgs: ChatMessage[]): { day: string; items: ChatMessage[] }[] {
  const map = new Map<string, ChatMessage[]>();
  for (const m of msgs) {
    const d = new Date(m.created_at);
    const key = isNaN(d.getTime())
      ? 'без даты'
      : new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' }).format(d);
    const arr = map.get(key);
    if (arr) arr.push(m);
    else map.set(key, [m]);
  }
  return Array.from(map.entries()).map(([day, items]) => ({ day, items }));
}
