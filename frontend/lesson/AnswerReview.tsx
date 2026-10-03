import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useDesktopLayout } from '@/app/useDesktopLayout';
import { getAnswerReview } from '@/lib/api';
import { studio, useStudio } from '@/studio/studio';
import type { AnswerReview as SavedAnswer } from '../../server/types/grading.types.js';
import { PianoDiagram } from '@/instruments/PianoDiagram';
import { ReplayIndicator } from '@/audio/ReplayIndicator';

export function AnswerReview({
  attemptId,
  label,
  open,
  onOpenChange,
  children,
}: {
  attemptId: string;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const desktop = useDesktopLayout();
  const { snapshot, musicPlayback } = useStudio();
  const [answer, setAnswer] = useState<SavedAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const keyboard = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => clearTimeout(closeTimer.current);
  const leave = () => {
    if (desktop && !keyboard.current) {
      cancelClose();
      closeTimer.current = setTimeout(() => onOpenChange(false), 140);
    }
  };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!open || answer) return;
    const controller = new AbortController();
    setError(null);
    void getAnswerReview(attemptId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setAnswer(result);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : 'The saved answer could not be loaded.',
          );
      });
    return () => controller.abort();
  }, [open, answer, attemptId, retry]);
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Review ${label}`}
          className="flex size-full cursor-pointer items-center justify-center rounded-[inherit] outline-none focus-visible:bg-background/20"
          onPointerEnter={(event) => {
            if (desktop && event.pointerType === 'mouse') {
              keyboard.current = false;
              cancelClose();
              onOpenChange(true);
            }
          }}
          onPointerLeave={leave}
          onKeyDown={() => {
            keyboard.current = true;
            cancelClose();
          }}
          onClick={(event) => {
            if (desktop && event.detail > 0) {
              event.preventDefault();
              cancelClose();
              onOpenChange(true);
            }
          }}
        >
          {children}
        </button>
      </PopoverTrigger>
      <PopoverContent
        aria-label="Answer review"
        align="center"
        side="top"
        sideOffset={8}
        collisionPadding={12}
        className="scrollbar-thin scrollbar-thumb-muted-foreground/60 scrollbar-track-transparent max-h-(--radix-popover-content-available-height) w-80 max-w-[calc(100vw-1.5rem)] space-y-3 overflow-y-auto rounded-2xl p-4"
        onPointerEnter={cancelClose}
        onPointerLeave={leave}
        onOpenAutoFocus={(event) => {
          if (desktop && !keyboard.current) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (desktop && !keyboard.current) event.preventDefault();
        }}
        onKeyDown={() => {
          keyboard.current = true;
          cancelClose();
        }}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-medium text-muted-foreground">Answer</h3>
          {musicPlayback?.replay && musicPlayback.exerciseId === answer?.exerciseId && (
            <ReplayIndicator />
          )}
        </div>
        {answer ? (
          <>
            <PianoDiagram example={answer.example} exampleId={answer.exerciseId} />
            <p className="text-center text-sm font-medium">{answer.grade.expectedLabel}</p>
            <div className="flex justify-center">
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                disabled={!snapshot?.session}
                onClick={() => {
                  void studio.action('replay_exercise', { exerciseId: answer.exerciseId });
                }}
              >
                <RotateCcw />
                Hear again
              </Button>
            </div>
          </>
        ) : error ? (
          <div>
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
            <Button variant="text" size="sm" onClick={() => setRetry((value) => value + 1)}>
              Try again
            </Button>
          </div>
        ) : (
          <div
            role="status"
            aria-label="Loading answer"
            className="flex h-24 items-center justify-center"
          >
            <LoaderCircle className="size-5 text-muted-foreground motion-safe:animate-spin" />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
