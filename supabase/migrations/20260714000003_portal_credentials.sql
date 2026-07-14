-- =====================================================================
-- Migration 011: إدارة بيانات دخول بوابة المستأجر (اسم مستخدم + رمز دخول)
-- =====================================================================
-- المشكلة: TenantSummary كان يعرض رابطاً خاطئاً للبوابة (/tenant-portal
-- بدل /portal/:token الفعلي)، ولم يكن هناك أي وسيلة لقراءة رمز الدخول
-- الفعلي (access_token) أو لتجديده. هذه الدالة تسمح لمالك/مدير/محاسب
-- الشركة بتوليد رمز دخول جديد لحساب بوابة مستأجر قائم (يُعادل "إعادة
-- تعيين كلمة المرور" لأن هذا النظام مصمم على دخول برمز سري بدل كلمة
-- مرور تقليدية).
-- =====================================================================

create or replace function public.portal_regenerate_token(p_booking_id uuid)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_cid uuid; v_role user_role; v_new_token text;
begin
  select company_id into v_cid from bookings where id = p_booking_id;
  if v_cid is null then raise exception 'الحجز غير موجود'; end if;
  if v_cid <> current_company_id() then raise exception 'الحجز لا يخص شركتك'; end if;

  select role into v_role from profiles where id = auth.uid();
  if v_role not in ('owner','manager','accountant') then
    raise exception 'صلاحية تعديل بيانات دخول البوابة حصرية للمالك أو المدير أو المحاسب';
  end if;

  v_new_token := encode(extensions.gen_random_bytes(24), 'hex');
  update tenant_portal_accounts
    set access_token = v_new_token, is_active = true
    where booking_id = p_booking_id;

  if not found then raise exception 'لا يوجد حساب بوابة لهذا الحجز بعد — يُنشأ تلقائياً عند تسليم الوحدة'; end if;
  return v_new_token;
end $$;
revoke all on function public.portal_regenerate_token(uuid) from public;
grant execute on function public.portal_regenerate_token(uuid) to authenticated;
