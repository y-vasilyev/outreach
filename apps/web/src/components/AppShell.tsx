import { useState, type ReactNode } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useAuth } from '../lib/auth';
import { Spinner } from './Spinner';
import { cn } from '../lib/cn';

export function AppShell({ children }: { children?: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { isReady } = useAuth();

  if (!isReady) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="text-brand-500" />
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <div className="hidden h-full lg:block">
        <Sidebar />
      </div>
      {drawerOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-900/40 lg:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <div
        className={cn(
          'fixed inset-y-0 left-0 z-50 transition-transform duration-200 lg:hidden',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <Sidebar />
      </div>
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <Topbar onToggleMenu={() => setDrawerOpen((v) => !v)} />
        <main className="flex-1 overflow-y-auto bg-slate-50 scrollbar-thin">
          <div className="mx-auto w-full max-w-7xl px-4 py-6 md:px-6 md:py-8">
            {children ?? <Outlet />}
          </div>
        </main>
      </div>
    </div>
  );
}
