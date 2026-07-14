-- =====================================================================
-- ALMAZEN — إعداد ما بعد التثبيت (Grants + Bootstrap Owner)
-- انسخ محتوى هذا الملف كاملاً وألصقه في SQL Editor بمشروع Supabase ثم نفّذه.
-- Idempotent — يمكن إعادة تنفيذه بأمان.
-- =====================================================================

-- 1) صلاحيات Data API لكل جداول public (RLS تبقى فعّالة)
do $$
declare tbl record;
begin
  for tbl in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where c.relkind = 'r' and n.nspname = 'public'
  loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', tbl.relname);
    execute format('grant all on public.%I to service_role', tbl.relname);
  end loop;
end $$;

grant usage, select on all sequences in schema public to authenticated;
grant all on all sequences in schema public to service_role;

-- 2) إصلاح دوال وسياسات الملف الشخصي بدون حلقة RLS لا نهائية
create or replace function public.current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.company_id from public.profiles p where p.id = auth.uid() limit 1;
$$;

create or replace function public.current_role_of_user()
returns public.user_role
language sql
stable
security definer
set search_path = public
as $$
  select p.role from public.profiles p where p.id = auth.uid() limit 1;
$$;

grant execute on function public.current_company_id() to authenticated;
grant execute on function public.current_role_of_user() to authenticated;

drop policy if exists profiles_select on public.profiles;
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select using (id = auth.uid());

drop policy if exists profiles_select_company on public.profiles;
create policy profiles_select_company on public.profiles
  for select using (company_id = public.current_company_id());

-- 3) دالة تأسيس أول مالك ذرّياً (تتجاوز RLS لهذه العملية فقط)
create or replace function public.bootstrap_owner(
  p_company_name text,
  p_full_name    text,
  p_vat_number   text default null
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

  insert into public.companies (name, vat_number)
    values (btrim(p_company_name), nullif(btrim(p_vat_number), ''))
    returning id into v_co;

  insert into public.profiles (id, company_id, role, full_name)
    values (v_uid, v_co, 'owner', btrim(p_full_name));

  return v_co;
end
$$;

revoke all on function public.bootstrap_owner(text, text, text) from public;
grant execute on function public.bootstrap_owner(text, text, text) to authenticated;
