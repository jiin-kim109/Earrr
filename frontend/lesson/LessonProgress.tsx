import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { cn } from 'cn';
import { useLesson } from './useLesson.js';
import { AnswerReview } from './AnswerReview.js';

const outcomes = {
  correct: {
    label: 'Correct',
    icon: Check,
    style: 'border-success bg-success text-primary-foreground',
  },
  incorrect: {
    label: 'Incorrect',
    icon: X,
    style: 'border-destructive bg-destructive text-primary-foreground',
  },
  unanswered: {
    label: 'Not answered',
    icon: null,
    style: 'border-border/80 bg-card text-muted-foreground',
  },
};

export function LessonProgress({ compact = false }: { compact?: boolean }) {
  const { state, snapshot, lesson, teaching, session } = useLesson();
  const round = snapshot.course.round;
  const [reviewed, setReviewed] = useState<string | null>(null);
  const [alreadySeen] = useState(() => new Set(round.answers.map((answer) => answer.attemptId)));
  if (teaching) return null;
  const completed = !state.restartingRound && session?.awaitingRoundChoice ? round.previous : null;
  const shown = completed ? { ...completed, answers: completed.answers ?? [] } : round;
  const { questions, correct } = lesson.checkpoint;
  return (
    <section
      aria-label="Pass condition"
      title={lesson.checkpointDescription}
      data-round-id={shown.id ?? 'new'}
      data-round-number={shown.number}
      className={cn('mx-auto w-full shrink-0', compact ? 'px-5 pt-3 pb-5' : 'px-6 pt-5 pb-8')}
      style={{
        maxWidth: `calc(${questions} * ${compact ? 2 : 2.5}rem + ${questions - 1} * ${compact ? 0.375 : 0.5}rem + ${compact ? 2.5 : 3}rem)`,
      }}
    >
      <div className={compact ? 'mb-2 text-xs' : 'mb-3 text-sm'}>
        <span className="text-muted-foreground">
          Pass condition{' '}
          <strong className="ml-1 font-medium text-foreground">
            {correct}/{questions}
          </strong>
        </span>
      </div>
      <ol
        aria-label="Round answers"
        className={cn('grid grid-flow-col auto-cols-fr', compact ? 'gap-1.5' : 'gap-2')}
      >
        {Array.from({ length: questions }, (_, index) => {
          const answer = shown.answers[index];
          const result = answer?.outcome ?? 'unanswered';
          const outcome = outcomes[result];
          const Icon = outcome.icon;
          return (
            <li
              key={answer?.attemptId ?? `${shown.id}:${index}`}
              data-outcome={result}
              aria-label={`Answer ${index + 1}: ${outcome.label}`}
              title={outcome.label}
              className={cn(
                'flex min-w-0 items-center justify-center rounded-lg border tabular-nums',
                compact ? 'h-7 text-[10px]' : 'h-10 text-xs',
                outcome.style,
              )}
            >
              {Icon && answer ? (
                <AnswerReview
                  attemptId={answer.attemptId}
                  label={`answer ${index + 1}: ${outcome.label}`}
                  open={reviewed === answer.attemptId}
                  onOpenChange={(open) =>
                    setReviewed((current) =>
                      open ? answer.attemptId : current === answer.attemptId ? null : current,
                    )
                  }
                >
                  <span
                    className={cn(
                      answer &&
                        !alreadySeen.has(answer.attemptId) &&
                        'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-250 motion-safe:ease-out-expo',
                    )}
                  >
                    <Icon className={compact ? 'size-3.5' : 'size-[18px]'} />
                  </span>
                </AnswerReview>
              ) : (
                <span>{index + 1}</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
