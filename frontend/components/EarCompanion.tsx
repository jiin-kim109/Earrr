import { useEffect, useRef, useState } from 'react';
import type { Curriculum } from '../../shared/types/course.js';
import type { CourseState } from '../../server/types/progress.types.js';
import { useStudio } from '../studio/studio.js';
import { EarFace } from './EarFace.js';

const ranks = [
  { name: 'Rookie Ear', color: 'oklch(43% .012 80)' },
  { name: 'Pitch Scout', color: 'oklch(49% .065 70)' },
  { name: 'Chord Keeper', color: 'oklch(46% .04 245)' },
  { name: 'Tonal Explorer', color: 'oklch(46% .065 155)' },
  { name: 'Harmony Sage', color: 'oklch(48% .09 65)' },
  { name: 'Ear Master', color: 'oklch(46% .115 70)' },
] as const;

export function companionRank(curriculum: Curriculum, course: CourseState) {
  const passed = new Set(
    course.lessons
      .filter((lesson) => lesson.status === 'completed')
      .map((lesson) => lesson.skillId),
  );
  const completed = curriculum.lessons.filter((lesson) => passed.has(lesson.id)).length;
  const total = curriculum.lessons.length;
  const tier =
    total === 0
      ? 0
      : completed === total
        ? ranks.length - 1
        : Math.min(ranks.length - 2, Math.ceil((completed * (ranks.length - 2)) / total));
  return { ...ranks[tier]!, tier };
}

export function EarCompanion() {
  const { curriculum, snapshot } = useStudio();
  const [reaction, setReaction] = useState(0);
  const drawing = useRef<SVGSVGElement>(null);
  const animations = useRef<Animation[]>([]);
  useEffect(() => () => animations.current.forEach((animation) => animation.cancel()), []);
  if (!curriculum || !snapshot) return null;
  const rank = companionRank(curriculum, snapshot.course);

  const wake = () => {
    animations.current.forEach((animation) => animation.cancel());
    animations.current = [];
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const mode = reaction % 3;
    setReaction((value) => value + 1);
    const animate = (part: string, frames: Keyframe[], duration = 900) => {
      const element = drawing.current?.querySelector(`[data-part="${part}"]`);
      if (element)
        animations.current.push(
          element.animate(frames, {
            duration: reduced ? 220 : duration,
            easing: 'cubic-bezier(0.16,1,0.3,1)',
          }),
        );
    };
    if (reduced) {
      animate('eyes', [{ opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }]);
      return;
    }
    animate('left-ear', [
      { transform: 'rotate(0deg)' },
      { transform: `rotate(${mode === 1 ? -22 : -12}deg)` },
      { transform: 'rotate(0deg)' },
    ]);
    animate('right-ear', [
      { transform: 'rotate(0deg)' },
      { transform: `rotate(${mode === 2 ? 22 : 12}deg)` },
      { transform: 'rotate(0deg)' },
    ]);
    animate(
      'face',
      [
        { transform: 'rotate(0deg)' },
        { transform: `rotate(${mode === 1 ? -7 : 6}deg)` },
        { transform: 'rotate(0deg)' },
      ],
      1000,
    );
    animate(
      'right-eye',
      [{ transform: 'scaleY(1)' }, { transform: 'scaleY(.12)' }, { transform: 'scaleY(1)' }],
      600,
    );
    animate(
      'halo',
      [
        { transform: 'scale(.7)', opacity: 0 },
        { transform: 'scale(1)', opacity: 0.5 },
        { transform: 'scale(1.35)', opacity: 0 },
      ],
      1100,
    );
    animate(
      'note',
      [
        { transform: `translate(${mode === 1 ? 16 : -10}px,-15px) rotate(-12deg)`, opacity: 0 },
        { transform: 'translate(0,-4px) rotate(6deg)', opacity: 1, offset: 0.35 },
        { transform: 'translate(18px,29px) scale(.25)', opacity: 0 },
      ],
      1050,
    );
    if (mode === 2)
      animate('star', [
        { transform: 'scale(.3) rotate(-45deg)', opacity: 0 },
        { transform: 'scale(1) rotate(0deg)', opacity: 1 },
        { transform: 'scale(.5) rotate(25deg)', opacity: 0 },
      ]);
  };

  return (
    <button
      type="button"
      onClick={wake}
      data-testid="ear-companion"
      data-tier={rank.tier}
      data-reaction={reaction}
      aria-label={`${rank.name} mascot`}
      title={`${rank.name}. Click to wake.`}
      className="group flex w-full cursor-pointer flex-col items-center rounded-2xl bg-transparent pt-1 pb-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <svg
        ref={drawing}
        viewBox="0 0 180 118"
        aria-hidden="true"
        className="h-28 w-44"
        style={{ color: rank.color }}
      >
        <ellipse cx="90" cy="106" rx="27" ry="4" className="fill-foreground/8" />
        <circle cx="90" cy="64" r="39" fill="currentColor" opacity=".06" />
        <circle
          data-part="halo"
          cx="90"
          cy="64"
          r="43"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.2"
          opacity="0"
          className="origin-center [transform-box:fill-box]"
        />
        {Array.from({ length: rank.tier }, (_, index) => (
          <path
            key={index}
            d="M88 8l2-4 2 4 4 .5-3 3 .7 4-3.7-2-3.7 2 .7-4-3-3Z"
            fill="currentColor"
            transform={`rotate(${(index - (rank.tier - 1) / 2) * 18} 90 65)`}
          />
        ))}
        <EarFace />
        <g
          data-part="note"
          opacity="0"
          className="origin-center [transform-box:fill-box]"
          fill="currentColor"
        >
          <path d="M32 12v13h2V16l9-2v9h2V9Z" />
          <ellipse cx="29.5" cy="26" rx="4.5" ry="3.3" transform="rotate(-20 29 26)" />
          <ellipse cx="40.5" cy="24" rx="4.5" ry="3.3" transform="rotate(-20 40 24)" />
        </g>
        <path
          data-part="star"
          d="M145 13l3 7 8 2-8 3-3 7-3-7-8-3 8-2Z"
          fill="currentColor"
          opacity="0"
          className="origin-center [transform-box:fill-box]"
        />
      </svg>
      <span className="text-xs font-medium tracking-tight">{rank.name}</span>
    </button>
  );
}
