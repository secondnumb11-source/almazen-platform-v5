-- =====================================================================
-- ALMAZEN — نظام التجربة المجانية 7 أيام + مدفوعات الاشتراك
-- انسخ هذا الملف بالكامل والصقه في Supabase SQL Editor ثم نفّذه.
-- Idempotent — آمن لإعادة التنفيذ مرات متعددة.
-- =====================================================================

-- 1) أعمدة الاشتراك والتجربة على companies
alter table public.companies
  add column if not exists plan text not null default 'trial'
    check (plan in ('trial','active','expired','suspended')),
  add column if not exists trial_started_at    timestamptz,
  add column if not exists trial_ends_at       timestamptz,
  add column if not exists subscription_ends_at timestamptz,
  add column if not exists activated_by_admin  boolean not null default false,
  add column if not exists owner_phone         text,
  add column if not exists owner_id_or_cr      text;

-- 2) الشركات الموجودة قبل هذا التحديث تُعامَل كنشطة حتى لا نكسر أي حساب حالي
update public.companies
   set plan = 'active',
       activated_by_admin = true
 where trial_ends_at is null and subscription_ends_at is null and plan = 'trial';

-- 3) جدول مدفوعات الاشتراك (تحويل بنكي / ميسر / أخرى)
create table if not exists public.subscription_payments (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  amount       numeric(12,2) not null,
  method       text not null check (method in ('bank_transfer','moyasar','other')),
  reference    text,
  receipt_url  text,
  status       text not null default 'pending'
                 check (status in ('pending','approved','rejected')),
  notes        text,
  created_at   timestamptz not null default now(),
  reviewed_at  timestamptz,
  reviewed_by  uuid references auth.users(id)
);

grant select, insert on public.subscription_payments to authenticated;
grant all on public.subscription_payments to service_role;

alter table public.subscription_payments enable row level security;

drop policy if exists sp_select on public.subscription_payments;
create policy sp_select on public.subscription_payments
  for select to authenticated
  using (company_id = public.current_company_id());

drop policy if exists sp_insert on public.subscription_payments;
create policy sp_insert on public.subscription_payments
  for insert to authenticated
  with check (company_id = public.current_company_id());

-- 4) Bucket خاص برفع إيصالات السداد (خاص — Signed URLs فقط)
insert into storage.buckets (id, name, public)
  values ('subscription-receipts','subscription-receipts', false)
  on conflict (id) do nothing;

drop policy if exists sr_upload on storage.objects;
create policy sr_upload on storage.objects
  for insert to authenticated
  with check (bucket_id = 'subscription-receipts');

drop policy if exists sr_read_own on storage.objects;
create policy sr_read_own on storage.objects
  for select to authenticated
  using (bucket_id = 'subscription-receipts' and owner = auth.uid());

-- 5) دالة حساب حالة الوصول الحيّة (تُستخدم من الواجهة والحماية)
create or replace function public.company_access_state(_company uuid)
returns table(plan text, active boolean, seconds_left bigint, ends_at timestamptz)
language sql stable security definer set search_path = public as $$
  select
    c.plan,
    case
      when c.activated_by_admin then true
      when c.plan = 'active'
           and (c.subscription_ends_at is null or c.subscription_ends_at > now()) then true
      when c.plan = 'trial'  and c.trial_ends_at is not null and c.trial_ends_at > now() then true
      else false
    end as active,
    greatest(0, extract(epoch from
      coalesce(c.subscription_ends_at, c.trial_ends_at, now()) - now())::bigint) as seconds_left,
    coalesce(c.subscription_ends_at, c.trial_ends_at) as ends_at
  from public.companies c
  where c.id = _company;
$$;
grant execute on function public.company_access_state(uuid) to authenticated;

-- 6) تحديث دالة تأسيس المالك لبدء فترة التجربة تلقائياً (7 أيام)
create or replace function public.bootstrap_owner(
  p_company_name text,
  p_full_name    text,
  p_vat_number   text default null,
  p_phone        text default null,
  p_id_or_cr     text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_co  uuid;
begin
  if v_uid is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;
  if coalesce(btrim(p_company_name),'') = '' or coalesce(btrim(p_full_name),'') = '' then
    raise exception 'اسم المنشأة والاسم الكامل مطلوبان' using errcode = '22023';
  end if;
  if exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'PROFILE_EXISTS' using errcode = '23505';
  end if;

  insert into public.companies (
    name, vat_number, owner_phone, owner_id_or_cr,
    plan, trial_started_at, trial_ends_at
  ) values (
    btrim(p_company_name),
    nullif(btrim(p_vat_number),''),
    nullif(btrim(p_phone),''),
    nullif(btrim(p_id_or_cr),''),
    'trial', now(), now() + interval '7 days'
  )
  returning id into v_co;

  insert into public.profiles (id, company_id, role, full_name)
    values (v_uid, v_co, 'owner', btrim(p_full_name));

  return v_co;
end
$$;
revoke all on function public.bootstrap_owner(text, text, text, text, text) from public;
grant execute on function public.bootstrap_owner(text, text, text, text, text) to authenticated;

-- 7) دوال إدارية يدوية (تُنفَّذ من SQL Editor فقط بصلاحية service_role)
create or replace function public.admin_extend_trial(_company uuid, _days int)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.companies
     set trial_ends_at = coalesce(trial_ends_at, now()) + make_interval(days => _days),
         plan = case when plan in ('expired','suspended') then 'trial' else plan end
   where id = _company;
end $$;

create or replace function public.admin_activate_subscription(_company uuid, _months int default 12)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.companies
     set plan = 'active',
         subscription_ends_at = coalesce(
           case when subscription_ends_at > now() then subscription_ends_at else now() end,
           now()
         ) + make_interval(months => _months)
   where id = _company;
end $$;

create or replace function public.admin_suspend_company(_company uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.companies set plan = 'suspended' where id = _company;
end $$;

create or replace function public.admin_force_active(_company uuid, _active boolean default true)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.companies set activated_by_admin = _active where id = _company;
end $$;

-- =====================================================================
-- أوامر إدارية جاهزة للاستخدام اليدوي من قِبل صاحب النظام:
--   -- تمديد فترة تجربة 15 يوم:
--   select public.admin_extend_trial('<company_uuid>', 15);
--
--   -- تفعيل اشتراك سنوي (12 شهر):
--   select public.admin_activate_subscription('<company_uuid>', 12);
--
--   -- تفعيل يدوي مفتوح المدة (ينفع للاختبار):
--   select public.admin_force_active('<company_uuid>', true);
--
--   -- إيقاف حساب:
--   select public.admin_suspend_company('<company_uuid>');
--
--   -- عرض كل الحسابات وحالتها:
--   select id, name, plan, trial_ends_at, subscription_ends_at, activated_by_admin
--     from public.companies order by created_at desc;
-- =====================================================================
