import { type ReactNode } from 'react';
import { InboxIcon } from '@heroicons/react/24/outline';
import { cn } from '../lib/cn';

interface Props {
  title: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, icon, action, className }: Props) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-16 text-center', className)}>
      <div className="rounded-2xl bg-slate-100 p-4 text-slate-500">
        {icon ?? <InboxIcon className="h-7 w-7" />}
      </div>
      <h3 className="mt-4 text-base font-semibold text-slate-900">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
