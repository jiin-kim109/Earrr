import type { AudioPlan, Instrument, NoteEvent } from '../../shared/types/course.js';
import { SampleBank } from './samples.js';

function canSetAudioSink(
  context: AudioContext,
): context is AudioContext & { setSinkId(id: string): Promise<void> } {
  return 'setSinkId' in context && typeof context.setSinkId === 'function';
}

async function audioDeadline<T>(operation: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface ScheduledNote {
  source: AudioBufferSourceNode;
  envelope: GainNode;
  startsAt: number;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  private voiceElement: HTMLAudioElement | null = null;
  private voiceAnalyser: AnalyserNode | null = null;
  private meterSink: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private microphoneAnalyser: AnalyserNode | null = null;
  private voiceSource: MediaStreamAudioSourceNode | null = null;
  private microphoneSource: MediaStreamAudioSourceNode | null = null;
  private readonly notes = new Set<ScheduledNote>();
  private sentinel: AudioBufferSourceNode | null = null;
  private completion: ((completed: boolean) => void) | null = null;
  private volume = 0.8;
  private voiceVolume = 0.8;
  private readonly samples = new Float32Array(256);
  private generation = 0;
  private voiceGeneration = 0;
  private outputDevice = '';
  private playbackStartedAt: number | null = null;
  private readonly bank = new SampleBank();

  constructor(private readonly onVoiceError: (error: Error) => void = () => undefined) {}

  private player(): HTMLAudioElement {
    if (!this.voiceElement) {
      const element = document.createElement('audio');
      element.id = 'earrr-coach-audio';
      element.autoplay = true;
      element.setAttribute('playsinline', '');
      element.hidden = true;
      element.volume = this.voiceVolume;
      document.body.appendChild(element);
      this.voiceElement = element;
    }
    return this.voiceElement;
  }

  async enableVoiceOutput() {
    const element = this.player();
    if (element.srcObject) await this.playVoice(element);
  }

  private async playVoice(element: HTMLAudioElement) {
    try {
      await element.play();
    } catch {
      throw new Error('Coach audio is blocked. Retry audio.');
    }
  }

  async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' });
      this.musicGain = this.context.createGain();
      this.musicGain.gain.value = this.volume;
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 512;
      this.musicGain.connect(this.analyser);
      this.analyser.connect(this.context.destination);
      this.meterSink = this.context.createGain();
      this.meterSink.gain.value = 0;
      this.meterSink.connect(this.context.destination);
    }
    if (this.context.state !== 'running') {
      await audioDeadline(
        this.context.resume(),
        'Audio could not start. Check your speakers and retry.',
      );
    }
    if (this.context.state !== 'running')
      throw new Error('Audio is unavailable. Check your speakers and retry.');
  }

  async resumeOnGesture() {
    if (this.context?.state === 'suspended') await this.unlock();
  }

  setVolume(volume: number) {
    this.volume = volume;
    if (this.context) this.musicGain?.gain.setTargetAtTime(volume, this.context.currentTime, 0.025);
  }

  setVoiceVolume(volume: number) {
    this.voiceVolume = volume;
    if (this.voiceElement) this.voiceElement.volume = volume;
  }

  async attachVoice(stream: MediaStream) {
    if (!this.context) throw new Error('Enable audio before connecting the coach.');
    const generation = ++this.voiceGeneration;
    const element = this.player();
    this.voiceSource?.disconnect();
    this.voiceAnalyser?.disconnect();
    element.removeAttribute('src');
    element.srcObject = stream;
    element.muted = false;
    element.volume = this.voiceVolume;
    this.voiceSource = this.context.createMediaStreamSource(stream);
    this.voiceAnalyser = this.context.createAnalyser();
    this.voiceAnalyser.fftSize = 512;
    this.voiceSource.connect(this.voiceAnalyser);
    this.voiceAnalyser.connect(this.meterSink!);
    try {
      await this.playVoice(element);
    } catch (error) {
      if (generation === this.voiceGeneration)
        this.onVoiceError(
          error instanceof Error ? error : new Error('Coach audio could not start.'),
        );
    }
  }

  attachMicrophone(stream: MediaStream | null) {
    this.microphoneSource?.disconnect();
    this.microphoneAnalyser?.disconnect();
    this.microphoneSource = null;
    this.microphoneAnalyser = null;
    if (stream && this.context) {
      this.microphoneAnalyser = this.context.createAnalyser();
      this.microphoneAnalyser.fftSize = 512;
      this.microphoneSource = this.context.createMediaStreamSource(stream);
      this.microphoneSource.connect(this.microphoneAnalyser);
      this.microphoneAnalyser.connect(this.meterSink!);
    }
  }

  detachVoice() {
    this.voiceSource?.disconnect();
    this.voiceSource = null;
    this.voiceAnalyser?.disconnect();
    this.voiceAnalyser = null;
    this.voiceGeneration++;
    if (this.voiceElement) {
      this.voiceElement.pause();
      this.voiceElement.srcObject = null;
      this.voiceElement.removeAttribute('src');
    }
    this.attachMicrophone(null);
  }

  supportsOutputSelection() {
    return 'setSinkId' in AudioContext.prototype && 'setSinkId' in HTMLMediaElement.prototype;
  }

  async setOutputDevice(id: string) {
    await this.unlock();
    const element = this.player();
    const context = this.context!;
    if (id === this.outputDevice) return;
    if (!canSetAudioSink(context) || !('setSinkId' in element)) {
      if (id) throw new Error('Use your system settings to change speakers in this browser.');
      return;
    }
    const previous = this.outputDevice;
    await audioDeadline(element.setSinkId(id), 'Speaker selection did not finish.');
    try {
      await audioDeadline(context.setSinkId(id), 'Instrument output selection did not finish.');
    } catch (error) {
      await audioDeadline(element.setSinkId(previous), 'Could not restore the previous speaker.');
      throw error;
    }
    this.outputDevice = id;
  }

  microphoneLevel(): number {
    return this.readLevel(this.microphoneAnalyser);
  }
  voiceLevel(): number {
    return this.readLevel(this.voiceAnalyser);
  }
  level(): number {
    return Math.max(this.readLevel(this.analyser), this.voiceLevel());
  }

  private readLevel(analyser: AnalyserNode | null): number {
    if (!analyser) return 0;
    analyser.getFloatTimeDomainData(this.samples);
    return Math.min(
      1,
      Math.sqrt(
        this.samples.reduce((sum, sample) => sum + sample * sample, 0) / this.samples.length,
      ) * 7,
    );
  }

  async previewNote(midi: number, instrument: Instrument) {
    const generation = this.generation;
    await this.unlock();
    if (generation !== this.generation) return;
    await this.bank.prepare(this.context!, instrument, [midi]);
    if (generation !== this.generation) return;
    if (this.notes.size >= 8) {
      const oldest = this.notes.values().next().value;
      if (oldest) this.release(oldest);
    }
    this.scheduleNote(
      { midi, at: 0, duration: 1.2, velocity: 0.65, role: 'reference' },
      instrument,
      this.context!.currentTime + 0.01,
      8,
    );
  }

  async play(plan: AudioPlan, onStarted?: () => void): Promise<boolean> {
    this.stop();
    const generation = this.generation;
    await this.unlock();
    if (generation !== this.generation) return false;
    const context = this.context!;
    await this.bank.prepare(
      context,
      plan.instrument,
      plan.events.map((note) => note.midi),
    );
    if (generation !== this.generation) return false;
    const start = context.currentTime + 0.08;
    this.playbackStartedAt = start;
    const polyphony = Math.max(
      1,
      ...plan.events.map(
        (note) =>
          plan.events.filter(
            (other) => other.at <= note.at && other.at + other.duration + 0.3 > note.at,
          ).length,
      ),
    );
    for (const note of plan.events) this.scheduleNote(note, plan.instrument, start, polyphony);

    // An audio node, rather than a UI timer, completes playback in background tabs.
    const sentinel = context.createBufferSource();
    const duration = Math.max(
      plan.duration,
      ...plan.events.map((note) => note.at + note.duration + 0.35),
    );
    sentinel.buffer = context.createBuffer(
      1,
      Math.ceil(context.sampleRate * (duration + 0.1)),
      context.sampleRate,
    );
    sentinel.connect(this.musicGain!);
    this.sentinel = sentinel;
    sentinel.start(start);
    onStarted?.();
    return new Promise<boolean>((resolve) => {
      this.completion = resolve;
      sentinel.onended = () => {
        if (generation !== this.generation) return;
        for (const note of this.notes) this.release(note);
        sentinel.disconnect();
        this.sentinel = null;
        this.playbackStartedAt = null;
        this.completion = null;
        resolve(true);
      };
    });
  }

  stop() {
    this.generation++;
    this.playbackStartedAt = null;
    for (const note of this.notes) this.release(note);
    if (this.sentinel) {
      this.sentinel.onended = null;
      this.sentinel.stop();
      this.sentinel.disconnect();
      this.sentinel = null;
    }
    this.completion?.(false);
    this.completion = null;
  }

  playbackTime(): number | null {
    return this.context && this.playbackStartedAt !== null
      ? this.context.currentTime - this.playbackStartedAt
      : null;
  }

  private release(note: ScheduledNote) {
    this.notes.delete(note);
    const now = this.context!.currentTime;
    const cleanup = () => {
      note.source.disconnect();
      note.envelope.disconnect();
    };
    if (note.startsAt > now) {
      note.source.onended = null;
      note.source.stop();
      cleanup();
      return;
    }
    const fadeEnd = now + 0.012;
    const gain = note.envelope.gain;
    if (typeof gain.cancelAndHoldAtTime === 'function') gain.cancelAndHoldAtTime(now);
    else {
      const level = gain.value;
      gain.cancelScheduledValues(now);
      gain.setValueAtTime(level, now);
    }
    gain.linearRampToValueAtTime(0, fadeEnd);
    note.source.onended = cleanup;
    note.source.stop(fadeEnd);
  }

  private scheduleNote(note: NoteEvent, instrument: Instrument, start: number, polyphony: number) {
    const context = this.context!;
    const time = start + note.at;
    const end = time + note.duration;
    const sample = this.bank.get(instrument, note.midi);
    const source = context.createBufferSource();
    const envelope = context.createGain();
    source.buffer = sample.buffer;
    source.playbackRate.value = sample.playbackRate;
    const amplitude = (0.85 * note.velocity) / (sample.peak * polyphony);
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(amplitude, time + 0.003);
    envelope.gain.setValueAtTime(amplitude, end);
    envelope.gain.exponentialRampToValueAtTime(0.00001, end + 0.28);
    envelope.gain.setValueAtTime(0, end + 0.3);
    source.connect(envelope);
    envelope.connect(this.musicGain!);
    const voice = { source, envelope, startsAt: time };
    this.notes.add(voice);
    source.onended = () => {
      source.disconnect();
      envelope.disconnect();
      this.notes.delete(voice);
    };
    source.start(time);
    source.stop(end + 0.32);
  }
}
