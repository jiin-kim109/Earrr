import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const revision = '622c2f1c32c8cfce4158ddc3eb26e518ddef37e5';
const base = `https://raw.githubusercontent.com/nbrosowsky/tonejs-instruments/${revision}`;
const directory = join('frontend', 'public', 'audio', 'guitar');
const pitches = [38, 40, 41, 44, 47, 50, 53, 56, 59, 62, 65, 68, 71, 74];
const names = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'];
await mkdir(directory, { recursive: true });
const samples = [];
for (let offset = 0; offset < pitches.length; offset += 4) {
  samples.push(
    ...(await Promise.all(
      pitches.slice(offset, offset + 4).map(async (midi) => {
        const file = `${names[midi % 12]}${Math.floor(midi / 12) - 1}.mp3`;
        const response = await fetch(`${base}/samples/guitar-acoustic/${file}`, {
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Guitar sample ${file}: HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length < 10_000) throw new Error(`Guitar sample ${file} was unexpectedly small.`);
        await writeFile(join(directory, file), bytes);
        return {
          midi,
          file,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        };
      }),
    )),
  );
}
const license = await fetch(`${base}/LICENSE.md`);
if (!license.ok) throw new Error('The sample license could not be retrieved.');
await writeFile(
  join(directory, 'LICENSE.txt'),
  [
    'Acoustic guitar samples from the University of Iowa Musical Instrument Samples.',
    'Distributed by Nicholaus P. Brosowsky in tonejs-instruments.',
    `Source revision: ${revision}`,
    `${base}/samples/guitar-acoustic`,
    `${base}/sample-source-info.txt`,
    'Sample license: Creative Commons Attribution 3.0.',
    'https://creativecommons.org/licenses/by/3.0/',
    'Original MP3 files are bundled unchanged. Playback may transpose and normalize their level.',
    '',
    await license.text(),
  ].join('\n'),
);
await writeFile(
  join(directory, 'manifest.json'),
  JSON.stringify(
    {
      revision,
      source: `${base}/samples/guitar-acoustic`,
      license: 'CC-BY-3.0',
      author: 'University of Iowa; distributed by Nicholaus P. Brosowsky',
      samples,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `Saved ${samples.length} licensed guitar samples (${samples.reduce((sum, sample) => sum + sample.bytes, 0)} bytes).`,
);
