-- =====================================================================
-- Migration 025: صلاحية الموظف على بيانات دخول بوابة المستأجر
--   (تعديل اسم المستخدم/الرمز/التفعيل) دون تعديل بيانات العميل نفسها.
-- =====================================================================
drop policy if exists tenant_portal_accounts_staff_select on tenant_portal_accounts;
drop policy if exists tenant_portal_accounts_staff_update on tenant_portal_accounts;

create policy tpa_staff_select on tenant_portal_accounts for select
  to authenticated using (
    company_id = current_company_id()
    and current_role_of_user() in ('owner','manager','accountant','employee')
  );

create policy tpa_staff_update on tenant_portal_accounts for update
  to authenticated using (
    company_id = current_company_id()
    and current_role_of_user() in ('owner','manager','accountant','employee')
  ) with check (
    company_id = current_company_id()
    and current_role_of_user() in ('owner','manager','accountant','employee')
  );

-- توليد رابط/رمز دخول جديد — يشمل الموظف الآن
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
  if v_role not in ('owner','manager','accountant','employee') then
    raise exception 'صلاحية تعديل بيانات دخول البوابة غير متاحة لدورك';
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
