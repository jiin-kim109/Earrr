export function ReplayIndicator() {
  return (
    <span
      role="status"
      aria-label="Replaying audio"
      data-testid="replay-indicator"
      className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        aria-hidden="true"
      >
        <path d="M3 9h4l5-4v14l-5-4H3Z" strokeLinejoin="round" />
        <path d="M16 8a6 6 0 0 1 0 8" className="motion-safe:animate-pulse" />
        <path
          d="M19 5a10 10 0 0 1 0 14"
          className="motion-safe:animate-pulse [animation-delay:200ms]"
        />
      </svg>
    </span>
  );
}
