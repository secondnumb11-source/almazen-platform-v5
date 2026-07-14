-- =====================================================================
-- ALMAZEN — المرحلة 1: توسعة الوحدات (أثاث + وسائط + رابط مشاركة)
-- + جداول Handovers و Discount Requests
-- Idempotent — انسخ محتوى هذا الملف كاملاً وألصقه في SQL Editor بمشروع Supabase ثم نفّذه.
-- =====================================================================

-- 1) توسعة units
alter table public.units
  add column if not exists is_furnished boolean not null default false,
  add column if not exists furniture_checklist jsonb not null default '[]'::jsonb,
  add column if not exists share_slug text unique;

update public.units
   set share_slug = lower(replace(gen_random_uuid()::text, '-', ''))
 where share_slug is null;

-- 2) جدول تسليم/استلام
create table if not exists public.handovers (
  id           uuid primary key default uuid_generate_v4(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  unit_id      uuid not null references public.units(id) on delete cascade,
  booking_id   uuid references public.bookings(id) on delete set null,
  kind         text not null check (kind in ('check_in','check_out')),
  checklist    jsonb not null default '[]'::jsonb,
  notes        text,
  signed_by    text,
  created_by   uuid references public.profiles(id),
  created_at   timestamptz not null default now()
);
create index if not exists idx_handovers_unit on public.handovers(unit_id);
create index if not exists idx_handovers_company on public.handovers(company_id);

grant select, insert, update, delete on public.handovers to authenticated;
grant all on public.handovers to service_role;

alter table public.handovers enable row level security;
drop policy if exists handovers_company_all on public.handovers;
create policy handovers_company_all on public.handovers for all to authenticated
  using (company_id = (select company_id from public.profiles where id = auth.uid()))
  with check (company_id = (select company_id from public.profiles where id = auth.uid()));

-- 3) طلبات موافقة على الخصم
create table if not exists public.discount_requests (
  id           uuid primary key default uuid_generate_v4(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  booking_id   uuid references public.bookings(id) on delete cascade,
  unit_id      uuid references public.units(id) on delete set null,
  requested_by uuid references public.profiles(id),
  percent      numeric(5,2) not null,
  amount       numeric(12,2),
  reason       text,
  status       text not null default 'pending' check (status in ('pending','approved','rejected')),
  reviewed_by  uuid references public.profiles(id),
  reviewed_at  timestamptz,
  review_note  text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_discount_requests_company on public.discount_requests(company_id, status);

grant select, insert, update, delete on public.discount_requests to authenticated;
grant all on public.discount_requests to service_role;

alter table public.discount_requests enable row level security;
drop policy if exists dreq_company_all on public.discount_requests;
create policy dreq_company_all on public.discount_requests for all to authenticated
  using (company_id = (select company_id from public.profiles where id = auth.uid()))
  with check (company_id = (select company_id from public.profiles where id = auth.uid()));

-- 4) القراءة العامة (بدون تسجيل دخول) للوحدة عبر share_slug:
--    ⚠ لا تُمنح anon قراءة شاملة على units/unit_media (كان ذلك يسرّب
--    كتالوج كل الشركات). القراءة العامة تمرّ حصراً عبر الدالة الآمنة
--    public.public_unit_by_slug(text) المعرّفة في SECURITY_FIXES_READY_TO_PASTE.sql
--    والتي تُرجع الوحدة المطابقة للـ slug فقط.

