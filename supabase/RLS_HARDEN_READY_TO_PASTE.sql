-- =====================================================================
-- ملف موحّد جاهز للنسخ واللصق في: Supabase → SQL Editor
-- =====================================================================
-- الغرض:
--   1) إصلاح مشكلة "infinite recursion detected in policy" في جدول profiles
--   2) تحصين دوال RLS المساعدة (SECURITY DEFINER + search_path + owner)
--   3) إعادة إنشاء سياسات profiles بأسماء نظيفة
--
-- آمن للتشغيل عدة مرات (idempotent).
-- بعد التشغيل: أعد تحميل التطبيق ثم سجّل الدخول من جديد.
-- =====================================================================

-- ============ (1) الدوال المساعدة المحصّنة ============
create or replace function public.current_company_id()
returns uuid
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p.company_id from public.profiles p
  where p.id = auth.uid() limit 1
$$;

create or replace function public.current_role_of_user()
returns user_role
language sql stable security definer
set search_path = public, pg_temp
as $$
  select p.role from public.profiles p
  where p.id = auth.uid() limit 1
$$;

create or replace function public.is_in_company(p_company_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.company_id = p_company_id
  )
$$;

-- ملكية الدوال + صلاحيات التنفيذ
alter function public.current_company_id()   owner to postgres;
alter function public.current_role_of_user() owner to postgres;
alter function public.is_in_company(uuid)    owner to postgres;
revoke all on function public.current_company_id()   from public;
revoke all on function public.current_role_of_user() from public;
revoke all on function public.is_in_company(uuid)    from public;
grant execute on function public.current_company_id()   to authenticated, service_role;
grant execute on function public.current_role_of_user() to authenticated, service_role;
grant execute on function public.is_in_company(uuid)    to authenticated, service_role;

-- ============ (2) حذف أي سياسات قديمة على profiles ثم إعادة إنشائها ============
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

-- تفعيل RLS (في حال كانت معطّلة)
alter table public.profiles enable row level security;

-- SELECT: يرى نفسه + بقية أعضاء شركته
create policy profiles_self_select on public.profiles
  for select using (
    id = auth.uid()
    or company_id = public.current_company_id()
  );

-- INSERT: إما إنشاء ذاتي، أو مالك/مدير داخل نفس الشركة
create policy profiles_insert on public.profiles
  for insert with check (
    id = auth.uid()
    or (company_id = public.current_company_id()
        and public.current_role_of_user() in ('owner','manager'))
  );

-- UPDATE: نفسه، أو مالك/مدير
create policy profiles_update on public.profiles
  for update using (
    id = auth.uid()
    or (company_id = public.current_company_id()
        and public.current_role_of_user() in ('owner','manager'))
  );

-- DELETE: المالك فقط ولا يحذف نفسه
create policy profiles_delete on public.profiles
  for delete using (
    company_id = public.current_company_id()
    and public.current_role_of_user() = 'owner'
    and id <> auth.uid()
  );

-- ============ (3) تحقق سريع ============
-- شغّل هذا بعد الإصلاح للتأكد من عمل السياسات:
--   select id, role, company_id from public.profiles where id = auth.uid();
--
-- إن ظهرت النتيجة بدون خطأ → الإصلاح ناجح ✅
