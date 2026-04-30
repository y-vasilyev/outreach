import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { CheckCircleIcon, ExclamationTriangleIcon, InformationCircleIcon, XCircleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { cn } from '../lib/cn';

type ToastVariant = 'success' | 'error' | 'info' | 'warning';

interface ToastItem {
  id: number;
  variant: ToastVariant;
  title: string;
  description?: string;
}

interface ToastApi {
  show(t: Omit<ToastItem, 'id'>): void;
  success(title: string, description?: string): void;
  error(title: string, description?: string): void;
  info(title: string, description?: string): void;
  warning(title: string, description?: string): void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    setItems((arr) => arr.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (t: Omit<ToastItem, 'id'>) => {
      const id = ++idRef.current;
      setItems((arr) => [...arr, { ...t, id }]);
      window.setTimeout(() => remove(id), 4500);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show,
      success: (title, description) => show({ variant: 'success', title, description }),
      error: (title, description) => show({ variant: 'error', title, description }),
      info: (title, description) => show({ variant: 'info', title, description }),
      warning: (title, description) => show({ variant: 'warning', title, description }),
    }),
    [show],
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[80] flex w-full max-w-sm flex-col gap-2">
        {items.map((t) => (
          <ToastCard key={t.id} item={t} onClose={() => remove(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

function ToastCard({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  const Icon =
    item.variant === 'success'
      ? CheckCircleIcon
      : item.variant === 'error'
      ? XCircleIcon
      : item.variant === 'warning'
      ? ExclamationTriangleIcon
      : InformationCircleIcon;
  const color =
    item.variant === 'success'
      ? 'text-emerald-600'
      : item.variant === 'error'
      ? 'text-rose-600'
      : item.variant === 'warning'
      ? 'text-amber-600'
      : 'text-brand-600';
  return (
    <div
      className={cn(
        'pointer-events-auto animate-fade-in rounded-2xl bg-white p-4 shadow-pop ring-1 ring-slate-200',
        'flex items-start gap-3',
      )}
    >
      <Icon className={cn('h-5 w-5 flex-shrink-0', color)} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-slate-900">{item.title}</div>
        {item.description && <div className="mt-1 text-sm text-slate-600">{item.description}</div>}
      </div>
      <button
        onClick={onClose}
        className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        aria-label="Close"
      >
        <XMarkIcon className="h-4 w-4" />
      </button>
    </div>
  );
}

