begin;

create table if not exists public.earrr_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  first_name text not null default '',
  last_name text not null default '',
  email text not null default '',
  updated_at timestamptz not null default now()
);
alter table public.earrr_profiles enable row level security;
drop policy if exists "Read own Earrr profile" on public.earrr_profiles;
create policy "Read own Earrr profile" on public.earrr_profiles
  for select to authenticated using (user_id = auth.uid());
grant select on public.earrr_profiles to authenticated;
revoke all on public.earrr_profiles from anon;

create or replace function public.earrr_profile_from_auth()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.earrr_profiles(user_id, first_name, last_name, email)
  values(new.id, left(coalesce(new.raw_user_meta_data->>'first_name',''),80),
    left(coalesce(new.raw_user_meta_data->>'last_name',''),80),coalesce(new.email,''))
  on conflict(user_id) do update set first_name=excluded.first_name,
    last_name=excluded.last_name,email=excluded.email,updated_at=now();
  return new;
end;
$$;
drop trigger if exists earrr_auth_profile on auth.users;
create trigger earrr_auth_profile after insert or update of email,raw_user_meta_data
  on auth.users for each row execute function public.earrr_profile_from_auth();

create table if not exists public.earrr_learning_saves (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null check(revision>0),
  payload text not null,
  imported_guest_id uuid,
  updated_at timestamptz not null default now()
);
alter table public.earrr_learning_saves enable row level security;
drop policy if exists "Read own encrypted Earrr progress" on public.earrr_learning_saves;
create policy "Read own encrypted Earrr progress" on public.earrr_learning_saves
  for select to authenticated using(user_id=auth.uid());
grant select on public.earrr_learning_saves to authenticated;
revoke insert,update,delete on public.earrr_learning_saves from anon,authenticated;
grant all on public.earrr_profiles,public.earrr_learning_saves to service_role;

create or replace function public.earrr_save_learning(
  subject_user_id uuid,expected_revision bigint,next_payload text,guest_import_id uuid default null
) returns boolean language plpgsql security invoker set search_path = '' as $$
declare changed integer;
begin
  if expected_revision < 0 then raise exception 'Invalid progress revision'; end if;
  if expected_revision = 0 then
    insert into public.earrr_learning_saves(user_id,revision,payload,imported_guest_id)
      values(subject_user_id,1,next_payload,guest_import_id) on conflict(user_id) do nothing;
  else
    update public.earrr_learning_saves set revision=expected_revision+1,
      payload=next_payload,imported_guest_id=guest_import_id,updated_at=now()
      where user_id=subject_user_id and revision=expected_revision;
  end if;
  get diagnostics changed=row_count;
  return changed=1;
end;
$$;
revoke all on function public.earrr_save_learning(uuid,bigint,text,uuid) from public,anon,authenticated;
grant execute on function public.earrr_save_learning(uuid,bigint,text,uuid) to service_role;

commit;
