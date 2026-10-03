import { useEffect, useRef } from 'react';
import { cn } from 'cn';

interface WaveformProps {
  active: boolean;
  level: () => number;
  label: string;
  className?: string;
}

export function Waveform({ active, level, label, className }: WaveformProps) {
  const root = useRef<HTMLDivElement>(null);
  const bars = useRef<Array<HTMLSpanElement | null>>([]);
  const count = 25;
  const height = (index: number, amplitude = 0) => {
    const curve = Math.sin(((index + 1) / (count + 1)) * Math.PI) ** 2;
    return 0.08 + 0.075 * curve + amplitude * (0.18 + 0.66 * curve);
  };
  useEffect(() => {
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    const reset = () =>
      bars.current.forEach((bar, index) => {
        if (bar) bar.style.transform = `scaleY(${height(index)})`;
      });
    const update = () => {
      if (!document.hidden) {
        const amplitude = active ? level() : 0;
        root.current?.setAttribute('data-level', amplitude.toFixed(3));
        bars.current.forEach((bar, index) => {
          if (bar) bar.style.transform = `scaleY(${height(index, amplitude)})`;
        });
      }
      frame = requestAnimationFrame(update);
    };
    const start = () => {
      cancelAnimationFrame(frame);
      reset();
      if (active && !motion.matches) frame = requestAnimationFrame(update);
    };
    motion.addEventListener('change', start);
    start();
    return () => {
      motion.removeEventListener('change', start);
      cancelAnimationFrame(frame);
      reset();
    };
  }, [active, level, count]);
  return (
    <div
      ref={root}
      role="img"
      aria-label={label}
      data-testid="coach-waveform"
      data-active={active}
      data-level="0"
      className={cn(
        'flex h-24 w-56 max-w-full shrink-0 items-center justify-center gap-[5px]',
        className,
      )}
    >
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          ref={(bar) => {
            bars.current[index] = bar;
          }}
          className="h-full w-[3px] shrink-0 origin-center rounded-full bg-foreground"
          style={{ transform: `scaleY(${height(index)})` }}
        />
      ))}
    </div>
  );
}
