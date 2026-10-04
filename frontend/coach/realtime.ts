import { z } from 'zod';
import { api } from '../lib/api.js';
import { Log } from '../lib/log.js';
import type { Presentation } from '../../server/types/agent.types.js';

export interface ResponseRequest {
  id: string;
  turn: number;
  section?: number;
  tools: 'auto' | 'none' | 'play_exercise';
  presentation?: Presentation;
}

const itemSchema = z
  .object({
    type: z.string(),
    id: z.string().optional(),
    name: z.string().optional(),
    call_id: z.string().optional(),
    arguments: z.string().optional(),
    content: z
      .array(
        z
          .object({
            type: z.string(),
            text: z.string().optional(),
            transcript: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();
const eventSchema = z
  .object({
    type: z.string(),
    event_id: z.string().optional(),
    response_id: z.string().optional(),
    item_id: z.string().optional(),
    transcript: z.string().optional(),
    text: z.string().optional(),
    delta: z.string().optional(),
    response: z
      .object({
        id: z.string(),
        status: z.string(),
        output: z.array(itemSchema).optional(),
        status_details: z.unknown().optional(),
        metadata: z.record(z.string(), z.unknown()).nullable().optional(),
      })
      .passthrough()
      .optional(),
    error: z.object({ code: z.string().optional(), message: z.string() }).passthrough().optional(),
  })
  .passthrough();
export type RealtimeEvent = z.infer<typeof eventSchema>;
export type RealtimeItem = z.infer<typeof itemSchema>;

interface Handlers {
  event: (event: RealtimeEvent) => void;
  voice: (stream: MediaStream) => void;
  microphone: (stream: MediaStream | null) => void;
  microphoneLost: () => void;
  disconnected: (message: string) => void;
}

export class RealtimeConnection {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private microphone: MediaStream | null = null;
  private sender: RTCRtpSender | null = null;
  private controller: AbortController | null = null;
  private intentionalClose = false;
  private opened = false;
  private microphoneDeviceId = '';
  private microphoneRequest = 0;

  constructor(private readonly handlers: Handlers) {}

  get connected() {
    return this.channel?.readyState === 'open';
  }
  get hasMicrophone() {
    return this.microphone !== null;
  }

  async connect(sessionId: string): Promise<void> {
    this.disconnect();
    this.intentionalClose = false;
    this.opened = false;
    this.controller = new AbortController();
    const controller = this.controller;
    const peer = new RTCPeerConnection();
    this.peer = peer;
    const transceiver = peer.addTransceiver('audio', { direction: 'sendrecv' });
    this.sender = transceiver.sender;
    if (controller.signal.aborted) throw new DOMException('Connection cancelled.', 'AbortError');
    peer.ontrack = (event) =>
      this.handlers.voice(event.streams[0] ?? new MediaStream([event.track]));
    peer.onconnectionstatechange = () => {
      if (this.intentionalClose) return;
      if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected')
        this.handlers.disconnected('The audio connection was lost.');
    };
    const channel = peer.createDataChannel('earrr-events');
    this.channel = channel;
    channel.onmessage = (message: MessageEvent<unknown>) => {
      try {
        if (typeof message.data !== 'string') throw new Error('Non-text realtime event.');
        const parsed = eventSchema.safeParse(JSON.parse(message.data));
        if (!parsed.success) throw new Error('Malformed realtime event.');
        this.handlers.event(parsed.data);
      } catch (error) {
        this.handlers.disconnected(
          `The coach sent an unreadable event. ${error instanceof Error ? error.message : 'The connection needs to be restored.'}`,
        );
      }
    };
    channel.onclose = () => {
      if (this.opened && !this.intentionalClose)
        this.handlers.disconnected('The coach connection closed.');
    };
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          reject(
            new Error(
              'The real-time audio channel did not open. Check your network or VPN; your current lesson is saved.',
            ),
          ),
        40_000,
      );
      const abort = () => {
        clearTimeout(timeout);
        reject(new DOMException('Connection cancelled.', 'AbortError'));
      };
      controller.signal.addEventListener('abort', abort, { once: true });
      channel.onopen = () => {
        clearTimeout(timeout);
        controller.signal.removeEventListener('abort', abort);
        this.opened = true;
        resolve();
      };
      channel.onerror = () => {
        clearTimeout(timeout);
        controller.signal.removeEventListener('abort', abort);
        reject(new Error('The real-time data channel could not connect.'));
      };
    });
    // A handler is attached immediately, even while SDP negotiation is in flight.
    void ready.catch(() => undefined);
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      if (!offer.sdp) throw new Error('The browser could not create an audio connection offer.');
      const { answer } = await api<{ answer: string }>('/realtime/connect', {
        method: 'POST',
        body: JSON.stringify({ sessionId, sdp: offer.sdp }),
        signal: controller.signal,
      });
      await peer.setRemoteDescription({ type: 'answer', sdp: answer });
      await ready;
      if (controller.signal.aborted || this.controller !== controller)
        throw new DOMException('Connection cancelled.', 'AbortError');
      this.send({
        type: 'session.update',
        session: {
          type: 'realtime',
          output_modalities: ['audio'],
          audio: {
            input: {
              turn_detection: {
                type: 'semantic_vad',
                eagerness: 'low',
                create_response: false,
                interrupt_response: true,
              },
            },
          },
        },
      });
    } catch (error) {
      if (this.controller === controller) this.disconnect();
      throw error;
    }
  }

  async enableMicrophone(deviceId = this.microphoneDeviceId) {
    if (this.microphone && deviceId === this.microphoneDeviceId) {
      this.microphone.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia)
      throw new Error(
        'Microphone access needs localhost or HTTPS and a supported browser. You can continue with typed answers.',
      );
    const request = ++this.microphoneRequest;
    const controller = this.controller;
    const sender = this.sender;
    if (!controller || !sender)
      throw new Error('Connect the coach before enabling the microphone.');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    if (
      this.intentionalClose ||
      this.controller !== controller ||
      controller.signal.aborted ||
      request !== this.microphoneRequest
    ) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException('Microphone request cancelled.', 'AbortError');
    }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      stream.getTracks().forEach((item) => item.stop());
      throw new Error('The selected microphone has no audio track.');
    }
    const settings = typeof track.getSettings === 'function' ? track.getSettings() : {};
    Log.event('voice.input_configured', {
      echoCancellation: settings.echoCancellation,
      noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl,
    });
    track.onended = () => {
      if (
        !this.intentionalClose &&
        this.controller === controller &&
        request === this.microphoneRequest
      ) {
        this.microphone = null;
        this.handlers.microphone(null);
        this.handlers.microphoneLost();
      }
    };
    try {
      await sender.replaceTrack(track);
    } catch (error) {
      stream.getTracks().forEach((item) => {
        item.onended = null;
        item.stop();
      });
      throw error;
    }
    if (
      this.controller !== controller ||
      controller.signal.aborted ||
      request !== this.microphoneRequest
    ) {
      stream.getTracks().forEach((item) => {
        item.onended = null;
        item.stop();
      });
      throw new DOMException('Microphone request cancelled.', 'AbortError');
    }
    this.microphone?.getTracks().forEach((item) => {
      item.onended = null;
      item.stop();
    });
    this.microphone = stream;
    this.microphoneDeviceId = deviceId;
    this.handlers.microphone(stream);
  }

  async disableMicrophone() {
    this.microphoneRequest++;
    this.microphone?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.microphone = null;
    if (this.sender) await this.sender.replaceTrack(null);
    if (this.connected) this.clearInput();
    this.handlers.microphone(null);
  }
  clearInput() {
    if (this.connected) this.send({ type: 'input_audio_buffer.clear' });
  }
  send(event: Record<string, unknown>) {
    if (!this.connected)
      throw new Error('The coach connection is being restored. Your current lesson is saved.');
    this.channel!.send(JSON.stringify(event));
  }
  message(text: string, role: 'user' | 'system' = 'user') {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'message', role, content: [{ type: 'input_text', text }] },
    });
  }
  functionResult(callId: string, output: unknown) {
    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) },
    });
  }
  deleteMessage(itemId: string) {
    this.send({ type: 'conversation.item.delete', item_id: itemId });
  }
  respond(request: ResponseRequest) {
    const presentation = request.presentation?.instructions ? request.presentation : undefined;
    this.send({
      type: 'response.create',
      response: {
        output_modalities: request.tools === 'none' ? ['audio'] : ['text'],
        tool_choice:
          request.tools === 'play_exercise'
            ? { type: 'function', name: 'play_exercise' }
            : request.tools,
        metadata: { earrr_turn: String(request.turn), earrr_request: request.id },
        ...(presentation
          ? {
              instructions: presentation.instructions,
              input: [
                {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: JSON.stringify(presentation.context) }],
                },
              ],
            }
          : {}),
      },
    });
  }
  cancel(generating = true) {
    if (this.connected) {
      if (generating) this.send({ type: 'response.cancel' });
      this.send({ type: 'output_audio_buffer.clear' });
    }
  }

  disconnect() {
    this.microphoneRequest++;
    this.intentionalClose = true;
    this.controller?.abort();
    this.controller = null;
    if (this.channel) {
      this.channel.onmessage = null;
      this.channel.onopen = null;
      this.channel.onclose = null;
      this.channel.onerror = null;
      this.channel.close();
    }
    this.channel = null;
    if (this.peer) {
      this.peer.ontrack = null;
      this.peer.onconnectionstatechange = null;
      this.peer.close();
    }
    this.peer = null;
    this.microphone?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    this.microphone = null;
    this.sender = null;
    this.handlers.microphone(null);
    this.opened = false;
  }
}
