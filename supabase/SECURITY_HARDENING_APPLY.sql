-- =====================================================================
-- ALMAZEN — Security Hardening (READY TO PASTE in Supabase SQL Editor)
-- Fixes:
--  (1) Report RPCs: enforce company ownership check to block cross-tenant leaks
--  (2) Isolate integration API keys (ejar/zatca) in role-restricted table
--  (3) Lock down admin_* billing RPCs (revoke PUBLIC execute; service_role only)
--  (4) Remove plaintext tenant portal password column
-- Idempotent — safe to run repeatedly.
-- =====================================================================

-- (1) Report RPCs — ownership check
create or replace function public.dashboard_today(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if p_company is null or p_company <> public.current_company_id() then
    raise exception 'FORBIDDEN';
  end if;
  return (select jsonb_build_object(
    'bookings_today',   (select count(*) from bookings  where company_id = p_company and created_at::date = current_date),
    'vacant_units',     (select count(*) from units     where company_id = p_company and status = 'available' and is_active),
    'occupied_units',   (select count(*) from units     where company_id = p_company and status = 'occupied'),
    'departures_today', (select count(*) from bookings  where company_id = p_company and check_out_date = current_date and status = 'checked_in'),
    'arrivals_today',   (select count(*) from bookings  where company_id = p_company and check_in_date = current_date and status = 'confirmed')
  ));
end $$;

create or replace function public.occupancy_rate(p_company uuid, p_from date, p_to date)
returns numeric language plpgsql stable security definer set search_path = public as $$
begin
  if p_company is null or p_company <> public.current_company_id() then
    raise exception 'FORBIDDEN';
  end if;
  return (select round(
    100.0 * coalesce(sum(least(b.check_out_date, p_to) - greatest(b.check_in_date, p_from)), 0)
    / nullif((select count(*) from units where company_id = p_company and is_active) * (p_to - p_from), 0), 2)
  from bookings b
  where b.company_id = p_company
    and b.status in ('checked_in','checked_out','confirmed')
    and daterange(b.check_in_date, b.check_out_date, '[)') && daterange(p_from, p_to, '[)'));
end $$;

create or replace function public.unit_history(p_unit uuid, p_from date default null, p_to date default null, p_customer uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (
    select 1 from units where id = p_unit and company_id = public.current_company_id()
  ) then
    raise exception 'FORBIDDEN';
  end if;
  return (select jsonb_build_object(
    'bookings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'booking_id', b.id, 'customer', c.full_name, 'from', b.check_in_date,
        'to', b.check_out_date, 'total', b.total_amount, 'status', b.status,
        'down_payment', b.down_payment, 'insurance', b.insurance_amount,
        'paid', (select coalesce(sum(p.amount),0) from payments p where p.booking_id = b.id)
      ) order by b.check_in_date desc)
      from bookings b join customers c on c.id = b.customer_id
      where b.unit_id = p_unit
        and (p_from is null or b.check_out_date >= p_from)
        and (p_to   is null or b.check_in_date  <= p_to)
        and (p_customer is null or b.customer_id = p_customer)
    ), '[]'::jsonb),
    'times_rented',    (select count(*) from bookings where unit_id = p_unit and status <> 'cancelled'),
    'total_revenue',   (select coalesce(sum(p.amount),0) from payments p join bookings b on b.id = p.booking_id where b.unit_id = p_unit),
    'total_expenses',  (select coalesce(sum(amount),0) from expenses where unit_id = p_unit),
    'maintenance_count', (select count(*) from maintenance_requests where unit_id = p_unit),
    'net_profit',      (select coalesce((select sum(p.amount) from payments p join bookings b on b.id = p.booking_id where b.unit_id = p_unit),0)
                        - coalesce((select sum(amount) from expenses where unit_id = p_unit),0))
  ));
end $$;

create or replace function public.overdue_payments(p_company uuid, p_days int default 1)
returns table (booking_id uuid, customer_name text, phone text, unit_number text,
               due_date date, amount_due numeric, days_late int)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_company is null or p_company <> public.current_company_id() then
    raise exception 'FORBIDDEN';
  end if;
  return query
    select ps.booking_id, c.full_name, c.phone, u.unit_number,
           ps.due_date, ps.amount_due, (current_date - ps.due_date)::int
    from payment_schedules ps
    join bookings b on b.id = ps.booking_id
    join customers c on c.id = b.customer_id
    join units u on u.id = b.unit_id
    where ps.company_id = p_company and not ps.is_paid
      and current_date - ps.due_date >= p_days
    order by ps.due_date;
end $$;

-- (2) Isolate integration API keys
create table if not exists public.company_secrets (
  company_id    uuid primary key references public.companies(id) on delete cascade,
  ejar_api_key  text,
  zatca_api_key text,
  updated_at    timestamptz not null default now()
);

grant select, insert, update, delete on public.company_secrets to authenticated;
grant all on public.company_secrets to service_role;

alter table public.company_secrets enable row level security;

drop policy if exists company_secrets_select on public.company_secrets;
create policy company_secrets_select on public.company_secrets for select to authenticated
  using (company_id = public.current_company_id()
         and public.current_role_of_user() in ('owner','manager','accountant'));

drop policy if exists company_secrets_insert on public.company_secrets;
create policy company_secrets_insert on public.company_secrets for insert to authenticated
  with check (company_id = public.current_company_id()
              and public.current_role_of_user() in ('owner','manager','accountant'));

drop policy if exists company_secrets_update on public.company_secrets;
create policy company_secrets_update on public.company_secrets for update to authenticated
  using (company_id = public.current_company_id()
         and public.current_role_of_user() in ('owner','manager','accountant'))
  with check (company_id = public.current_company_id()
              and public.current_role_of_user() in ('owner','manager','accountant'));

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'companies'
      and column_name in ('ejar_api_key','zatca_api_key')
  ) then
    insert into public.company_secrets (company_id, ejar_api_key, zatca_api_key)
      select id,
             (to_jsonb(c) ->> 'ejar_api_key'),
             (to_jsonb(c) ->> 'zatca_api_key')
      from public.companies c
    on conflict (company_id) do update
      set ejar_api_key  = coalesce(excluded.ejar_api_key,  public.company_secrets.ejar_api_key),
          zatca_api_key = coalesce(excluded.zatca_api_key, public.company_secrets.zatca_api_key),
          updated_at    = now();
  end if;
end $$;

alter table public.companies drop column if exists ejar_api_key;
alter table public.companies drop column if exists zatca_api_key;

-- (3) Lock down admin billing RPCs
do $$
declare r record;
begin
  for r in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('admin_extend_trial','admin_activate_subscription','admin_suspend_company','admin_force_active')
  loop
    execute format('revoke all on function public.%I(%s) from public',        r.proname, r.args);
    execute format('revoke all on function public.%I(%s) from anon',          r.proname, r.args);
    execute format('revoke all on function public.%I(%s) from authenticated', r.proname, r.args);
    execute format('grant execute on function public.%I(%s) to service_role', r.proname, r.args);
  end loop;
end $$;

-- (4) Remove plaintext tenant portal password (portal auth uses secure access_token)
alter table public.customers drop column if exists portal_password;
