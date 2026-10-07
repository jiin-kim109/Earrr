import { cn } from 'cn';

export function Brand({ className, compact = false }: { className?: string; compact?: boolean }) {
  const image = (
    <img
      src="/brand/earrr-wordmark.svg"
      alt="Earrr"
      draggable={false}
      className={cn('block h-8 w-auto', className)}
    />
  );
  return compact ? (
    <picture>
      <source media="(max-width: 359px)" srcSet="/brand/earrr-mark.svg" />
      {image}
    </picture>
  ) : (
    image
  );
}
