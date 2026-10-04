import { useEffect, useRef } from 'react';
import type { StaveNote, GhostNote } from 'vexflow/core';
import '@vexflow-fonts/bravura/index.css';
import { studio } from '@/studio/studio';

export interface ScoreFrame {
  notes: string[];
  symbol?: string;
  function?: string;
  highlighted?: boolean;
}
let loaded: Promise<typeof import('vexflow/core')> | undefined;
async function notationEngine() {
  loaded ??= Promise.all([import('vexflow/core'), document.fonts.load('40px Bravura')]).then(
    ([engine]) => {
      engine.VexFlow.setFonts('Bravura', 'Instrument Sans Variable');
      return engine;
    },
  );
  return loaded;
}
const writtenKey = (note: string) => {
  const match = /^([A-G])([b#]*)(-?\d+)$/.exec(note);
  if (!match) throw new Error('The score has an invalid written pitch.');
  return {
    key: `${match[1]!.toLowerCase()}${match[2]}/${match[3]}`,
    accidental: match[2]!,
    octave: Number(match[3]),
  };
};

export function MusicNotation({
  frames,
  label,
}: {
  frames: Array<ScoreFrame | null>;
  label: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    void notationEngine()
      .then((vf) => {
        if (cancelled || !host.current) return;
        const element = host.current;
        element.replaceChildren();
        const all = frames.flatMap((frame) => frame?.notes ?? []);
        const singleLine = frames.every((frame) => frame?.notes.length === 1);
        const average = all.length
          ? all.reduce((sum, note) => {
              const key = writtenKey(note);
              const natural = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[
                note[0] as 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B'
              ]!;
              return sum + (key.octave + 1) * 12 + natural;
            }, 0) / all.length
          : 64;
        const grand = !singleLine && all.some((note) => writtenKey(note).octave < 4);
        const mainClef = singleLine && average < 60 ? 'bass' : 'treble';
        const height = grand ? 220 : 165;
        const renderer = new vf.Renderer(element, vf.Renderer.Backends.SVG);
        renderer.resize(460, height);
        const context = renderer.getContext();
        const foreground = getComputedStyle(element).color;
        const brand = getComputedStyle(element).getPropertyValue('--color-brand').trim();
        context.setFillStyle(foreground).setStrokeStyle(foreground);
        const treble = new vf.Stave(10, grand ? 7 : 20, 440).addClef(mainClef);
        treble
          .setBegBarType(vf.Barline.type.NONE)
          .setEndBarType(vf.Barline.type.NONE)
          .setContext(context)
          .draw();
        const bass = grand ? new vf.Stave(10, 90, 440).addClef('bass') : null;
        bass
          ?.setBegBarType(vf.Barline.type.NONE)
          .setEndBarType(vf.Barline.type.NONE)
          .setContext(context)
          .draw();
        if (bass)
          new vf.StaveConnector(treble, bass).setType('singleLeft').setContext(context).draw();
        const make = (frame: ScoreFrame | null, clef: 'treble' | 'bass'): StaveNote | GhostNote => {
          const notes =
            frame?.notes.filter((note) =>
              grand ? writtenKey(note).octave >= 4 === (clef === 'treble') : true,
            ) ?? [];
          if (!notes.length) return new vf.GhostNote({ duration: 'w' });
          const note = new vf.StaveNote({
            keys: notes.map((pitch) => writtenKey(pitch).key),
            duration: 'w',
            clef,
          });
          notes.forEach((pitch, index) => {
            const accidental = writtenKey(pitch).accidental;
            if (accidental) note.addModifier(new vf.Accidental(accidental), index);
          });
          note.setStyle({
            fillStyle: frame?.highlighted ? brand : foreground,
            strokeStyle: frame?.highlighted ? brand : foreground,
          });
          return note;
        };
        const topNotes = frames.map((frame) => make(frame, mainClef));
        const top = new vf.Voice({ numBeats: frames.length * 4, beatValue: 4 })
          .setMode(vf.Voice.Mode.SOFT)
          .addTickables(topNotes);
        const bottom = bass
          ? new vf.Voice({ numBeats: frames.length * 4, beatValue: 4 })
              .setMode(vf.Voice.Mode.SOFT)
              .addTickables(frames.map((frame) => make(frame, 'bass')))
          : null;
        const voices = bottom ? [top, bottom] : [top];
        new vf.Formatter().joinVoices(voices).format(voices, 380);
        top.draw(context, treble);
        if (bottom && bass) bottom.draw(context, bass);
        const svg = element.querySelector('svg')!;
        svg.setAttribute('viewBox', `0 0 460 ${height}`);
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('data-written-notes', all.join(' '));
        element.style.removeProperty('width');
        element.style.removeProperty('height');
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.display = 'block';
        const text = (value: string, x: number, y: number, color: string, size: number) => {
          const node = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          node.textContent = value;
          node.setAttribute('x', String(x));
          node.setAttribute('y', String(y));
          node.setAttribute('text-anchor', 'middle');
          node.setAttribute('fill', color);
          node.setAttribute('font-size', String(size));
          node.setAttribute('font-family', 'Instrument Sans Variable, sans-serif');
          svg.append(node);
        };
        frames.forEach((frame, index) => {
          const x = topNotes[index]!.getAbsoluteX() + 9;
          if (!frame) text('?', x, 26, brand, 24);
          else {
            if (frame.symbol) text(frame.symbol, x, 25, frame.highlighted ? brand : foreground, 19);
            if (frame.function)
              text(frame.function, x, height - 10, frame.highlighted ? brand : foreground, 14);
          }
        });
      })
      .catch((error: unknown) => {
        if (!cancelled) studio.reportError(error);
      });
    return () => {
      cancelled = true;
    };
  }, [frames]);
  return (
    <div
      ref={host}
      data-testid="music-notation"
      role="img"
      aria-label={label}
      className="h-full w-full text-foreground"
    />
  );
}
