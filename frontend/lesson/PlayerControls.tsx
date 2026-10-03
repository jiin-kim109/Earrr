import { useState } from 'react';
import { ArrowRight, BookOpen, RotateCcw, SkipForward } from 'lucide-react';
import { AlertDialog } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { studio } from '@/studio/studio';
import { useLesson } from './useLesson.js';
import { ReplayIndicator } from '@/audio/ReplayIndicator';

export function TutorialReturn() {
  const { state, snapshot, session, teaching } = useLesson();
  const [roundId, setRoundId] = useState<string | null>(null);
  if (teaching || !session) return null;
  return (
    <AlertDialog.Root
      onOpenChange={(open) => {
        if (open) setRoundId(snapshot.course.round.id);
      }}
    >
      <AlertDialog.Trigger asChild>
        <Button
          type="button"
          variant="text"
          size="sm"
          className="h-12 gap-2 px-2 text-sm font-medium"
          disabled={state.busy || !snapshot.configured}
          title="Review this lesson's explanation"
        >
          <BookOpen className="size-5" strokeWidth={1.7} />
          Tutorial
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-foreground/25 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:fade-in motion-safe:duration-150" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-popover p-6 shadow-lg outline-none motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150">
          <AlertDialog.Title className="text-lg font-semibold tracking-tight">
            Return to the tutorial?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Your current round will be reset. Your saved learning history will be kept.
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="ghost" className="rounded-full">
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button
                className="rounded-full"
                onClick={() => {
                  void studio.openTutorial(roundId);
                }}
              >
                Confirm
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

export function PlayerControls() {
  const { state, session, paused, running, resolved, teaching, next, nextUnlocked, welcome } =
    useLesson();
  if (state.busy || state.entering || state.restartingRound || !running || paused) return null;
  if (teaching)
    return (
      <Button
        type="button"
        aria-label={
          welcome
            ? 'Start learning'
            : teaching.awaitingPractice
              ? 'Start exercises'
              : 'Skip tutorial'
        }
        variant={welcome ? 'outline' : 'ghost'}
        size="sm"
        className="gap-2 rounded-full px-4 font-normal text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => {
          void (welcome
            ? studio.action('continue_teaching', { presentationId: teaching.presentationId })
            : studio.skipTeaching());
        }}
      >
        {welcome || teaching.awaitingPractice ? <ArrowRight /> : <SkipForward />}
        {welcome ? "Let's begin" : teaching.awaitingPractice ? 'Start exercises' : 'Skip'}
      </Button>
    );
  if (session?.awaitingRoundChoice)
    return (
      <div className="flex w-full flex-wrap items-center justify-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="rounded-full px-5"
          onClick={() => {
            void studio.startRound();
          }}
        >
          <RotateCcw />
          Restart exercises
        </Button>
        {state.snapshot?.course.round.previous?.passed && next && (
          <Button
            variant="outline"
            size="sm"
            className="rounded-full px-5"
            disabled={!nextUnlocked}
            onClick={() => {
              void studio.focus(next);
            }}
          >
            Next lesson
            <ArrowRight />
          </Button>
        )}
      </div>
    );
  if (state.answerReveal && session?.mode === 'coach') return null;
  const nextQuestion = resolved && session?.mode === 'solo';
  const nextRound = nextQuestion && state.answerReveal?.roundResult;
  const replaying =
    state.musicPlayback?.replay && state.musicPlayback.exerciseId === state.snapshot?.current?.id;
  return (
    <Button
      variant="outline"
      size="sm"
      className="rounded-full px-5"
      onClick={() => {
        void studio.action(nextQuestion ? 'play_exercise' : 'replay_exercise', {});
      }}
    >
      {nextQuestion ? <ArrowRight /> : replaying ? <ReplayIndicator /> : <RotateCcw />}
      {nextRound ? 'Next round' : nextQuestion ? 'Next question' : 'Hear again'}
    </Button>
  );
}
