import { z } from 'zod';

const privateField =
  /password|secret|token|apikey|authorization|cookie|privatekey|servicekey|accesskey|^email$|^(first|last|full|display)name$|^phone(number)?$|^address$|^sdp$|^(raw|user)?(text|transcript|audio)$/;

export function sanitizeLogMessage(
  message: Record<string, unknown>,
  secrets: readonly string[] = [],
) {
  const encoded = JSON.stringify(message);
  if (!encoded || new TextEncoder().encode(encoded).byteLength > 8192)
    throw new Error('A log message must be a JSON object of at most 8 KB.');
  const clean = (value: unknown, depth: number): unknown => {
    if (depth > 8) throw new Error('Log messages cannot exceed eight nested levels.');
    if (typeof value === 'string') {
      let text = value
        .replace(/[A-Z]:\\Users\\[^\\]+\\/gi, '[user]\\')
        .replace(/\/(?:Users|home)\/[^/]+\//g, '/[user]/')
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted]')
        .replace(/https?:\/\/[^\s<>"']+/g, (address) => {
          try {
            const url = new URL(address);
            return `${url.origin}${url.pathname}`;
          } catch {
            return '[invalid URL]';
          }
        });
      for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[redacted]');
      return text;
    }
    if (Array.isArray(value)) return value.map((item) => clean(item, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          privateField.test(key.replace(/[^a-z]/gi, '').toLowerCase())
            ? '[redacted]'
            : clean(item, depth + 1),
        ]),
      );
    }
    return value;
  };
  const result = z.record(z.string(), z.unknown()).parse(clean(JSON.parse(encoded), 0));
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 8192)
    throw new Error('The sanitized log message exceeds 8 KB.');
  return result;
}

export const logEventSchema = z
  .object({
    id: z.string().uuid(),
    timestamp: z.iso.datetime(),
    event: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_]*$/),
    level: z.enum(['info', 'warn', 'error']),
    sessionId: z.string().uuid().nullable(),
    requestId: z.string().uuid().nullable(),
    message: z.record(z.string(), z.unknown()).transform((value, context) => {
      try {
        return sanitizeLogMessage(value);
      } catch {
        context.addIssue({
          code: 'custom',
          message: 'Log message must be valid JSON within the size and depth limits.',
        });
        return z.NEVER;
      }
    }),
  })
  .strict();

const legacyEventNames = new Map([
  ['app.opened', 'user_open_app'],
  ['app.fatal', 'application_error'],
  ['auth.changed', 'user_authentication_changed'],
]);
const legacyLogEventSchema = logEventSchema
  .extend({
    event: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z][a-z0-9_.-]*$/),
    visitId: z.string().uuid().nullable().optional(),
    visitorId: z.string().uuid().nullable().optional(),
  })
  .transform(({ visitId: _visitId, visitorId: _visitorId, ...event }) => {
    const name =
      legacyEventNames.get(event.event) ??
      (logEventSchema.shape.event.safeParse(event.event).success ? event.event : null);
    return name ? logEventSchema.parse({ ...event, event: name }) : null;
  });

export const logBatchSchema = z
  .object({
    events: z
      .array(z.union([logEventSchema, legacyLogEventSchema]))
      .min(1)
      .max(5),
  })
  .strict()
  .transform(({ events }) => ({ events: events.filter((event) => event !== null) }));
