import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/db/database.js';
import { AgentService } from '../server/services/agent/agent.service.js';
import type { ToolName } from '../server/types/agent.types.js';

const controls = vi.hoisted(() => ({
  connected: false,
  owner: 'guest:entry-fixture',
  connect: vi.fn<(sessionId: string) => Promise<void>>(),
  disconnect: vi.fn(),
  microphone: vi.fn(),
  speaking: vi.fn(),
  output: vi.fn<() => Promise<void>>(),
  calls: vi.fn(),
}));
vi.mock('../frontend/audio/audio.js', () => ({
  AudioEngine: class {
    setOutputDevice = controls.output;
    stop = vi.fn();
    detachVoice = vi.fn();
    setVolume = vi.fn();
    setVoiceVolume = vi.fn();
    attachMicrophone = vi.fn();
    play = vi.fn(async () => true);
    unlock = vi.fn(async () => undefined);
  },
}));
vi.mock('../frontend/coach/realtime.js', () => ({
  RealtimeConnection: class {
    get connected() {
      return controls.connected;
    }
    connect = controls.connect;
    disconnect = controls.disconnect;
    enableMicrophone = controls.microphone;
    disableMicrophone = vi.fn(async () => undefined);
  },
}));
vi.mock('../frontend/coach/conversation.js', () => ({
  Conversation: class {
    reset = vi.fn();
    start = controls.speaking;
    action = vi.fn();
    text = vi.fn();
  },
}));
vi.mock('../frontend/auth/auth.js', () => ({ account: {} }));
vi.mock('../frontend/storage/access.js', () => ({
  scope: () => controls.owner,
  learningStarted: true,
  restoreGuest: vi.fn(),
  restoreAccount: vi.fn(),
  waitForSaves: vi.fn(async () => undefined),
}));
vi.mock('../frontend/lib/api.js', () => ({
  callTool: controls.calls,
  callAgentTool: controls.calls,
  acknowledgePlayback: vi.fn(async () => undefined),
  acknowledgeTeaching: vi.fn(),
  getState: vi.fn(),
  getCurriculum: vi.fn(),
  saveSettings: vi.fn(),
  api: vi.fn(),
}));

let store: Store;
let game: AgentService;
let studio: (typeof import('../frontend/studio/studio.js'))['studio'];
let state: (typeof import('../frontend/studio/store.js'))['studioStore'];
let auth: (typeof import('../frontend/auth/store.js'))['useAuth'];
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  controls.connected = false;
  controls.owner = 'guest:entry-fixture';
  controls.output.mockResolvedValue();
  controls.connect.mockImplementation(async () => {
    controls.connected = true;
  });
  controls.disconnect.mockImplementation(() => {
    controls.connected = false;
  });
  store = await Store.open(':memory:');
  game = await AgentService.create(store, true, 'test');
  const started = await game.execute({
    callId: randomUUID(),
    name: 'start_session',
    arguments: { mode: 'coach' },
  });
  const question = await game.execute({
    callId: randomUUID(),
    sessionId: started.snapshot.session!.id,
    name: 'start_practice',
    arguments: {},
  });
  controls.calls.mockImplementation((name: ToolName, args: object, sessionId?: string) =>
    game.execute({ callId: randomUUID(), name, arguments: args, sessionId }),
  );
  ({ studio } = await import('../frontend/studio/studio.js'));
  ({ studioStore: state } = await import('../frontend/studio/store.js'));
  ({ useAuth: auth } = await import('../frontend/auth/store.js'));
  auth.setState({ view: null, busy: false });
  state.setState({
    snapshot: question.snapshot,
    curriculum: game.exercises.curriculum(),
    loading: false,
    setupOpen: false,
    setupComplete: true,
    phase: 'ready',
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await store.close();
});

describe('automatic section activation', () => {
  it('connects once and preserves the unanswered question without opening the microphone', async () => {
    const id = state.getState().snapshot!.current!.id;
    const first = studio.enterSection();
    const duplicate = studio.enterSection();
    expect(first).toBe(duplicate);
    expect(state.getState().entering).toBe(true);
    await first;
    expect(controls.connect).toHaveBeenCalledOnce();
    expect(controls.speaking).toHaveBeenCalledOnce();
    expect(controls.microphone).not.toHaveBeenCalled();
    expect(state.getState().snapshot!.current!.id).toBe(id);
    expect(state.getState().entering).toBe(false);
    await studio.enterSection();
    expect(controls.connect).toHaveBeenCalledOnce();
  });

  it('resumes an auth-paused session automatically while keeping its round and question', async () => {
    const before = state.getState().snapshot!;
    const paused = await game.execute({
      callId: randomUUID(),
      sessionId: before.session!.id,
      name: 'pause_session',
      arguments: {},
    });
    state.setState({ snapshot: paused.snapshot });
    await studio.enterSection();
    expect(state.getState().snapshot!.session?.status).toBe('active');
    expect(state.getState().snapshot!.current?.id).toBe(before.current!.id);
    expect(state.getState().snapshot!.course.round).toEqual(before.course.round);
    expect(controls.connect).toHaveBeenCalledOnce();
  });

  it('automatically connects when selecting a lesson while the transport is closed', async () => {
    const id = state.getState().snapshot!.current!.id;
    await studio.focus('pitch-direction');
    expect(controls.connect).toHaveBeenCalledOnce();
    expect(state.getState().snapshot!.current?.id).toBe(id);
    expect(state.getState().snapshot!.session?.status).toBe('active');
  });

  it('does not activate a hidden account screen or a busy identity transition', async () => {
    auth.setState({ view: 'login' });
    await studio.enterSection();
    expect(controls.connect).not.toHaveBeenCalled();
    auth.setState({ view: null, busy: true });
    await studio.enterSection();
    expect(controls.connect).not.toHaveBeenCalled();
    expect(state.getState().entering).toBe(false);
  });

  it('blocks with refresh-only recovery after one failed connection attempt', async () => {
    vi.useFakeTimers();
    controls.connect.mockRejectedValueOnce(new Error('Temporary network failure.'));
    const operation = studio.enterSection();
    await vi.waitFor(() => expect(controls.connect).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(30_000);
    await operation;
    expect(controls.connect).toHaveBeenCalledOnce();
    expect(state.getState().connection).toBe('error');
    expect(state.getState().fatalError).toMatchObject({ code: 'unexpected_error' });
    expect(state.getState().error).toBeNull();
    expect(state.getState().entering).toBe(false);
    await studio.enterSection();
    expect(controls.connect).toHaveBeenCalledOnce();
  });

  it('does not reconnect the old account after the identity changes during retry', async () => {
    vi.useFakeTimers();
    controls.connect.mockRejectedValueOnce(new Error('Temporary network failure.'));
    const operation = studio.enterSection();
    await vi.waitFor(() => expect(controls.connect).toHaveBeenCalledOnce());
    controls.owner = 'account:other-fixture';
    await vi.advanceTimersByTimeAsync(1000);
    await operation;
    expect(controls.connect).toHaveBeenCalledOnce();
    expect(state.getState().entering).toBe(false);
  });

  it('resumes a saved solo result without silently advancing to another question', async () => {
    const prior = state.getState().snapshot!.session!.id;
    await game.execute({
      callId: randomUUID(),
      sessionId: prior,
      name: 'end_session',
      arguments: {},
    });
    const started = await game.execute({
      callId: randomUUID(),
      name: 'start_session',
      arguments: { mode: 'solo' },
    });
    const sessionId = started.snapshot.session!.id;
    const played = await game.execute({
      callId: randomUUID(),
      sessionId,
      name: 'play_exercise',
      arguments: {},
    });
    const exercise = (await store.exercises.get(played.snapshot.current!.id))!;
    const graded = await game.execute({
      callId: randomUUID(),
      sessionId,
      name: 'submit_answer',
      arguments: { exerciseId: exercise.id, answer: exercise.expected },
    });
    const paused = await game.execute({
      callId: randomUUID(),
      sessionId,
      name: 'pause_session',
      arguments: {},
    });
    state.setState({ snapshot: paused.snapshot, phase: 'ready' });
    controls.calls.mockClear();
    await studio.enterSection();
    expect(state.getState().snapshot?.session?.status).toBe('active');
    expect(state.getState().snapshot?.current?.id).toBe(graded.snapshot.current!.id);
    expect(state.getState().snapshot?.totalAnswers).toBe(1);
    expect(controls.calls.mock.calls.map(([name]) => name)).toEqual(['resume_session']);
    expect(controls.connect).not.toHaveBeenCalled();
  });
});
