import { useEffect, useId, useRef } from 'react';
import { MicOff } from 'lucide-react';
import { cn } from 'cn';
import { studio } from '@/studio/studio';

interface MicrophoneIndicatorProps {
  active: boolean;
  meter?: boolean;
  icon?: boolean;
  className?: string;
}

export function MicrophoneIndicator({
  active,
  meter = false,
  icon = true,
  className,
}: MicrophoneIndicatorProps) {
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const fill = useRef<SVGRectElement>(null);
  const bars = useRef<Array<HTMLSpanElement | null>>([]);
  useEffect(() => {
    let frame = 0;
    let previous = 0;
    let lastUpdate = 0;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const draw = (value: number) => {
      root.current?.setAttribute('data-level', value.toFixed(3));
      if (meter) root.current?.setAttribute('aria-valuenow', String(Math.round(value * 100)));
      if (fill.current) fill.current.style.transform = `translateY(${(1 - value) * 24}px)`;
      bars.current.forEach((bar, index) => {
        if (bar) bar.style.opacity = active && value > index / 20 ? '1' : '.2';
      });
    };
    const update = (time: number) => {
      if (!document.hidden && time - lastUpdate >= (motion.matches ? 150 : 32)) {
        previous = Math.max(studio.audio.microphoneLevel(), previous * 0.76);
        draw(previous);
        lastUpdate = time;
      }
      frame = requestAnimationFrame(update);
    };
    draw(0);
    if (active) frame = requestAnimationFrame(update);
    return () => {
      cancelAnimationFrame(frame);
      draw(0);
    };
  }, [active, meter]);

  return (
    <span
      ref={root}
      data-testid={meter ? 'microphone-meter' : 'microphone-indicator'}
      data-active={active}
      data-level="0"
      role={meter ? 'meter' : undefined}
      aria-label={meter ? 'Microphone input level' : undefined}
      aria-valuemin={meter ? 0 : undefined}
      aria-valuemax={meter ? 100 : undefined}
      aria-valuenow={meter ? 0 : undefined}
      className={cn(
        'inline-flex items-center',
        meter ? 'h-9 gap-3' : 'size-9 justify-center',
        className,
      )}
    >
      {icon &&
        (active ? (
          <svg
            viewBox="0 0 32 40"
            className={meter ? 'h-6 w-5 shrink-0' : 'size-9'}
            aria-hidden="true"
          >
            <defs>
              <clipPath id={id}>
                <rect x="10" y="3" width="12" height="24" rx="6" />
              </clipPath>
            </defs>
            <rect
              x="10"
              y="3"
              width="12"
              height="24"
              rx="6"
              className="fill-muted stroke-foreground"
              strokeWidth="1.7"
            />
            <g clipPath={`url(#${id})`}>
              <rect
                ref={fill}
                x="10"
                y="3"
                width="12"
                height="24"
                className="fill-foreground"
                style={{ transform: 'translateY(24px)' }}
              />
            </g>
            <path
              d="M5 20v2a11 11 0 0 0 22 0v-2M16 33v5M10 38h12"
              className="stroke-foreground"
              strokeWidth="1.8"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        ) : (
          <MicOff
            aria-hidden="true"
            className={cn('shrink-0 text-muted-foreground', meter ? 'size-5' : 'size-8')}
            strokeWidth={1.7}
          />
        ))}
      {meter && (
        <span className="flex flex-1 items-center gap-[5px]" aria-hidden="true">
          {Array.from({ length: 20 }, (_, index) => (
            <span
              key={index}
              ref={(bar) => {
                bars.current[index] = bar;
              }}
              className="h-3.5 w-1 shrink-0 rounded-full bg-foreground opacity-20"
            />
          ))}
        </span>
      )}
    </span>
  );
}
