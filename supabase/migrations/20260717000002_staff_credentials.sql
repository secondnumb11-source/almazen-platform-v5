-- =====================================================================
-- Migration 024: إدارة بيانات دخول بوابة الموظف (اسم المستخدم/كلمة المرور)
--   من داخل قسم إدارة الموظفين — للإدارة فقط.
--   يعتمد على pgcrypto لتحديث كلمة المرور المُشفّرة في auth.users مباشرة،
--   دون الحاجة إلى Edge Function أو مفتاح service_role في الواجهة.
-- =====================================================================
create extension if not exists pgcrypto;

-- إعادة تعيين كلمة مرور موظف (pgcrypto مثبّت في مخطط extensions في Supabase)
create or replace function public.admin_reset_staff_password(p_staff_id uuid, p_new_password text)
returns void
language plpgsql security definer set search_path = public, auth, extensions as $$
declare v_cid uuid;
begin
  if current_role_of_user() not in ('owner','manager','accountant') then
    raise exception 'صلاحية إدارة الحسابات حصرية للإدارة';
  end if;
  if length(coalesce(p_new_password,'')) < 6 then
    raise exception 'كلمة المرور يجب أن تكون 6 أحرف على الأقل';
  end if;
  -- التأكد أن الموظف ينتمي لنفس منشأة مُصدِر الطلب
  select company_id into v_cid from profiles where id = p_staff_id;
  if v_cid is null or v_cid <> current_company_id() then
    raise exception 'الموظف غير موجود في منشأتك';
  end if;

  update auth.users
     set encrypted_password = extensions.crypt(p_new_password, extensions.gen_salt('bf')),
         updated_at = now()
   where id = p_staff_id;
end $$;
revoke all on function public.admin_reset_staff_password(uuid, text) from public;
grant execute on function public.admin_reset_staff_password(uuid, text) to authenticated;

-- تغيير اسم مستخدم موظف (يُحدّث profiles.username و auth.users.email معاً)
create or replace function public.admin_change_staff_username(p_staff_id uuid, p_new_username text)
returns void
language plpgsql security definer set search_path = public, auth as $$
declare v_cid uuid; v_norm text; v_email text;
begin
  if current_role_of_user() not in ('owner','manager','accountant') then
    raise exception 'صلاحية إدارة الحسابات حصرية للإدارة';
  end if;
  v_norm := lower(trim(p_new_username));
  if length(v_norm) < 3 then raise exception 'اسم المستخدم قصير جداً'; end if;

  select company_id into v_cid from profiles where id = p_staff_id;
  if v_cid is null or v_cid <> current_company_id() then
    raise exception 'الموظف غير موجود في منشأتك';
  end if;
  if exists (select 1 from profiles where username = v_norm and id <> p_staff_id) then
    raise exception 'اسم المستخدم مستخدم بالفعل';
  end if;

  v_email := v_norm || '@staff.almazen.app';
  update profiles set username = v_norm where id = p_staff_id;
  update auth.users set email = v_email, updated_at = now() where id = p_staff_id;
end $$;
revoke all on function public.admin_change_staff_username(uuid, text) from public;
grant execute on function public.admin_change_staff_username(uuid, text) to authenticated;
