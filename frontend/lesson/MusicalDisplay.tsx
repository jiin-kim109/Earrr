import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { PlayedExample, QuestionDisplay } from '../../server/types/exercise.types.js';
import { PianoDiagram } from '@/instruments/PianoDiagram';
import { studio } from '@/studio/studio';
import { MusicNotation } from './MusicNotation.js';
import type { ScoreFrame } from './MusicNotation.js';

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

function SymbolPiano({
  example,
  exampleId,
  symbol,
  dense,
}: {
  example: PlayedExample;
  exampleId: string;
  symbol?: string;
  dense: boolean;
}) {
  if (!symbol) return <PianoDiagram example={example} exampleId={exampleId} />;
  return (
    <div className="flex size-full flex-col items-center justify-center gap-1">
      <p
        data-testid="chord-symbol"
        className={
          dense ? 'text-lg leading-none font-medium' : 'text-2xl leading-tight font-medium'
        }
      >
        {symbol}
      </p>
      <div className="flex min-h-0 w-full flex-1 items-center justify-center">
        <PianoDiagram example={example} exampleId={exampleId} />
      </div>
    </div>
  );
}

function ChordStrip({ frames }: { frames: Array<ScoreFrame | null> }) {
  return (
    <div className="flex size-full items-center justify-evenly gap-2">
      {frames.map((frame, index) => (
        <div
          key={index}
          className={`min-w-0 text-center ${frame?.highlighted ? 'text-brand' : 'text-foreground'}`}
        >
          <p className="text-base leading-tight font-medium">{frame?.symbol ?? '?'}</p>
          {frame?.function && (
            <p className="mt-1 text-[11px] text-muted-foreground">{frame.function}</p>
          )}
        </div>
      ))}
    </div>
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
  const frames = useMemo<ScoreFrame[] | null>(() => {
    if (diagram?.kind === 'progression') {
      const marked =
        diagram.targetIndices ?? (diagram.targetIndex === undefined ? [] : [diagram.targetIndex]);
      return diagram.chords.map((chord, index) => ({
        ...chord,
        highlighted: marked.includes(index),
      }));
    }
    if (diagram?.kind === 'scale' || diagram?.kind === 'melody')
      return diagram.points.map((point) => ({ notes: [point.note], highlighted: true }));
    return null;
  }, [diagram]);
  if (!diagram || diagram.kind === 'chord')
    return (
      <SymbolPiano
        example={example}
        exampleId={exampleId}
        symbol={example.symbol ?? (diagram?.kind === 'chord' ? diagram.symbol : undefined)}
        dense={dense}
      />
    );
  if (diagram.kind === 'degree')
    return (
      <PianoDiagram
        example={{ midi: [diagram.midi], notes: [diagram.note], presentation: 'single' }}
        exampleId={exampleId}
      />
    );
  if (!frames) return null;
  return (
    <div
      data-testid="musical-diagram"
      data-diagram-kind={diagram.kind}
      data-example-id={exampleId}
      className="h-full w-full max-w-[450px]"
    >
      {dense ? (
        diagram.kind === 'progression' ? (
          <ChordStrip frames={frames} />
        ) : (
          <PianoDiagram example={example} exampleId={exampleId} />
        )
      ) : (
        <MusicNotation
          frames={frames}
          label={`Played ${diagram.kind}: ${frames.map((frame) => frame.symbol ?? frame.notes.join(', ')).join('; ')}`}
        />
      )}
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
  const score = useMemo(
    () =>
      question.kind === 'sequence' && question.notation
        ? question.notation.map((frame, index) =>
            frame ? { ...frame, highlighted: playing && active === index } : null,
          )
        : null,
    [question, playing, active],
  );
  return (
    <div
      data-testid="question-diagram"
      data-question-kind={question.kind}
      data-active-position={playing ? active : -1}
      className="flex size-full flex-col justify-center"
    >
      {question.kind !== 'comparison' && (
        <p className="mb-2 text-center text-xs text-muted-foreground">{question.tonic}</p>
      )}
      {question.kind === 'degree' ? (
        <div
          className="flex justify-center gap-7"
          role="img"
          aria-label="Tonal anchors: 1 do, 3 mi, 5 sol"
        >
          {[
            [1, 'do'],
            [3, 'mi'],
            [5, 'sol'],
          ].map(([number, name]) => (
            <div key={number} className="text-center">
              <span className="text-2xl font-medium">{number}</span>
              <p className="mt-1 text-xs text-muted-foreground">{name}</p>
            </div>
          ))}
        </div>
      ) : question.kind === 'comparison' ? (
        <div
          className="flex items-center justify-center gap-8"
          role="img"
          aria-label={`${question.reference}, then an unknown ${question.subject}`}
        >
          <div className="text-center">
            <p className="mb-2 text-xs text-muted-foreground">Reference</p>
            <p className={`text-xl font-medium ${playing && active === 0 ? 'text-brand' : ''}`}>
              {question.reference}
            </p>
          </div>
          <span aria-hidden="true" className="text-muted-foreground">
            →
          </span>
          <div className="text-center">
            <p className="mb-2 text-xs text-muted-foreground">Second</p>
            <p className="text-3xl font-medium text-brand">?</p>
          </div>
        </div>
      ) : score?.some((frame) => frame && frame.notes.length > 0) && !dense ? (
        <div className="min-h-0 flex-1">
          <MusicNotation
            frames={score}
            label={`${question.tonic}. ${question.instruction}. ${question.labels.map((label) => label ?? 'missing').join(', ')}`}
          />
        </div>
      ) : (
        <div className="flex justify-evenly gap-2">
          {question.labels.map((label, index) => (
            <div
              key={index}
              data-question-position={index}
              data-masked={label === null}
              data-active={playing && active === index}
              className={`rounded-xl border px-3 py-2 text-center text-xl ${label === null ? 'border-dashed border-brand/40 text-brand' : 'border-border'} ${playing && active === index ? 'bg-brand/8' : ''}`}
            >
              {label ?? '?'}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
