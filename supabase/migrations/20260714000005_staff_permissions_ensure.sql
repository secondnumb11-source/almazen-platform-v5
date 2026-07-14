-- =====================================================================
-- Migration 013: مزامنة staff_permissions بين الكود وقاعدة البيانات
-- الجدول كان يستخدم user_id/max_discount_pct/can_issue_reports
-- الكود يتوقع staff_id/discount_max_percent/can_export_reports/can_discount
-- الحل: إضافة الأعمدة الناقصة والتقييد الفريد المطلوب للـ upsert
-- =====================================================================

-- 1) العمود الرئيسي المستخدم في onConflict:'staff_id'
alter table public.staff_permissions
  add column if not exists staff_id uuid;

update public.staff_permissions
  set staff_id = user_id where staff_id is null;

alter table public.staff_permissions
  alter column staff_id set not null;

-- تقييد UNIQUE لكي يعمل upsert onConflict:'staff_id'
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.staff_permissions'::regclass
      and conname = 'staff_permissions_staff_id_key'
  ) then
    alter table public.staff_permissions add constraint staff_permissions_staff_id_key unique (staff_id);
  end if;
end $$;

-- 2) العمود المفقود can_discount
alter table public.staff_permissions
  add column if not exists can_discount boolean not null default false;

-- 3) عمود discount_max_percent (كان max_discount_pct)
alter table public.staff_permissions
  add column if not exists discount_max_percent integer not null default 10;
update public.staff_permissions
  set discount_max_percent = max_discount_pct::integer
  where max_discount_pct is not null and max_discount_pct != 0;

-- 4) عمود can_export_reports (كان can_issue_reports)
alter table public.staff_permissions
  add column if not exists can_export_reports boolean not null default false;
update public.staff_permissions
  set can_export_reports = can_issue_reports
  where can_issue_reports = true;

-- 5) تأكيد RLS مفعّل
alter table public.staff_permissions enable row level security;

-- سياسات RLS (تُحدَّث إن وُجدت)
drop policy if exists sp_company_select on public.staff_permissions;
create policy sp_company_select on public.staff_permissions for select to authenticated
  using (company_id = current_company_id());

drop policy if exists sp_company_insert on public.staff_permissions;
create policy sp_company_insert on public.staff_permissions for insert to authenticated
  with check (company_id = current_company_id()
              and current_role_of_user() in ('owner','manager'));

drop policy if exists sp_company_update on public.staff_permissions;
create policy sp_company_update on public.staff_permissions for update to authenticated
  using (company_id = current_company_id()
         and current_role_of_user() in ('owner','manager'));

drop policy if exists sp_self_select on public.staff_permissions;
create policy sp_self_select on public.staff_permissions for select to authenticated
  using (staff_id = auth.uid() or user_id = auth.uid());

-- 6) تحديث schema cache
notify pgrst, 'reload schema';
