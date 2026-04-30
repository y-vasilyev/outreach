import { forwardRef, type SelectHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface Props extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  helpText?: string;
  error?: string;
  options: SelectOption[];
  placeholder?: string;
}

export const Select = forwardRef<HTMLSelectElement, Props>(function Select(
  { label, helpText, error, options, placeholder, className, id, ...rest },
  ref,
) {
  const inputId = id || `sel-${Math.random().toString(36).slice(2, 9)}`;
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="label-base">
          {label}
        </label>
      )}
      <select
        id={inputId}
        ref={ref}
        className={cn(
          'input-base appearance-none bg-[url("data:image/svg+xml;utf8,%3Csvg%20xmlns%3D%27http%3A//www.w3.org/2000/svg%27%20width%3D%2716%27%20height%3D%2716%27%20fill%3D%27none%27%20viewBox%3D%270%200%2016%2016%27%3E%3Cpath%20stroke%3D%27%2364748b%27%20stroke-linecap%3D%27round%27%20stroke-linejoin%3D%27round%27%20stroke-width%3D%271.5%27%20d%3D%27m4%206%204%204%204-4%27/%3E%3C/svg%3E")] bg-[length:16px_16px] bg-[right_10px_center] bg-no-repeat pr-9',
          label && 'mt-1.5',
          error && 'ring-rose-300 focus:ring-rose-500',
          className,
        )}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      {error ? (
        <p className="mt-1.5 text-xs text-rose-600">{error}</p>
      ) : helpText ? (
        <p className="help-text">{helpText}</p>
      ) : null}
    </div>
  );
});
