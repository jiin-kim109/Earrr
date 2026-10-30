import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AgentService as Game } from '../server/services/agent/agent.service.js';
import { Store } from '../server/db/database.js';
import { Conversation } from '../frontend/coach/conversation.js';
import { publicToolResult } from '../server/services/agent/presentation.js';
import { RealtimeConnection } from '../frontend/coach/realtime.js';
import type { RealtimeEvent } from '../frontend/coach/realtime.js';
import type { Snapshot, ToolResult, ToolName } from '../server/types/agent.types.js';
import type { Transcript } from '../frontend/coach/types.js';

let store: Store;
let game: Game;
let snapshot: Snapshot;
let loop: Conversation;
let connection: RealtimeConnection;
let sent: Record<string, unknown>[];
let messages: Transcript[];
let execute: ReturnType<
  typeof vi.fn<(name: ToolName, args: Record<string, unknown>, id: string) => Promise<ToolResult>>
>;
let after: ReturnType<
  typeof vi.fn<(result: ToolResult | null, current: () => boolean) => Promise<ToolResult | null>>
>;
let errors: string[];
let counter = 0;
const responses = () => sent.filter((event) => event.type === 'response.create');
function emit(event: RealtimeEvent) {
  loop.handle(event);
}
function created() {
  const id = `resp-${++counter}`;
  emit({ type: 'response.created', response: { id, status: 'in_progress' } });
  return id;
}
function done(id: string, calls: Array<{ name: ToolName; args?: Record<string, unknown> }> = []) {
  emit({
    type: 'response.done',
    response: {
      id,
      status: 'completed',
      output: calls.length
        ? calls.map((call, index) => ({
            type: 'function_call',
            id: `${id}-${index}`,
            call_id: `${id}-${index}`,
            name: call.name,
            arguments: JSON.stringify(call.args ?? {}),
          }))
        : [{ type: 'message', content: [{ type: 'audio' }] }],
    },
  });
}
async function tool(name: ToolName, args: Record<string, unknown> = {}, expectReply = true) {
  const count = responses().length;
  const executed = execute.mock.calls.length;
  const id = created();
  done(id, [{ name, args }]);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(executed + 1));
  if (expectReply) await vi.waitFor(() => expect(responses()).toHaveLength(count + 1));
  else {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(responses()).toHaveLength(count);
  }
  return id;
}
async function reply(text = 'Listen carefully.') {
  const id = created();
  emit({ type: 'output_audio_buffer.started', response_id: id });
  emit({ type: 'response.output_audio_transcript.delta', response_id: id, delta: text });
  emit({ type: 'response.output_audio_transcript.done', response_id: id, transcript: text });
  done(id);
  emit({ type: 'output_audio_buffer.stopped', response_id: id });
  await vi.waitFor(() =>
    expect(
      messages.some((message) => message.id === `assistant:${id}` && message.delivery === 'spoken'),
    ).toBe(true),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  return id;
}
beforeEach(async () => {
  store = await Store.open(':memory:');
  await store.progress.finishIntroduction('pitch-direction', 'skipped');
  game = await Game.create(store, true, 'test');
  snapshot = (
    await game.execute({
      callId: crypto.randomUUID(),
      name: 'start_session',
      arguments: { mode: 'coach' },
    })
  ).snapshot;
  sent = [];
  messages = [];
  errors = [];
  connection = new RealtimeConnection({
    event: emit,
    voice: vi.fn(),
    microphone: vi.fn(),
    microphoneLost: vi.fn(),
    disconnected: vi.fn(),
  });
  vi.spyOn(connection, 'connected', 'get').mockReturnValue(true);
  vi.spyOn(connection, 'send').mockImplementation((event) => {
    sent.push(event);
  });
  execute = vi.fn(
    async (name, args, id) =>
      await game.execute(
        { callId: id, sessionId: snapshot.session!.id, name, arguments: args },
        true,
      ),
  );
  after = vi.fn(async () => null);
  loop = new Conversation(connection, {
    snapshot: () => snapshot,
    result: (result) => {
      snapshot = result.snapshot;
    },
    execute,
    afterReply: after,
    stopMusic: vi.fn(),
    phase: vi.fn(),
    error: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    message: (role, text, id, complete, interrupted) => {
      const previous = messages.find((item) => item.id === id);
      const item: Transcript = {
        id,
        sessionId: snapshot.session?.id ?? 'ended',
        role,
        text,
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        ...(complete ? { delivery: interrupted ? 'interrupted' : 'spoken' } : {}),
      };
      if (previous) messages[messages.indexOf(previous)] = item;
      else messages.push(item);
    },
  });
  loop.start();
});
afterEach(async () => {
  loop.reset();
  vi.useRealTimers();
  await store.close();
  vi.restoreAllMocks();
});

describe('causal single-stream turns', () => {
  it('updates navigation immediately but generates speech only for the final choice in a burst', async () => {
    await tool('play_exercise');
    await reply();
    vi.useFakeTimers();
    const generated = vi.spyOn(connection, 'respond').mockImplementation(() => {
      done(created());
    });
    const actions: Promise<void>[] = [];
    try {
      for (const skillId of ['triads', 'modes', 'progressions']) {
        actions.push(loop.action('select_lesson', { skillId }));
        await vi.advanceTimersByTimeAsync(40);
        expect(snapshot.course.selectedLesson).toBe(skillId);
      }
      expect(generated).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(250);
      await Promise.all(actions);
      expect(generated).toHaveBeenCalledOnce();
      expect(generated.mock.calls[0]![0].tools).toBe('none');
      expect(snapshot.course.selectedLesson).toBe('progressions');
      expect(snapshot.totalAnswers).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      loop.reset();
      await Promise.all(actions);
    }
  });

  it.each(['text', 'speech', 'reset'] as const)(
    'cancels a pending UI narration when %s takes ownership without leaving the action queue locked',
    async (interruption) => {
      await tool('play_exercise');
      await reply();
      vi.useFakeTimers();
      const generated = vi.spyOn(connection, 'respond');
      const selecting = loop.action('select_lesson', { skillId: 'triads' });
      await vi.advanceTimersByTimeAsync(0);
      if (interruption === 'text') loop.text('Please explain that sound.');
      else if (interruption === 'speech') {
        emit({ type: 'input_audio_buffer.speech_started', item_id: 'ui-barge-in' });
        await vi.advanceTimersByTimeAsync(0);
        expect(generated).not.toHaveBeenCalled();
        emit({ type: 'input_audio_buffer.committed', item_id: 'ui-barge-in' });
      } else loop.reset();
      await vi.advanceTimersByTimeAsync(1000);
      await selecting;
      if (interruption !== 'reset') {
        expect(generated).toHaveBeenCalledOnce();
        expect(generated.mock.calls[0]![0].tools).toBe('auto');
      } else {
        expect(generated).not.toHaveBeenCalled();
        loop.start();
        expect(generated).toHaveBeenCalledOnce();
      }
      expect(errors).toEqual([]);
    },
  );

  it('does not add another wait when a slow UI request has already outlasted the quiet window', async () => {
    await tool('play_exercise');
    await reply();
    vi.useFakeTimers();
    const run = execute.getMockImplementation()!;
    execute.mockImplementationOnce(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return run(...args);
    });
    const generated = vi.spyOn(connection, 'respond');
    const selecting = loop.action('select_lesson', { skillId: 'triads' });
    await vi.advanceTimersByTimeAsync(500);
    await selecting;
    expect(generated).toHaveBeenCalledOnce();
    expect(snapshot.course.selectedLesson).toBe('triads');
    expect(errors).toEqual([]);
  });

  it('accepts a provider cancellation before the VAD start event without treating the interruption as a failure', async () => {
    await tool('play_exercise');
    const id = created();
    emit({ type: 'response.output_audio_transcript.delta', response_id: id, delta: 'Listen to' });
    emit({ type: 'response.done', response: { id, status: 'cancelled' } });
    emit({ type: 'input_audio_buffer.speech_started', item_id: 'barge-in' });
    emit({ type: 'input_audio_buffer.committed', item_id: 'barge-in' });
    expect(messages.find((message) => message.id === `assistant:${id}`)?.delivery).toBe(
      'interrupted',
    );
    expect(after).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    await tool('replay_exercise', {}, false);
    expect(errors).toEqual([]);
  });

  it('cancels a response only once when replay and navigation arrive before cancellation completes', async () => {
    await tool('play_exercise');
    const response = created();
    emit({ type: 'output_audio_buffer.started', response_id: response });
    const first = loop.action('replay_exercise');
    const second = loop.action('replay_exercise');
    const last = loop.action('select_lesson', { skillId: 'progressions' });
    await Promise.all([first, second, last]);
    expect(sent.filter((event) => event.type === 'response.cancel')).toHaveLength(1);
    expect(sent.filter((event) => event.type === 'output_audio_buffer.clear')).toHaveLength(1);
    emit({ type: 'response.done', response: { id: response, status: 'cancelled' } });
    expect(snapshot.course.selectedLesson).toBe('progressions');
    expect(execute.mock.calls.map(([name]) => name)).toEqual(['play_exercise', 'select_lesson']);
    expect(errors).toEqual([]);
  });

  it('does not report an obsolete action failure after the learner has already chosen another lesson', async () => {
    await tool('play_exercise');
    await reply();
    let reject!: (error: Error) => void;
    execute.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const old = loop.action('replay_exercise');
    await vi.waitFor(() => expect(reject).toBeDefined());
    const latest = loop.action('select_lesson', { skillId: 'triads' });
    reject(new Error('Obsolete replay failed.'));
    await Promise.all([old, latest]);
    expect(snapshot.course.selectedLesson).toBe('triads');
    expect(errors).toEqual([]);
  });

  it('navigates to the first tutorial step without presenting a late grading result from the old lesson', async () => {
    for (const id of ['pitch-direction', 'intervals-foundation', 'intervals-harmonic'] as const)
      await store.progress.completeLesson(id, new Date().toISOString());
    await tool('play_exercise');
    await reply('Listen to the example.');
    const exercise = (await store.exercises.get(snapshot.current!.id))!;
    loop.text('My answer.');
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    execute.mockImplementationOnce(async (name, args, id) => {
      const result = await game.execute(
        { callId: id, sessionId: snapshot.session!.id, name, arguments: args },
        true,
      );
      await held;
      return result;
    });
    const old = created();
    done(old, [
      { name: 'submit_answer', args: { exerciseId: exercise.id, answer: exercise.expected } },
    ]);
    await vi.waitFor(() =>
      expect(execute.mock.calls.some(([name]) => name === 'submit_answer')).toBe(true),
    );
    const navigation = loop.action('select_lesson', { skillId: 'triads' });
    finish();
    await navigation;
    expect(snapshot.course.selectedLesson).toBe('triads');
    expect(snapshot.teaching?.stepId).toBe('overview');
    const request = responses().at(-1)!.response as {
      input: Array<{ content: Array<{ text: string }> }>;
      instructions: string;
    };
    const context = JSON.parse(request.input[0]!.content[0]!.text);
    expect(context.parts.map((part: { kind: string }) => part.kind)).toEqual(['teaching']);
    expect(context.parts[0].explanation).toContain('major from minor');
    expect(request.instructions).toContain('entire current presentation');
    expect(snapshot.totalAnswers).toBe(1);
    expect(errors).toEqual([]);
  });

  it('waits for tool completion before requesting feedback and waits for drained speech before music', async () => {
    await tool('play_exercise');
    expect(execute).toHaveBeenCalledOnce();
    expect(after).not.toHaveBeenCalled();
    const id = created();
    emit({ type: 'output_audio_buffer.started', response_id: id });
    done(id);
    expect(after).not.toHaveBeenCalled();
    emit({ type: 'output_audio_buffer.stopped', response_id: id });
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
    expect(after.mock.calls[0]?.[0]?.audio).toBeDefined();
    expect(
      responses().map(
        (event) => (event.response as { output_modalities: string[] }).output_modalities,
      ),
    ).toEqual([['text'], ['audio']]);
  });
  it('combines deterministic grading and the next question in one tool result', async () => {
    await tool('play_exercise');
    await reply();
    const exercise = (await store.exercises.get(snapshot.current!.id))!;
    loop.text('Same?');
    await tool('submit_answer', { exerciseId: exercise.id, answer: exercise.expected });
    expect(snapshot.feedback?.grade.verdict).toBe('correct');
    expect(snapshot.current?.id).not.toBe(exercise.id);
    expect(snapshot.totalAnswers).toBe(1);
    expect(execute.mock.calls.map(([name]) => name)).toEqual(['play_exercise', 'submit_answer']);
    await reply('Correct.');
    const result = after.mock.calls.at(-1)?.[0];
    expect(result?.reply).toBe('feedback');
    expect(publicToolResult(result!).current).not.toHaveProperty('prompt');
    expect(after.mock.calls.at(-1)?.[0]?.audio).toBeDefined();
    expect(errors).toEqual([]);
  });
  it('ignores duplicate response completion and handles audio stopping before response.done', async () => {
    await tool('play_exercise');
    const id = created();
    emit({ type: 'output_audio_buffer.started', response_id: id });
    emit({ type: 'output_audio_buffer.stopped', response_id: id });
    expect(after).not.toHaveBeenCalled();
    done(id);
    done(id);
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
  });
  it('handles a continuous audio buffer across a tool preamble and final reply', async () => {
    const count = responses().length;
    const preamble = created();
    emit({ type: 'output_audio_buffer.started', response_id: preamble });
    emit({
      type: 'response.output_audio_transcript.delta',
      response_id: preamble,
      delta: 'Let us listen.',
    });
    done(preamble, [{ name: 'play_exercise' }]);
    await vi.waitFor(() => expect(responses()).toHaveLength(count + 1));
    const final = created();
    emit({
      type: 'response.output_audio_transcript.delta',
      response_id: final,
      delta: 'Does the second note move up or down?',
    });
    done(final);
    expect(after).not.toHaveBeenCalled();
    emit({ type: 'output_audio_buffer.stopped', response_id: final });
    await vi.waitFor(() => expect(after).toHaveBeenCalledOnce());
  });
  it('does not execute an old answer after the learner interrupted with a new request', async () => {
    await tool('play_exercise');
    await reply();
    const exercise = (await store.exercises.get(snapshot.current!.id))!;
    loop.text('Up');
    const old = created();
    const count = responses().length;
    loop.text('Wait, pause instead.');
    expect(responses()).toHaveLength(count);
    done(old, [
      { name: 'submit_answer', args: { exerciseId: exercise.id, answer: exercise.expected } },
    ]);
    expect(responses()).toHaveLength(count + 1);
    expect(snapshot.totalAnswers).toBe(0);
    await tool('pause_session');
    await reply('Paused.');
    expect(snapshot.session?.status).toBe('paused');
  });
  it('waits for an already-running tool before beginning the next user turn', async () => {
    await tool('play_exercise');
    await reply();
    let release!: () => void;
    execute.mockImplementationOnce(async (name, args, id) => {
      const result = await game.execute(
        { callId: id, sessionId: snapshot.session!.id, name, arguments: args },
        true,
      );
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return result;
    });
    loop.text('Pause');
    done(created(), [{ name: 'pause_session' }]);
    await vi.waitFor(async () => expect((await game.snapshot()).session?.status).toBe('paused'));
    await vi.waitFor(() => expect(typeof release).toBe('function'));
    const count = responses().length;
    loop.text('Actually resume.');
    expect(responses()).toHaveLength(count);
    release();
    await vi.waitFor(() => expect(responses()).toHaveLength(count + 1));
    expect(snapshot.session?.status).toBe('paused');
    await tool('resume_session', {}, false);
    expect(snapshot.session?.status).toBe('active');
    expect(errors).toEqual([]);
  });
  it('creates one response for a voice commit and preserves a late user caption position', async () => {
    await tool('play_exercise');
    await reply();
    emit({ type: 'input_audio_buffer.speech_started', item_id: 'voice-1' });
    const count = responses().length;
    emit({ type: 'input_audio_buffer.committed', item_id: 'voice-1' });
    emit({ type: 'input_audio_buffer.committed', item_id: 'voice-1' });
    expect(responses()).toHaveLength(count + 1);
    const replyId = created();
    emit({ type: 'output_audio_buffer.started', response_id: replyId });
    emit({ type: 'response.output_audio_transcript.delta', response_id: replyId, delta: 'Sure.' });
    done(replyId, [{ name: 'replay_exercise' }]);
    emit({ type: 'output_audio_buffer.stopped', response_id: replyId });
    await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(2));
    emit({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'voice-1',
      transcript: 'Play again.',
    });
    expect(messages.map((item) => item.role)).toEqual(['assistant', 'user', 'assistant']);
    expect(messages[1]?.text).toBe('Play again.');
  });
  it.each([false, true])(
    'does not repeat the provider-owned voice interruption when generation has finished: %s',
    async (generationFinished) => {
      await tool('play_exercise');
      const id = created();
      emit({ type: 'output_audio_buffer.started', response_id: id });
      emit({
        type: 'response.output_audio_transcript.delta',
        response_id: id,
        delta: 'Listen to this example.',
      });
      if (generationFinished) done(id);
      const before = sent.length;
      emit({ type: 'input_audio_buffer.speech_started', item_id: 'voice-interruption' });
      emit({ type: 'input_audio_buffer.speech_started', item_id: 'voice-interruption' });
      expect(
        sent
          .slice(before)
          .filter((event) =>
            ['response.cancel', 'output_audio_buffer.clear'].includes(String(event.type)),
          ),
      ).toEqual([]);
      if (!generationFinished)
        emit({ type: 'response.done', response: { id, status: 'cancelled', output: [] } });
      emit({ type: 'output_audio_buffer.cleared', response_id: id });
      const count = responses().length;
      emit({ type: 'input_audio_buffer.committed', item_id: 'voice-interruption' });
      expect(responses()).toHaveLength(count + 1);
      expect(messages.find((item) => item.id === `assistant:${id}`)?.delivery).toBe('interrupted');
      expect(after).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    },
  );
  it.each([false, true])(
    'still cancels keyboard interruptions when generation has finished: %s',
    async (generationFinished) => {
      await tool('play_exercise');
      const id = created();
      emit({ type: 'output_audio_buffer.started', response_id: id });
      if (generationFinished) done(id);
      const before = sent.length;
      loop.text('Wait, pause instead.');
      expect(
        sent
          .slice(before)
          .filter((event) =>
            ['response.cancel', 'output_audio_buffer.clear'].includes(String(event.type)),
          ),
      ).toEqual([
        ...(!generationFinished ? [{ type: 'response.cancel' }] : []),
        { type: 'output_audio_buffer.clear' },
      ]);
    },
  );
  it('still cancels a manually committed voice turn that had no automatic VAD interruption', async () => {
    await tool('play_exercise');
    created();
    const before = sent.length;
    emit({ type: 'input_audio_buffer.committed', item_id: 'manual-voice' });
    expect(
      sent
        .slice(before)
        .filter((event) =>
          ['response.cancel', 'output_audio_buffer.clear'].includes(String(event.type)),
        ),
    ).toEqual([{ type: 'response.cancel' }, { type: 'output_audio_buffer.clear' }]);
  });
  it.each([
    ['session_expired', 'Your session hit the maximum duration of 60 minutes.'],
    ['server_error', 'The provider could not process this turn.'],
    ['invalid_value', 'An unrelated request parameter is invalid.'],
  ])('continues to report real provider failures: %s', (code, message) => {
    emit({ type: 'error', error: { code, message } });
    expect(errors).toEqual([`Realtime ${code}: ${message}`]);
  });
  it('does not play queued notes after speech was interrupted', async () => {
    await tool('play_exercise');
    const id = created();
    emit({ type: 'output_audio_buffer.started', response_id: id });
    emit({
      type: 'response.output_audio_transcript.delta',
      response_id: id,
      delta: 'Listen to this',
    });
    loop.text('Hold on.');
    done(id);
    emit({ type: 'output_audio_buffer.stopped', response_id: id });
    expect(after).not.toHaveBeenCalled();
    expect(messages.find((item) => item.id === `assistant:${id}`)?.delivery).toBe('interrupted');
  });
  it('serializes a UI action behind an unfinished playback/checkpoint boundary', async () => {
    await tool('play_exercise');
    let release!: (result: ToolResult | null) => void;
    after.mockImplementationOnce(
      async () =>
        new Promise<ToolResult | null>((resolve) => {
          release = resolve;
        }),
    );
    await reply();
    const count = execute.mock.calls.length;
    const pause = loop.action('pause_session');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(execute).toHaveBeenCalledTimes(count);
    release(null);
    await pause;
    expect(execute).toHaveBeenCalledTimes(count + 1);
    expect(snapshot.session?.status).toBe('paused');
  });

  it('never shows a tool-stage text preamble and still speaks ordinary coaching questions', async () => {
    await tool('play_exercise');
    await reply();
    loop.text('What does a semitone mean?');
    const count = responses().length;
    const id = created();
    emit({
      type: 'response.output_text.delta',
      response_id: id,
      item_id: 'hidden-draft',
      delta: 'Let me think about that.',
    });
    emit({
      type: 'response.done',
      response: {
        id,
        status: 'completed',
        output: [
          {
            type: 'message',
            id: 'hidden-draft',
            content: [{ type: 'output_text', text: 'A semitone is the smallest piano-key step.' }],
          },
        ],
      },
    });
    expect(responses()).toHaveLength(count + 1);
    expect(sent).toContainEqual({ type: 'conversation.item.delete', item_id: 'hidden-draft' });
    expect(messages.some((message) => message.text.includes('Let me think'))).toBe(false);
    await reply('A semitone is the distance to the next piano key.');
    expect(messages.at(-1)?.text).toBe('A semitone is the distance to the next piano key.');
    expect(execute).toHaveBeenCalledOnce();
  });

  it('replays immediately with no second model response when the tool call is silent', async () => {
    await tool('play_exercise');
    await reply();
    loop.text('Again');
    const count = responses().length;
    const exerciseId = snapshot.current!.id;
    await tool('replay_exercise', {}, false);
    await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(2));
    expect(responses()).toHaveLength(count);
    expect(snapshot.current?.id).toBe(exerciseId);
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
  });

  it('waits for a single pre-tool acknowledgment to drain, then replays without another reply', async () => {
    await tool('play_exercise');
    await reply();
    loop.text('Play again');
    const count = responses().length;
    const id = created();
    emit({ type: 'output_audio_buffer.started', response_id: id });
    emit({ type: 'response.output_audio_transcript.delta', response_id: id, delta: 'Sure.' });
    done(id, [{ name: 'replay_exercise' }]);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(after).toHaveBeenCalledOnce();
    expect(responses()).toHaveLength(count);
    emit({ type: 'output_audio_buffer.stopped', response_id: id });
    await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(2));
    expect(messages.at(-1)?.text).toBe('Sure.');
    expect(responses()).toHaveLength(count);
  });

  it('handles replay audio finishing before the tool result, without losing the playback', async () => {
    await tool('play_exercise');
    await reply();
    let release!: () => void;
    execute.mockImplementationOnce(async (name, args, id) => {
      const result = await game.execute(
        { callId: id, sessionId: snapshot.session!.id, name, arguments: args },
        true,
      );
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return result;
    });
    loop.text('Play again');
    const id = created();
    emit({ type: 'output_audio_buffer.started', response_id: id });
    done(id, [{ name: 'replay_exercise' }]);
    emit({ type: 'output_audio_buffer.stopped', response_id: id });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
    expect(after).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(after).toHaveBeenCalledTimes(2));
  });

  it('plays a UI replay directly without asking the model to acknowledge the button', async () => {
    await tool('play_exercise');
    await reply();
    vi.useFakeTimers();
    const count = responses().length;
    await loop.action('replay_exercise');
    expect(responses()).toHaveLength(count);
    expect(after).toHaveBeenCalledTimes(2);
  });

  it('reports repeated current-question playback with compact facts instead of appending the full state', async () => {
    await tool('play_exercise');
    await reply();
    const before = sent.length;
    const count = responses().length;
    const exerciseId = snapshot.current!.id;
    for (let index = 0; index < 3; index++) await loop.action('replay_exercise');
    const updates = sent
      .slice(before)
      .filter((event) => event.type === 'conversation.item.create')
      .map((event) => event.item as { role: string; content: Array<{ text: string }> })
      .filter((item) => item.role === 'system');
    expect(updates).toHaveLength(3);
    for (const [index, item] of updates.entries()) {
      expect(item.content[0]!.text.length).toBeLessThan(250);
      expect(JSON.parse(item.content[0]!.text)).toEqual({
        event: 'exercise_replayed',
        exerciseId,
        replayCount: index + 1,
        hintCount: 0,
        reply: 'none',
      });
    }
    expect(snapshot.current?.id).toBe(exerciseId);
    expect(snapshot.totalAnswers).toBe(0);
    expect(responses()).toHaveLength(count);
    expect(after).toHaveBeenCalledTimes(4);
  });

  it('keeps full review and previous-example context instead of treating them as current-question replay', async () => {
    await tool('play_exercise');
    await reply();
    const exercise = (await store.exercises.get(snapshot.current!.id))!;
    loop.text('My answer.');
    await tool('submit_answer', { exerciseId: exercise.id, answer: exercise.expected });
    await reply('Correct. Next.');
    const currentId = snapshot.current!.id;
    const update = vi.spyOn(connection, 'message');
    await loop.action('replay_exercise', { target: 'previous' });
    const previous = await execute.mock.results.at(-1)!.value;
    expect(update).toHaveBeenLastCalledWith(previous.agent.update, 'system');
    await loop.action('replay_exercise', { exerciseId: exercise.id });
    const reviewed = await execute.mock.results.at(-1)!.value;
    expect(reviewed.agent.context.review?.exerciseId).toBe(exercise.id);
    expect(update).toHaveBeenLastCalledWith(reviewed.agent.update, 'system');
    expect(snapshot.current?.id).toBe(currentId);
    expect(snapshot.totalAnswers).toBe(1);
  });

  it('does not compact tutorial replays that change the active presentation', async () => {
    await tool('play_exercise');
    await reply();
    await loop.action('select_lesson', { skillId: 'triads' });
    await reply('Compare major and minor.');
    await loop.action('teach_lesson', { stepId: 'major-0' });
    await reply('Hear C major.');
    const update = vi.spyOn(connection, 'message');
    const before = snapshot.teaching!.presentationId;
    await loop.action('replay_exercise');
    const replay = await execute.mock.results.at(-1)!.value;
    expect(snapshot.teaching!.presentationId).not.toBe(before);
    expect(update).toHaveBeenLastCalledWith(replay.agent.update, 'system');
    expect(snapshot.totalAnswers).toBe(0);
  });

  it('keeps assisted-listening context when replaying a chord as separate notes', async () => {
    await tool('play_exercise');
    await reply();
    await loop.action('select_lesson', { skillId: 'triads' });
    await reply('Compare major and minor.');
    await loop.action('start_practice');
    await reply('Identify this chord.');
    const update = vi.spyOn(connection, 'message');
    const exerciseId = snapshot.current!.id;
    await loop.action('replay_exercise', { arpeggiate: true });
    const replay: ToolResult = await execute.mock.results.at(-1)!.value;
    expect(update).toHaveBeenLastCalledWith(replay.agent.update, 'system');
    expect(replay.agent.context.current?.hintCount).toBe(1);
    expect(new Set(replay.audio!.events.map((note) => note.at)).size).toBe(3);
    expect(snapshot.current?.id).toBe(exerciseId);
    expect(snapshot.totalAnswers).toBe(0);
  });

  it('sends the new question state if an in-flight grade advanced before a UI replay reached the server', async () => {
    await tool('play_exercise');
    await reply();
    const exercise = (await store.exercises.get(snapshot.current!.id))!;
    execute.mockImplementationOnce(async (name, args, callId) => {
      await game.execute(
        {
          callId: crypto.randomUUID(),
          sessionId: snapshot.session!.id,
          name: 'submit_answer',
          arguments: { exerciseId: exercise.id, answer: exercise.expected },
        },
        true,
      );
      return game.execute({ callId, sessionId: snapshot.session!.id, name, arguments: args }, true);
    });
    const update = vi.spyOn(connection, 'message');
    await loop.action('replay_exercise');
    const replay = await execute.mock.results.at(-1)!.value;
    expect(snapshot.current?.id).not.toBe(exercise.id);
    expect(replay.agent.context.current?.id).toBe(snapshot.current?.id);
    expect(update).toHaveBeenLastCalledWith(replay.agent.update, 'system');
    expect(snapshot.totalAnswers).toBe(1);
  });
});
