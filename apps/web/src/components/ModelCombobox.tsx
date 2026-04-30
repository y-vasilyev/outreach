import { Fragment, useMemo, useState } from 'react';
import { Combobox, Transition } from '@headlessui/react';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, ChevronUpDownIcon, ExclamationTriangleIcon } from '@heroicons/react/20/solid';
import { api, ApiError } from '../lib/api';
import { cn } from '../lib/cn';

export interface ModelOption {
  id: string;
  name?: string;
  description?: string;
  contextLength?: number;
  pricing?: { promptPer1M?: number; completionPer1M?: number };
}

interface Props {
  /** Endpoint id whose `/models` we'll fetch. When falsy, the combobox is disabled. */
  endpointId: string | null | undefined;
  value: string;
  onChange: (next: string) => void;
  label?: string;
  helpText?: string;
  className?: string;
}

/**
 * Searchable combobox for picking an LLM model. Loads the catalogue from
 * `/endpoints/:id/models` (provider-aware: hits OpenRouter/openai-compat
 * `GET /models`, hardcoded list for Yandex). Always allows free-form input
 * so operators can type a model id the provider added recently.
 */
export function ModelCombobox({ endpointId, value, onChange, label, helpText, className }: Props) {
  const [query, setQuery] = useState('');

  const { data: models, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['endpoint-models', endpointId],
    queryFn: () => api.get<ModelOption[]>(`/endpoints/${endpointId}/models`),
    enabled: !!endpointId,
    staleTime: 5 * 60_000,
    retry: false,
  });

  const filtered = useMemo<ModelOption[]>(() => {
    const list = models ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list.slice(0, 200);
    return list
      .filter((m) => {
        const haystack = `${m.id} ${m.name ?? ''} ${m.description ?? ''}`.toLowerCase();
        return haystack.includes(q);
      })
      .slice(0, 200);
  }, [models, query]);

  // Always allow the typed value as an option even if the catalogue doesn't
  // include it (operator might know about a freshly-added model).
  const allowFreeform =
    query.length > 0 && !filtered.some((m) => m.id === query);

  const errMsg = isError
    ? error instanceof ApiError
      ? `${error.code}: ${error.message}`
      : (error as Error)?.message
    : null;

  return (
    <div className={cn('w-full', className)}>
      {label && <label className="label-base">{label}</label>}
      <Combobox value={value} onChange={(v) => onChange(v ?? '')} disabled={!endpointId}>
        <div className={cn('relative', label && 'mt-1.5')}>
          <Combobox.Input
            className="input-base pr-9"
            displayValue={(v: string) => v}
            placeholder={endpointId ? 'Поиск модели…' : 'Сначала выберите endpoint'}
            onChange={(e) => setQuery(e.target.value)}
          />
          <Combobox.Button className="absolute inset-y-0 right-0 flex items-center pr-2">
            <ChevronUpDownIcon className="h-5 w-5 text-slate-400" aria-hidden />
          </Combobox.Button>
          <Transition
            as={Fragment}
            leave="transition ease-in duration-100"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
            afterLeave={() => setQuery('')}
          >
            <Combobox.Options className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-xl bg-white py-1 shadow-pop ring-1 ring-slate-200 focus:outline-none scrollbar-thin">
              {isLoading && (
                <div className="px-3 py-2 text-xs text-slate-500">Загрузка моделей…</div>
              )}
              {isError && (
                <div className="px-3 py-2 text-xs text-rose-600">
                  <div className="flex items-center gap-1.5">
                    <ExclamationTriangleIcon className="h-4 w-4" />
                    {errMsg ?? 'Не удалось получить список моделей'}
                  </div>
                  <button
                    type="button"
                    onClick={() => refetch()}
                    className="mt-1 text-brand-600 hover:underline"
                  >
                    Повторить
                  </button>
                </div>
              )}
              {!isLoading && !isError && filtered.length === 0 && !allowFreeform && (
                <div className="px-3 py-2 text-xs text-slate-500">Ничего не найдено</div>
              )}
              {allowFreeform && (
                <Combobox.Option
                  value={query}
                  className={({ active }) =>
                    cn(
                      'relative cursor-pointer select-none px-3 py-2 text-sm',
                      active ? 'bg-brand-50 text-brand-700' : 'text-slate-700',
                    )
                  }
                >
                  Использовать как есть: <code className="font-mono">{query}</code>
                </Combobox.Option>
              )}
              {filtered.map((m) => (
                <Combobox.Option
                  key={m.id}
                  value={m.id}
                  className={({ active }) =>
                    cn(
                      'relative cursor-pointer select-none px-3 py-2 text-sm',
                      active ? 'bg-brand-50 text-brand-900' : 'text-slate-800',
                    )
                  }
                >
                  {({ selected }) => (
                    <div className="flex items-start gap-2">
                      <CheckIcon
                        className={cn(
                          'mt-0.5 h-4 w-4 flex-shrink-0',
                          selected ? 'text-brand-600' : 'text-transparent',
                        )}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-[12px]">{m.id}</div>
                        {m.name && m.name !== m.id && (
                          <div className="truncate text-[11px] text-slate-500">{m.name}</div>
                        )}
                        {(m.contextLength != null || m.pricing) && (
                          <div className="mt-0.5 flex flex-wrap gap-2 text-[10px] text-slate-500">
                            {m.contextLength != null && (
                              <span>ctx {formatCtx(m.contextLength)}</span>
                            )}
                            {m.pricing?.promptPer1M != null && (
                              <span>
                                ${m.pricing.promptPer1M.toFixed(2)}/1M in
                              </span>
                            )}
                            {m.pricing?.completionPer1M != null && (
                              <span>
                                ${m.pricing.completionPer1M.toFixed(2)}/1M out
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </Combobox.Option>
              ))}
            </Combobox.Options>
          </Transition>
        </div>
      </Combobox>
      {helpText && <p className="help-text">{helpText}</p>}
    </div>
  );
}

function formatCtx(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
