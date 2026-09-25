-- Read-only post-rollback proof; never inspect or print real Auth rows.
select current_database(),current_user,
 to_regnamespace('rooted') is not null as rooted_installed,
 to_regclass('supabase_migrations.schema_migrations') is not null as migration_ledger_exists,
 (select count(*) from auth.users where id in ('00000000-0000-4000-8000-000000000001'::uuid,'00000000-0000-4000-8000-000000000002'::uuid,'00000000-0000-4000-8000-000000000003'::uuid)) as synthetic_users_remaining,
 (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'rooted_%') as rooted_public_functions_remaining;
