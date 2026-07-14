-- =====================================================================
-- Migration 014: دالة تحقق من بيانات دخول بوابة المستأجر
-- =====================================================================
-- تتيح للمستأجر تسجيل الدخول لبوابته عبر اسم المستخدم + رمز الدخول
-- بدلاً من الاعتماد فقط على الرابط المباشر في واتساب. الدالة آمنة
-- (SECURITY DEFINER) وتُتاح لـ anon لأن المستأجر لا يملك حساب Supabase.
-- =====================================================================

create or replace function public.portal_validate_login(p_username text, p_token text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_token text;
begin
  if length(trim(coalesce(p_username,''))) = 0 or length(trim(coalesce(p_token,''))) = 0 then
    return null;
  end if;

  select access_token into v_token
  from tenant_portal_accounts
  where lower(trim(username)) = lower(trim(p_username))
    and access_token = trim(p_token)
    and is_active = true;

  return v_token;
end $$;

revoke all on function public.portal_validate_login(text, text) from public;
grant execute on function public.portal_validate_login(text, text) to anon, authenticated;
