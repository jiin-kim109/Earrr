import { useEffect, useRef, useState } from 'react';
import { CoachPanel, CompactCoachPanel } from '@/coach/CoachPanel';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useDesktopLayout } from '@/app/useDesktopLayout';
import { ExercisePlayer } from './ExercisePlayer.js';
import { useLesson } from './useLesson.js';
import { studio, useStudio } from '@/studio/studio';
import { useAuth } from '@/auth/store';

function LessonToolbar() {
  const { lesson, welcome, curriculum } = useLesson();
  const title = welcome ? curriculum.welcome.name : lesson.shortName;
  return (
    <header
      data-testid="lesson-toolbar"
      className="flex h-14 min-w-0 shrink-0 items-center gap-2 px-1"
    >
      <h1
        className="line-clamp-2 min-w-0 flex-1 text-base leading-tight font-semibold tracking-tight sm:text-xl"
        title={title}
      >
        {title}
      </h1>
    </header>
  );
}

export function CourseLesson() {
  const desktop = useDesktopLayout();
  const [draft, setDraft] = useState('');
  const entered = useRef(false);
  const { busy, loading, setupOpen } = useStudio();
  const accountBusy = useAuth((state) => state.busy);
  useEffect(() => {
    if (entered.current || busy || loading || setupOpen || accountBusy) return;
    entered.current = true;
    void studio.enterSection();
  }, [busy, loading, setupOpen, accountBusy]);
  return desktop ? (
    <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" id="training-layout">
      <ResizablePanel id="exercise" defaultSize="60%" minSize="320px">
        <div className="flex h-full min-h-0 flex-col gap-2">
          <LessonToolbar />
          <div className="min-h-0 flex-1">
            <ExercisePlayer />
          </div>
        </div>
      </ResizablePanel>
      <ResizableHandle
        aria-label="Resize exercise and conversation"
        className="w-8 bg-transparent after:left-1/2 after:w-px after:bg-border/45 hover:after:bg-border"
      />
      <ResizablePanel id="conversation" defaultSize="40%" minSize="280px">
        <CoachPanel draft={draft} setDraft={setDraft} />
      </ResizablePanel>
    </ResizablePanelGroup>
  ) : (
    <div className="flex min-h-0 flex-1 flex-col">
      <LessonToolbar />
      <CompactCoachPanel draft={draft} setDraft={setDraft}>
        <ExercisePlayer compact />
      </CompactCoachPanel>
    </div>
  );
}
