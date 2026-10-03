import { useEffect, useState, useSyncExternalStore } from 'react';
import type {
  MusicalDiagram,
  PlayedExample,
  QuestionDisplay,
} from '../../server/types/exercise.types.js';
import { PianoDiagram } from '@/instruments/PianoDiagram';
import { studio } from '@/studio/studio';

const musicText = (text: string) => text.replaceAll('#', '♯').replaceAll('b', '♭');
const xAt = (index: number, count: number) =>
  count === 1 ? 210 : 34 + (index * 352) / (count - 1);
function subscribeShortDisplay(update: () => void) {
  window.addEventListener('resize', update);
  window.visualViewport?.addEventListener('resize', update);
  return () => {
    window.removeEventListener('resize', update);
    window.visualViewport?.removeEventListener('resize', update);
  };
}
export function useShortDisplay() {
  return useSyncExternalStore(
    subscribeShortDisplay,
    () => Math.min(window.innerHeight, window.visualViewport?.height ?? window.innerHeight) <= 640,
    () => false,
  );
}

function TonalPath({
  diagram,
  dense,
}: {
  diagram: Extract<MusicalDiagram, { kind: 'melody' | 'scale' }>;
  dense: boolean;
}) {
  const low = Math.min(...diagram.points.map((point) => point.midi));
  const span = Math.max(1, Math.max(...diagram.points.map((point) => point.midi)) - low);
  const points = diagram.points.map((point, index) => ({
    ...point,
    x: xAt(index, diagram.points.length),
    y: dense ? 60 - (25 * (point.midi - low)) / span : 101 - (52 * (point.midi - low)) / span,
  }));
  return (
    <>
      <text x="14" y={dense ? 13 : 18} fontSize="12" className="fill-muted-foreground">
        {diagram.tonic}
      </text>
      <polyline
        points={points.map((point) => `${point.x},${point.y}`).join(' ')}
        fill="none"
        className="stroke-border"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      {points.map((point, index) => {
        const focused = diagram.targetIndex === undefined || index === diagram.targetIndex;
        return (
          <g key={index} data-note-midi={point.midi} data-musical-label={point.label}>
            <circle
              cx={point.x}
              cy={point.y}
              r={diagram.kind === 'melody' ? 14 : dense ? 4 : 6}
              className={focused ? 'fill-brand/12 stroke-brand/50' : 'fill-muted stroke-border'}
            />
            <text
              x={point.x}
              y={diagram.kind === 'melody' ? point.y + 5 : point.y - (dense ? 10 : 14)}
              textAnchor="middle"
              fontSize={diagram.kind === 'melody' ? 17 : 14}
              fontWeight="550"
              className={focused ? 'fill-brand' : 'fill-muted-foreground'}
            >
              {musicText(point.label)}
            </text>
            {!dense && (
              <text
                x={point.x}
                y="142"
                textAnchor="middle"
                fontSize="12"
                className="fill-muted-foreground"
              >
                {musicText(point.note.replace(/-?\d+$/, ''))}
              </text>
            )}
            {!dense && diagram.kind === 'scale' && index < points.length - 1 && (
              <text
                x={(point.x + points[index + 1]!.x) / 2}
                y={(point.y + points[index + 1]!.y) / 2 + 21}
                textAnchor="middle"
                fontSize="11"
                className={diagram.gaps?.[index] === 1 ? 'fill-brand' : 'fill-muted-foreground'}
              >
                {diagram.gaps?.[index]}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

function Progression({
  diagram,
  dense,
}: {
  diagram: Extract<MusicalDiagram, { kind: 'progression' }>;
  dense: boolean;
}) {
  const notes = diagram.chords.flatMap((chord) => chord.midi);
  const low = Math.min(...notes);
  const span = Math.max(12, Math.max(...notes) - low);
  return (
    <>
      <text x="14" y="16" fontSize="12" className="fill-muted-foreground">
        {diagram.tonic}
      </text>
      {(dense ? [46, 56, 66] : [66, 84, 102]).map((y) => (
        <line key={y} x1="14" x2="406" y1={y} y2={y} className="stroke-border/60" />
      ))}
      {diagram.chords.map((chord, index) => {
        const x = 210 + (index - (diagram.chords.length - 1) / 2) * (376 / diagram.chords.length);
        const selected = index === diagram.targetIndex;
        return (
          <g key={index} data-chord-function={chord.function} data-chord-symbol={chord.symbol}>
            {selected && (
              <rect
                x={x - 32}
                y={dense ? 22 : 27}
                width="64"
                height={dense ? 66 : 119}
                rx="13"
                className="fill-brand/5 stroke-brand/25"
              />
            )}
            <text
              x={x}
              y={dense ? 36 : 43}
              textAnchor="middle"
              fontSize="17"
              fontWeight="550"
              className="fill-foreground"
            >
              {musicText(chord.symbol)}
            </text>
            {chord.midi.map((midi, note) => (
              <ellipse
                key={note}
                cx={x}
                cy={dense ? 64 - note * 5 : 108 - ((midi - low) / span) * 48}
                rx="5.5"
                ry={dense ? 2 : 4}
                className="fill-brand/65"
                data-note-midi={midi}
              />
            ))}
            <text
              x={x}
              y={dense ? 84 : 136}
              textAnchor="middle"
              fontSize="15"
              className={selected ? 'fill-brand' : 'fill-muted-foreground'}
            >
              {chord.function}
            </text>
          </g>
        );
      })}
    </>
  );
}

function Chord({
  diagram,
  dense,
}: {
  diagram: Extract<MusicalDiagram, { kind: 'chord' }>;
  dense: boolean;
}) {
  const low = Math.min(...diagram.tones.map((tone) => tone.midi));
  const span = Math.max(12, Math.max(...diagram.tones.map((tone) => tone.midi)) - low);
  return (
    <>
      <text x="14" y="17" fontSize="12" className="fill-muted-foreground">
        Root {musicText(diagram.root)}
      </text>
      {(dense ? [45, 55, 65] : [65, 84, 103]).map((y) => (
        <line key={y} x1="14" x2="406" y1={y} y2={y} className="stroke-border/60" />
      ))}
      {diagram.tones.map((tone, index) => {
        const x = xAt(index, diagram.tones.length);
        const y = dense
          ? 62 - ((tone.midi - low) / span) * 17
          : 104 - ((tone.midi - low) / span) * 43;
        return (
          <g key={`${tone.midi}:${index}`} data-note-midi={tone.midi} data-chord-tone={tone.degree}>
            <text
              x={x}
              y={dense ? 34 : 41}
              textAnchor="middle"
              fontSize="18"
              fontWeight="550"
              className={tone.color ? 'fill-brand' : 'fill-muted-foreground'}
            >
              {musicText(tone.degree)}
            </text>
            {tone.color && <circle cx={x} cy={y} r={dense ? 10 : 15} className="fill-brand/8" />}
            <ellipse
              cx={x}
              cy={y}
              rx="6"
              ry="4.5"
              className={tone.color ? 'fill-brand' : 'fill-muted-foreground/75'}
            />
            <text
              x={x}
              y={dense ? 86 : 137}
              textAnchor="middle"
              fontSize="13"
              className="fill-muted-foreground"
            >
              {musicText(tone.note.replace(/-?\d+$/, ''))}
            </text>
          </g>
        );
      })}
    </>
  );
}

function DegreeRail({
  degree,
  note,
  tonic,
  dense = false,
}: {
  degree?: number;
  note?: string;
  tonic: string;
  dense?: boolean;
}) {
  const y = dense ? 43 : 77;
  return (
    <>
      <text x="14" y={dense ? 14 : 22} fontSize="12" className="fill-muted-foreground">
        {tonic}
      </text>
      <line x1="34" x2="386" y1={y} y2={y} className="stroke-border" strokeWidth="2" />
      {Array.from({ length: 7 }, (_, index) => (
        <g key={index} data-scale-degree={index + 1} data-selected={degree === index + 1}>
          <circle
            cx={xAt(index, 7)}
            cy={y}
            r="17"
            className={degree === index + 1 ? 'fill-brand stroke-brand' : 'fill-card stroke-border'}
          />
          <text
            x={xAt(index, 7)}
            y={y + 6}
            textAnchor="middle"
            fontSize="18"
            fontWeight="550"
            className={degree === index + 1 ? 'fill-primary-foreground' : 'fill-muted-foreground'}
          >
            {index + 1}
          </text>
        </g>
      ))}
      {degree !== undefined && note && (
        <text
          x={xAt(degree - 1, 7)}
          y={dense ? 82 : 125}
          textAnchor="middle"
          fontSize="14"
          className="fill-brand"
        >
          {musicText(note)}
        </text>
      )}
    </>
  );
}

export function MusicalDisplay({
  example,
  exampleId,
  dense = false,
}: {
  example: PlayedExample;
  exampleId: string;
  dense?: boolean;
}) {
  const diagram = example.diagram;
  if (!diagram) return <PianoDiagram example={example} exampleId={exampleId} />;
  return (
    <div
      data-testid="musical-diagram"
      data-diagram-kind={diagram.kind}
      data-example-id={exampleId}
      role="img"
      aria-label={`Played ${diagram.kind}: ${
        diagram.kind === 'progression'
          ? diagram.chords.map((chord) => `${chord.symbol}, ${chord.function}`).join('; ')
          : diagram.kind === 'chord'
            ? `${diagram.symbol}; ${diagram.tones.map((tone) => `${tone.degree}, ${tone.note}`).join('; ')}`
            : diagram.kind === 'degree'
              ? `${diagram.tonic}, degree ${diagram.degree}, ${diagram.note}`
              : diagram.points.map((point) => `${point.label}, ${point.note}`).join('; ')
      }`}
      className="h-full w-full max-w-[430px] motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
    >
      <svg
        viewBox={dense ? '0 0 420 90' : '0 0 420 156'}
        className="block size-full"
        aria-hidden="true"
      >
        {diagram.kind === 'chord' ? (
          <Chord diagram={diagram} dense={dense} />
        ) : diagram.kind === 'progression' ? (
          <Progression diagram={diagram} dense={dense} />
        ) : diagram.kind === 'degree' ? (
          <DegreeRail {...diagram} dense={dense} />
        ) : (
          <TonalPath diagram={diagram} dense={dense} />
        )}
      </svg>
    </div>
  );
}

export function QuestionGraphic({
  question,
  playing = false,
  dense = false,
}: {
  question: QuestionDisplay;
  playing?: boolean;
  dense?: boolean;
}) {
  const [active, setActive] = useState(-1);
  const onsets = question.kind === 'degree' ? null : question.onsets;
  useEffect(() => {
    setActive(-1);
    if (!playing || !onsets) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const tick = () => {
      const elapsed = studio.audio.playbackTime();
      setActive(
        elapsed === null
          ? -1
          : onsets.reduce((position, at, index) => (elapsed >= at ? index : position), -1),
      );
      frame = requestAnimationFrame(tick);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      if (reduced.matches) setActive(-1);
      else tick();
    };
    update();
    reduced.addEventListener('change', update);
    return () => {
      cancelAnimationFrame(frame);
      reduced.removeEventListener('change', update);
    };
  }, [playing, onsets]);
  return (
    <div
      data-testid="question-diagram"
      data-question-kind={question.kind}
      data-active-position={playing ? active : -1}
      role="img"
      aria-label={
        question.kind === 'sequence'
          ? `${question.tonic}. ${question.instruction}: ${question.labels.map((label, index) => label ?? `unknown ${index + 1}`).join(', ')}.`
          : question.kind === 'comparison'
            ? `${question.reference}, then an unknown ${question.subject}. ${question.instruction}.`
            : `${question.tonic}. Find degree one to seven.`
      }
      className="h-full w-full max-w-[430px]"
    >
      <svg
        viewBox={dense ? '0 0 420 90' : '0 0 420 156'}
        className="block size-full"
        aria-hidden="true"
      >
        {question.kind === 'degree' ? (
          <DegreeRail tonic={question.tonic} dense={dense} />
        ) : question.kind === 'comparison' ? (
          <>
            <text
              x="107"
              y={dense ? 20 : 42}
              textAnchor="middle"
              fontSize="12"
              className="fill-muted-foreground"
            >
              Reference
            </text>
            <text
              x="313"
              y={dense ? 20 : 42}
              textAnchor="middle"
              fontSize="12"
              className="fill-muted-foreground"
            >
              Second
            </text>
            <text
              x="107"
              y={dense ? 58 : 92}
              textAnchor="middle"
              fontSize="24"
              fontWeight="550"
              className={playing && active === 0 ? 'fill-brand' : 'fill-foreground'}
            >
              {musicText(question.reference)}
            </text>
            <path
              d={dense ? 'M187 48h44m-6-5 6 5-6 5' : 'M187 82h44m-6-5 6 5-6 5'}
              fill="none"
              className="stroke-muted-foreground/60"
              strokeWidth="1.5"
            />
            <rect
              x="281"
              y={dense ? 26 : 56}
              width="64"
              height={dense ? 44 : 56}
              rx="13"
              className={
                playing && active === 1
                  ? 'fill-brand/12 stroke-brand'
                  : 'fill-brand/5 stroke-brand/35'
              }
              strokeDasharray="3 4"
            />
            <text
              x="313"
              y={dense ? 59 : 93}
              textAnchor="middle"
              fontSize="30"
              className="fill-brand"
            >
              ?
            </text>
          </>
        ) : (
          <>
            <text x="14" y={dense ? 14 : 22} fontSize="12" className="fill-muted-foreground">
              {question.tonic}
            </text>
            <line
              x1="24"
              x2="396"
              y1={dense ? 48 : 80}
              y2={dense ? 48 : 80}
              className="stroke-border"
            />
            {question.labels.map((label, index) => {
              const x =
                210 + (index - (question.labels.length - 1) / 2) * (376 / question.labels.length);
              const target = question.targetIndex === undefined || question.targetIndex === index;
              return (
                <g
                  key={index}
                  data-question-position={index}
                  data-masked={label === null}
                  data-active={playing && active === index}
                >
                  <rect
                    x={x - 28}
                    y={dense ? 26 : 53}
                    width="56"
                    height={dense ? 44 : 54}
                    rx="13"
                    className={
                      playing && active === index
                        ? 'fill-brand/8 stroke-brand'
                        : target
                          ? 'fill-card stroke-brand/40'
                          : 'fill-card stroke-border'
                    }
                    strokeDasharray={target ? '3 4' : undefined}
                  />
                  <text
                    x={x}
                    y={dense ? 56 : 88}
                    textAnchor="middle"
                    fontSize="24"
                    fontWeight="500"
                    className={target ? 'fill-brand' : 'fill-foreground'}
                  >
                    {label ?? '?'}
                  </text>
                  <text
                    x={x}
                    y={dense ? 85 : 133}
                    textAnchor="middle"
                    fontSize="11"
                    className="fill-muted-foreground"
                  >
                    {index + 1}
                  </text>
                </g>
              );
            })}
          </>
        )}
      </svg>
    </div>
  );
}
