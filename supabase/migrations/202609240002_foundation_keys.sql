begin;

-- Which Foundation key each user's conversation carries, by ID only. Only the API server reads or
-- writes it; the secret itself is never stored here.
create table public.foundation_keys (
  user_id uuid primary key references auth.users(id),
  key_id text not null check (length(key_id) > 0),
  updated_at timestamptz not null default now()
);

alter table public.foundation_keys enable row level security;
revoke all on public.foundation_keys from public, anon, authenticated, service_role;
grant select, insert, update on public.foundation_keys to service_role;

commit;
