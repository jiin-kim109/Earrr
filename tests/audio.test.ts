import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../frontend/audio/audio.js';
import type { AudioPlan } from '../shared/types/course.js';
import { SampleBank } from '../frontend/audio/samples.js';

class Parameter {
  value = 0;
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
  setTargetAtTime = vi.fn();
  cancelAndHoldAtTime = vi.fn();
  cancelScheduledValues = vi.fn();
}
class Node {
  gain = new Parameter();
  frequency = new Parameter();
  playbackRate = new Parameter();
  detune = new Parameter();
  pan = new Parameter();
  threshold = new Parameter();
  knee = new Parameter();
  ratio = new Parameter();
  attack = new Parameter();
  release = new Parameter();
  fftSize = 0;
  getFloatTimeDomainData = vi.fn();
  type = '';
  buffer: unknown;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn();
  stop = vi.fn();
}
class Context {
  static current: Context;
  state = 'suspended';
  currentTime = 5;
  sampleRate = 24_000;
  destination = new Node();
  sources: Node[] = [];
  gains: Node[] = [];
  finishResume: () => void;
  private readonly resumed: Promise<void>;
  constructor() {
    Context.current = this;
    let finish!: () => void;
    this.resumed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.finishResume = () => {
      this.state = 'running';
      finish();
    };
  }
  resume() {
    return this.resumed;
  }
  addEventListener() {}
  createGain() {
    const node = new Node();
    this.gains.push(node);
    return node;
  }
  createDynamicsCompressor() {
    return new Node();
  }
  createAnalyser() {
    return new Node();
  }
  createStereoPanner() {
    return new Node();
  }
  createBuffer() {
    return {};
  }
  decodeAudioData = vi.fn(async (_bytes: ArrayBuffer) => ({}) as AudioBuffer);
  createBufferSource() {
    const node = new Node();
    this.sources.push(node);
    return node;
  }
  createOscillator() {
    const node = new Node();
    this.sources.push(node);
    return node;
  }
  createMediaStreamSource() {
    return new Node();
  }
  setSinkId = vi.fn(async (_id: string) => undefined);
}
const plan: AudioPlan = {
  instrument: 'piano',
  duration: 1.3,
  events: [{ midi: 69, at: 0.2, duration: 0.8, velocity: 0.7, role: 'exercise' }],
};
beforeEach(() => {
  vi.spyOn(SampleBank.prototype, 'prepare').mockResolvedValue(undefined);
  vi.spyOn(SampleBank.prototype, 'get').mockReturnValue({
    buffer: {} as AudioBuffer,
    peak: 1,
    playbackRate: 1,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('audio-clock scheduling and cancellation', () => {
  it('plays saved voice through the shared output volume and stops immediately on abort', async () => {
    vi.stubGlobal('AudioContext', Context);
    const engine = new AudioEngine();
    const controller = new AbortController();
    const started = vi.fn();
    const playing = engine.playNarration(new ArrayBuffer(16), controller.signal, started);
    Context.current.finishResume();
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const source = Context.current.sources[0]!;
    const gain = Context.current.gains.at(-1)!;
    engine.setVolume(0.25);
    expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.25, 5, 0.025);
    controller.abort();
    await expect(playing).resolves.toBe(false);
    expect(source.stop).toHaveBeenCalledWith(5.015);
    source.onended?.();
    expect(source.disconnect).toHaveBeenCalledOnce();
  });

  it('does not start cached voice after a newer action wins during decoding', async () => {
    vi.stubGlobal('AudioContext', Context);
    const engine = new AudioEngine();
    const unlocking = engine.unlock();
    Context.current.finishResume();
    await unlocking;
    let decode!: (audio: AudioBuffer) => void;
    Context.current.decodeAudioData.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          decode = resolve;
        }),
    );
    const started = vi.fn();
    const playing = engine.playNarration(
      new ArrayBuffer(16),
      new AbortController().signal,
      started,
    );
    await vi.waitFor(() => expect(decode).toBeDefined());
    engine.stop();
    decode({} as AudioBuffer);
    await expect(playing).resolves.toBe(false);
    expect(started).not.toHaveBeenCalled();
    expect(Context.current.sources).toHaveLength(0);
  });

  it('finishes cached narration from the audio end event, including a synchronous stop at start', async () => {
    vi.stubGlobal('AudioContext', Context);
    const engine = new AudioEngine();
    const first = engine.playNarration(new ArrayBuffer(16), new AbortController().signal, () =>
      engine.stop(),
    );
    Context.current.finishResume();
    await expect(first).resolves.toBe(false);
    const second = engine.playNarration(new ArrayBuffer(16), new AbortController().signal, vi.fn());
    await vi.waitFor(() => expect(Context.current.sources).toHaveLength(2));
    Context.current.sources[1]!.onended?.();
    await expect(second).resolves.toBe(true);
  });

  it('settles when playback is stopped synchronously by its start callback', async () => {
    vi.stubGlobal('AudioContext', Context);
    const engine = new AudioEngine();
    let result: boolean | undefined;
    const playing = engine
      .play(plan, () => engine.stop())
      .then((value) => {
        result = value;
      });
    Context.current.finishResume();
    await vi.waitFor(() => expect(result).toBe(false), { timeout: 500 });
    await playing;
    expect(engine.playbackTime()).toBeNull();
  });

  it('ignores a failed sample load after that playback was superseded', async () => {
    vi.stubGlobal('AudioContext', Context);
    let reject!: (error: Error) => void;
    vi.mocked(SampleBank.prototype.prepare).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const engine = new AudioEngine();
    const first = engine.play(plan);
    const outcome = first.then(
      (value) => value,
      (error: unknown) => error,
    );
    Context.current.finishResume();
    await vi.waitFor(() => expect(reject).toBeDefined());
    const latest = engine.play(plan);
    await vi.waitFor(() => expect(Context.current.sources).toHaveLength(2));
    reject(new Error('Old sample load failed.'));
    await expect(outcome).resolves.toBe(false);
    engine.stop();
    await expect(latest).resolves.toBe(false);
  });

  it('reports the actual scheduled music clock and clears it after completion or interruption', async () => {
    vi.stubGlobal('AudioContext', Context);
    const engine = new AudioEngine();
    expect(engine.playbackTime()).toBeNull();
    const playing = engine.play(plan);
    Context.current.finishResume();
    await vi.waitFor(() => expect(Context.current.sources).toHaveLength(2));
    expect(engine.playbackTime()).toBeCloseTo(-0.08);
    Context.current.currentTime = 5.58;
    expect(engine.playbackTime()).toBeCloseTo(0.5);
    Context.current.sources.at(-1)!.onended?.();
    await expect(playing).resolves.toBe(true);
    expect(engine.playbackTime()).toBeNull();
    const replay = engine.play(plan);
    await vi.waitFor(() => expect(engine.playbackTime()).not.toBeNull());
    engine.stop();
    await expect(replay).resolves.toBe(false);
    expect(engine.playbackTime()).toBeNull();
  });

  it('fades interrupted notes before a rapid replay starts and releases old voices once', async () => {
    vi.stubGlobal('AudioContext', Context);
    const engine = new AudioEngine();
    const first = engine.play(plan);
    Context.current.finishResume();
    await vi.waitFor(() => expect(Context.current.sources).toHaveLength(2));
    const voice = Context.current.sources[0]!;
    const envelope = Context.current.gains.at(-1)!;
    Context.current.currentTime = 5.5;
    const second = engine.play(plan);
    await expect(first).resolves.toBe(false);
    await vi.waitFor(() => expect(Context.current.sources).toHaveLength(4));
    expect(envelope.gain.cancelAndHoldAtTime).toHaveBeenCalledWith(5.5);
    expect(envelope.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 5.512);
    expect(voice.stop).toHaveBeenLastCalledWith(5.512);
    const newStart = Context.current.sources[2]!.start.mock.calls[0]![0];
    expect(newStart).toBeGreaterThan(5.512);
    voice.onended?.();
    expect(voice.disconnect).toHaveBeenCalledOnce();
    expect(envelope.disconnect).toHaveBeenCalledOnce();
    engine.stop();
    await expect(second).resolves.toBe(false);
  });

  it('allows only the newest replay after concurrent sample loads', async () => {
    vi.stubGlobal('AudioContext', Context);
    let release!: () => void;
    vi.mocked(SampleBank.prototype.prepare).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const engine = new AudioEngine();
    const first = engine.play(plan);
    Context.current.finishResume();
    await vi.waitFor(() => expect(typeof release).toBe('function'));
    const finishFirst = release;
    const second = engine.play(plan);
    await vi.waitFor(() => expect(release).not.toBe(finishFirst));
    finishFirst();
    await expect(first).resolves.toBe(false);
    expect(Context.current.sources).toHaveLength(0);
    release();
    await vi.waitFor(() => expect(Context.current.sources).toHaveLength(2));
    engine.stop();
    await expect(second).resolves.toBe(false);
  });
  it('does not play or log a canceled request after delayed audio permission resolves', async () => {
    vi.stubGlobal('AudioContext', Context);
    const engine = new AudioEngine(vi.fn());
    const started = vi.fn();
    const playing = engine.play(plan, started);
    engine.stop();
    Context.current.finishResume();
    await expect(playing).resolves.toBe(false);
    expect(Context.current.sources).toHaveLength(0);
    expect(started).not.toHaveBeenCalled();
  });

  describe('coach audio output', () => {
    class Player {
      id = '';
      src = '';
      currentSrc = '';
      srcObject: unknown = null;
      autoplay = false;
      hidden = false;
      muted = false;
      volume = 1;
      play = vi.fn<() => Promise<void>>(async () => undefined);
      pause = vi.fn();
      setAttribute = vi.fn();
      removeAttribute = vi.fn();
      setSinkId = vi.fn(async (_id: string) => undefined);
    }

    it('does not wait for a silent media clip before there is a remote stream', async () => {
      const player = new Player();
      player.play.mockImplementation(() => new Promise(() => undefined));
      vi.stubGlobal('document', { createElement: () => player, body: { appendChild: vi.fn() } });
      const engine = new AudioEngine(vi.fn());
      await engine.enableVoiceOutput();
      expect(player.play).not.toHaveBeenCalled();
      expect(player.src).toBe('');
    });

    it('routes piano and coach to the same selected device and rolls back a failed output change', async () => {
      const player = new Player();
      vi.stubGlobal('AudioContext', Context);
      vi.stubGlobal('HTMLMediaElement', Player);
      vi.stubGlobal('document', { createElement: () => player, body: { appendChild: vi.fn() } });
      const engine = new AudioEngine(vi.fn());
      const unlocked = engine.unlock();
      Context.current.finishResume();
      await unlocked;
      await engine.setOutputDevice('headset');
      expect(player.setSinkId).toHaveBeenCalledWith('headset');
      expect(Context.current.setSinkId).toHaveBeenCalledWith('headset');
      Context.current.setSinkId.mockRejectedValueOnce(new Error('Output device was removed.'));
      await expect(engine.setOutputDevice('missing-speaker')).rejects.toThrow(
        'Output device was removed.',
      );
      expect(player.setSinkId).toHaveBeenLastCalledWith('headset');
    });

    it('uses the same volume for remote speech and instrument output', async () => {
      const player = new Player();
      vi.stubGlobal('AudioContext', Context);
      vi.stubGlobal('HTMLMediaElement', Player);
      vi.stubGlobal('MediaStream', class {});
      vi.stubGlobal('document', { createElement: () => player, body: { appendChild: vi.fn() } });
      const blocked = vi.fn();
      const engine = new AudioEngine(blocked);
      const unlocked = engine.unlock();
      Context.current.finishResume();
      await unlocked;
      engine.setVolume(0.4);
      const stream = new MediaStream();
      await engine.attachVoice(stream);
      expect(player.srcObject).toBe(stream);
      expect(player.autoplay).toBe(true);
      expect(player.muted).toBe(false);
      expect(player.volume).toBe(0.4);
      engine.setVolume(0.6);
      expect(player.volume).toBe(0.6);
      expect(Context.current.gains[0]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(
        0.6,
        Context.current.currentTime,
        0.025,
      );
      engine.setVolume(0);
      expect(player.volume).toBe(0);
      expect(Context.current.gains[0]!.gain.setTargetAtTime).toHaveBeenLastCalledWith(
        0,
        Context.current.currentTime,
        0.025,
      );
      expect(player.play).toHaveBeenCalledOnce();
      expect(blocked).not.toHaveBeenCalled();
      engine.detachVoice();
      expect(player.pause).toHaveBeenCalled();
      expect(player.srcObject).toBeNull();
    });

    it('keeps tutor and instrument on the last chosen speaker when sink changes resolve out of order', async () => {
      const player = new Player();
      vi.stubGlobal('AudioContext', Context);
      vi.stubGlobal('HTMLMediaElement', Player);
      vi.stubGlobal('document', { createElement: () => player, body: { appendChild: vi.fn() } });
      const engine = new AudioEngine();
      const unlocked = engine.unlock();
      Context.current.finishResume();
      await unlocked;
      let release!: () => void;
      player.setSinkId.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(undefined);
          }),
      );
      const first = engine.setOutputDevice('first-speaker');
      await vi.waitFor(() => expect(release).toBeDefined());
      const last = engine.setOutputDevice('last-speaker');
      await new Promise<void>((resolve) => setImmediate(resolve));
      release();
      await Promise.all([first, last]);
      expect(player.setSinkId).toHaveBeenLastCalledWith('last-speaker');
      expect(Context.current.setSinkId).toHaveBeenLastCalledWith('last-speaker');
    });

    it('surfaces blocked speech playback instead of presenting silent captions as success', async () => {
      const player = new Player();
      player.play.mockRejectedValueOnce(new DOMException('Blocked', 'NotAllowedError'));
      vi.stubGlobal('AudioContext', Context);
      vi.stubGlobal('HTMLMediaElement', Player);
      vi.stubGlobal('MediaStream', class {});
      vi.stubGlobal('document', { createElement: () => player, body: { appendChild: vi.fn() } });
      const blocked = vi.fn();
      const engine = new AudioEngine(blocked);
      const unlocked = engine.unlock();
      Context.current.finishResume();
      await unlocked;
      await engine.attachVoice(new MediaStream());
      expect(blocked).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('Retry audio') }),
      );
      engine.setVolume(0.4);
      await engine.enableVoiceOutput();
      expect(player.volume).toBe(0.4);
      expect(player.play).toHaveBeenCalledTimes(2);
    });

    it('does not mistake delayed remote audio for an autoplay failure', async () => {
      vi.useFakeTimers();
      try {
        const player = new Player();
        let begin!: () => void;
        player.play.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              begin = resolve;
            }),
        );
        vi.stubGlobal('AudioContext', Context);
        vi.stubGlobal('MediaStream', class {});
        vi.stubGlobal('document', { createElement: () => player, body: { appendChild: vi.fn() } });
        const blocked = vi.fn();
        const engine = new AudioEngine(blocked);
        const unlocked = engine.unlock();
        Context.current.finishResume();
        await unlocked;
        const attached = engine.attachVoice(new MediaStream());
        await vi.advanceTimersByTimeAsync(10_000);
        expect(blocked).not.toHaveBeenCalled();
        begin();
        await attached;
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('schedules notes in audio time and resolves from the audio node ending', async () => {
    vi.stubGlobal('AudioContext', Context);
    const engine = new AudioEngine(vi.fn());
    const started = vi.fn();
    const playing = engine.play(plan, started);
    Context.current.finishResume();
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    const sample = Context.current.sources[0]!;
    expect(sample.playbackRate.value).toBe(1);
    expect(sample.start).toHaveBeenCalledWith(5.28);
    const sentinel = Context.current.sources[Context.current.sources.length - 1]!;
    sentinel.onended!();
    await expect(playing).resolves.toBe(true);
    expect(sample.disconnect).toHaveBeenCalled();
  });

  it('gives the most recent playback exclusive ownership of pending audio', async () => {
    vi.stubGlobal('AudioContext', Context);
    const engine = new AudioEngine(vi.fn());
    const firstStarted = vi.fn();
    const secondStarted = vi.fn();
    const first = engine.play(plan, firstStarted);
    const second = engine.play(plan, secondStarted);
    Context.current.finishResume();
    await expect(first).resolves.toBe(false);
    await vi.waitFor(() => expect(secondStarted).toHaveBeenCalledOnce());
    expect(firstStarted).not.toHaveBeenCalled();
    engine.stop();
    await expect(second).resolves.toBe(false);
  });

  it('reports a stalled browser audio resume instead of waiting indefinitely', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('AudioContext', Context);
      const engine = new AudioEngine(vi.fn());
      const resumed = expect(engine.unlock()).rejects.toThrow('Audio could not start');
      await vi.advanceTimersByTimeAsync(5000);
      await resumed;
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets instrument-preview notes overlap and cancels pending notes on exit', async () => {
    vi.stubGlobal('AudioContext', Context);
    const engine = new AudioEngine();
    const unlocked = engine.unlock();
    Context.current.finishResume();
    await unlocked;
    await engine.previewNote(60, 'piano');
    await engine.previewNote(64, 'piano');
    expect(Context.current.sources).toHaveLength(2);
    expect(Context.current.sources[0]?.disconnect).not.toHaveBeenCalled();
    let resolve!: () => void;
    vi.mocked(SampleBank.prototype.prepare).mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const late = engine.previewNote(40, 'guitar');
    await vi.waitFor(() => expect(resolve).toBeDefined());
    engine.stop();
    resolve();
    await late;
    expect(Context.current.sources).toHaveLength(2);
    expect(Context.current.sources.every((source) => source.disconnect.mock.calls.length > 0)).toBe(
      true,
    );
  });
});
