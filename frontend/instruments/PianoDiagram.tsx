import type { PlayedExample } from '../../server/types/exercise.types.js';

export function PianoDiagram({
  example,
  exampleId,
}: {
  example: PlayedExample;
  exampleId: string;
}) {
  const midi = [...new Set(example.midi)];
  if (!midi.length)
    return (
      <p role="alert" className="text-sm text-destructive">
        The example's notes could not be displayed.
      </p>
    );
  const isBlack = (note: number) => [1, 3, 6, 8, 10].includes(note % 12);
  const lowest = Math.min(...midi);
  const highest = Math.max(...midi);
  const span = Math.max(12, highest - lowest + 4);
  let first = Math.floor((lowest + highest - span) / 2);
  while (isBlack(first)) first--;
  let last = Math.max(highest + 1, first + span);
  while (isBlack(last)) last++;
  const pitches = Array.from({ length: last - first + 1 }, (_, index) => first + index);
  const width = 360 / pitches.filter((note) => !isBlack(note)).length;
  const labels = new Map(
    example.midi.map((note, index) => [
      note,
      example.notes[index]!.replace(/-?\d+$/, '')
        .replaceAll('#', '♯')
        .replaceAll('b', '♭'),
    ]),
  );
  let white = 0;
  const keys = pitches.map((note) => {
    const black = isBlack(note);
    const x = black ? 10 + white * width - width * 0.3 : 10 + white++ * width;
    return { note, black, x, width: black ? width * 0.6 : width - 1.5, pressed: labels.has(note) };
  });
  return (
    <div
      key={exampleId}
      data-testid="piano-diagram"
      data-example-id={exampleId}
      role="img"
      aria-label={`Played notes: ${example.notes.join(', ')}`}
      className="aspect-[380/134] max-h-full w-full max-w-[420px] motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-2 motion-safe:duration-300"
    >
      <svg viewBox="0 0 380 134" className="block size-full" aria-hidden="true">
        <rect x="3" y="6" width="374" height="125" rx="13" className="fill-foreground/8" />
        <rect x="3" y="2" width="374" height="122" rx="12" className="fill-muted stroke-border" />
        {keys
          .filter((key) => !key.black)
          .map((key) => (
            <g key={key.note} data-note-midi={key.pressed ? key.note : undefined}>
              <rect
                x={key.x}
                y={key.pressed ? 13 : 9}
                width={key.width}
                height={key.pressed ? 104 : 108}
                rx="3"
                className={
                  key.pressed ? 'fill-brand/15 stroke-brand/40' : 'fill-card stroke-border'
                }
                strokeWidth=".8"
              />
              {key.pressed && (
                <text
                  x={key.x + key.width / 2}
                  y="101"
                  textAnchor="middle"
                  className="fill-brand"
                  fontSize={Math.min(14, key.width * 0.6)}
                  fontWeight="650"
                >
                  {labels.get(key.note)}
                </text>
              )}
            </g>
          ))}
        {keys
          .filter((key) => key.black)
          .map((key) => (
            <g key={key.note} data-note-midi={key.pressed ? key.note : undefined}>
              <rect
                x={key.x + 1}
                y="10"
                width={key.width}
                height="66"
                rx="3"
                className="fill-foreground/20"
              />
              <rect
                x={key.x}
                y={key.pressed ? 10 : 7}
                width={key.width}
                height="65"
                rx="3"
                className={key.pressed ? 'fill-brand' : 'fill-foreground'}
              />
              {key.pressed && (
                <text
                  x={key.x + key.width / 2}
                  y="58"
                  textAnchor="middle"
                  className="fill-primary-foreground"
                  fontSize={Math.min(12, key.width * 0.7)}
                  fontWeight="650"
                >
                  {labels.get(key.note)}
                </text>
              )}
            </g>
          ))}
      </svg>
    </div>
  );
}
