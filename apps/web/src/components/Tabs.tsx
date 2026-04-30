import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface Tab {
  key: string;
  label: ReactNode;
  badge?: ReactNode;
}

interface Props {
  tabs: Tab[];
  current: string;
  onChange: (key: string) => void;
  className?: string;
}

export function Tabs({ tabs, current, onChange, className }: Props) {
  return (
    <div className={cn('border-b border-slate-200', className)}>
      <nav className="flex -mb-px gap-6 overflow-x-auto scrollbar-thin">
        {tabs.map((t) => {
          const active = t.key === current;
          return (
            <button
              key={t.key}
              onClick={() => onChange(t.key)}
              className={cn(
                'inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-1 py-3 text-sm font-medium transition-colors',
                active
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700',
              )}
            >
              {t.label}
              {t.badge}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
