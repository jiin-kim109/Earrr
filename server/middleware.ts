import type { RequestHandler } from 'express';
import type { Config } from './config/environment.js';
import { AppError } from './errors/app-error.js';

export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'microphone=(self), speaker-selection=(self), camera=()');
  next();
};

export function ownOriginApiOnly(
  config: Pick<Config, 'allowedOrigins' | 'publicOrigin' | 'listenHost'>,
): RequestHandler {
  const origins = new Set([
    ...(config.allowedOrigins ?? []),
    ...(config.publicOrigin ? [config.publicOrigin] : []),
  ]);
  const hosts = new Set([...origins].map((origin) => new URL(origin).host));
  const allowLocal =
    config.listenHost === '127.0.0.1' || (hosts.size === 0 && config.listenHost !== '0.0.0.0');
  return (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    const host = (req.get('host') ?? '').toLowerCase();
    const local = allowLocal && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    if (!local && !hosts.has(host))
      return next(
        AppError.create('local_only', 'Access this API through a configured Earrr hostname.'),
      );
    const origin = req.get('origin');
    const ownOrigin = local
      ? origin === `http://${host}` || origin === `https://${host}`
      : origin !== undefined && origins.has(origin) && new URL(origin).host === host;
    if (origin && !ownOrigin)
      return next(AppError.create('cross_origin', 'Cross-origin access to Earrr is not allowed.'));
    if (!['GET', 'HEAD'].includes(req.method) && req.get('x-earrr-client') !== '1')
      return next(
        AppError.create('client_header_required', 'This action must come from the Earrr app.'),
      );
    next();
  };
}
