import { useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import { cn } from 'cn';
import type { Instrument as InstrumentName } from '../../shared/types/course.js';

interface InstrumentProps {
  instrument: InstrumentName;
  interactive?: boolean;
  onNote?: (midi: number) => void;
  className?: string;
}

const noteNames = [
  'C',
  'C sharp',
  'D',
  'D sharp',
  'E',
  'F',
  'F sharp',
  'G',
  'G sharp',
  'A',
  'A sharp',
  'B',
];
export const guitarStrings = [40, 45, 50, 55, 59, 64] as const;
export const guitarFretCount = 19;
export const pianoNotes = Array.from({ length: 25 }, (_, index) => 60 + index);
export function noteLabel(midi: number) {
  return `${noteNames[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

function useInstrumentInput(onNote?: (midi: number) => void) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const [pressed, setPressed] = useState<number | null>(null);
  const [focused, setFocused] = useState(0);
  function press(event: PointerEvent<HTMLButtonElement>, index: number, midi: number) {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setPressed(index);
    setFocused(index);
    onNote?.(midi);
  }
  function navigate(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
    count: number,
    columns = 1,
    reverse = false,
  ) {
    const move =
      event.key === 'ArrowRight'
        ? reverse
          ? -1
          : 1
        : event.key === 'ArrowLeft'
          ? reverse
            ? 1
            : -1
          : event.key === 'ArrowDown'
            ? columns
            : event.key === 'ArrowUp'
              ? -columns
              : 0;
    if (!move) return;
    event.preventDefault();
    const row = Math.floor(index / columns);
    const horizontal = columns > 1 && Math.abs(move) === 1;
    const minimum = horizontal ? row * columns : 0;
    const maximum = horizontal ? (row + 1) * columns - 1 : count - 1;
    const next = Math.max(minimum, Math.min(maximum, index + move));
    setFocused(next);
    buttons.current[next]?.focus();
  }
  return { buttons, pressed, focused, setPressed, setFocused, press, navigate };
}

function Piano({ interactive, onNote }: Pick<InstrumentProps, 'interactive' | 'onNote'>) {
  const id = useId();
  const input = useInstrumentInput(onNote);
  let whiteIndex = 0;
  const keys = pianoNotes.map((midi) => {
    const black = [1, 3, 6, 8, 10].includes(midi % 12);
    const x = black ? 23 + whiteIndex * (554 / 15) - 12 : 23 + whiteIndex++ * (554 / 15);
    return { midi, black, x, width: black ? 24 : 554 / 15 - 2 };
  });
  return (
    <div className="relative aspect-[600/185] w-full">
      <svg
        viewBox="0 0 600 185"
        className="pointer-events-none absolute inset-0 size-full"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`${id}-case`} x2="0" y2="1">
            <stop stopColor="oklch(35% .008 80)" />
            <stop offset="1" stopColor="oklch(22% .006 80)" />
          </linearGradient>
          <linearGradient id={`${id}-ivory`} x2="0" y2="1">
            <stop stopColor="oklch(95% .006 80)" />
            <stop offset=".7" stopColor="oklch(99% .003 80)" />
            <stop offset="1" stopColor="oklch(89% .009 80)" />
          </linearGradient>
          <linearGradient id={`${id}-ebony`} x2=".5" y2="1">
            <stop stopColor="oklch(38% .006 80)" />
            <stop offset=".8" stopColor="oklch(19% .005 80)" />
            <stop offset="1" stopColor="oklch(12% .005 80)" />
          </linearGradient>
        </defs>
        <rect x="4" y="10" width="592" height="167" rx="18" fill="oklch(25% .005 80 / .12)" />
        <rect x="4" y="3" width="592" height="166" rx="17" fill={`url(#${id}-case)`} />
        <rect x="20" y="24" width="560" height="139" rx="5" fill="oklch(13% .005 80)" />
        {keys
          .filter((key) => !key.black)
          .map((key) => (
            <g key={key.midi}>
              <rect
                x={key.x + 1}
                y="28"
                width={key.width}
                height="130"
                rx="3"
                fill={`url(#${id}-ivory)`}
              />
              <path
                d={`M${key.x + 4} 153h${key.width - 6}`}
                stroke="oklch(80% .008 80)"
                strokeWidth=".6"
              />
            </g>
          ))}
        {keys
          .filter((key) => key.black)
          .map((key) => (
            <g key={key.midi}>
              <rect
                x={key.x + 2}
                y="27"
                width={key.width + 1}
                height="84"
                rx="3"
                fill="oklch(10% .003 80 / .35)"
              />
              <rect
                x={key.x}
                y="25"
                width={key.width}
                height="82"
                rx="3"
                fill={`url(#${id}-ebony)`}
              />
              <path
                d={`M${key.x + 4} 30h${key.width - 8}`}
                stroke="oklch(55% .008 80)"
                strokeWidth="1"
              />
            </g>
          ))}
      </svg>
      {interactive &&
        keys.map((key, index) => (
          <button
            key={key.midi}
            type="button"
            ref={(button) => {
              input.buttons.current[index] = button;
            }}
            aria-label={`Play ${noteLabel(key.midi)}`}
            data-midi={key.midi}
            tabIndex={input.focused === index ? 0 : -1}
            className={cn(
              'absolute touch-none rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              key.black ? 'z-10' : 'z-0',
              input.pressed === index ? 'bg-foreground/20 shadow-inner' : 'hover:bg-foreground/5',
            )}
            style={{
              left: `${key.x / 6}%`,
              top: `${(key.black ? 25 : 28) / 1.85}%`,
              width: `${key.width / 6}%`,
              height: `${(key.black ? 82 : 130) / 1.85}%`,
            }}
            onPointerDown={(event) => input.press(event, index, key.midi)}
            onPointerUp={() => input.setPressed(null)}
            onPointerCancel={() => input.setPressed(null)}
            onClick={(event) => {
              if (event.detail === 0) onNote?.(key.midi);
            }}
            onFocus={() => input.setFocused(index)}
            onKeyDown={(event) => input.navigate(event, index, keys.length)}
          />
        ))}
    </div>
  );
}

function Guitar({ interactive, onNote }: Pick<InstrumentProps, 'interactive' | 'onNote'>) {
  const id = useId();
  const input = useInstrumentInput(onNote);
  const columns = guitarFretCount + 1;
  const body =
    'M314 115C316 75 288 47 259 54C229 61 226 84 205 81C178 76 171 33 114 27C51 20 26 74 26 146C26 218 52 269 114 265C171 260 178 217 205 212C226 208 229 232 259 239C289 246 316 218 314 178Z';
  const fretX = (fret: number) => 622 - 472 * (1 - 2 ** (-fret / 12));
  const stringY = (string: number, x: number) => 146 + (string - 2.5) * (9 - ((x - 150) / 472) * 2);
  return (
    <div className="relative aspect-[760/292] w-full">
      <svg
        viewBox="0 0 760 292"
        className="pointer-events-none absolute inset-0 size-full"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`${id}-wood`} x1=".1" y1="0" x2=".85" y2="1">
            <stop stopColor="oklch(85% .061 79)" />
            <stop offset=".5" stopColor="oklch(91% .048 83)" />
            <stop offset="1" stopColor="oklch(78% .057 75)" />
          </linearGradient>
          <linearGradient id={`${id}-neck`} x2="0" y2="1">
            <stop stopColor="oklch(34% .025 56)" />
            <stop offset=".4" stopColor="oklch(23% .018 52)" />
            <stop offset="1" stopColor="oklch(31% .021 56)" />
          </linearGradient>
          <linearGradient id={`${id}-metal`} x2="0" y2="1">
            <stop stopColor="oklch(89% .005 80)" />
            <stop offset=".5" stopColor="oklch(58% .009 80)" />
            <stop offset="1" stopColor="oklch(79% .007 80)" />
          </linearGradient>
          <radialGradient id={`${id}-hole`}>
            <stop stopColor="oklch(10% .009 60)" />
            <stop offset="1" stopColor="oklch(23% .016 65)" />
          </radialGradient>
          <clipPath id={`${id}-outline`}>
            <path d={body} />
          </clipPath>
        </defs>
        <path d={body} transform="translate(0 5)" fill="oklch(23% .015 65 / .15)" />
        <path d={body} fill={`url(#${id}-wood)`} stroke="oklch(41% .047 61)" strokeWidth="4" />
        <path d={body} fill="none" stroke="oklch(94% .022 82)" strokeWidth="1.4" />
        <g clipPath={`url(#${id}-outline)`} opacity=".12">
          {Array.from({ length: 24 }, (_, index) => (
            <path
              key={index}
              d={`M25 ${34 + index * 10}Q164 ${29 + index * 10} 320 ${36 + index * 10}`}
              fill="none"
              stroke="oklch(48% .05 75)"
              strokeWidth=".7"
            />
          ))}
        </g>
        <path
          d="M242 162C263 171 276 189 258 205C243 218 217 206 218 184Z"
          fill="oklch(29% .031 50)"
        />
        <circle cx="220" cy="146" r="37" fill="oklch(65% .058 72)" />
        <circle
          cx="220"
          cy="146"
          r="34"
          fill="oklch(94% .025 82)"
          stroke="oklch(44% .036 65)"
          strokeWidth="1.1"
        />
        <circle
          cx="220"
          cy="146"
          r="31"
          fill={`url(#${id}-hole)`}
          stroke="oklch(41% .034 62)"
          strokeWidth="1.6"
        />
        <path d="M126 113Q139 121 153 116L158 176Q140 172 126 181Z" fill="oklch(28% .028 53)" />
        <path d="M149 119L153 173" stroke="oklch(94% .018 82)" strokeWidth="3.2" />
        <path d="M279 115L625 123L625 169L279 177Z" fill="oklch(45% .035 58)" />
        <path d="M281 117L622 126L622 166L281 175Z" fill={`url(#${id}-neck)`} />
        <path
          d="M623 122L717 107Q741 112 741 128V162Q741 179 717 184L623 170Z"
          fill="oklch(53% .052 62)"
          stroke="oklch(33% .031 55)"
          strokeWidth="1.8"
        />
        <path
          d="M629 126L718 112Q735 116 735 130V160Q735 174 718 179L629 165Z"
          fill={`url(#${id}-wood)`}
        />
        {[652, 683, 714].map((x, index) => (
          <g key={x}>
            <path
              d={`M${x} ${118 - index * 3}v-10M${x} ${174 + index * 2}v11`}
              stroke="oklch(52% .009 80)"
              strokeWidth="3"
            />
            <ellipse
              cx={x}
              cy={102 - index * 3}
              rx="7"
              ry="4.8"
              fill={`url(#${id}-metal)`}
              stroke="oklch(49% .007 80)"
              strokeWidth=".6"
            />
            <ellipse
              cx={x}
              cy={190 + index * 2}
              rx="7"
              ry="4.8"
              fill={`url(#${id}-metal)`}
              stroke="oklch(49% .007 80)"
              strokeWidth=".6"
            />
            <circle cx={x} cy={130 - index * 3} r="5" fill={`url(#${id}-metal)`} />
            <circle cx={x} cy={162 + index * 3} r="5" fill={`url(#${id}-metal)`} />
            <circle cx={x} cy={130 - index * 3} r="1.8" fill="oklch(35% .007 80)" />
            <circle cx={x} cy={162 + index * 3} r="1.8" fill="oklch(35% .007 80)" />
          </g>
        ))}
        {Array.from({ length: guitarFretCount }, (_, index) => index + 1).map((fret) => {
          const x = fretX(fret);
          const height = 40 + ((622 - x) / 341) * 18;
          return (
            <path
              key={fret}
              d={`M${x} ${146 - height / 2}v${height}`}
              data-fret-wire={fret}
              stroke="oklch(76% .009 80)"
              strokeWidth="1.5"
            />
          );
        })}
        {[3, 5, 7, 9, 12, 15, 17].map((fret) => {
          const x = (fretX(fret) + fretX(fret - 1)) / 2;
          return fret === 12 ? (
            <g key={fret}>
              <circle cx={x} cy="139" r="2.1" fill="oklch(87% .011 80)" />
              <circle cx={x} cy="153" r="2.1" fill="oklch(87% .011 80)" />
            </g>
          ) : (
            <circle key={fret} cx={x} cy="146" r="2.1" fill="oklch(87% .011 80)" />
          );
        })}
        <path d="M623 125v42" stroke="oklch(96% .011 82)" strokeWidth="4" />
        {guitarStrings.map((_note, string) => {
          const post = string < 3 ? 652 + string * 31 : 652 + (5 - string) * 31;
          const postY = string < 3 ? 130 - string * 3 : 162 + (5 - string) * 3;
          return (
            <g key={string}>
              <path
                d={`M140 ${stringY(string, 150)}L623 ${stringY(string, 622)}L${post} ${postY}`}
                stroke={string < 3 ? 'oklch(72% .044 75)' : 'oklch(85% .007 80)'}
                strokeWidth={1.15 - string * 0.1}
              />
              <circle cx="139" cy={stringY(string, 150)} r="1.9" fill="oklch(91% .015 80)" />
            </g>
          );
        })}
      </svg>
      {interactive &&
        guitarStrings.flatMap((open, string) =>
          Array.from({ length: columns }, (_, fret) => {
            const index = string * columns + fret;
            const midi = open + fret;
            const right = fret === 0 ? 641 : fretX(fret - 1);
            const left = fret === 0 ? 625 : fretX(fret);
            const center = (left + right) / 2;
            const height = 9 - ((center - 150) / 472) * 2;
            const style: CSSProperties = {
              left: `${left / 7.6}%`,
              top: `${(stringY(string, center) - height / 2) / 2.92}%`,
              width: `${(right - left) / 7.6}%`,
              height: `${height / 2.92}%`,
            };
            return (
              <button
                key={index}
                type="button"
                ref={(button) => {
                  input.buttons.current[index] = button;
                }}
                aria-label={`String ${6 - string}, fret ${fret}, ${noteLabel(midi)}`}
                data-midi={midi}
                data-string={6 - string}
                data-fret={fret}
                tabIndex={input.focused === index ? 0 : -1}
                style={style}
                className="group absolute touch-none rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                onPointerDown={(event) => input.press(event, index, midi)}
                onPointerUp={() => input.setPressed(null)}
                onPointerCancel={() => input.setPressed(null)}
                onClick={(event) => {
                  if (event.detail === 0) onNote?.(midi);
                }}
                onFocus={() => input.setFocused(index)}
                onKeyDown={(event) =>
                  input.navigate(event, index, guitarStrings.length * columns, columns, true)
                }
              >
                <span
                  className={cn(
                    'mx-auto block size-1.5 rounded-full bg-primary-foreground opacity-0 group-hover:opacity-70 group-focus-visible:opacity-70',
                    input.pressed === index && 'opacity-100',
                  )}
                />
              </button>
            );
          }),
        )}
    </div>
  );
}

export function Instrument({
  instrument,
  interactive = false,
  onNote,
  className,
}: InstrumentProps) {
  return (
    <div
      className={className}
      role={interactive ? 'group' : 'img'}
      aria-label={instrument === 'piano' ? 'Piano' : 'Acoustic guitar'}
      data-testid={`instrument-${instrument}`}
    >
      {instrument === 'piano' ? (
        <Piano interactive={interactive} onNote={onNote} />
      ) : (
        <Guitar interactive={interactive} onNote={onNote} />
      )}
    </div>
  );
}
