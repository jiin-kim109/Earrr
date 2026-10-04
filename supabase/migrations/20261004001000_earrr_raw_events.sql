begin;

create table if not exists public.earrr_events (
  id uuid primary key,
  timestamp timestamptz not null,
  received_at timestamptz not null default now(),
  event_name text not null check (length(event_name) between 1 and 80),
  level text not null check (level in ('info', 'warn', 'error')),
  source text not null check (source in ('client', 'server')),
  actor_id text,
  session_id uuid,
  visit_id uuid,
  visitor_id uuid,
  request_id uuid,
  release_id text,
  environment text not null check (environment in ('development', 'test', 'production')),
  message jsonb not null check (jsonb_typeof(message) = 'object' and octet_length(message::text) <= 16384)
);
alter table public.earrr_events enable row level security;
revoke all on public.earrr_events from anon, authenticated;
grant select, insert, delete on public.earrr_events to service_role;

create index if not exists earrr_events_received on public.earrr_events(received_at);
create index if not exists earrr_events_session_time on public.earrr_events(session_id, timestamp desc);
create index if not exists earrr_events_actor_time on public.earrr_events(actor_id, timestamp desc);

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule(
  'earrr-events-retention',
  '17 * * * *',
  $$delete from public.earrr_events where received_at < now() - interval '30 days';$$
);

commit;
