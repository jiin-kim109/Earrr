import type { LogEvent } from '../../shared/types/logging.js';

export interface LogContext {
  actorId?: string | null;
  sessionId?: string | null;
  visitId?: string | null;
  visitorId?: string | null;
  requestId?: string | null;
}

export interface LogRow {
  id: string;
  timestamp: string;
  event_name: string;
  level: LogEvent['level'];
  source: 'client' | 'server';
  actor_id: string | null;
  session_id: string | null;
  visit_id: string | null;
  visitor_id: string | null;
  request_id: string | null;
  release_id: string | null;
  environment: 'development' | 'test' | 'production';
  message: LogEvent['message'];
}
