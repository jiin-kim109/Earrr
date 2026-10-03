import type { Snapshot, ToolResult } from '../server/types/agent.types.js';
import { skills } from '../server/services/exercise/catalog.js';

export async function prepareIntervalLesson(
  origin: string,
  target: 'intervals-foundation' | 'intervals-harmonic',
): Promise<Snapshot> {
  const url = new URL(origin);
  if (url.hostname !== '127.0.0.1' || !['3101', '3102'].includes(url.port)) {
    throw new Error('Interval fixtures may only modify an isolated test server.');
  }
  const post = async (path: string, body: object) => {
    const response = await fetch(`${origin}/api${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-earrr-client': '1' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Interval fixture ${path} failed: ${await response.text()}`);
    return (await response.json()) as ToolResult;
  };
  const call = (name: string, args: object = {}, sessionId?: string) =>
    post('/tools', { callId: crypto.randomUUID(), name, arguments: args, sessionId });
  const stateResponse = await fetch(`${origin}/api/state`);
  if (!stateResponse.ok) throw new Error('The test server state could not be read.');
  const initial: Snapshot = await stateResponse.json();
  if (initial.session) await call('end_session', {}, initial.session.id);
  await call('select_lesson', { skillId: 'pitch-direction' });
  let state = (await call('start_session', { mode: 'solo' })).snapshot;
  const sessionId = state.session!.id;

  for (const lesson of skills.slice(
    0,
    skills.findIndex((skill) => skill.id === target),
  )) {
    if (state.course.lessons.find((item) => item.skillId === lesson.id)?.status === 'completed')
      continue;
    state = (await call('select_lesson', { skillId: lesson.id }, sessionId)).snapshot;
    if (state.session?.awaitingRoundChoice) await call('start_round', {}, sessionId);
    let completed = false;
    for (let round = 0; round < 100 && !completed; round++) {
      const result = await call('play_exercise', {}, sessionId);
      const notes = result.audio!.events;
      const distance = notes[1]!.midi - notes[0]!.midi;
      const answer =
        lesson.id === 'pitch-direction'
          ? { direction: distance > 0 ? 'up' : distance < 0 ? 'down' : 'same' }
          : { interval: Math.abs(distance) };
      const scored = await call(
        'submit_answer',
        { exerciseId: result.snapshot.current!.id, answer },
        sessionId,
      );
      completed = scored.lessonCompleted === true;
      state = scored.snapshot;
    }
    if (!completed) throw new Error(`The test fixture did not pass ${lesson.id}.`);
  }
  await call('end_session', {}, sessionId);
  await call('select_lesson', { skillId: target });
  const prepared = (await call('start_session', { mode: 'solo' })).snapshot;
  if (prepared.session?.awaitingRoundChoice) await call('start_round', {}, prepared.session.id);
  await call('end_session', {}, prepared.session!.id);
  return (await call('select_lesson', { skillId: target })).snapshot;
}
