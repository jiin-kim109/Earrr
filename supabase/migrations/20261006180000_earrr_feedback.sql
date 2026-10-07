begin;

create table public.earrr_feedback (
  actor_id text primary key check (actor_id ~ '^(account|guest):[0-9a-f-]{36}$'),
  session_id uuid,
  rating smallint not null check (rating between 1 and 5),
  message text not null check (length(btrim(message)) between 1 and 4000),
  reply_email text check (reply_email is null or length(reply_email) between 3 and 254),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.earrr_feedback enable row level security;
revoke all on public.earrr_feedback from anon, authenticated;
grant select, insert, update on public.earrr_feedback to service_role;

notify pgrst, 'reload schema';

commit;
