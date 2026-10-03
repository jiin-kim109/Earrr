import { useId, type ComponentProps } from 'react';
import { cn } from 'cn';
import { Label } from '@/components/ui/label';

type FormFieldProps = ComponentProps<'input'> & {
  label: string;
  hint?: string;
  error?: string;
};

export function FormField({ label, hint, error, id, className, ...props }: FormFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const descriptionIds =
    [
      props['aria-describedby'],
      hint ? `${fieldId}-hint` : undefined,
      error ? `${fieldId}-error` : undefined,
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <div className="min-w-0 space-y-2">
      <Label htmlFor={fieldId}>{label}</Label>
      <input
        {...props}
        id={fieldId}
        aria-describedby={descriptionIds}
        aria-invalid={error ? true : props['aria-invalid']}
        className={cn(
          'h-12 w-full min-w-0 rounded-md border border-input bg-card px-3.5 text-base text-foreground outline-none transition-[border-color,box-shadow] duration-150 ease-out-expo placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/15 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive/15 motion-reduce:transition-none',
          className,
        )}
      />
      {hint && (
        <p id={`${fieldId}-hint`} className="text-xs leading-relaxed text-muted-foreground">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${fieldId}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
