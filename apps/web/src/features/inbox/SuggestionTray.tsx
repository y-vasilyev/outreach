import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  PaperAirplaneIcon,
  PencilSquareIcon,
  XMarkIcon,
  ArrowUturnRightIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import { Button } from '../../components/Button';
import { Textarea } from '../../components/Textarea';
import { Badge } from '../../components/Badge';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { cn } from '../../lib/cn';

export interface Suggestion {
  id: string;
  conversationId: string;
  agentName: string;
  text: string;
  rationale?: string;
  score?: number;
  status: 'pending' | 'approved' | 'edited' | 'rejected' | 'sent' | 'expired';
  /** `intent_target` and `risk_score` are intentional snake_case keys inside agent meta. */
  meta?: { intent_target?: string; risk_score?: number; length?: string };
  createdAt: string;
}

interface Props {
  conversationId: string;
  suggestions: Suggestion[];
  onModeChange: (mode: 'auto' | 'assisted' | 'manual') => void;
}

export function SuggestionTray({ conversationId, suggestions, onModeChange }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [customText, setCustomText] = useState('');
  const [showCustom, setShowCustom] = useState(false);

  const approveMut = useMutation({
    mutationFn: ({ id, text }: { id: string; text?: string }) =>
      api.post<void>(`/conversations/${conversationId}/suggestions/${id}/approve`, text ? { text } : {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation-messages', conversationId] });
      qc.invalidateQueries({ queryKey: ['conversation-suggestions', conversationId] });
      qc.invalidateQueries({ queryKey: ['conversations'] });
      toast.success('Сообщение поставлено в очередь отправки');
      setEditingId(null);
    },
    onError: (e: Error) => toast.error('Не удалось одобрить', e.message),
  });

  const rejectMut = useMutation({
    mutationFn: (id: string) => api.post<void>(`/conversations/${conversationId}/suggestions/${id}/reject`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation-suggestions', conversationId] });
      toast.info('Подсказка отклонена');
    },
  });

  const customMut = useMutation({
    mutationFn: () => api.post<void>(`/conversations/${conversationId}/messages`, { text: customText }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation-messages', conversationId] });
      setCustomText('');
      setShowCustom(false);
      toast.success('Сообщение поставлено в очередь');
    },
    onError: (e: Error) => toast.error('Не удалось отправить', e.message),
  });

  const pending = suggestions.filter((s) => s.status === 'pending').slice(0, 3);

  return (
    <div className="border-t border-slate-200 bg-white">
      {pending.length > 0 && (
        <div className="px-4 pt-3">
          <div className="mb-2 flex items-center justify-between">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Подсказки агентов · {pending.length}
            </div>
            <ModeSwitcher onChange={onModeChange} />
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-thin">
            {pending.map((s) => (
              <SuggestionCard
                key={s.id}
                s={s}
                editing={editingId === s.id}
                editText={editText}
                onEditStart={() => {
                  setEditingId(s.id);
                  setEditText(s.text);
                }}
                onEditChange={setEditText}
                onSendAsIs={() => approveMut.mutate({ id: s.id })}
                onSendEdited={() => approveMut.mutate({ id: s.id, text: editText })}
                onCancelEdit={() => setEditingId(null)}
                onReject={() => rejectMut.mutate(s.id)}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 px-4 py-3">
        {showCustom ? (
          <div className="flex flex-1 items-end gap-2">
            <Textarea
              rows={2}
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              placeholder="Свой текст…"
              className="flex-1"
            />
            <Button
              leftIcon={<PaperAirplaneIcon className="h-4 w-4" />}
              loading={customMut.isPending}
              disabled={!customText.trim()}
              onClick={() => customMut.mutate()}
            >
              Отправить
            </Button>
            <Button variant="secondary" onClick={() => setShowCustom(false)}>
              Отмена
            </Button>
          </div>
        ) : (
          <>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={<PencilSquareIcon className="h-4 w-4" />}
              onClick={() => setShowCustom(true)}
            >
              Свой текст
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-amber-700 hover:bg-amber-50"
              leftIcon={<ExclamationTriangleIcon className="h-4 w-4" />}
              onClick={() => onModeChange('manual')}
            >
              Эскалация на оператора
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function SuggestionCard({
  s,
  editing,
  editText,
  onEditStart,
  onEditChange,
  onSendAsIs,
  onSendEdited,
  onCancelEdit,
  onReject,
}: {
  s: Suggestion;
  editing: boolean;
  editText: string;
  onEditStart: () => void;
  onEditChange: (v: string) => void;
  onSendAsIs: () => void;
  onSendEdited: () => void;
  onCancelEdit: () => void;
  onReject: () => void;
}) {
  const risk = s.meta?.risk_score ?? 0;
  const riskTone = risk > 0.6 ? 'rose' : risk > 0.3 ? 'amber' : 'emerald';
  return (
    <div
      className={cn(
        'flex w-[320px] flex-shrink-0 flex-col rounded-2xl bg-slate-50 p-3 ring-1 ring-slate-200',
        editing && 'w-[420px] bg-white ring-brand-300',
      )}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <Badge tone="indigo">{s.agentName}</Badge>
        {s.meta?.intent_target && <Badge tone="slate">{s.meta.intent_target}</Badge>}
        <Badge tone={riskTone} dot>
          risk {(risk * 100).toFixed(0)}%
        </Badge>
      </div>
      {editing ? (
        <Textarea rows={5} value={editText} onChange={(e) => onEditChange(e.target.value)} className="mb-2" />
      ) : (
        <p className="mb-2 line-clamp-5 whitespace-pre-wrap text-sm text-slate-800">{s.text}</p>
      )}
      {s.rationale && !editing && (
        <p className="mb-2 line-clamp-2 text-[11px] italic text-slate-500">{s.rationale}</p>
      )}
      <div className="mt-auto flex items-center justify-between gap-1.5">
        {editing ? (
          <>
            <Button size="sm" leftIcon={<PaperAirplaneIcon className="h-3.5 w-3.5" />} onClick={onSendEdited}>
              Отправить
            </Button>
            <Button size="sm" variant="secondary" onClick={onCancelEdit}>
              Отмена
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" leftIcon={<PaperAirplaneIcon className="h-3.5 w-3.5" />} onClick={onSendAsIs}>
              Как есть
            </Button>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<PencilSquareIcon className="h-3.5 w-3.5" />}
              onClick={onEditStart}
            >
              Править
            </Button>
            <button
              onClick={onReject}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-200 hover:text-slate-700"
              title="Пропустить"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ModeSwitcher({ onChange }: { onChange: (m: 'auto' | 'assisted' | 'manual') => void }) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg bg-slate-100 p-0.5 text-xs">
      {(['auto', 'assisted', 'manual'] as const).map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className="rounded-md px-2 py-1 font-medium text-slate-600 hover:bg-white hover:text-slate-900"
        >
          {m === 'manual' ? (
            <span className="inline-flex items-center gap-1">
              <ArrowUturnRightIcon className="h-3 w-3" />
              {m}
            </span>
          ) : (
            m
          )}
        </button>
      ))}
    </div>
  );
}
