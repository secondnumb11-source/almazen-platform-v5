-- ============================================================================
-- السماح لطاقم العمل بتعيين "كلمة مرور" مخصّصة وسهلة التذكّر لبوابة المستأجر
-- بدل الاكتفاء بتوليد رمز عشوائي فقط. القيمة نفسها تبقى مخزَّنة في نفس
-- عمود access_token (المستخدم فعلياً كرمز الدخول اليدوي عبر
-- portal_validate_login وكجزء من رابط البوابة المباشر) — لا عمود جديد،
-- ولا إعادة لأي عمود كلمة مرور نصي كان قد أُزيل سابقاً لأسباب أمنية.
-- ============================================================================

create or replace function public.set_portal_password(p_booking_id uuid, p_password text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_cid uuid; v_role user_role;
begin
  select company_id into v_cid from bookings where id = p_booking_id;
  if v_cid is null then raise exception 'الحجز غير موجود'; end if;
  if v_cid <> current_company_id() then raise exception 'الحجز لا يخص شركتك'; end if;

  select role into v_role from profiles where id = auth.uid();
  if v_role not in ('owner','manager','accountant','employee') then
    raise exception 'صلاحية تعديل بيانات دخول البوابة غير متاحة لدورك';
  end if;

  if length(trim(coalesce(p_password,''))) < 6 then
    raise exception 'كلمة المرور يجب ألا تقل عن 6 خانات';
  end if;

  update public.tenant_portal_accounts
    set access_token = trim(p_password), is_active = true
  where booking_id = p_booking_id;

  if not found then
    raise exception 'لا يوجد حساب بوابة لهذا الحجز بعد — يُنشأ تلقائياً عند تسليم الوحدة';
  end if;
end $$;

revoke all on function public.set_portal_password(uuid, text) from public;
grant execute on function public.set_portal_password(uuid, text) to authenticated;
