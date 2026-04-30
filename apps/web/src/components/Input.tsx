import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import { cn } from '../lib/cn';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  helpText?: string;
  error?: string;
  leftIcon?: ReactNode;
  rightSlot?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, Props>(function Input(
  { label, helpText, error, leftIcon, rightSlot, className, id, ...rest },
  ref,
) {
  const inputId = id || `inp-${Math.random().toString(36).slice(2, 9)}`;
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="label-base">
          {label}
        </label>
      )}
      <div className={cn('relative', label && 'mt-1.5')}>
        {leftIcon && (
          <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-slate-400">
            {leftIcon}
          </div>
        )}
        <input
          id={inputId}
          ref={ref}
          className={cn(
            'input-base',
            leftIcon && 'pl-9',
            rightSlot && 'pr-10',
            error && 'ring-rose-300 focus:ring-rose-500',
            className,
          )}
          {...rest}
        />
        {rightSlot && <div className="absolute inset-y-0 right-0 flex items-center pr-2">{rightSlot}</div>}
      </div>
      {error ? (
        <p className="mt-1.5 text-xs text-rose-600">{error}</p>
      ) : helpText ? (
        <p className="help-text">{helpText}</p>
      ) : null}
    </div>
  );
});
