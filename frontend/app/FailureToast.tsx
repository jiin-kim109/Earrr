import { Component } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle, RotateCw } from 'lucide-react';
import { AlertDialog } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { studio, useStudio } from '@/studio/studio';

export function FailureToast() {
  const failed = useStudio((state) => state.fatalError !== null);
  return (
    <AlertDialog.Root open={failed}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          data-testid="fatal-backdrop"
          className="fixed inset-0 z-[80] bg-background/25 backdrop-blur-[3px]"
        />
        <AlertDialog.Content
          data-testid="fatal-toast"
          onEscapeKeyDown={(event) => event.preventDefault()}
          className="fixed right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] z-[90] flex w-[min(26rem,calc(100vw-2rem))] items-start gap-3 rounded-2xl border border-border bg-popover p-5 text-popover-foreground shadow-lg outline-none"
        >
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <AlertDialog.Title className="text-base font-semibold">
              Something went wrong
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-muted-foreground">
              Refresh the page to continue.
            </AlertDialog.Description>
            <Button className="mt-4 rounded-full" size="sm" onClick={() => location.reload()}>
              <RotateCw />
              Refresh
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export class AppFailureBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    studio.fail(error);
  }
  render() {
    return this.state.failed ? (
      <div className="min-h-dvh bg-background">
        <FailureToast />
      </div>
    ) : (
      this.props.children
    );
  }
}
