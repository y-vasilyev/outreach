import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

interface Item {
  label: ReactNode;
  value: ReactNode;
}

interface Props {
  items: Item[];
  columns?: 1 | 2 | 3;
  className?: string;
}

export function KeyValue({ items, columns = 2, className }: Props) {
  const cols =
    columns === 3 ? 'sm:grid-cols-3' : columns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-1';
  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-4', cols, className)}>
      {items.map((it, idx) => (
        <div key={idx} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{it.label}</dt>
          <dd className="mt-1 text-sm text-slate-900">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
