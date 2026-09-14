begin;

-- Only the API server can bind an OpenAI session to an authenticated user.
-- Clients must never be able to claim ownership of an arbitrary session_id.
create table public.agent_sessions (
  user_id uuid primary key references auth.users(id),
  session_id text not null unique check (length(session_id) > 0),
  created_at timestamptz not null default now()
);

alter table public.agent_sessions enable row level security;
revoke all on public.agent_sessions from public, anon, authenticated, service_role;
grant select, insert on public.agent_sessions to service_role;

commit;
