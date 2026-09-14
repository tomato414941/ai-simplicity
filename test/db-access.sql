\set ON_ERROR_STOP on
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key);
-- Simulate the permissive defaults of an existing Supabase project.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
\ir /tmp/agent-sessions.sql

insert into auth.users values
  ('11111111-1111-4111-8111-111111111111'),
  ('22222222-2222-4222-8222-222222222222');

set role service_role;
insert into public.agent_sessions (user_id, session_id) values
  ('11111111-1111-4111-8111-111111111111', 'sess_a'),
  ('22222222-2222-4222-8222-222222222222', 'sess_b');
do $$ begin
  if (select session_id from public.agent_sessions where user_id = '11111111-1111-4111-8111-111111111111') <> 'sess_a' then
    raise exception 'Incorrect owner mapping';
  end if;
  begin
    insert into public.agent_sessions (user_id, session_id) values ('22222222-2222-4222-8222-222222222222', 'sess_a');
    raise exception 'Duplicate ownership must fail';
  exception when unique_violation then null;
  end;
end $$;
reset role;

do $$ declare role_name text; begin
  foreach role_name in array array['anon', 'authenticated'] loop
    if has_table_privilege(role_name, 'public.agent_sessions', 'select,insert,update,delete,truncate,references,trigger') then
      raise exception 'Client role retains table privileges: %', role_name;
    end if;
  end loop;
  if not (select relrowsecurity from pg_class where oid = 'public.agent_sessions'::regclass) then
    raise exception 'RLS must be enabled';
  end if;
  if has_table_privilege('service_role', 'public.agent_sessions', 'update,delete,truncate') then
    raise exception 'Runtime does not need to overwrite or delete ownership';
  end if;
end $$;

set role authenticated;
do $$ begin
  begin
    perform * from public.agent_sessions;
    raise exception 'Client read must fail';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.agent_sessions (user_id, session_id) values ('11111111-1111-4111-8111-111111111111', 'sess_stolen');
    raise exception 'Client ownership assignment must fail';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- Even if somebody later grants table access, RLS still denies client access.
grant select, insert on public.agent_sessions to authenticated;
set role authenticated;
do $$ begin
  if (select count(*) from public.agent_sessions) <> 0 then raise exception 'RLS leaked another conversation'; end if;
  begin
    insert into public.agent_sessions (user_id, session_id) values ('11111111-1111-4111-8111-111111111111', 'sess_stolen');
    raise exception 'RLS allowed forged ownership';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
revoke all on public.agent_sessions from authenticated;
select 'Ownership grants, RLS and uniqueness checks passed' as result;
