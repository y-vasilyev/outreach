import { forwardRef, type TextareaHTMLAttributes } from 'react';
import { cn } from '../lib/cn';

interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  helpText?: string;
  error?: string;
  fontMono?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, Props>(function Textarea(
  { label, helpText, error, fontMono, className, id, rows = 5, ...rest },
  ref,
) {
  const inputId = id || `ta-${Math.random().toString(36).slice(2, 9)}`;
  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="label-base">
          {label}
        </label>
      )}
      <textarea
        id={inputId}
        ref={ref}
        rows={rows}
        className={cn(
          'input-base resize-y leading-6',
          label && 'mt-1.5',
          fontMono && 'font-mono text-[13px]',
          error && 'ring-rose-300 focus:ring-rose-500',
          className,
        )}
        {...rest}
      />
      {error ? (
        <p className="mt-1.5 text-xs text-rose-600">{error}</p>
      ) : helpText ? (
        <p className="help-text">{helpText}</p>
      ) : null}
    </div>
  );
});
