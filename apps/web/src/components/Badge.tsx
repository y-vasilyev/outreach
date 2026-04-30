import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

export type BadgeTone =
  | 'gray'
  | 'emerald'
  | 'amber'
  | 'rose'
  | 'violet'
  | 'sky'
  | 'indigo'
  | 'slate';

interface Props {
  tone?: BadgeTone;
  dot?: boolean;
  children: ReactNode;
  className?: string;
}

const tones: Record<BadgeTone, string> = {
  gray: 'bg-slate-50 text-slate-700 ring-slate-200',
  slate: 'bg-slate-100 text-slate-800 ring-slate-200',
  emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  rose: 'bg-rose-50 text-rose-700 ring-rose-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
  sky: 'bg-sky-50 text-sky-700 ring-sky-200',
  indigo: 'bg-brand-50 text-brand-700 ring-brand-200',
};

const dotTones: Record<BadgeTone, string> = {
  gray: 'bg-slate-400',
  slate: 'bg-slate-500',
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  rose: 'bg-rose-500',
  violet: 'bg-violet-500',
  sky: 'bg-sky-500',
  indigo: 'bg-brand-500',
};

export function Badge({ tone = 'gray', dot, children, className }: Props) {
  return (
    <span className={cn('pill', tones[tone], className)}>
      {dot && <span className={cn('h-1.5 w-1.5 rounded-full', dotTones[tone])} />}
      {children}
    </span>
  );
}
