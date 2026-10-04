begin;

-- Keep old and new app versions writable until the reduced event writer is deployed.
alter table public.earrr_events alter column source drop not null;
alter table public.earrr_events drop constraint earrr_events_event_name_check;
alter table public.earrr_events add constraint earrr_events_event_name_check
  check (length(event_name) between 1 and 128);

commit;
