import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import { ModeBadge } from './ModeBadge';
import { formatRelative, truncate } from '../../lib/format';
import { cn } from '../../lib/cn';

export interface ConversationListItem {
  id: string;
  contact?: {
    id: string;
    value: string;
    role_guess?: string;
    channel?: { handle?: string; title?: string };
  };
  status: 'active' | 'paused' | 'done' | 'failed';
  mode: 'auto' | 'assisted' | 'manual';
  last_message_text?: string;
  last_message_at?: string;
  last_inbound_at?: string | null;
  unread?: number;
  pending_suggestions?: number;
  campaign?: { id: string; name: string };
}

interface Props {
  items: ConversationListItem[];
  activeId?: string;
  onPick: (id: string) => void;
}

export function ConversationList({ items, activeId, onPick }: Props) {
  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 py-10 text-center">
        <div>
          <ChatBubbleLeftRightIcon className="mx-auto h-7 w-7 text-slate-300" />
          <div className="mt-2 text-sm text-slate-500">Диалогов нет</div>
        </div>
      </div>
    );
  }
  return (
    <ul className="flex-1 divide-y divide-slate-100 overflow-y-auto scrollbar-thin">
      {items.map((c) => {
        const handle = c.contact?.channel?.handle ?? c.contact?.value ?? '—';
        const title = c.contact?.channel?.title ?? c.contact?.value ?? 'Без названия';
        const initials = (title || '??').slice(0, 2).toUpperCase();
        const active = c.id === activeId;
        return (
          <li key={c.id}>
            <button
              onClick={() => onPick(c.id)}
              className={cn(
                'flex w-full items-start gap-3 px-4 py-3 text-left transition-colors',
                active ? 'bg-brand-50' : 'hover:bg-slate-50',
              )}
            >
              <div className="relative">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-700">
                  {initials}
                </div>
                {(c.unread ?? 0) > 0 && (
                  <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-rose-500 ring-2 ring-white" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-slate-900">{title}</div>
                    <div className="truncate text-[11px] text-slate-500">{handle}</div>
                  </div>
                  <div className="flex flex-shrink-0 flex-col items-end gap-1">
                    <span className="whitespace-nowrap text-[11px] text-slate-400">
                      {formatRelative(c.last_message_at)}
                    </span>
                    <ModeBadge mode={c.mode} />
                  </div>
                </div>
                {c.last_message_text && (
                  <div className="mt-1 truncate text-xs text-slate-500">
                    {truncate(c.last_message_text, 80)}
                  </div>
                )}
                {(c.pending_suggestions ?? 0) > 0 && (
                  <div className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-brand-700">
                    <span className="h-1.5 w-1.5 rounded-full bg-brand-500 animate-pulse-dot" />
                    {c.pending_suggestions} подсказки
                  </div>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
