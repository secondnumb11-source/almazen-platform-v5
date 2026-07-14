-- =====================================================================
-- Migration 008: تحصين RLS ضد infinite recursion
-- =====================================================================
-- المشكلة: دوال RLS المساعدة (current_company_id, current_role_of_user)
-- تستعلم من جدول profiles وهي مستخدَمة داخل سياسات profiles نفسها. رغم أن
-- SECURITY DEFINER يتجاوز RLS نظرياً، فإن بعض إعدادات النشر (تغيّر مالك الدالة
-- أو غياب search_path) قد تُشعل خطأ:
--   "infinite recursion detected in policy for relation profiles"
--
-- هذا الملف يعيد إنشاء الدوال بشكل محصّن + يمنح التنفيذ للأدوار الصحيحة
-- + يمنع أي كتابة داخل الدوال (STABLE + LEAKPROOF) + يضبط search_path.
-- آمن للتشغيل مرات متعددة (idempotent).
-- ---------------------------------------------------------------------

-- 1) إعادة إنشاء الدوال المساعدة بشكل محصّن
create or replace function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.company_id
  from public.profiles p
  where p.id = auth.uid()
  limit 1
$$;

create or replace function public.current_role_of_user()
returns user_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.role
  from public.profiles p
  where p.id = auth.uid()
  limit 1
$$;

-- تأكيد ملكية الدوال لمستخدم postgres (يبطل RLS داخلها فعلياً)
alter function public.current_company_id()    owner to postgres;
alter function public.current_role_of_user()  owner to postgres;

-- حصر تنفيذها على الأدوار المخوّلة فقط
revoke all on function public.current_company_id()   from public;
revoke all on function public.current_role_of_user() from public;
grant execute on function public.current_company_id()   to authenticated, service_role;
grant execute on function public.current_role_of_user() to authenticated, service_role;

-- 2) دالة إضافية آمنة: هل المستخدم الحالي عضو في نفس شركة صف مُعطى؟
--    تُستخدم كبديل مباشر في السياسات لتفادي الحاجة لاستعلام profiles مرتين.
create or replace function public.is_in_company(p_company_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.company_id = p_company_id
  )
$$;
alter function public.is_in_company(uuid) owner to postgres;
revoke all on function public.is_in_company(uuid) from public;
grant execute on function public.is_in_company(uuid) to authenticated, service_role;

-- 3) سياسة قراءة profiles: نُبقيها كما هي منطقياً، لكن نضمن عدم وجود
--    سياسة متكررة قديمة قد تكون أُنشئت بأسماء مختلفة.
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname='public' and tablename='profiles'
  loop
    execute format('drop policy if exists %I on public.profiles', pol.policyname);
  end loop;
end $$;

-- إعادة إنشاء سياسات profiles بشكل واضح وآمن
-- (SELECT: يرى نفسه دائماً + بقية أعضاء شركته)
create policy profiles_self_select on public.profiles
  for select using (
    id = auth.uid()
    or company_id = public.current_company_id()
  );

create policy profiles_insert on public.profiles
  for insert with check (
    -- إما تأسيس ذاتي (المستخدم يُدرج ملفه الشخصي الأول)
    id = auth.uid()
    -- أو مالك/مدير يُنشئ حساب موظف داخل نفس الشركة
    or (company_id = public.current_company_id()
        and public.current_role_of_user() in ('owner','manager'))
  );

create policy profiles_update on public.profiles
  for update using (
    id = auth.uid()
    or (company_id = public.current_company_id()
        and public.current_role_of_user() in ('owner','manager'))
  );

create policy profiles_delete on public.profiles
  for delete using (
    company_id = public.current_company_id()
    and public.current_role_of_user() = 'owner'
    and id <> auth.uid()  -- المالك لا يحذف نفسه
  );

-- 4) تحقق سريع: إن ظهر أي خطأ بعد ذلك يمكن تشغيل هذا الاستعلام يدوياً
--    select id, role, company_id from public.profiles where id = auth.uid();
