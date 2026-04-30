import { Fragment, type ReactNode } from 'react';
import { Menu, Transition } from '@headlessui/react';
import { cn } from '../lib/cn';

export interface DropdownItem {
  label: string;
  onClick?: () => void;
  href?: string;
  icon?: ReactNode;
  variant?: 'default' | 'danger';
  disabled?: boolean;
}

interface Props {
  trigger: ReactNode;
  items: DropdownItem[];
  align?: 'left' | 'right';
}

export function Dropdown({ trigger, items, align = 'right' }: Props) {
  return (
    <Menu as="div" className="relative inline-block text-left">
      <Menu.Button as="div" className="inline-flex">
        {trigger}
      </Menu.Button>
      <Transition
        as={Fragment}
        enter="transition ease-out duration-100"
        enterFrom="transform opacity-0 scale-95"
        enterTo="transform opacity-100 scale-100"
        leave="transition ease-in duration-75"
        leaveFrom="transform opacity-100 scale-100"
        leaveTo="transform opacity-0 scale-95"
      >
        <Menu.Items
          className={cn(
            'absolute z-30 mt-1 min-w-[12rem] origin-top-right rounded-xl bg-white p-1 shadow-pop ring-1 ring-slate-200 focus:outline-none',
            align === 'right' ? 'right-0' : 'left-0',
          )}
        >
          {items.map((it, idx) => (
            <Menu.Item key={idx} disabled={it.disabled}>
              {({ active, disabled }) => {
                const cls = cn(
                  'flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm',
                  active && 'bg-slate-50',
                  it.variant === 'danger' ? 'text-rose-600' : 'text-slate-700',
                  disabled && 'cursor-not-allowed opacity-50',
                );
                if (it.href) {
                  return (
                    <a href={it.href} className={cls}>
                      {it.icon}
                      {it.label}
                    </a>
                  );
                }
                return (
                  <button onClick={it.onClick} className={cls} disabled={disabled}>
                    {it.icon}
                    {it.label}
                  </button>
                );
              }}
            </Menu.Item>
          ))}
        </Menu.Items>
      </Transition>
    </Menu>
  );
}
