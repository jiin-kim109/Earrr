import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const revision = 'efd8296360f9526e379bfbe5c1698ff54d6a1d34';
const base = `https://raw.githubusercontent.com/Tonejs/audio/${revision}/salamander`;
const directory = join('frontend', 'public', 'audio', 'piano');
const notes = Array.from({ length: 22 }, (_, index) => {
  const midi = 36 + index * 3;
  return `${['C', 'Ds', 'Fs', 'A'][index % 4]}${Math.floor(midi / 12) - 1}`;
});
await mkdir(directory, { recursive: true });
const checksums = [];
for (let offset = 0; offset < notes.length; offset += 6) {
  const batch = await Promise.all(
    notes.slice(offset, offset + 6).map(async (note) => {
      const response = await fetch(`${base}/${note}.mp3`, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`Piano sample ${note}: HTTP ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 10_000) throw new Error(`Piano sample ${note} was unexpectedly small.`);
      await writeFile(join(directory, `${note}.mp3`), bytes);
      return {
        file: `${note}.mp3`,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    }),
  );
  checksums.push(...batch);
}
await writeFile(
  join(directory, 'manifest.json'),
  JSON.stringify(
    { revision, source: base, license: 'CC-BY-3.0', author: 'Alexander Holm', samples: checksums },
    null,
    2,
  ) + '\n',
);
console.log(
  `Saved ${checksums.length} licensed acoustic piano samples (${checksums.reduce((sum, file) => sum + file.bytes, 0)} bytes).`,
);
