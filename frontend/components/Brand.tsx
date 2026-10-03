import { cn } from 'cn';

export function Brand({ className }: { className?: string }) {
  return (
    <img
      src="/brand/earrr-wordmark.svg"
      alt="Earrr"
      draggable={false}
      className={cn('block h-8 w-auto', className)}
    />
  );
}
