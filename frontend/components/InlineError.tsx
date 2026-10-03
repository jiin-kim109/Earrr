import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { studio, useStudio } from '@/studio/studio';

export function InlineError() {
  const state = useStudio();
  const message = state.error ?? state.notice;
  if (!message) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 py-2 text-xs"
      role={state.error ? 'alert' : 'status'}
    >
      <AlertCircle className="size-3.5 shrink-0 text-destructive" />
      <span className="min-w-0 flex-1 wrap-anywhere">{message}</span>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 text-xs"
        aria-label="Dismiss error"
        onClick={() => studio.dismissError()}
      >
        Dismiss
      </Button>
    </div>
  );
}
