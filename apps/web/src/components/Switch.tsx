import { Switch as HSwitch } from '@headlessui/react';
import { cn } from '../lib/cn';

interface Props {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, description, disabled }: Props) {
  return (
    <HSwitch.Group as="div" className="flex items-center justify-between gap-4">
      <span className="flex flex-1 flex-col">
        {label && <HSwitch.Label className="text-sm font-medium text-slate-900">{label}</HSwitch.Label>}
        {description && (
          <HSwitch.Description className="text-xs text-slate-500">{description}</HSwitch.Description>
        )}
      </span>
      <HSwitch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className={cn(
          'relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2',
          checked ? 'bg-brand-600' : 'bg-slate-200',
          disabled && 'opacity-50',
        )}
      >
        <span
          className={cn(
            'pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </HSwitch>
    </HSwitch.Group>
  );
}
