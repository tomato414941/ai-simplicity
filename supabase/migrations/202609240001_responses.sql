begin;

-- Only ownership is stored here. OpenAI retains response bodies when store=true.
create table public.responses (
  id text primary key check (id ~ '^resp_[A-Za-z0-9_-]{1,200}$'),
  user_id uuid not null references auth.users(id)
);

alter table public.responses enable row level security;
revoke all on public.responses from public, anon, authenticated, service_role;
grant select, insert on public.responses to service_role;

commit;
