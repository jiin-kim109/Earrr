import type { Instrument } from '../../shared/types/course.js';

interface Sample {
  midi: number;
  url: string;
}

const fileNames = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'];
function sample(instrument: Instrument, midi: number): Sample {
  return {
    midi,
    url: `/audio/${instrument}/${fileNames[midi % 12]}${Math.floor(midi / 12) - 1}.mp3`,
  };
}

export const instrumentSamples: Record<Instrument, Sample[]> = {
  piano: Array.from({ length: 22 }, (_, index) => sample('piano', 36 + index * 3)),
  guitar: [38, 40, 41, 44, 47, 50, 53, 56, 59, 62, 65, 68, 71, 74].map((midi) =>
    sample('guitar', midi),
  ),
};

export function sampleFor(instrument: Instrument, midi: number): Sample {
  return instrumentSamples[instrument].reduce((nearest, candidate) =>
    Math.abs(candidate.midi - midi) < Math.abs(nearest.midi - midi) ? candidate : nearest,
  );
}

export class SampleBank {
  private readonly buffers = new Map<string, { buffer: AudioBuffer; peak: number }>();
  private readonly pending = new Map<string, Promise<void>>();

  async prepare(context: BaseAudioContext, instrument: Instrument, notes: number[]) {
    await Promise.all(
      [...new Set(notes.map((midi) => sampleFor(instrument, midi).midi))].map(async (midi) => {
        const key = `${instrument}:${midi}`;
        if (this.buffers.has(key)) return;
        const existing = this.pending.get(key);
        if (existing) return existing;
        const loading = (async () => {
          const response = await fetch(sampleFor(instrument, midi).url, {
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok)
            throw new Error(
              `${instrument === 'piano' ? 'Piano' : 'Guitar'} sample could not load (${response.status}). Retry the note.`,
            );
          const buffer = await context.decodeAudioData(await response.arrayBuffer());
          let peak = 0;
          for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            for (const value of buffer.getChannelData(channel))
              peak = Math.max(peak, Math.abs(value));
          }
          if (peak < 0.0001) throw new Error('The instrument sample contains no audible sound.');
          this.buffers.set(key, { buffer, peak });
        })();
        this.pending.set(key, loading);
        try {
          await loading;
        } finally {
          this.pending.delete(key);
        }
      }),
    );
  }

  get(instrument: Instrument, midi: number) {
    const sample = sampleFor(instrument, midi);
    const loaded = this.buffers.get(`${instrument}:${sample.midi}`);
    if (!loaded) throw new Error('The instrument is not ready to play.');
    return { ...loaded, playbackRate: 2 ** ((midi - sample.midi) / 12) };
  }
}
