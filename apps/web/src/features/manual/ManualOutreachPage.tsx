import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardDocumentIcon, CheckIcon, MagnifyingGlassIcon } from '@heroicons/react/24/outline';
import { PageHeader } from '../../components/PageHeader';
import { Input } from '../../components/Input';
import { Select } from '../../components/Select';
import { Button } from '../../components/Button';
import { Badge } from '../../components/Badge';
import { StatusDot } from '../../components/StatusDot';
import { Spinner } from '../../components/Spinner';
import { EmptyState } from '../../components/EmptyState';
import { useToast } from '../../components/Toast';
import { api } from '../../lib/api';
import { formatRelative } from '../../lib/format';
import { cn } from '../../lib/cn';
import type { Contact } from '../contacts/ContactsPage';

interface DraftResp {
  text: string;
  channel?: { title?: string; description?: string };
  analysis?: Record<string, unknown>;
}

export function ManualOutreachPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('new');
  const [selected, setSelected] = useState<Contact | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ['contacts-manual', { search, type, status }],
    queryFn: () => {
      const qs = new URLSearchParams();
      qs.set('reachability', 'manual');
      if (search) qs.set('q', search);
      if (type) qs.set('type', type);
      if (status) qs.set('status', status);
      return api.get<{ items: Contact[] } | Contact[]>(`/contacts?${qs.toString()}`);
    },
  });

  const contacts = useMemo<Contact[]>(() => {
    if (!data) return [];
    if (Array.isArray(data)) return data;
    return data.items;
  }, [data]);

  const markMut = useMutation({
    mutationFn: ({ id, status: s }: { id: string; status: string }) =>
      api.patch<void>(`/contacts/${id}`, { status: s }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['contacts-manual'] });
      toast.success('Статус контакта обновлён');
    },
  });

  return (
    <div>
      <PageHeader
        title="Manual outreach"
        description="Контакты без TG: email, web-форма, IG. Агент готовит черновик — оператор пишет сам."
      />

      <div className="card mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <Input
            placeholder="Поиск…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leftIcon={<MagnifyingGlassIcon className="h-4 w-4" />}
          />
          <Select
            value={type}
            onChange={(e) => setType(e.target.value)}
            options={[
              { value: '', label: 'Любой тип' },
              { value: 'email', label: 'email' },
              { value: 'website', label: 'website' },
              { value: 'web_form', label: 'web_form' },
              { value: 'other', label: 'other' },
            ]}
          />
          <Select
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={[
              { value: '', label: 'Любой статус' },
              { value: 'new', label: 'new' },
              { value: 'contacted', label: 'contacted' },
              { value: 'finished', label: 'finished' },
            ]}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="card lg:col-span-1">
          {isLoading ? (
            <div className="flex h-48 items-center justify-center">
              <Spinner className="text-brand-500" />
            </div>
          ) : contacts.length === 0 ? (
            <EmptyState title="Контактов пока нет" description="Здесь появятся email/web-form контакты, до которых нет TG-связи." />
          ) : (
            <ul className="max-h-[calc(100vh-20rem)] divide-y divide-slate-100 overflow-y-auto scrollbar-thin">
              {contacts.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => setSelected(c)}
                    className={cn(
                      'block w-full px-4 py-3 text-left transition-colors',
                      selected?.id === c.id ? 'bg-brand-50' : 'hover:bg-slate-50',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="truncate font-mono text-sm font-medium text-slate-900">{c.value}</div>
                      <Badge tone="slate">{c.type}</Badge>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-500">
                      <span className="truncate">{c.channel?.title ?? c.channel?.handle ?? '—'}</span>
                      <StatusDot status={c.status} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="lg:col-span-2">
          {selected ? (
            <DraftPanel
              contact={selected}
              onMark={(status) => markMut.mutate({ id: selected.id, status })}
            />
          ) : (
            <div className="card">
              <EmptyState
                title="Выберите контакт"
                description="Слева — контакты для ручного аутрича. Здесь будет канал, анализ и черновик."
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function DraftPanel({ contact, onMark }: { contact: Contact; onMark: (status: string) => void }) {
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  const { data: draft, isLoading } = useQuery({
    queryKey: ['contact-draft', contact.id],
    queryFn: () => api.get<DraftResp>(`/contacts/${contact.id}/draft`),
  });

  const text = draft?.text ?? '';

  function copy(): void {
    if (!text) return;
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        toast.success('Скопировано в буфер');
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => toast.error('Не удалось скопировать'));
  }

  return (
    <div className="card-padded">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-base font-semibold text-slate-900">
            {contact.channel?.title ?? contact.channel?.handle ?? '—'}
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
            <Badge tone="slate">{contact.type}</Badge>
            <Badge tone="indigo">{contact.roleGuess}</Badge>
            <span className="font-mono">{contact.value}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => onMark('contacted')}>
            Отметить «contacted»
          </Button>
          <Button variant="secondary" size="sm" onClick={() => onMark('finished')}>
            Закрыть
          </Button>
        </div>
      </div>

      <div className="mt-5">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Черновик от агента</h3>
          <Button
            size="sm"
            leftIcon={copied ? <CheckIcon className="h-4 w-4" /> : <ClipboardDocumentIcon className="h-4 w-4" />}
            onClick={copy}
            disabled={!text}
          >
            {copied ? 'Скопировано' : 'Копировать'}
          </Button>
        </div>
        <div className="mt-2 rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
          {isLoading ? (
            <div className="flex h-24 items-center justify-center">
              <Spinner className="text-brand-500" />
            </div>
          ) : text ? (
            <p className="whitespace-pre-wrap text-sm text-slate-800">{text}</p>
          ) : (
            <div className="text-sm text-slate-500">
              Черновик ещё не сгенерирован. Запустите кампанию или дождитесь обработки агентом.
            </div>
          )}
        </div>
      </div>

      {draft?.channel?.description && (
        <div className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Описание канала</h3>
          <p className="mt-2 line-clamp-6 whitespace-pre-wrap text-sm text-slate-700">
            {draft.channel.description}
          </p>
        </div>
      )}

      {draft?.analysis && (
        <div className="mt-5">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Анализ</h3>
          <pre className="mt-2 max-h-48 overflow-auto rounded-xl bg-slate-50 p-3 font-mono text-[11px] text-slate-700 ring-1 ring-slate-200 scrollbar-thin">
            {JSON.stringify(draft.analysis, null, 2)}
          </pre>
        </div>
      )}

      <div className="mt-5 text-xs text-slate-500">Обновлён: {formatRelative(contact.updatedAt)}</div>
    </div>
  );
}
