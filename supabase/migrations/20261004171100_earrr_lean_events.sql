begin;

update public.earrr_events
set event_name = replace(replace(event_name, '.', '_'), '-', '_')
where event_name ~ '[.-]';

update public.earrr_events set actor_id = null where actor_id like 'visitor:%';

alter table public.earrr_events
  drop column source,
  drop column visit_id,
  drop column visitor_id,
  drop column release_id;

alter table public.earrr_events drop constraint earrr_events_event_name_check;
alter table public.earrr_events add constraint earrr_events_event_name_check
  check (length(event_name) between 1 and 128 and event_name ~ '^[a-z][a-z0-9_]*$');

notify pgrst, 'reload schema';

commit;
