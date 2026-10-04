import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Config } from '../config/environment.js';
import { AppError } from './app-error.js';
import { Log } from '../services/log.service.js';

export function formatValidationError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'Request'}: ${issue.message}`)
    .join('; ');
}

function normalizedError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof ZodError)
    return AppError.create('invalid_request', formatValidationError(error));
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
    return AppError.create('connection_timeout');
  }
  if (error instanceof SyntaxError && 'status' in error) return AppError.create('invalid_json');
  return AppError.create('server_error');
}

export function requestErrors(
  config: Pick<Config, 'apiKey' | 'databaseUrl' | 'supabaseServiceKey' | 'learningSaveKey'>,
): ErrorRequestHandler {
  const secrets = [
    config.apiKey,
    config.databaseUrl ?? '',
    config.supabaseServiceKey ?? '',
    config.learningSaveKey ?? '',
  ].filter(Boolean);
  if (config.databaseUrl) {
    const password = new URL(config.databaseUrl).password;
    if (password) secrets.push(password, decodeURIComponent(password));
  }
  const redact = (message: string) =>
    secrets.reduce((text, secret) => text.replaceAll(secret, '[redacted]'), message);
  return (error: unknown, req, res, next) => {
    if (res.headersSent) return next(error);
    const failure = normalizedError(error);
    if (req.path !== '/api/logs') {
      const recorded = new Error(redact(error instanceof Error ? error.message : failure.message));
      if (error instanceof Error) {
        recorded.name = error.name;
        if (error.stack) recorded.stack = redact(error.stack);
      }
      Log.error('request.failed', recorded, {
        path: req.path,
        code: failure.code,
        status: failure.status,
        exception: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    if (failure.code === 'server_error') {
      const detail =
        error instanceof Error
          ? (error.stack ?? error.message)
          : 'A non-Error exception was thrown.';
      console.error('[earrr] Request failed:', redact(detail));
    }
    res.status(failure.status).json({
      error: { code: failure.code, message: redact(failure.message) },
    });
  };
}
