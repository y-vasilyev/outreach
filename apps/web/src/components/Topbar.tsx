import { type ReactNode } from 'react';
import { BellIcon, MagnifyingGlassIcon, Bars3Icon } from '@heroicons/react/24/outline';
import { useAuth } from '../lib/auth';

interface Props {
  onToggleMenu?: () => void;
  search?: ReactNode;
}

export function Topbar({ onToggleMenu, search }: Props) {
  const { user } = useAuth();
  const initials = user?.email?.slice(0, 2).toUpperCase() ?? '??';
  return (
    <header className="sticky top-0 z-20 flex h-14 flex-shrink-0 items-center gap-3 border-b border-slate-200 bg-white/80 px-4 backdrop-blur md:px-6">
      <button
        onClick={onToggleMenu}
        className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden"
        aria-label="Open menu"
      >
        <Bars3Icon className="h-5 w-5" />
      </button>
      <div className="flex flex-1 items-center gap-2">
        {search ?? (
          <div className="relative hidden max-w-md flex-1 md:block">
            <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              placeholder="Поиск каналов, контактов, диалогов…"
              className="block w-full rounded-xl border-0 bg-slate-100 py-2 pl-9 pr-3 text-sm text-slate-700 placeholder:text-slate-400 focus:bg-white focus:ring-2 focus:ring-inset focus:ring-brand-500"
            />
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-100" aria-label="Notifications">
          <BellIcon className="h-5 w-5" />
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-rose-500 ring-2 ring-white" />
        </button>
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-xs font-semibold text-white">
          {initials}
        </div>
      </div>
    </header>
  );
}
