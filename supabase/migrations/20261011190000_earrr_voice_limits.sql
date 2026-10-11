begin;

create table public.earrr_voice_limits (
  ip_key text primary key check (ip_key ~ '^[0-9a-f]{64}$'),
  revision bigint not null check (revision > 0),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now()
);

alter table public.earrr_voice_limits enable row level security;
revoke all on public.earrr_voice_limits from anon, authenticated;
grant select, insert, update, delete on public.earrr_voice_limits to service_role;

create function public.earrr_write_voice_limit(
  subject_ip_key text,
  expected_revision bigint,
  next_data jsonb
) returns boolean
language plpgsql
set search_path = public
as $$
declare
  changed bigint;
begin
  if expected_revision = 0 then
    insert into earrr_voice_limits (ip_key, revision, data)
    values (subject_ip_key, 1, next_data)
    on conflict (ip_key) do nothing;
  else
    update earrr_voice_limits
    set revision = revision + 1, data = next_data, updated_at = now()
    where ip_key = subject_ip_key and revision = expected_revision;
  end if;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

revoke all on function public.earrr_write_voice_limit(text, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.earrr_write_voice_limit(text, bigint, jsonb) to service_role;

notify pgrst, 'reload schema';

commit;
