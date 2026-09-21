begin;

-- Measurements and supplier costs are independent of customer credit charges.
-- Corrections append a replacement, preserving the original evidence.
create table public.billing_usage (
  id uuid primary key default gen_random_uuid(),
  source text not null check (length(source) between 1 and 100),
  reference text not null check (length(reference) between 1 and 512),
  user_id uuid references auth.users(id),
  metric text not null check (length(metric) between 1 and 100),
  unit text not null check (length(unit) between 1 and 100),
  quantity numeric(30,9) check (quantity >= 0 and quantity < 'Infinity'::numeric),
  status text not null check (status in ('unknown', 'provisional', 'final')),
  occurred_at timestamptz not null,
  period_end timestamptz check (period_end >= occurred_at),
  supersedes_id uuid unique references public.billing_usage(id),
  created_at timestamptz not null default now(),
  unique (source, reference),
  check ((status = 'unknown') = (quantity is null))
);

create table public.billing_costs (
  id uuid primary key default gen_random_uuid(),
  source text not null check (length(source) between 1 and 100),
  reference text not null check (length(reference) between 1 and 512),
  user_id uuid references auth.users(id),
  attribution text not null check (attribution in ('user', 'shared', 'unassigned')),
  amount numeric(30,9) check (abs(amount) < 'Infinity'::numeric),
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  status text not null check (status in ('unknown', 'estimated', 'final')),
  occurred_at timestamptz not null,
  period_end timestamptz check (period_end >= occurred_at),
  usage_id uuid references public.billing_usage(id),
  supersedes_id uuid unique references public.billing_costs(id),
  created_at timestamptz not null default now(),
  unique (source, reference),
  check ((attribution = 'user') = (user_id is not null)),
  check ((status = 'unknown') = (amount is null))
);

create table public.credit_accounts (
  user_id uuid primary key references auth.users(id),
  balance bigint not null default 0 check (balance >= 0),
  reserved bigint not null default 0 check (reserved >= 0 and reserved <= balance)
);

create table public.credit_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.credit_accounts(user_id),
  reference text not null check (length(reference) between 1 and 512),
  credits bigint not null check (credits > 0),
  pricing jsonb not null check (jsonb_typeof(pricing) = 'object' and pricing ? 'version' and
    jsonb_typeof(pricing->'version') = 'string' and length(pricing->>'version') > 0),
  review_at timestamptz not null,
  status text not null default 'held' check (status in ('held', 'settled', 'released')),
  charged bigint check (charged >= 0 and charged <= credits),
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (user_id, reference),
  check ((status = 'settled') = (charged is not null)),
  check ((status = 'held') = (resolved_at is null))
);

create table public.credit_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.credit_accounts(user_id),
  source text not null check (length(source) between 1 and 100),
  reference text not null check (length(reference) between 1 and 512),
  kind text not null check (kind in ('grant', 'charge', 'refund')),
  credits bigint not null,
  reason text not null check (length(reason) between 1 and 200),
  reservation_id uuid unique references public.credit_reservations(id),
  refunds_id uuid unique references public.credit_entries(id),
  pricing jsonb,
  created_at timestamptz not null default now(),
  unique (source, reference),
  check ((kind = 'charge' and credits <= 0 and reservation_id is not null and refunds_id is null and pricing is not null)
    or (kind = 'grant' and credits > 0 and reservation_id is null and refunds_id is null and pricing is null)
    or (kind = 'refund' and credits > 0 and reservation_id is null and refunds_id is not null and pricing is null))
);

create index credit_entries_user_history on public.credit_entries (user_id, created_at desc, id desc);
create index credit_reservations_review on public.credit_reservations (review_at) where status = 'held';
create index billing_usage_user on public.billing_usage (user_id, occurred_at);
create index billing_costs_user on public.billing_costs (user_id, occurred_at);

-- Numeric values cross JSON boundaries as strings, never lossy JS numbers.
create view public.current_billing_usage with (security_invoker = true) as
  select u.id, u.source, u.reference, u.user_id, u.metric, u.unit, u.quantity::text,
    u.status, u.occurred_at, u.period_end, u.created_at
  from public.billing_usage u
  where not exists (select 1 from public.billing_usage replacement where replacement.supersedes_id = u.id);

create view public.current_billing_costs with (security_invoker = true) as
  select c.id, c.source, c.reference, c.user_id, c.attribution, c.amount::text,
    c.currency, c.status, c.occurred_at, c.period_end, c.usage_id, c.created_at
  from public.billing_costs c
  where not exists (select 1 from public.billing_costs replacement where replacement.supersedes_id = c.id);

create view public.credit_history with (security_invoker = true) as
  select id, user_id, kind, credits::text, reason, pricing, refunds_id, created_at
  from public.credit_entries;

create function public.billing_record_usage(p_record jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare candidate public.billing_usage; existing public.billing_usage; previous public.billing_usage;
begin
  candidate := jsonb_populate_record(null::public.billing_usage, p_record);
  if candidate.supersedes_id is not null then
    select * into strict previous from public.billing_usage where id = candidate.supersedes_id for update;
    if (previous.source, previous.metric, previous.unit, previous.occurred_at, previous.period_end)
      is distinct from (candidate.source, candidate.metric, candidate.unit, candidate.occurred_at, candidate.period_end)
      or (previous.user_id is not null and previous.user_id is distinct from candidate.user_id) then
      raise exception using errcode = 'P0001', message = 'replacement_mismatch';
    end if;
  end if;
  insert into public.billing_usage (source, reference, user_id, metric, unit, quantity, status, occurred_at, period_end, supersedes_id)
    values (candidate.source, candidate.reference, candidate.user_id, candidate.metric, candidate.unit, candidate.quantity,
      candidate.status, candidate.occurred_at, candidate.period_end, candidate.supersedes_id)
    on conflict (source, reference) do nothing returning * into existing;
  if existing.id is null then
    select * into strict existing from public.billing_usage where source = candidate.source and reference = candidate.reference;
    if (existing.user_id, existing.metric, existing.unit, existing.quantity, existing.status, existing.occurred_at, existing.period_end, existing.supersedes_id)
      is distinct from (candidate.user_id, candidate.metric, candidate.unit, candidate.quantity, candidate.status, candidate.occurred_at, candidate.period_end, candidate.supersedes_id) then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
  end if;
  return existing.id;
end $$;

create function public.billing_record_cost(p_record jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare candidate public.billing_costs; existing public.billing_costs; previous public.billing_costs; usage_owner uuid;
begin
  candidate := jsonb_populate_record(null::public.billing_costs, p_record);
  if candidate.usage_id is not null then
    select user_id into strict usage_owner from public.billing_usage where id = candidate.usage_id;
    if usage_owner is distinct from candidate.user_id then
      raise exception using errcode = 'P0001', message = 'usage_owner_mismatch';
    end if;
  end if;
  if candidate.supersedes_id is not null then
    select * into strict previous from public.billing_costs where id = candidate.supersedes_id for update;
    if (previous.source, previous.currency, previous.occurred_at, previous.period_end)
      is distinct from (candidate.source, candidate.currency, candidate.occurred_at, candidate.period_end)
      or (previous.attribution <> 'unassigned' and (previous.user_id, previous.attribution, previous.usage_id)
        is distinct from (candidate.user_id, candidate.attribution, candidate.usage_id)) then
      raise exception using errcode = 'P0001', message = 'replacement_mismatch';
    end if;
  end if;
  insert into public.billing_costs (source, reference, user_id, attribution, amount, currency, status, occurred_at, period_end, usage_id, supersedes_id)
    values (candidate.source, candidate.reference, candidate.user_id, candidate.attribution, candidate.amount, candidate.currency,
      candidate.status, candidate.occurred_at, candidate.period_end, candidate.usage_id, candidate.supersedes_id)
    on conflict (source, reference) do nothing returning * into existing;
  if existing.id is null then
    select * into strict existing from public.billing_costs where source = candidate.source and reference = candidate.reference;
    if (existing.user_id, existing.attribution, existing.amount, existing.currency, existing.status, existing.occurred_at, existing.period_end, existing.usage_id, existing.supersedes_id)
      is distinct from (candidate.user_id, candidate.attribution, candidate.amount, candidate.currency, candidate.status, candidate.occurred_at, candidate.period_end, candidate.usage_id, candidate.supersedes_id) then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
  end if;
  return existing.id;
end $$;

create function public.credit_balance(p_user_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('unit', 'credit', 'balance', coalesce(a.balance, 0)::text,
    'reserved', coalesce(a.reserved, 0)::text, 'available', (coalesce(a.balance, 0) - coalesce(a.reserved, 0))::text)
  from (select 1) singleton left join public.credit_accounts a on a.user_id = p_user_id;
$$;

create function public.credit_grant(p_user_id uuid, p_source text, p_reference text, p_credits bigint, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare existing public.credit_entries;
begin
  if p_credits is null or p_credits <= 0 then raise exception using errcode = '22023', message = 'invalid_credits'; end if;
  insert into public.credit_accounts (user_id) values (p_user_id) on conflict do nothing;
  perform 1 from public.credit_accounts where user_id = p_user_id for update;
  insert into public.credit_entries (user_id, source, reference, kind, credits, reason)
    values (p_user_id, p_source, p_reference, 'grant', p_credits, p_reason)
    on conflict (source, reference) do nothing returning * into existing;
  if existing.id is null then
    select * into strict existing from public.credit_entries where source = p_source and reference = p_reference;
    if (existing.user_id, existing.kind, existing.credits, existing.reason) is distinct from (p_user_id, 'grant'::text, p_credits, p_reason) then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
  else
    update public.credit_accounts set balance = balance + p_credits where user_id = p_user_id;
  end if;
  return existing.id;
end $$;

create function public.credit_reserve(p_user_id uuid, p_reference text, p_credits bigint, p_pricing jsonb, p_review_at timestamptz) returns uuid
language plpgsql security definer set search_path = '' as $$
declare account public.credit_accounts; existing public.credit_reservations;
begin
  if p_credits is null or p_credits <= 0 then raise exception using errcode = '22023', message = 'invalid_credits'; end if;
  insert into public.credit_accounts (user_id) values (p_user_id) on conflict do nothing;
  select * into strict account from public.credit_accounts where user_id = p_user_id for update;
  select * into existing from public.credit_reservations where user_id = p_user_id and reference = p_reference;
  if found then
    if (existing.credits, existing.pricing, existing.review_at) is distinct from (p_credits, p_pricing, p_review_at) then
      raise exception using errcode = 'P0001', message = 'idempotency_conflict';
    end if;
    return existing.id;
  end if;
  if p_review_at is null or p_review_at <= now() then raise exception using errcode = '22023', message = 'invalid_review_time'; end if;
  if account.balance - account.reserved < p_credits then raise exception using errcode = 'P0001', message = 'insufficient_credits'; end if;
  insert into public.credit_reservations (user_id, reference, credits, pricing, review_at)
    values (p_user_id, p_reference, p_credits, p_pricing, p_review_at) returning * into existing;
  update public.credit_accounts set reserved = reserved + p_credits where user_id = p_user_id;
  return existing.id;
end $$;

create function public.credit_settle(p_user_id uuid, p_reservation_id uuid, p_credits bigint) returns uuid
language plpgsql security definer set search_path = '' as $$
declare reservation public.credit_reservations; entry_id uuid;
begin
  perform 1 from public.credit_accounts where user_id = p_user_id for update;
  select * into strict reservation from public.credit_reservations where id = p_reservation_id and user_id = p_user_id;
  if p_credits is null or p_credits < 0 or p_credits > reservation.credits then
    raise exception using errcode = '22023', message = 'invalid_settlement';
  end if;
  if reservation.status = 'settled' and reservation.charged = p_credits then
    select id into strict entry_id from public.credit_entries where reservation_id = reservation.id;
    return entry_id;
  end if;
  if reservation.status <> 'held' then raise exception using errcode = 'P0001', message = 'reservation_resolved'; end if;
  insert into public.credit_entries (user_id, source, reference, kind, credits, reason, reservation_id, pricing)
    values (p_user_id, 'billing', 'charge:' || reservation.id, 'charge', -p_credits, 'usage', reservation.id, reservation.pricing)
    returning id into entry_id;
  update public.credit_accounts set balance = balance - p_credits, reserved = reserved - reservation.credits where user_id = p_user_id;
  update public.credit_reservations set status = 'settled', charged = p_credits, resolution = 'usage', resolved_at = now() where id = reservation.id;
  return entry_id;
end $$;

create function public.credit_release(p_user_id uuid, p_reservation_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
declare reservation public.credit_reservations;
begin
  if p_reason is null or length(p_reason) not between 1 and 200 then raise exception using errcode = '22023', message = 'invalid_reason'; end if;
  perform 1 from public.credit_accounts where user_id = p_user_id for update;
  select * into strict reservation from public.credit_reservations where id = p_reservation_id and user_id = p_user_id;
  if reservation.status = 'released' and reservation.resolution = p_reason then return; end if;
  if reservation.status <> 'held' then raise exception using errcode = 'P0001', message = 'reservation_resolved'; end if;
  update public.credit_accounts set reserved = reserved - reservation.credits where user_id = p_user_id;
  update public.credit_reservations set status = 'released', resolution = p_reason, resolved_at = now() where id = reservation.id;
end $$;

create function public.credit_refund(p_user_id uuid, p_charge_id uuid, p_reason text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare charge public.credit_entries; existing public.credit_entries;
begin
  if p_reason is null or length(p_reason) not between 1 and 200 then raise exception using errcode = '22023', message = 'invalid_reason'; end if;
  perform 1 from public.credit_accounts where user_id = p_user_id for update;
  select * into strict charge from public.credit_entries where id = p_charge_id and user_id = p_user_id and kind = 'charge' and credits < 0;
  select * into existing from public.credit_entries where refunds_id = charge.id;
  if found then
    if existing.reason <> p_reason then raise exception using errcode = 'P0001', message = 'idempotency_conflict'; end if;
    return existing.id;
  end if;
  insert into public.credit_entries (user_id, source, reference, kind, credits, reason, refunds_id)
    values (p_user_id, 'billing', 'refund:' || charge.id, 'refund', -charge.credits, p_reason, charge.id) returning * into existing;
  update public.credit_accounts set balance = balance - charge.credits where user_id = p_user_id;
  return existing.id;
end $$;

-- The runtime reads records but can mutate balances only through atomic RPCs.
-- A browser JWT, including an anonymous-auth JWT, cannot call these functions.
alter table public.billing_usage enable row level security;
alter table public.billing_costs enable row level security;
alter table public.credit_accounts enable row level security;
alter table public.credit_reservations enable row level security;
alter table public.credit_entries enable row level security;
revoke all on public.billing_usage, public.billing_costs, public.credit_accounts, public.credit_reservations, public.credit_entries,
  public.current_billing_usage, public.current_billing_costs, public.credit_history from public, anon, authenticated, service_role;
grant select on public.billing_usage, public.billing_costs, public.credit_accounts, public.credit_reservations, public.credit_entries,
  public.current_billing_usage, public.current_billing_costs, public.credit_history to service_role;

revoke all on function public.billing_record_usage(jsonb), public.billing_record_cost(jsonb), public.credit_balance(uuid),
  public.credit_grant(uuid,text,text,bigint,text), public.credit_reserve(uuid,text,bigint,jsonb,timestamptz),
  public.credit_settle(uuid,uuid,bigint), public.credit_release(uuid,uuid,text), public.credit_refund(uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.billing_record_usage(jsonb), public.billing_record_cost(jsonb), public.credit_balance(uuid),
  public.credit_grant(uuid,text,text,bigint,text), public.credit_reserve(uuid,text,bigint,jsonb,timestamptz),
  public.credit_settle(uuid,uuid,bigint), public.credit_release(uuid,uuid,text), public.credit_refund(uuid,uuid,text)
  to service_role;

commit;
