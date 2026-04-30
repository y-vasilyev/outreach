import { NavLink } from 'react-router-dom';
import {
  HomeIcon,
  ChatBubbleLeftRightIcon,
  RectangleStackIcon,
  UserGroupIcon,
  Cog6ToothIcon,
  ServerStackIcon,
  CommandLineIcon,
  KeyIcon,
  PaperAirplaneIcon,
  IdentificationIcon,
  HashtagIcon,
  ClipboardDocumentListIcon,
  DevicePhoneMobileIcon,
  PuzzlePieceIcon,
  ShieldCheckIcon,
  ArrowRightOnRectangleIcon,
} from '@heroicons/react/24/outline';
import { cn } from '../lib/cn';
import { useAuth } from '../lib/auth';
import { Dropdown } from './Dropdown';

interface NavItem {
  to: string;
  label: string;
  icon: typeof HomeIcon;
  end?: boolean;
}

const groups: { label: string; items: NavItem[] }[] = [
  {
    label: 'Обзор',
    items: [
      { to: '/', label: 'Дашборд', icon: HomeIcon, end: true },
      { to: '/inbox', label: 'Диалоги', icon: ChatBubbleLeftRightIcon },
      { to: '/manual', label: 'Manual outreach', icon: PaperAirplaneIcon },
    ],
  },
  {
    label: 'Данные',
    items: [
      { to: '/channels', label: 'Каналы', icon: HashtagIcon },
      { to: '/contacts', label: 'Контакты', icon: IdentificationIcon },
      { to: '/campaigns', label: 'Кампании', icon: ClipboardDocumentListIcon },
    ],
  },
  {
    label: 'Конфигурация',
    items: [
      { to: '/agents', label: 'Агенты', icon: CommandLineIcon },
      { to: '/endpoints', label: 'LLM endpoints', icon: ServerStackIcon },
      { to: '/integrations', label: 'Интеграции', icon: PuzzlePieceIcon },
      { to: '/tg-accounts', label: 'TG аккаунты', icon: DevicePhoneMobileIcon },
    ],
  },
  {
    label: 'Команда',
    items: [
      { to: '/users', label: 'Пользователи', icon: UserGroupIcon },
      { to: '/audit', label: 'Аудит', icon: ShieldCheckIcon },
    ],
  },
];

export function Sidebar() {
  const { user, logout } = useAuth();
  const initials = user?.email?.slice(0, 2).toUpperCase() ?? '??';
  return (
    <aside className="flex h-full w-60 flex-shrink-0 flex-col border-r border-slate-800 bg-slate-900 text-slate-200">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-brand-600 text-base font-bold text-white">
          N
        </div>
        <div className="min-w-0 leading-tight">
          <div className="truncate text-sm font-semibold text-white">Nosquare</div>
          <div className="truncate text-[11px] text-slate-400">Outreach Console</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-4 scrollbar-thin">
        {groups.map((g) => (
          <div key={g.label} className="mt-3">
            <div className="px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              {g.label}
            </div>
            <ul className="space-y-0.5">
              {g.items.map((it) => {
                const Icon = it.icon;
                return (
                  <li key={it.to}>
                    <NavLink
                      to={it.to}
                      end={it.end}
                      className={({ isActive }) =>
                        cn(
                          'group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                          isActive
                            ? 'bg-slate-800 text-white'
                            : 'text-slate-300 hover:bg-slate-800/60 hover:text-white',
                        )
                      }
                    >
                      <Icon className="h-[18px] w-[18px] flex-shrink-0" />
                      <span className="truncate">{it.label}</span>
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-slate-800 p-3">
        <Dropdown
          align="left"
          trigger={
            <button className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-slate-800">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-700 text-xs font-semibold text-white">
                {initials}
              </div>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="truncate text-sm font-medium text-white">{user?.name || user?.email || 'Гость'}</div>
                <div className="truncate text-[11px] text-slate-400">{user?.role ?? '—'}</div>
              </div>
              <Cog6ToothIcon className="h-4 w-4 text-slate-400" />
            </button>
          }
          items={[
            {
              label: 'Профиль',
              icon: <KeyIcon className="h-4 w-4" />,
              href: '/users',
            },
            {
              label: 'Настройки',
              icon: <RectangleStackIcon className="h-4 w-4" />,
              href: '/integrations',
            },
            {
              label: 'Выйти',
              icon: <ArrowRightOnRectangleIcon className="h-4 w-4" />,
              variant: 'danger',
              onClick: logout,
            },
          ]}
        />
      </div>
    </aside>
  );
}
