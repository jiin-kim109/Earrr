import { useEffect, useRef } from 'react';
import { cn } from 'cn';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { studio } from '@/studio/studio';
import { useLesson } from './useLesson.js';

export function TutorialSteps({ compact = false }: { compact?: boolean }) {
  const { state, session, teaching, connected, welcome } = useLesson();
  const current = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    current.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [teaching?.presentationId]);
  if (!teaching || welcome) return null;
  const disabled = state.busy || state.entering || (session?.mode === 'coach' && !connected);
  return (
    <TooltipProvider>
      <nav
        aria-label="Tutorial steps"
        className={cn('w-full shrink-0', compact ? 'px-4 pt-2 pb-4' : 'px-6 pt-3 pb-6')}
      >
        <p className="sr-only">
          {teaching.awaitingPractice
            ? 'At the end of the tutorial.'
            : `Current explanation: ${teaching.title}.`}{' '}
          Choose any step to hear its explanation.
        </p>
        <div className="scrollbar-thin scrollbar-thumb-muted-foreground/60 overflow-x-auto">
          <ol className="mx-auto flex w-max items-center">
            {teaching.steps.map((step, index) => {
              const active = index === teaching.index;
              const played = teaching.playedSteps?.includes(step.id) ?? false;
              return (
                <li key={step.id} className="flex items-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        ref={active ? current : undefined}
                        type="button"
                        data-step-id={step.id}
                        data-played={played}
                        aria-current={active ? 'step' : undefined}
                        aria-label={`Step ${index + 1}: ${step.title}${active ? ', current' : ''}${played ? ', played' : ', not marked played'}`}
                        disabled={disabled}
                        className="group flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none transition-colors duration-150 hover:bg-tutorial/15 focus-visible:bg-tutorial/20 disabled:cursor-default disabled:opacity-50 motion-reduce:transition-none"
                        onClick={() => {
                          void studio.action('teach_lesson', { stepId: step.id });
                        }}
                      >
                        <span
                          className={cn(
                            'size-2.5 rounded-full border transition-colors duration-150 motion-reduce:transition-none',
                            active
                              ? 'border-foreground bg-foreground'
                              : played
                                ? 'border-muted-foreground bg-muted-foreground/65 group-hover:border-foreground'
                                : 'border-border bg-card group-hover:border-muted-foreground',
                          )}
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                      {index + 1}. {step.title}
                    </TooltipContent>
                  </Tooltip>
                  {index < teaching.steps.length - 1 && (
                    <span aria-hidden="true" className="h-px w-4 shrink-0 bg-border" />
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </nav>
    </TooltipProvider>
  );
}
