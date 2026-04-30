import { CheckIcon, ClockIcon, ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { Badge } from '../../components/Badge';
import { formatTime } from '../../lib/format';
import { cn } from '../../lib/cn';

export interface ChatMessage {
  id: string;
  direction: 'in' | 'out';
  sender: 'contact' | 'ai' | 'operator' | 'system';
  text: string;
  status?: 'pending' | 'sending' | 'sent' | 'failed' | 'received';
  created_at: string;
  sent_at?: string | null;
}

export function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isOut = msg.direction === 'out';
  const senderLabel =
    msg.sender === 'ai' ? 'AI' : msg.sender === 'operator' ? 'Operator' : msg.sender === 'system' ? 'System' : '';
  return (
    <div className={cn('flex w-full animate-fade-in', isOut ? 'justify-end' : 'justify-start')}>
      <div className={cn('max-w-[75%]', isOut ? 'items-end' : 'items-start')}>
        <div
          className={cn(
            'rounded-2xl px-4 py-2.5 text-sm shadow-sm ring-1',
            isOut
              ? 'rounded-br-md bg-brand-600 text-white ring-brand-600/40'
              : 'rounded-bl-md bg-white text-slate-900 ring-slate-200',
          )}
        >
          <p className="whitespace-pre-wrap break-words">{msg.text}</p>
        </div>
        <div
          className={cn(
            'mt-1 flex items-center gap-1.5 text-[11px] text-slate-400',
            isOut ? 'justify-end' : 'justify-start',
          )}
        >
          {senderLabel && (
            <Badge tone={msg.sender === 'ai' ? 'indigo' : msg.sender === 'operator' ? 'violet' : 'slate'}>
              {senderLabel}
            </Badge>
          )}
          <span>{formatTime(msg.sent_at ?? msg.created_at)}</span>
          {isOut && msg.status && <StatusIcon status={msg.status} />}
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: NonNullable<ChatMessage['status']> }) {
  if (status === 'failed') return <ExclamationTriangleIcon className="h-3.5 w-3.5 text-rose-500" />;
  if (status === 'pending' || status === 'sending') return <ClockIcon className="h-3.5 w-3.5 text-slate-400" />;
  return <CheckIcon className="h-3.5 w-3.5 text-emerald-500" />;
}
