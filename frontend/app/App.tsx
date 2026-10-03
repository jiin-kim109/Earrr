import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { Menu } from 'lucide-react';
import { cn } from 'cn';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Brand } from '@/components/Brand';
import { studio, useStudio } from '@/studio/studio';
import { useAuth } from '@/auth/store';
import { AuthScreen } from '@/auth/AuthScreen';
import { AccountControl } from '@/auth/AccountControl';
import { AudioSetup } from '@/audio/AudioSetup';
import { readEntrySettings } from '@/audio/entrySettings';
import { AppHeader } from './AppHeader.js';
import { CourseOutline } from './CourseOutline.js';
import { useDesktopLayout } from './useDesktopLayout.js';

export default function App() {
  const state = useStudio(
    useShallow(({ snapshot, curriculum, loading, busy, setupOpen }) => ({
      snapshot,
      curriculum,
      loading,
      busy,
      setupOpen,
    })),
  );
  const desktop = useDesktopLayout();
  const [entrySettings] = useState(readEntrySettings);
  const [Lesson, setLesson] = useState<ComponentType | null>(null);
  const authView = useAuth((state) => state.view);
  const accountId = useAuth((state) => state.session?.user.id);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const setup = state.setupOpen || state.loading || !state.snapshot || Boolean(authView);
  const startTraining = () => {
    void studio.startTraining(() =>
      import('@/lesson/CourseLesson').then(({ CourseLesson }) => {
        setLesson(() => CourseLesson);
      }),
    );
  };
  useEffect(() => {
    if (!state.setupOpen && !Lesson) {
      void import('@/lesson/CourseLesson')
        .then(({ CourseLesson }) => setLesson(() => CourseLesson))
        .catch((error: unknown) => studio.reportError(error));
    }
  }, [state.setupOpen, Lesson]);
  useEffect(() => {
    void studio.initialize();
  }, []);
  useEffect(() => {
    if (location.pathname === '/auth/callback' && accountId) history.replaceState(null, '', '/');
  }, [accountId]);
  useEffect(() => {
    setOutlineOpen(false);
  }, [desktop, state.setupOpen]);
  useEffect(() => {
    if (setup) {
      frame.current?.style.removeProperty('height');
      return;
    }
    window.scrollTo({ top: 0, behavior: 'instant' });
    const viewport = window.visualViewport;
    const resize = () => {
      if (frame.current) {
        const height = Math.min(innerHeight, viewport?.height ?? innerHeight);
        frame.current.style.height = `${height}px`;
        frame.current.style.setProperty('--app-height', `${height}px`);
      }
    };
    resize();
    viewport?.addEventListener('resize', resize);
    window.addEventListener('resize', resize);
    return () => {
      viewport?.removeEventListener('resize', resize);
      window.removeEventListener('resize', resize);
    };
  }, [setup]);

  return (
    <Sheet open={outlineOpen && !desktop && !setup} onOpenChange={setOutlineOpen}>
      <div
        ref={frame}
        data-testid="app-frame"
        className={cn(
          'flex w-full flex-col',
          setup ? 'min-h-dvh' : 'h-dvh min-h-0 overflow-hidden',
        )}
      >
        <a
          href="#main-content"
          className="fixed top-2 left-2 z-50 -translate-y-24 rounded bg-foreground px-3 py-2 text-background focus:translate-y-0"
        >
          Skip to training
        </a>
        {setup ? (
          <header className="flex h-16 shrink-0 items-center justify-end px-5 sm:px-8">
            {!authView && <AccountControl />}
          </header>
        ) : (
          <AppHeader
            compact={!desktop}
            navigation={
              !desktop && !setup ? (
                <SheetTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="-ml-2"
                    aria-label="Open lessons"
                  >
                    <Menu className="size-5" />
                  </Button>
                </SheetTrigger>
              ) : undefined
            }
          />
        )}
        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-1',
            desktop ? 'flex-row' : 'flex-col',
            setup && 'px-5 pb-3 sm:px-8',
          )}
        >
          {!setup && state.snapshot && desktop && <CourseOutline />}
          <main
            id="main-content"
            tabIndex={-1}
            aria-busy={state.busy}
            className={cn(
              'flex min-h-0 min-w-0 flex-1 flex-col outline-none',
              !setup &&
                (desktop
                  ? 'px-3 pt-2 pr-6 pb-3'
                  : 'px-3 pb-[max(.25rem,env(safe-area-inset-bottom))]'),
            )}
          >
            {authView ? (
              <AuthScreen />
            ) : setup ? (
              <AudioSetup defaults={entrySettings} onStart={startTraining} />
            ) : (
              Lesson && <Lesson />
            )}
          </main>
        </div>
      </div>
      {!desktop && !setup && (
        <SheetContent
          side="left"
          className="w-[min(320px,88vw)] gap-0"
          aria-describedby={undefined}
        >
          <SheetTitle className="sr-only">Lessons</SheetTitle>
          <div className="flex h-16 shrink-0 items-center px-5">
            <Brand />
          </div>
          <CourseOutline drawer onSelect={() => setOutlineOpen(false)} />
        </SheetContent>
      )}
    </Sheet>
  );
}
