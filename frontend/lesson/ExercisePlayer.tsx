import { BookOpen, Box, LoaderCircle } from 'lucide-react';
import { cn } from 'cn';
import { Waveform } from '@/audio/Waveform';
import { AudioSettings } from '@/audio/AudioSettings';
import { studio } from '@/studio/studio';
import { PlayerControls, TutorialReturn } from './PlayerControls.js';
import { LessonProgress } from './LessonProgress.js';
import { MusicalDisplay, QuestionGraphic, useShortDisplay } from './MusicalDisplay.js';
import { useLesson } from './useLesson.js';
import { TutorialSteps } from './TutorialSteps.js';

const voiceLevel = () => studio.audio.voiceLevel();
export function ExercisePlayer({ compact = false }: { compact?: boolean }) {
  const { state, snapshot, session, teaching, phase, current, welcome, lesson } = useLesson();
  const round =
    !teaching && !state.restartingRound && session?.awaitingRoundChoice
      ? snapshot.course.round.previous
      : null;
  const lastAttempt = round?.answers?.at(-1)?.attemptId;
  const savedReveal =
    round && snapshot.feedback?.attemptId === lastAttempt ? snapshot.feedback : null;
  const reveal = teaching || state.restartingRound ? null : (state.answerReveal ?? savedReveal);
  const evidence = teaching?.example
    ? { example: teaching.example, id: teaching.presentationId }
    : reveal?.example
      ? { example: reveal.example, id: reveal.exerciseId }
      : null;
  const played = evidence?.example;
  const question =
    !teaching && !reveal && !round && !state.restartingRound && current?.status === 'unanswered'
      ? current.question
      : undefined;
  const noteSummary = played?.notes.join(played.presentation === 'together' ? ' + ' : ' → ');
  const short = useShortDisplay();
  const dense = compact && short && Boolean(played?.diagram || question);
  const title = round
    ? round.passed
      ? 'Round passed'
      : 'Round not passed'
    : reveal
      ? reveal.grade.expectedLabel
      : teaching
        ? teaching.title
        : !session
          ? lesson.shortName
          : phase === 'speaking' || (phase === 'playing' && !state.musicPlayback?.replay)
            ? 'Listen'
            : 'Your turn';
  const mode = welcome ? 'welcome' : teaching ? 'tutorial' : 'exercise';
  return (
    <section
      aria-label="Exercise player"
      data-phase={phase}
      data-mode={welcome ? 'welcome' : teaching ? 'teaching' : 'practice'}
      className={cn(
        'flex min-h-0 flex-col rounded-3xl border border-border/60 bg-card shadow-soft',
        compact ? 'flex-1' : 'h-full',
      )}
    >
      <header
        data-testid="exercise-toolbar"
        className={cn(
          'flex shrink-0 items-center justify-between',
          compact ? 'px-4 pt-3 pb-1' : 'px-6 pt-4 pb-2',
        )}
      >
        <TutorialReturn />
        <div className="ml-auto">
          <AudioSettings />
        </div>
      </header>
      <div
        className={cn(
          'scrollbar-thin scrollbar-thumb-muted-foreground/60 scrollbar-track-transparent flex min-h-0 flex-1 flex-col overflow-y-auto px-5 text-center',
          compact ? 'py-0' : 'py-4',
        )}
      >
        <div className="my-auto flex w-full shrink-0 flex-col items-center">
          {(evidence || question) && (
            <div
              className={cn(
                'flex w-full max-w-[430px] items-center justify-center',
                dense ? 'mb-1' : compact ? 'mb-2' : 'mb-4 h-40',
              )}
              style={
                compact
                  ? {
                      height: dense
                        ? '3.5rem'
                        : evidence?.example.diagram || question
                          ? 'clamp(5.5rem, calc(var(--app-height, 100dvh) * 0.16), 8rem)'
                          : 'clamp(2.25rem, calc(var(--app-height, 100dvh) * 0.14 - 2.5rem), 7rem)',
                    }
                  : undefined
              }
            >
              {evidence ? (
                <MusicalDisplay example={evidence.example} exampleId={evidence.id} dense={dense} />
              ) : question ? (
                <QuestionGraphic
                  question={question}
                  playing={state.musicPlayback?.exerciseId === current?.id}
                  dense={dense}
                />
              ) : null}
            </div>
          )}
          <div
            className={cn(
              'flex w-full items-center justify-center',
              dense ? 'mb-1 h-4' : compact ? 'mb-2 h-12' : 'mb-4 h-24',
            )}
            style={
              compact
                ? {
                    height: dense
                      ? '1rem'
                      : 'clamp(1.5rem, calc(var(--app-height, 100dvh) * 0.08 - 1rem), 3rem)',
                  }
                : undefined
            }
          >
            <Waveform
              active={phase === 'speaking'}
              level={voiceLevel}
              label="Coach audio"
              className={compact ? 'h-full' : 'h-24'}
            />
          </div>
          <div
            key={mode}
            data-testid="lesson-content"
            className="flex w-full shrink-0 flex-col items-center motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150 motion-safe:ease-out-expo motion-reduce:animate-none"
          >
            {!welcome && (
              <div
                className={cn(
                  dense ? 'sr-only' : 'flex items-center gap-2.5',
                  !dense && (compact ? 'mb-2 min-h-8' : 'mb-3 min-h-9'),
                )}
              >
                <span
                  data-testid="lesson-mode"
                  className={cn(
                    'flex items-center gap-2.5 font-medium text-muted-foreground',
                    compact ? 'text-sm' : 'text-base',
                  )}
                >
                  <span
                    className={cn(
                      'flex items-center justify-center rounded-lg',
                      compact ? 'size-8' : 'size-9',
                      teaching ? 'bg-tutorial/20 text-foreground/75' : 'bg-brand/10 text-brand',
                    )}
                  >
                    {teaching ? (
                      <BookOpen className="size-[18px]" strokeWidth={1.7} />
                    ) : (
                      <Box className="size-[18px]" strokeWidth={1.7} />
                    )}
                  </span>
                  {teaching ? 'Tutorial' : 'Exercise'}
                </span>
              </div>
            )}
            <h2
              data-testid={round ? 'round-result' : undefined}
              className={cn(
                'font-medium tracking-tight',
                dense
                  ? 'text-base leading-tight'
                  : compact
                    ? 'text-xl'
                    : 'text-[28px] leading-tight',
                round && (round.passed ? 'text-success' : 'text-destructive'),
              )}
              aria-live={snapshot.settings.volume === 0 ? 'polite' : 'off'}
            >
              {dense && question ? question.instruction : title}
            </h2>
            {evidence && !played?.diagram && (
              <div
                data-testid={teaching ? 'teaching-example' : 'grade-feedback'}
                data-feedback-id={reveal?.attemptId ?? undefined}
                role="status"
                className="mt-2 max-w-[44ch]"
              >
                <p
                  className={cn(
                    'mt-1 max-w-[48ch] leading-relaxed text-muted-foreground',
                    compact ? 'text-xs' : 'text-sm',
                  )}
                >
                  {noteSummary}
                </p>
                {played?.semitones !== undefined && (
                  <p
                    data-testid="interval-size"
                    className={cn('mt-1 text-muted-foreground', compact ? 'text-xs' : 'text-sm')}
                  >
                    {played.semitones} {played.semitones === 1 ? 'semitone' : 'semitones'}
                  </p>
                )}
              </div>
            )}
            {question && !dense && (
              <p className="mt-2 text-sm text-muted-foreground">{question.instruction}</p>
            )}
            {!compact && !question && !reveal && !round && !teaching && current && (
              <p
                data-testid="exercise-prompt"
                className="mt-2 max-w-[44ch] text-sm text-muted-foreground"
              >
                {current.prompt}
              </p>
            )}
            {teaching && snapshot.settings.volume === 0 && (
              <p className="mt-3 max-w-[46ch] text-sm text-muted-foreground">
                {teaching.narration}
              </p>
            )}
            <div
              className={cn(
                dense ? 'mt-2' : compact ? 'mt-3' : 'mt-5',
                round && 'max-w-sm',
                round && (compact && short ? '-mx-4 w-[calc(100%+2rem)]' : 'w-full'),
              )}
            >
              {state.busy ||
              state.entering ||
              state.restartingRound ||
              ['connecting', 'reconnecting'].includes(state.connection) ? (
                <span
                  role="status"
                  aria-label="Preparing training"
                  className="flex h-9 items-center justify-center"
                >
                  <LoaderCircle className="size-5 text-muted-foreground motion-safe:animate-spin" />
                </span>
              ) : (
                <PlayerControls />
              )}
            </div>
          </div>
        </div>
      </div>
      {teaching ? <TutorialSteps compact={compact} /> : <LessonProgress compact={compact} />}
    </section>
  );
}
