import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { z } from 'zod';
import type { Config } from '../config/environment.js';
import { AppError } from '../errors/app-error.js';
import type { VoiceLimitRepository } from '../repositories/voice-limit.repository.js';
import { Log } from './log.service.js';

const minute = 60_000;
const budget = 1_300_000;
const cooldown = 5 * minute;
const leaseDuration = 45_000;
const usageSchema = z.object({ total_tokens: z.number().int().nonnegative() });
const responseUsage = z.object({
  type: z.literal('response.done'),
  response: z.object({ id: z.string(), usage: usageSchema.nullish() }),
});
const transcriptionUsage = z.object({
  type: z.literal('conversation.item.input_audio_transcription.completed'),
  item_id: z.string(),
  usage: z.union([usageSchema, z.object({ type: z.literal('duration') })]).optional(),
});

interface Call {
  key: string;
  leaseId: string;
  callId: string;
  socket: WebSocket;
  pending: Promise<void>;
  queuedUsage: Usage[];
  writingUsage: boolean;
  timer?: ReturnType<typeof setInterval>;
  stopping?: Promise<void>;
}
interface Usage {
  id: string;
  at: number;
  tokens: number;
}
interface Options {
  now?: () => number;
  socket?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
}

export class RealtimeCallService {
  private readonly calls = new Set<Call>();
  private readonly connecting = new Map<AbortController, Promise<void>>();
  private closing = false;

  constructor(
    private readonly config: Config,
    private readonly limits: VoiceLimitRepository,
    private readonly fetcher: typeof fetch = fetch,
    private readonly options: Options = {},
  ) {}

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  async connect(
    ip: string,
    signal: AbortSignal,
    negotiate: (signal: AbortSignal) => Promise<{ answer: string; callId: string }>,
  ): Promise<string> {
    if (this.closing) throw AppError.create('voice_limit_unavailable');
    const controller = new AbortController();
    let finished!: () => void;
    this.connecting.set(
      controller,
      new Promise<void>((resolve) => {
        finished = resolve;
      }),
    );
    const activeSignal = AbortSignal.any([signal, controller.signal]);
    const key = createHmac('sha256', this.config.learningSaveKey ?? this.config.apiKey)
      .update(`earrr-voice-ip\0${ip}`)
      .digest('hex');
    const leaseId = randomUUID();
    let claimed = false;
    let callId: string | null = null;
    let call: Call | undefined;
    try {
      activeSignal.throwIfAborted();
      const previous = await this.limits.change(key, (state) => {
        const now = this.now();
        state.usage = state.usage.filter((entry) => entry.at > now - minute);
        if (state.blockedUntil > now) throw AppError.create('voice_usage_limited');
        if (state.lease && state.lease.id !== leaseId && state.lease.until > now)
          throw AppError.create('voice_connection_in_use');
        const previous = state.lease?.callId ?? null;
        state.lease = { id: leaseId, until: now + 90_000, callId: previous };
        return previous;
      });
      claimed = true;
      callId = previous;
      if (previous) {
        const owned = [...this.calls].find((call) => call.callId === previous);
        if (owned) await this.stop(owned);
        else await this.hangup(previous);
      }
      callId = null;
      activeSignal.throwIfAborted();
      const result = await negotiate(activeSignal);
      callId = result.callId;
      if (!result.answer.startsWith('v=0')) throw AppError.create('azure_sdp_invalid');
      await this.limits.change(key, (state) => {
        if (state.lease?.id !== leaseId) throw AppError.create('voice_connection_in_use');
        state.lease.callId = result.callId;
        state.lease.until = this.now() + leaseDuration;
      });
      activeSignal.throwIfAborted();
      const url = `${this.config.azureEndpoint.replace('https:', 'wss:')}/openai/v1/realtime?call_id=${encodeURIComponent(result.callId)}`;
      const options = { headers: { 'api-key': this.config.apiKey }, handshakeTimeout: 8000 };
      const socket = this.options.socket?.(url, options) ?? new WebSocket(url, options);
      call = {
        key,
        leaseId,
        callId: result.callId,
        socket,
        pending: Promise.resolve(),
        queuedUsage: [],
        writingUsage: false,
      };
      this.calls.add(call);
      this.observe(call);
      await once(socket, 'open', { signal: activeSignal });
      activeSignal.throwIfAborted();
      if (call.stopping) throw AppError.create('voice_limit_unavailable');
      return result.answer;
    } catch (error) {
      if (call) await this.stop(call);
      else if (claimed) {
        if (callId) await this.hangup(callId);
        await this.release(key, leaseId);
      }
      throw error;
    } finally {
      this.connecting.delete(controller);
      finished();
    }
  }

  private observe(call: Call) {
    let alive = true;
    call.socket.on('pong', () => {
      alive = true;
    });
    call.socket.on('error', (error) => this.fail(call, error));
    call.socket.on('close', (code) => {
      if (call.stopping) return;
      if (code === 1000)
        void this.stop(call).catch((error: unknown) => this.terminationFailed(call, error));
      else this.fail(call, new Error(`The server-side voice observer closed (${code}).`));
    });
    call.socket.on('message', (data) => {
      if (call.stopping) return;
      try {
        const event: unknown = JSON.parse(data.toString());
        if (!event || typeof event !== 'object' || !('type' in event))
          throw new Error('Invalid server-side voice event.');
        if (event.type === 'response.done') {
          const { response } = responseUsage.parse(event);
          if (response.usage) {
            const tokens = response.usage.total_tokens;
            this.queueUsage(call, `response:${response.id}`, tokens);
          }
        } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
          const parsed = transcriptionUsage.parse(event);
          if (parsed.usage && 'total_tokens' in parsed.usage) {
            const tokens = parsed.usage.total_tokens;
            this.queueUsage(call, `transcription:${parsed.item_id}`, tokens);
          }
        }
      } catch (error) {
        this.fail(call, error);
      }
    });
    call.timer = setInterval(() => {
      if (call.stopping || call.socket.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        this.fail(call, new Error('The server-side voice observer stopped responding.'));
        return;
      }
      alive = false;
      call.socket.ping();
      this.enqueue(call, async () => {
        await this.limits.change(call.key, (state) => {
          if (state.lease?.id !== call.leaseId) throw AppError.create('voice_connection_in_use');
          state.lease.until = this.now() + leaseDuration;
        });
      });
    }, 15_000);
    call.timer.unref();
  }

  private enqueue(call: Call, work: () => Promise<void>) {
    call.pending = call.pending.then(work).catch((error: unknown) => {
      this.fail(call, error);
    });
  }

  private queueUsage(call: Call, id: string, tokens: number) {
    if (!tokens) return;
    call.queuedUsage.push({ id: `${call.callId}:${id}`, at: this.now(), tokens });
    if (call.writingUsage) return;
    call.writingUsage = true;
    this.enqueue(call, async () => {
      try {
        while (call.queuedUsage.length) await this.record(call, call.queuedUsage.splice(0));
      } finally {
        call.writingUsage = false;
      }
    });
  }

  private async record(call: Call, usage: Usage[]) {
    const limited = await this.limits.change(call.key, (state) => {
      if (state.lease?.id !== call.leaseId) throw AppError.create('voice_connection_in_use');
      let limited = false;
      for (const entry of usage) {
        state.usage = state.usage.filter((previous) => previous.at > entry.at - minute);
        if (!state.usage.some((previous) => previous.id === entry.id)) state.usage.push(entry);
        if (state.usage.reduce((sum, previous) => sum + previous.tokens, 0) > budget) {
          if (state.blockedUntil <= entry.at) state.blockedUntil = entry.at + cooldown;
          limited = true;
        }
      }
      state.lease.until = this.now() + leaseDuration;
      return limited;
    });
    if (limited) this.fail(call, AppError.create('voice_usage_limited'));
  }

  private fail(call: Call, error: unknown) {
    if (call.stopping) return;
    Log.error('voice_connection_stopped', error, { callId: call.callId });
    void this.stop(call).catch((failure: unknown) => this.terminationFailed(call, failure));
  }

  private terminationFailed(call: Call, error: unknown) {
    Log.error('voice_termination_failed', error, { callId: call.callId });
    console.error(
      '[earrr] Voice termination failed:',
      error instanceof Error ? error.message : 'Unknown error',
    );
  }

  private async hangup(callId: string) {
    const response = await this.fetcher(
      `${this.config.azureEndpoint}/openai/v1/realtime/calls/${encodeURIComponent(callId)}/hangup`,
      {
        method: 'POST',
        headers: { 'api-key': this.config.apiKey },
        signal: AbortSignal.timeout(8000),
      },
    );
    if (!response.ok && response.status !== 404) throw AppError.provider(response.status);
  }

  private async release(key: string, leaseId: string) {
    await this.limits.change(key, (state) => {
      if (state.lease?.id === leaseId) state.lease = null;
    });
  }

  private stop(call: Call): Promise<void> {
    if (call.stopping) return call.stopping;
    clearInterval(call.timer);
    call.stopping = (async () => {
      await call.pending;
      await this.hangup(call.callId);
      await this.release(call.key, call.leaseId);
    })().finally(() => {
      call.socket.terminate();
      this.calls.delete(call);
    });
    return call.stopping;
  }

  async close() {
    this.closing = true;
    const connecting = [...this.connecting];
    for (const [controller] of connecting) controller.abort();
    await Promise.all(connecting.map(([, finished]) => finished));
    await Promise.all([...this.calls].map((call) => this.stop(call)));
  }
}
