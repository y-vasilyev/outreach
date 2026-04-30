import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

interface Props {
  title: string;
  description?: string;
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
  className?: string;
}

export function PageHeader({ title, description, actions, breadcrumbs, className }: Props) {
  return (
    <div className={cn('flex flex-col gap-3 pb-6 md:flex-row md:items-end md:justify-between', className)}>
      <div className="min-w-0">
        {breadcrumbs && <div className="mb-1.5 text-xs text-slate-500">{breadcrumbs}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
