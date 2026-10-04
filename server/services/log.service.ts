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
let environment: LogRow['environment'] = 'development';
let privateValues: readonly string[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | null = null;

function enqueue(event: LogEvent, fields: LogContext) {
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
    actor_id: fields.actorId ?? null,
    session_id: item.sessionId,
    request_id: item.requestId,
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
    secrets?: readonly string[];
    environment?: LogRow['environment'];
  }) {
    writer = options.write;
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
          id: options.eventId ?? randomUUID(),
          timestamp: new Date().toISOString(),
          event,
          level: options.level ?? 'info',
          sessionId: current.sessionId ?? null,
          requestId: current.requestId ?? null,
          message,
        },
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
    enqueue(event, { actorId });
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
export const requestLogContext: RequestHandler = (req, res, next) => {
  if (req.path === '/logs' || req.path === '/health') return next();
  const fields: LogContext = {
    requestId: headerId(req.get('x-earrr-request-id')) ?? randomUUID(),
  };
  res.setHeader('x-earrr-request-id', fields.requestId!);
  Log.scope(fields, next);
};

const activityEvents: Partial<Record<ToolRequest['name'], string>> = {
  select_lesson: 'user_open_lesson',
  show_welcome: 'user_open_lesson',
  start_practice: 'user_start_exercise_round',
  start_round: 'user_start_exercise_round',
  end_session: 'user_end_training',
};

export function logToolResult(
  input: Pick<ToolRequest, 'callId' | 'name' | 'sessionId'>,
  result: ToolResult,
) {
  const sessionId =
    result.snapshot.session?.id ??
    (input.name === 'end_session' ? (input.sessionId ?? null) : null);
  Log.context({ sessionId });
  const details = {
    callId: input.callId,
    lessonId: result.snapshot.teaching?.section ?? result.snapshot.course.selectedLesson,
    mode: result.snapshot.session?.mode,
  };
  const activity = activityEvents[input.name];
  if (activity) Log.event(activity, details, { eventId: input.callId, sessionId });
  if (
    ['submit_answer', 'skip_exercise'].includes(input.name) &&
    result.grade &&
    result.grade.verdict !== 'incomplete'
  ) {
    const feedback = result.snapshot.feedback;
    const attemptId =
      feedback && feedback.exerciseId === result.gradedExerciseId ? feedback.attemptId : null;
    Log.event(
      input.name === 'skip_exercise' ? 'user_skip_exercise' : 'user_submit_exercise_answer',
      {
        ...details,
        questionId: result.gradedExerciseId,
        attemptId,
        verdict: result.grade.verdict,
        score: result.grade.score,
      },
      { eventId: input.callId, sessionId },
    );
  }
  if (result.roundResult) {
    const { answers: _answers, ...round } = result.roundResult;
    Log.event(
      'user_complete_exercise_round',
      { ...round, callId: input.callId },
      { eventId: round.id, sessionId },
    );
  }
}
