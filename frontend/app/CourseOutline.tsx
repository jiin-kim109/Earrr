import { useEffect, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from 'cn';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { EarCompanion } from '@/components/EarCompanion';
import { studio, useStudio } from '@/studio/studio';

export function CourseOutline({
  onSelect,
  drawer = false,
}: {
  onSelect?: () => void;
  drawer?: boolean;
}) {
  const { snapshot, curriculum, busy } = useStudio(
    useShallow(({ snapshot, curriculum, busy }) => ({ snapshot, curriculum, busy })),
  );
  const selected = curriculum?.lessons.find(
    (lesson) => lesson.id === snapshot?.course.selectedLesson,
  );
  const welcomeSelected = snapshot?.teaching?.section === 'welcome';
  const [expanded, setExpanded] = useState<number[]>([]);
  useEffect(() => {
    if (selected && !welcomeSelected)
      setExpanded((current) =>
        current.includes(selected.chapter) ? current : [...current, selected.chapter],
      );
  }, [selected, welcomeSelected]);
  if (!snapshot || !curriculum) return null;
  const { chapters, lessons: skills } = curriculum;

  return (
    <aside
      aria-label="Course outline"
      className={cn(
        'flex min-h-0 min-w-0 flex-col px-3 py-3',
        drawer ? 'w-full flex-1' : 'w-64 shrink-0',
      )}
    >
      <header className="mb-2 flex items-center justify-between px-3">
        <h2 className="text-sm font-medium text-muted-foreground">Lessons</h2>
      </header>
      <div
        data-testid="lesson-scroll"
        className="scrollbar-thin scrollbar-thumb-muted-foreground/60 scrollbar-track-transparent hover:scrollbar-thumb-muted-foreground min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto"
      >
        <nav aria-label="Chapters and lessons" className="min-w-0 space-y-1">
          <Button
            variant="ghost"
            className={cn(
              'mb-1 h-auto min-w-0 w-full justify-start gap-2 rounded-md px-2 py-3 text-left text-[13px] font-normal',
              welcomeSelected &&
                'bg-foreground font-medium text-background hover:bg-foreground/95 hover:text-background',
            )}
            disabled={busy}
            aria-current={welcomeSelected ? 'step' : undefined}
            aria-label={curriculum.welcome.name}
            onClick={() => {
              void studio.welcome();
              onSelect?.();
            }}
          >
            <span
              className={cn(
                'w-6 shrink-0 text-xs tabular-nums',
                welcomeSelected ? 'text-background/70' : 'text-muted-foreground',
              )}
            >
              {String(curriculum.welcome.number).padStart(2, '0')}
            </span>
            <span>{curriculum.welcome.name}</span>
          </Button>
          {chapters.map((chapter) => {
            const chapterSkills = skills.filter((skill) => skill.chapter === chapter.number);
            const complete = chapterSkills.every(
              (skill) =>
                snapshot.course.lessons.find((item) => item.skillId === skill.id)?.status ===
                'completed',
            );
            return (
              <Collapsible
                key={chapter.number}
                open={expanded.includes(chapter.number)}
                onOpenChange={(isOpen) =>
                  setExpanded((current) =>
                    isOpen
                      ? [...current, chapter.number]
                      : current.filter((value) => value !== chapter.number),
                  )
                }
              >
                <CollapsibleTrigger asChild>
                  <Button
                    variant="ghost"
                    className="group h-auto min-w-0 w-full justify-start gap-2 px-2 py-3 text-left text-[13px] whitespace-normal hover:bg-transparent"
                  >
                    <span className="w-6 shrink-0 text-xs text-muted-foreground tabular-nums">
                      {String(chapter.number).padStart(2, '0')}
                    </span>
                    <span className="min-w-0 flex-1 break-words">{chapter.name}</span>
                    {complete ? (
                      <Check className="size-4" aria-label="Chapter complete" />
                    ) : (
                      <ChevronDown className="size-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none" />
                    )}
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent className="motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
                  <ul className="mt-1 mb-2 space-y-1 rounded-2xl bg-secondary/65 p-3">
                    {chapterSkills.map((skill, index) => {
                      const progress = snapshot.course.lessons.find(
                        (item) => item.skillId === skill.id,
                      )!;
                      const active = !welcomeSelected && skill.id === selected?.id;
                      return (
                        <li key={skill.id}>
                          <Button
                            variant="ghost"
                            className={cn(
                              'h-auto min-w-0 w-full justify-start gap-2 rounded-md px-2 py-2.5 text-left text-sm font-normal whitespace-normal hover:bg-card/70 disabled:opacity-60',
                              active &&
                                'bg-foreground font-medium text-background shadow-none hover:bg-foreground/95 hover:text-background disabled:opacity-100',
                            )}
                            disabled={busy}
                            aria-current={active ? 'step' : undefined}
                            aria-label={`${skill.shortName}${progress.status === 'completed' ? ', completed' : ''}`}
                            title={skill.description}
                            onClick={() => {
                              void studio.focus(skill.id);
                              onSelect?.();
                            }}
                          >
                            <span
                              className={cn(
                                'w-5 shrink-0 text-[11px] tabular-nums',
                                active ? 'text-background/70' : 'text-muted-foreground',
                              )}
                            >
                              {chapter.number}.{index + 1}
                            </span>
                            <span className="min-w-0 flex-1 break-words">{skill.shortName}</span>
                            <span
                              data-testid="lesson-status"
                              data-status={progress.status}
                              className="flex size-4 shrink-0 items-center justify-center"
                            >
                              {progress.status === 'completed' ? (
                                <Check
                                  aria-hidden="true"
                                  className="size-4 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
                                />
                              ) : null}
                            </span>
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </nav>
        <footer className="px-3 pt-3 pb-1">
          <EarCompanion />
        </footer>
      </div>
    </aside>
  );
}
