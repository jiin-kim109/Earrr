import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { z } from 'zod';
import { logEventSchema, sanitizeLogMessage } from '../../shared/schemas/logging.js';
import type { LogEvent, LogMessage, LogOptions } from '../../shared/types/logging.js';
import type { LogContext, LogRow } from '../types/logging.types.js';
import type { ToolRequest, ToolResult } from '../types/agent.types.js';

const context = new AsyncLocalStorage<LogContext>();
const pending: LogRow[] = [];
let writer: ((events: LogRow[]) => Promise<void>) | null = null;
let releaseId: string | null = null;
let environment: LogRow['environment'] = 'development';
let privateValues: readonly string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | null = null;

function enqueue(event: LogEvent, source: LogRow['source'], fields: LogContext) {
  if (!writer) return;
  const item = logEventSchema.parse(event);
  if (pending.length >= 500) {
    console.warn('[telemetry] Buffer full; event not stored.');
    return;
  }
  pending.push({
    id: item.id,
    timestamp: item.timestamp,
    event_name: item.event,
    level: item.level,
    source,
    actor_id: fields.actorId ?? null,
    session_id: item.sessionId,
    visit_id: item.visitId,
    visitor_id: item.visitorId,
    request_id: item.requestId,
    release_id: releaseId,
    environment,
    message: sanitizeLogMessage(item.message, privateValues),
  });
  if (pending.length >= 20) void Log.flush();
  else if (!timer) {
    timer = setTimeout(() => {
      timer = undefined;
      void Log.flush();
    }, 1000);
    timer.unref();
  }
}

export const Log = {
  configure(options: {
    write: ((events: LogRow[]) => Promise<void>) | null;
    releaseId?: string;
    secrets?: readonly string[];
    environment?: LogRow['environment'];
  }) {
    writer = options.write;
    releaseId = options.releaseId ?? null;
    privateValues = options.secrets?.filter(Boolean) ?? [];
    environment = options.environment ?? 'development';
  },
  get enabled() {
    return writer !== null;
  },
  scope<T>(fields: LogContext, work: () => T): T {
    return context.run({ ...context.getStore(), ...fields }, work);
  },
  context(fields: LogContext) {
    const current = context.getStore();
    if (current) Object.assign(current, fields);
  },
  event(event: string, message: LogMessage = {}, options: LogOptions = {}) {
    if (!writer) return;
    const current = { ...context.getStore(), ...options };
    try {
      enqueue(
        {
          id: randomUUID(),
          timestamp: new Date().toISOString(),
          event,
          level: options.level ?? 'info',
          sessionId: current.sessionId ?? null,
          visitId: current.visitId ?? null,
          visitorId: current.visitorId ?? null,
          requestId: current.requestId ?? null,
          message,
        },
        'server',
        current,
      );
    } catch {
      console.warn('[telemetry] Invalid event; nothing was stored.');
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
  ingest(event: LogEvent, actorId: string | null) {
    enqueue(event, 'client', { actorId });
  },
  flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    if (flushing) return flushing;
    const send = writer;
    if (!send || !pending.length) return Promise.resolve();
    flushing = (async () => {
      while (pending.length) {
        const batch = pending.splice(0, 20);
        try {
          await send(batch);
        } catch (error) {
          console.warn(
            `[telemetry] Could not store ${batch.length} events.`,
            sanitizeLogMessage(
              { reason: error instanceof Error ? error.message.slice(0, 300) : 'Storage error' },
              privateValues,
            ),
          );
        }
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  },
};

const headerId = (value: string | undefined) => {
  const parsed = z.string().uuid().safeParse(value);
  return parsed.success ? parsed.data : null;
};
export const requestLogging: RequestHandler = (req, res, next) => {
  if (req.path === '/logs' || req.path === '/health') return next();
  const fields: LogContext = {
    requestId: headerId(req.get('x-earrr-request-id')) ?? randomUUID(),
    visitId: headerId(req.get('x-earrr-visit-id')),
    visitorId: headerId(req.get('x-earrr-visitor-id')),
  };
  fields.actorId = fields.visitorId ? `visitor:${fields.visitorId}` : null;
  const started = performance.now();
  const path = req.originalUrl.split('?')[0];
  let finished = false;
  res.setHeader('x-earrr-request-id', fields.requestId!);
  Log.scope(fields, () => {
    const current = context.getStore()!;
    res.once('finish', () => {
      finished = true;
      Log.scope(current, () =>
        Log.event(
          'request.completed',
          {
            method: req.method,
            path,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - started),
          },
          { level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info' },
        ),
      );
    });
    res.once('close', () => {
      if (!finished)
        Log.scope(current, () =>
          Log.event(
            'request.cancelled',
            {
              method: req.method,
              path,
              durationMs: Math.round(performance.now() - started),
            },
            { level: 'warn' },
          ),
        );
    });
    next();
  });
};

export function logToolResult(
  input: Pick<ToolRequest, 'callId' | 'name' | 'sessionId'>,
  result: ToolResult,
) {
  const sessionId =
    result.snapshot.session?.id ??
    (input.name === 'end_session' ? (input.sessionId ?? null) : null);
  Log.context({ sessionId });
  Log.event('tool.completed', {
    tool: input.name,
    callId: input.callId,
    lessonId: result.snapshot.course.selectedLesson,
    phase: result.snapshot.session?.phase,
    mode: result.snapshot.session?.mode,
    questionId: result.snapshot.current?.id,
    stepId: result.teaching?.stepId,
    sectionId: result.snapshot.teaching?.section ?? result.snapshot.course.selectedLesson,
  });
  if (['start_session', 'select_lesson', 'show_welcome'].includes(input.name))
    Log.event('lesson.entered', {
      lessonId: result.snapshot.teaching?.section ?? result.snapshot.course.selectedLesson,
      mode: result.snapshot.session?.mode,
      callId: input.callId,
    });
  if (
    ['submit_answer', 'skip_exercise'].includes(input.name) &&
    result.grade &&
    result.grade.verdict !== 'incomplete'
  )
    Log.event(input.name === 'skip_exercise' ? 'answer.skipped' : 'answer.result', {
      callId: input.callId,
      questionId: result.gradedExerciseId,
      attemptId:
        result.snapshot.feedback && result.snapshot.feedback.exerciseId === result.gradedExerciseId
          ? result.snapshot.feedback.attemptId
          : null,
      lessonId: result.snapshot.course.selectedLesson,
      verdict: result.grade.verdict,
      score: result.grade.score,
    });
  if (result.roundResult)
    Log.event('round.completed', {
      ...result.roundResult,
      answers: undefined,
      callId: input.callId,
    });
}
