-- OWNER-APPROVED PRODUCTION OPERATION ONLY, after backup and migration 00400.
-- Execute only on Supabase sfrkowqljeaztupywtzy, not another project.
-- Owner confirmed: no lessons on the LAST Friday of each month prospectively.
-- Historical Sep25 gathering/check-ins/ledger stay intact; third Fridays remain.
begin;
do $$ begin
 if not exists(select 1 from rooted.seasons where id='7df59d3a-685b-4878-bfb0-b975394cd548' and active and starts_on='2026-09-25' and ends_on='2027-05-28') then
  raise exception 'Expected production season/bounds missing; refusing activation';
 end if;
 if not exists(select 1 from pg_available_extensions where name='pg_cron') then raise exception 'pg_cron unavailable'; end if;
end $$;
create extension if not exists pg_cron;
insert into rooted.weekly_schedule(season_id,enabled,title)
values('7df59d3a-685b-4878-bfb0-b975394cd548',true,'Rooted Teens')
on conflict(season_id) do update set enabled=true,title=excluded.title;
-- Job name is stable: cron.schedule updates rather than duplicating it.
select cron.schedule('rooted-weekly-maintenance','*/5 * * * *','select rooted.weekly_maintain();');
select rooted.weekly_maintain();
commit;
-- Independent readback required: cron.job active schedule/command, all bounded
-- eligible Friday dates (excluding last Fridays), historical Sep25 preservation,
-- no points/attendance changes, and successful cron.job_run_details.
