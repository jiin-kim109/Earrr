import { z } from 'zod';
import type { Snapshot, ToolName, ToolResult } from '../../server/types/agent.types.js';
import type { Transcript } from './types.js';
import type {
  RealtimeConnection,
  RealtimeEvent,
  RealtimeItem,
  ResponseRequest,
} from './realtime.js';

export type Phase =
  | 'ready'
  | 'connecting'
  | 'thinking'
  | 'speaking'
  | 'playing'
  | 'listening'
  | 'hearing'
  | 'paused';
interface ResponseRun {
  request: ResponseRequest;
  id: string;
  done: boolean;
  drained: boolean;
  audio: boolean;
  waitingForTools: boolean;
  settled: boolean;
  text: string;
}
interface Handlers {
  snapshot: () => Snapshot | null;
  result: (result: ToolResult) => void;
  execute: (name: ToolName, args: Record<string, unknown>, callId: string) => Promise<ToolResult>;
  afterReply: (result: ToolResult | null, isCurrent: () => boolean) => Promise<ToolResult | null>;
  stopMusic: () => void;
  phase: (phase: Phase) => void;
  message: (
    role: Transcript['role'],
    text: string,
    id: string,
    complete: boolean,
    interrupted?: boolean,
  ) => void;
  error: (error: unknown) => void;
}

export class Conversation {
  private turn = 0;
  private generation = 0;
  private active: { request: ResponseRequest; id?: string } | null = null;
  private queued: ResponseRequest | null = null;
  private working = 0;
  private operations: Promise<void> = Promise.resolve();
  private pending: ToolResult | null = null;
  private readonly responses = new Map<string, ResponseRun>();
  private readonly calls = new Set<string>();
  private readonly voiceTurns = new Map<string, number>();
  private readonly commits = new Set<string>();
  private readonly events = new Set<string>();
  private actionCount = 0;
  private section = 0;

  constructor(
    private readonly connection: RealtimeConnection,
    private readonly handlers: Handlers,
  ) {}

  reset() {
    this.generation++;
    this.section++;
    this.turn++;
    this.active = null;
    this.queued = null;
    this.pending = null;
    this.responses.clear();
    this.calls.clear();
    this.voiceTurns.clear();
    this.commits.clear();
    this.events.clear();
    this.handlers.stopMusic();
  }

  begin(): number {
    const oldTurn = this.turn;
    const speaking = [...this.responses.values()].some(
      (run) => run.request.turn === oldTurn && run.audio && !run.drained && !run.settled,
    );
    if (this.connection.connected && (this.active || speaking))
      this.connection.cancel(this.active !== null);
    for (const response of this.responses.values()) {
      if (response.request.turn === oldTurn && !response.settled && response.text) {
        response.settled = true;
        this.handlers.message('assistant', response.text, `assistant:${response.id}`, true, true);
      }
    }
    this.turn++;
    this.queued = null;
    this.pending = null;
    this.actionCount = 0;
    this.handlers.stopMusic();
    return this.turn;
  }

  start() {
    const snapshot = this.handlers.snapshot();
    if (!snapshot) throw new Error('Load the saved lesson before starting the coach.');
    this.begin();
    this.connection.message(snapshot.agent.connectionPrompt, 'system');
    this.request('play_exercise');
  }
  text(text: string) {
    this.begin();
    this.connection.clearInput();
    this.handlers.message('user', text, crypto.randomUUID(), true);
    this.connection.message(text);
    this.request('auto');
  }
  async action(name: ToolName, args: Record<string, unknown> = {}) {
    if (['select_lesson', 'show_welcome', 'teach_lesson', 'start_practice'].includes(name))
      this.section++;
    const section = this.section;
    const turn = this.begin();
    const generation = this.generation;
    const release = await this.acquire();
    let silent = false;
    try {
      if (turn !== this.turn || generation !== this.generation) return;
      const result = await this.handlers.execute(name, args, crypto.randomUUID());
      if (generation !== this.generation || section !== this.section) return;
      this.handlers.result(result);
      this.connection.message(result.agent.update, 'system');
      if (turn === this.turn) {
        this.pending = result;
        silent = result.reply === 'none';
        if (!silent) this.request('none', result);
      }
    } catch (error) {
      this.handlers.error(error);
    } finally {
      release();
    }
    if (silent && turn === this.turn && generation === this.generation) await this.deliver(turn);
  }

  private acquire(): Promise<() => void> {
    const previous = this.operations;
    let unlock!: () => void;
    this.operations = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this.working++;
    return previous.then(() => () => {
      this.working--;
      unlock();
      this.pump();
    });
  }

  private request(tools: ResponseRequest['tools'], result?: ToolResult) {
    this.queued = {
      id: crypto.randomUUID(),
      turn: this.turn,
      tools,
      section: this.section,
      ...(result?.agent.presentation ? { presentation: result.agent.presentation } : {}),
    };
    const speaking = [...this.responses.values()].some(
      (run) => run.request.turn === this.turn && run.audio && !run.drained && !run.settled,
    );
    this.handlers.phase(speaking ? 'speaking' : 'thinking');
    this.pump();
  }
  private pump() {
    if (!this.queued || this.active || this.working || !this.connection.connected) return;
    const request = this.queued;
    this.queued = null;
    if (request.turn !== this.turn) return;
    this.active = { request };
    this.connection.respond(request);
  }
  private voiceTurn(id: string) {
    let turn = this.voiceTurns.get(id);
    if (turn === undefined) {
      turn = this.begin();
      this.voiceTurns.set(id, turn);
      this.handlers.message('user', 'Listening…', `user:${id}`, false);
    }
    return turn;
  }

  handle(event: RealtimeEvent) {
    if (event.event_id) {
      if (this.events.has(event.event_id)) return;
      this.events.add(event.event_id);
      if (this.events.size > 3000) this.events.delete(this.events.values().next().value!);
    }
    const run = event.response_id ? this.responses.get(event.response_id) : undefined;
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        if (event.item_id) this.voiceTurn(event.item_id);
        this.handlers.phase('hearing');
        break;
      case 'input_audio_buffer.committed':
        if (event.item_id && !this.commits.has(event.item_id)) {
          this.commits.add(event.item_id);
          if (this.voiceTurn(event.item_id) === this.turn) this.request('auto');
        }
        break;
      case 'conversation.item.input_audio_transcription.delta':
        if (event.item_id && event.delta)
          this.handlers.message('user', event.delta, `user:${event.item_id}`, false);
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (event.item_id)
          this.handlers.message('user', event.transcript ?? '', `user:${event.item_id}`, true);
        break;
      case 'conversation.item.input_audio_transcription.failed':
        if (event.item_id)
          this.handlers.message(
            'user',
            '(Voice caption unavailable)',
            `user:${event.item_id}`,
            true,
          );
        break;
      case 'response.created': {
        if (!this.active || !event.response) return;
        const requested = event.response.metadata?.earrr_request;
        if (requested && requested !== this.active.request.id) return;
        if (this.responses.has(event.response.id)) return;
        const request = this.active.request;
        this.active.id = event.response.id;
        this.responses.set(event.response.id, {
          request,
          id: event.response.id,
          done: false,
          drained: false,
          audio: false,
          waitingForTools: false,
          settled: false,
          text: '',
        });
        break;
      }
      case 'output_audio_buffer.started':
        if (run && run.request.turn === this.turn) {
          run.audio = true;
          this.handlers.phase('speaking');
        }
        break;
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta':
        if (run && run.request.turn === this.turn && !run.settled) {
          run.audio = true;
          run.text += event.delta ?? '';
          this.handlers.phase('speaking');
          this.handlers.message('assistant', run.text, `assistant:${run.id}`, false);
        }
        break;
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done':
        if (run && run.request.turn === this.turn && !run.settled) {
          run.audio = true;
          run.text = event.transcript ?? run.text;
          this.handlers.phase('speaking');
          this.handlers.message('assistant', run.text, `assistant:${run.id}`, false);
        }
        break;
      case 'output_audio_buffer.stopped':
        if (run) {
          run.drained = true;
          void this.finish(run);
        }
        break;
      case 'output_audio_buffer.cleared':
        if (
          run &&
          run.request.turn === this.turn &&
          run.request.section === this.section &&
          !run.settled
        ) {
          run.settled = true;
          if (run.text)
            this.handlers.message('assistant', run.text, `assistant:${run.id}`, true, true);
        }
        break;
      case 'response.done': {
        const response = event.response;
        if (!response) return;
        const record = this.responses.get(response.id);
        if (!record || record.done) return;
        record.done = true;
        if (this.active?.id === response.id) this.active = null;
        const output = response.output ?? [];
        if (record.request.tools !== 'none') {
          for (const item of output)
            if (item.type === 'message' && item.id) this.connection.deleteMessage(item.id);
        }
        record.audio ||= output.some((item) =>
          item.content?.some((part) => ['audio', 'output_audio'].includes(part.type)),
        );
        if (record.request.turn !== this.turn) {
          for (const item of output)
            if (item.type === 'function_call' && item.call_id)
              this.connection.functionResult(item.call_id, {
                ok: false,
                cancelled: true,
                message: 'The learner interrupted before this action ran.',
              });
          this.pump();
          return;
        }
        if (response.status !== 'completed') {
          this.handlers.error(
            'The coach could not finish that response. Your exercise remains saved; try the message again.',
          );
          this.pump();
          return;
        }
        const calls = output.filter((item) => item.type === 'function_call');
        record.waitingForTools = calls.length > 0;
        if (calls.length) void this.execute(calls, record);
        else if (record.request.tools !== 'none') this.request('none');
        else if (!record.audio)
          this.handlers.error('The coach returned no speech. Try the message again.');
        else void this.finish(record);
        break;
      }
      case 'error':
        if (
          !['response_cancel_not_active', 'output_audio_buffer_empty'].includes(
            event.error?.code ?? '',
          )
        ) {
          this.handlers.error(event.error?.message ?? 'The realtime coach reported an error.');
        }
        break;
    }
  }

  private async execute(calls: RealtimeItem[], record: ResponseRun) {
    const generation = this.generation;
    let section = record.request.section;
    const release = await this.acquire();
    let failed = false;
    let needsReply = false;
    const replyResults: ToolResult[] = [];
    try {
      if (generation !== this.generation || !this.connection.connected) return;
      for (const call of calls) {
        if (!call.call_id || this.calls.has(call.call_id)) continue;
        this.calls.add(call.call_id);
        if (record.request.turn !== this.turn) {
          this.connection.functionResult(call.call_id, { ok: false, cancelled: true });
          continue;
        }
        try {
          if (++this.actionCount > 8)
            throw new Error('Too many actions in one turn. Ask the learner to try again.');
          const name = this.handlers.snapshot()?.agent.toolNames.find((name) => name === call.name);
          if (!name)
            throw new Error(
              `The coach requested an unknown tool: ${call.name ?? '(missing name)'}.`,
            );
          const args = z.record(z.string(), z.unknown()).parse(JSON.parse(call.arguments ?? '{}'));
          if (['select_lesson', 'show_welcome', 'teach_lesson', 'start_practice'].includes(name)) {
            this.section++;
            section = this.section;
          }
          const result = await this.handlers.execute(name, args, call.call_id);
          if (generation !== this.generation || !this.connection.connected) return;
          this.connection.functionResult(call.call_id, result.agent.context);
          if (section !== this.section) continue;
          this.handlers.result(result);
          needsReply ||= result.reply !== 'none';
          if (result.reply !== 'none') replyResults.push(result);
          if (record.request.turn === this.turn) {
            if (result.audio || result.teaching || result.endConversation) this.pending = result;
            if (result.snapshot.session?.status === 'paused') this.pending = null;
          }
        } catch (error) {
          if (generation !== this.generation || !this.connection.connected) return;
          failed = true;
          this.connection.functionResult(call.call_id, {
            ok: false,
            error: error instanceof Error ? error.message : 'Action failed.',
            current: this.handlers.snapshot()?.current,
          });
        }
      }
      if (needsReply && record.text && !record.settled) {
        record.settled = true;
        this.handlers.message('assistant', record.text, `assistant:${record.id}`, true);
      }
      if (record.request.turn === this.turn && generation === this.generation) {
        if (failed || needsReply)
          this.request(
            failed && this.actionCount < 3 ? 'auto' : 'none',
            !failed && replyResults.length === 1 ? replyResults[0] : undefined,
          );
        else {
          record.waitingForTools = false;
          if (!record.audio) record.drained = true;
        }
      }
    } finally {
      release();
    }
    if (!failed && !needsReply) await this.finish(record);
  }

  private async finish(run: ResponseRun) {
    if (
      !run.done ||
      !run.drained ||
      run.waitingForTools ||
      run.settled ||
      run.request.turn !== this.turn ||
      this.active ||
      this.working ||
      this.queued
    )
      return;
    run.settled = true;
    if (run.text) this.handlers.message('assistant', run.text, `assistant:${run.id}`, true);
    await this.deliver(run.request.turn);
  }

  private async deliver(turn: number) {
    const generation = this.generation;
    const current = () =>
      this.generation === generation && this.turn === turn && this.connection.connected;
    const pending = this.pending;
    this.pending = null;
    const release = await this.acquire();
    let nextTurn: number | null = null;
    try {
      if (!current()) return;
      const next = await this.handlers.afterReply(pending, current);
      if (next && generation === this.generation && this.connection.connected) {
        this.handlers.result(next);
        if (!current()) this.connection.message(next.agent.update, 'system');
      }
      if (next && current()) {
        this.begin();
        this.pending = next;
        this.connection.message(next.agent.update, 'system');
        if (next.reply === 'none') nextTurn = this.turn;
        else this.request('none', next);
      } else if (current())
        this.handlers.phase(
          this.handlers.snapshot()?.session?.status === 'paused' ? 'paused' : 'listening',
        );
    } catch (error) {
      if (current()) this.handlers.error(error);
    } finally {
      release();
    }
    if (nextTurn !== null) await this.deliver(nextTurn);
  }
}
