import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { instrumentSamples, sampleFor } from '../frontend/audio/samples.js';

describe('locally bundled acoustic instruments', () => {
  it.each(['piano', 'guitar'] as const)(
    '%s has unchanged licensed samples and pinned provenance',
    (instrument) => {
      const directory = resolve('frontend', 'public', 'audio', instrument);
      const manifest: {
        revision: string;
        license: string;
        author: string;
        samples: Array<{ file: string; bytes: number; sha256: string }>;
      } = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
      expect(manifest.revision).toHaveLength(40);
      expect(manifest.license).toBe('CC-BY-3.0');
      expect(manifest.samples).toHaveLength(instrumentSamples[instrument].length);
      for (const sample of manifest.samples) {
        const bytes = readFileSync(resolve(directory, sample.file));
        expect(bytes.length).toBe(sample.bytes);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(sample.sha256);
      }
      const attribution = readFileSync(resolve(directory, 'LICENSE.txt'), 'utf8');
      expect(attribution).toContain(
        instrument === 'piano' ? 'Alexander Holm' : 'Nicholaus P. Brosowsky',
      );
      expect(attribution).toContain('creativecommons.org/licenses/by/3.0');
    },
  );

  it('uses close-pitched samples throughout each recorded register', () => {
    for (let midi = 36; midi <= 100; midi++)
      expect(Math.abs(midi - sampleFor('piano', midi).midi)).toBeLessThanOrEqual(1);
    for (let midi = 40; midi <= 74; midi++)
      expect(Math.abs(midi - sampleFor('guitar', midi).midi)).toBeLessThanOrEqual(1);
  });

  describe('locally bundled typography', () => {
    it('uses the selected pinned font with intact provenance and its OFL license', () => {
      const directory = resolve('frontend', 'public', 'fonts', 'instrument-sans');
      const manifest: { version: string; bytes: number; sha256: string; license: string } =
        JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
      expect(manifest.version).toBe('5.3.0');
      expect(manifest.license).toBe('SIL-OFL-1.1');
      const bytes = readFileSync(
        resolve(
          'node_modules',
          '@fontsource-variable',
          'instrument-sans',
          'files',
          'instrument-sans-latin-wght-normal.woff2',
        ),
      );
      expect(bytes.length).toBe(manifest.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(manifest.sha256);
      expect(readFileSync(resolve(directory, 'LICENSE.txt'), 'utf8')).toContain(
        'SIL OPEN FONT LICENSE',
      );
    });
  });
});
