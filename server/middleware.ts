import type { Request, RequestHandler } from 'express';
import { isIP } from 'node:net';
import type { Config } from './config/environment.js';
import { AppError } from './errors/app-error.js';

export function realtimeClientIp(req: Request, config: Pick<Config, 'azureAppService'>) {
  let address = config.azureAppService ? req.get('client-ip') : req.socket.remoteAddress;
  if (config.azureAppService && address) {
    const endpoint = /^\[([^\]]+)\]:(\d{1,5})$/.exec(address) ?? /^(.*):(\d{1,5})$/.exec(address);
    if (endpoint && Number(endpoint[2]) <= 65535 && isIP(endpoint[1]!)) address = endpoint[1];
  }
  if (!address || !isIP(address))
    throw AppError.create(
      'client_ip_unavailable',
      address
        ? 'The voice connection IP endpoint is invalid.'
        : 'The platform did not supply the voice connection IP.',
    );
  if (isIP(address) === 4) return address;
  const normalized = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(normalized);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16);
    const low = parseInt(mapped[2]!, 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return normalized;
}

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
