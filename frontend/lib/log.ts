import { logEventSchema } from '../../shared/schemas/logging.js';
import type { LogEvent, LogMessage, LogOptions } from '../../shared/types/logging.js';

type Access = { identity: string; headers: Record<string, string> };
const pending: Array<{ event: LogEvent; access: Access }> = [];
let visitId: string | null = null;
let visitorId: string | null = null;
let session: () => string | null = () => null;
let access: () => Access = () => ({ identity: 'anonymous', headers: {} });
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | null = null;

export const Log = {
  initialize(options?: { session: () => string | null; access: () => Access }) {
    if (options) {
      session = options.session;
      access = options.access;
    }
    if (visitId) return;
    visitId = crypto.randomUUID();
    const openedAt = performance.now();
    try {
      const saved = localStorage.getItem('earrr:visitor');
      const parsed = logEventSchema.shape.visitorId.safeParse(saved);
      visitorId = parsed.success && parsed.data ? parsed.data : crypto.randomUUID();
      localStorage.setItem('earrr:visitor', visitorId);
    } catch {
      visitorId = crypto.randomUUID();
      console.warn('[telemetry] Anonymous visitor ID is temporary because storage is unavailable.');
    }
    document.addEventListener('visibilitychange', () => {
      this.event('app.visibility', { state: document.visibilityState });
      if (document.visibilityState === 'hidden') void this.flush();
    });
    window.addEventListener('pagehide', () => {
      this.event('app.closed', { durationMs: Math.round(performance.now() - openedAt) });
      void this.flush();
    });
    let referrerOrigin: string | null = null;
    if (document.referrer) {
      try {
        const url = new URL(document.referrer);
        if (url.protocol === 'https:' || url.protocol === 'http:') referrerOrigin = url.origin;
      } catch {
        console.warn('[telemetry] Invalid referrer omitted.');
      }
    }
    this.event('app.opened', {
      path: location.pathname,
      viewport: { width: innerWidth, height: innerHeight },
      language: navigator.language,
      referrerOrigin,
    });
  },
  headers(requestId = crypto.randomUUID()): Record<string, string> {
    return {
      'x-earrr-request-id': requestId,
      ...(visitId ? { 'x-earrr-visit-id': visitId } : {}),
      ...(visitorId ? { 'x-earrr-visitor-id': visitorId } : {}),
    };
  },
  event(event: string, message: LogMessage = {}, options: LogOptions = {}) {
    if (!visitId) return;
    try {
      const item = logEventSchema.parse({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        event,
        level: options.level ?? 'info',
        sessionId: options.sessionId === undefined ? session() : options.sessionId,
        visitId,
        visitorId,
        requestId: options.requestId ?? null,
        message,
      });
      if (pending.length >= 100) {
        console.warn('[telemetry] Buffer full; event not sent.');
        return;
      }
      pending.push({ event: item, access: access() });
      if (pending.length >= 5) void this.flush();
      else if (!timer)
        timer = setTimeout(() => {
          timer = undefined;
          void this.flush();
        }, 800);
    } catch {
      console.warn('[telemetry] Invalid event; nothing was sent.');
    }
  },
  error(event: string, error: unknown, message: LogMessage = {}) {
    this.event(
      event,
      {
        ...message,
        error:
          error instanceof Error
            ? {
                name: error.name,
                message: error.message,
                stack: error.stack?.split('\n').slice(0, 8).join('\n'),
              }
            : { name: 'UnknownError' },
      },
      { level: 'error' },
    );
  },
  flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (flushing) return flushing;
    flushing = (async () => {
      while (pending.length) {
        const owner = pending[0]!.access;
        const batch: LogEvent[] = [];
        while (batch.length < 5 && pending[0]?.access.identity === owner.identity)
          batch.push(pending.shift()!.event);
        try {
          const response = await fetch('/api/logs', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-earrr-client': '1',
              ...owner.headers,
            },
            body: JSON.stringify({ events: batch }),
            keepalive: true,
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) throw new Error(`Telemetry rejected (${response.status}).`);
        } catch {
          console.warn(`[telemetry] Could not send ${batch.length} events.`);
        }
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  },
};
