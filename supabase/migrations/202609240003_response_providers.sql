begin;

alter table public.responses
  add column provider text not null default 'openai' check (provider in ('openai', 'openrouter', 'anthropic')),
  add column upstream_id text,
  add column upstream_model text,
  add column input jsonb check (input is null or jsonb_typeof(input) = 'array'),
  add column response jsonb check (response is null or coalesce(jsonb_typeof(response) = 'object' and response->>'id' = id and response->>'object' = 'response', false));

update public.responses set upstream_id = id;
alter table public.responses alter column upstream_id set not null;
alter table public.responses alter column provider drop default;
create unique index responses_upstream on public.responses (provider, upstream_id);

-- The server can finish/delete snapshots, but cannot reassign their owner,
-- provider, upstream ID or original input. Clients retain no table access.
grant update (response), delete on public.responses to service_role;

commit;
