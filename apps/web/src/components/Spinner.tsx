import { cn } from '../lib/cn';

export function Spinner({ className, size = 'md' }: { className?: string; size?: 'sm' | 'md' | 'lg' }) {
  const sz = size === 'sm' ? 'h-4 w-4' : size === 'lg' ? 'h-8 w-8' : 'h-5 w-5';
  return (
    <svg
      className={cn('animate-spin text-current', sz, className)}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
      />
    </svg>
  );
}

export function PageSpinner({ label = 'Загрузка…' }: { label?: string }) {
  return (
    <div className="flex h-64 items-center justify-center text-slate-500">
      <Spinner className="text-brand-500" />
      <span className="ml-3 text-sm">{label}</span>
    </div>
  );
}
