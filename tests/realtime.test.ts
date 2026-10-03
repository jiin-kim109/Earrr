import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../frontend/lib/api.js';
import { RealtimeConnection } from '../frontend/coach/realtime.js';
import { presentationInstructions } from '../server/services/agent/presentation.js';
import type { Presentation } from '../server/types/agent.types.js';

vi.mock('../frontend/lib/api.js', () => ({ api: vi.fn() }));

class Channel {
  readyState = 'connecting';
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  close() {
    this.readyState = 'closed';
    this.onclose?.();
  }
  send(_message: string) {}
}
class Peer {
  channel = new Channel();
  sender = { replaceTrack: vi.fn(async () => undefined) };
  addTransceiver() {
    return { sender: this.sender };
  }
  createDataChannel() {
    return this.channel;
  }
  async createOffer() {
    return { sdp: 'v=0 test offer' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {
    this.channel.readyState = 'open';
    this.channel.onopen?.();
  }
  close() {
    this.channel.close();
  }
}
class Track {
  enabled = true;
  readyState = 'live';
  onended: (() => void) | null = null;
  stop() {
    this.readyState = 'ended';
    this.onended?.();
  }
}
const handlers = () => ({
  event: vi.fn(),
  voice: vi.fn(),
  microphone: vi.fn(),
  microphoneLost: vi.fn(),
  disconnected: vi.fn(),
});
function setup() {
  vi.stubGlobal('RTCPeerConnection', Peer);
  vi.mocked(api).mockResolvedValue({ answer: 'v=0 test answer' });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('one realtime connection with optional microphone', () => {
  it('connects without microphone permission and selects tools silently before a native audio reply', async () => {
    setup();
    const capture = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: capture } });
    const send = vi.spyOn(Channel.prototype, 'send');
    const connection = new RealtimeConnection(handlers());
    await connection.connect('session');
    expect(capture).not.toHaveBeenCalled();
    expect(JSON.parse(send.mock.calls[0]![0])).toMatchObject({
      type: 'session.update',
      session: {
        output_modalities: ['audio'],
        audio: { input: { turn_detection: { create_response: false } } },
      },
    });
    connection.message('A minor third?');
    connection.respond({ id: 'request', turn: 1, tools: 'auto' });
    expect(JSON.parse(send.mock.calls.at(-1)![0])).toEqual({
      type: 'response.create',
      response: {
        output_modalities: ['text'],
        tool_choice: 'auto',
        metadata: { earrr_turn: '1', earrr_request: 'request' },
      },
    });
    connection.respond({ id: 'reply', turn: 1, tools: 'none' });
    expect(JSON.parse(send.mock.calls.at(-1)![0]).response.output_modalities).toEqual(['audio']);
    connection.disconnect();
  });
  it('switches microphones and turns capture off without replacing the conversation', async () => {
    setup();
    const first = new Track();
    const second = new Track();
    const capture = vi
      .fn()
      .mockResolvedValueOnce({ getAudioTracks: () => [first], getTracks: () => [first] })
      .mockResolvedValueOnce({ getAudioTracks: () => [second], getTracks: () => [second] });
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: capture } });
    const connection = new RealtimeConnection(handlers());
    await connection.connect('session');
    await connection.enableMicrophone('headset');
    await connection.enableMicrophone('usb');
    expect(capture.mock.calls[1]![0].audio.deviceId).toEqual({ exact: 'usb' });
    expect(first.readyState).toBe('ended');
    expect(second.readyState).toBe('live');
    await connection.disableMicrophone();
    expect(second.readyState).toBe('ended');
    expect(connection.connected).toBe(true);
    expect(connection.hasMicrophone).toBe(false);
    connection.disconnect();
  });
  it('scopes a feedback reply to the graded facts rather than the next question or old dialogue', async () => {
    setup();
    const send = vi.spyOn(Channel.prototype, 'send');
    const connection = new RealtimeConnection(handlers());
    await connection.connect('session');
    const context: Presentation['context'] = {
      parts: [
        {
          kind: 'feedback',
          verdict: 'correct',
          expectedAnswer: 'minor third',
          missing: [],
          details: [],
          played: { midi: [67, 70], notes: ['G4', 'Bb4'], semitones: 3, presentation: 'ascending' },
        },
        { kind: 'next_question', cue: 'Two notes descending.' },
      ],
    };
    const instructions = presentationInstructions('feedback');
    connection.respond({
      id: 'feedback',
      turn: 1,
      tools: 'none',
      presentation: { purpose: 'feedback', context, instructions },
    });
    const event = JSON.parse(send.mock.calls.at(-1)![0]);
    expect(event.response.output_modalities).toEqual(['audio']);
    expect(event.response.tool_choice).toBe('none');
    expect(event.response.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: JSON.stringify(context) }],
      },
    ]);
    expect(event.response.instructions).toContain('parts in order');
    expect(event.response.instructions).toBe(instructions);
    connection.respond({
      id: 'instruction',
      turn: 2,
      tools: 'none',
      presentation: {
        purpose: 'instruction',
        context: { parts: [{ kind: 'instruction', text: 'Name the interval.' }] },
      },
    });
    expect(JSON.parse(send.mock.calls.at(-1)![0]).response).not.toHaveProperty('input');
    connection.disconnect();
  });
  it('releases late permission results after the user chose to turn the mic off', async () => {
    setup();
    const track = new Track();
    const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
    let allow!: (value: typeof stream) => void;
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((resolve) => {
            allow = resolve;
          }),
      },
    });
    const connection = new RealtimeConnection(handlers());
    await connection.connect('session');
    const request = connection.enableMicrophone();
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await connection.disableMicrophone();
    allow(stream);
    await rejected;
    expect(track.readyState).toBe('ended');
    expect(connection.connected).toBe(true);
    connection.disconnect();
  });
  it('treats microphone disconnection as input loss, not conversation loss', async () => {
    setup();
    const track = new Track();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: async () => ({ getAudioTracks: () => [track], getTracks: () => [track] }),
      },
    });
    const callbacks = handlers();
    const connection = new RealtimeConnection(callbacks);
    await connection.connect('session');
    await connection.enableMicrophone();
    track.stop();
    expect(callbacks.microphoneLost).toHaveBeenCalledOnce();
    expect(callbacks.disconnected).not.toHaveBeenCalled();
    expect(connection.connected).toBe(true);
    connection.disconnect();
  });
});
