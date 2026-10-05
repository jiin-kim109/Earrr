import { useStudio } from '@/studio/studio';

export function useLesson() {
  const state = useStudio();
  const snapshot = state.snapshot;
  const curriculum = state.curriculum;
  if (!snapshot || !curriculum) throw new Error('Load the course before opening a lesson.');
  const lesson = curriculum.lessons.find((item) => item.id === snapshot.course.selectedLesson);
  if (!lesson) throw new Error('The selected lesson is not in the current curriculum.');
  const session = snapshot.session;
  const connected = state.connection === 'connected';
  const paused = session?.status === 'paused';
  const phase =
    paused && !['speaking', 'hearing', 'connecting'].includes(state.phase) ? 'paused' : state.phase;
  const current = snapshot.current;
  return {
    state,
    snapshot,
    session,
    connected,
    paused,
    phase,
    current,
    curriculum,
    lesson,
    running: Boolean(session && (connected || session.mode === 'solo')),
    resolved: Boolean(current && current.status !== 'unanswered'),
    next: snapshot.course.nextLesson,
    teaching: snapshot.teaching,
    welcome: snapshot.teaching?.section === 'welcome',
  };
}
