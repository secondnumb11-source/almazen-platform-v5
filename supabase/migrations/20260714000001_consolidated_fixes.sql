-- =====================================================================
-- Migration 009: تصحيحات شاملة — يوثّق الحالة الفعلية المُطبَّقة على قاعدة
-- الإنتاج بعد فحص معمّق اكتشف أن عدة ملفات SQL سابقة (POST_SETUP_FIX,
-- SECURITY_FIXES_READY_TO_PASTE, TRIAL_SYSTEM_READY_TO_PASTE) طُبِّقت
-- جزئياً فقط، مما ترك ثغرات حرجة (RLS مفقودة بالكامل على معظم الجداول
-- التشغيلية، تسريب بيانات عامة، دالة إعدادات إيجار معطوبة).
-- هذا الملف Idempotent بالكامل — آمن للتنفيذ عدة مرات ومن الصفر.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0) دالة إنفاذ انتهاء التجربة/الاشتراك — يجب تعريفها أولاً لأن سياسات
--    RLS أدناه (القسم 2) تعتمد عليها. سابقاً كان الحجب على مستوى الواجهة
--    فقط (يمكن تجاوزه بطلب API مباشر) — الآن يُنفَّذ داخل قاعدة البيانات.
-- ---------------------------------------------------------------------
create or replace function public.company_is_active(_company uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when c.activated_by_admin then true
      when c.plan = 'active' and (c.subscription_ends_at is null or c.subscription_ends_at > now()) then true
      when c.plan = 'trial'  and c.trial_ends_at is not null and c.trial_ends_at > now() then true
      else false
    end
    from public.companies c where c.id = _company
  ), false);
$$;
revoke all on function public.company_is_active(uuid) from public;
grant execute on function public.company_is_active(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 1) استعادة سياسات RLS للشركات (كانت مفقودة تماماً)
-- ---------------------------------------------------------------------
drop policy if exists companies_select on companies;
create policy companies_select on companies for select
  using (id = current_company_id());
drop policy if exists companies_update on companies;
create policy companies_update on companies for update
  using (id = current_company_id() and current_role_of_user() = 'owner');

-- ---------------------------------------------------------------------
-- 2) استعادة سياسات RLS لكل الجداول التشغيلية (كانت مفقودة تماماً رغم
--    تفعيل RLS عليها — ما كان يمنع أي قراءة أو كتابة لأي مستخدم)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'properties','units','unit_media','unit_assets','customers','bookings',
    'booking_companions','payments','payment_schedules','insurance_records',
    'invoices','maintenance_requests','key_logs','checkin_logs','checklists',
    'notifications','loyalty_transactions','service_requests','ai_conversations']
  loop
    execute format('drop policy if exists %I_select on %I', t, t);
    execute format('create policy %I_select on %I for select using (company_id = current_company_id() and public.company_is_active(company_id))', t, t);

    execute format('drop policy if exists %I_insert on %I', t, t);
    execute format('create policy %I_insert on %I for insert with check (company_id = current_company_id() and public.company_is_active(company_id))', t, t);

    execute format('drop policy if exists %I_update on %I', t, t);
    execute format('create policy %I_update on %I for update using (company_id = current_company_id() and public.company_is_active(company_id))', t, t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'properties','units','unit_media','unit_assets','customers',
    'booking_companions','maintenance_requests']
  loop
    execute format('drop policy if exists %I_delete on %I', t, t);
    execute format(
      'create policy %I_delete on %I for delete
       using (company_id = current_company_id()
              and public.company_is_active(company_id)
              and current_role_of_user() in (''owner'',''manager''))', t, t);
  end loop;
end $$;

drop policy if exists expenses_select on expenses;
create policy expenses_select on expenses for select
  using (company_id = current_company_id() and public.company_is_active(company_id)
         and current_role_of_user() in ('owner','manager','accountant'));
drop policy if exists expenses_insert on expenses;
create policy expenses_insert on expenses for insert
  with check (company_id = current_company_id() and public.company_is_active(company_id));
drop policy if exists expenses_update on expenses;
create policy expenses_update on expenses for update
  using (company_id = current_company_id() and public.company_is_active(company_id)
         and current_role_of_user() in ('owner','manager','accountant'));
drop policy if exists expenses_delete on expenses;
create policy expenses_delete on expenses for delete
  using (company_id = current_company_id() and current_role_of_user() = 'owner');

drop policy if exists pricing_rules_select on pricing_rules;
create policy pricing_rules_select on pricing_rules for select
  using (company_id = current_company_id() and public.company_is_active(company_id));
drop policy if exists pricing_rules_write on pricing_rules;
create policy pricing_rules_write on pricing_rules for insert
  with check (company_id = current_company_id() and public.company_is_active(company_id)
              and current_role_of_user() in ('owner','manager'));
drop policy if exists pricing_rules_update on pricing_rules;
create policy pricing_rules_update on pricing_rules for update
  using (company_id = current_company_id() and public.company_is_active(company_id)
         and current_role_of_user() in ('owner','manager'));

drop policy if exists ai_insights_select on ai_insights;
create policy ai_insights_select on ai_insights for select
  using (company_id = current_company_id() and public.company_is_active(company_id));
drop policy if exists ai_insights_write on ai_insights;
create policy ai_insights_write on ai_insights for insert
  with check (company_id = current_company_id() and public.company_is_active(company_id));
drop policy if exists ai_insights_update on ai_insights;
create policy ai_insights_update on ai_insights for update
  using (company_id = current_company_id() and public.company_is_active(company_id));

drop policy if exists automation_logs_select on automation_logs;
create policy automation_logs_select on automation_logs for select
  using (company_id = current_company_id() and current_role_of_user() in ('owner','manager'));
drop policy if exists automation_logs_insert on automation_logs;
create policy automation_logs_insert on automation_logs for insert
  with check (company_id = current_company_id());

drop policy if exists audit_select on audit_logs;
create policy audit_select on audit_logs for select
  using (company_id = current_company_id() and current_role_of_user() in ('owner','manager'));
drop policy if exists audit_insert on audit_logs;
create policy audit_insert on audit_logs for insert
  with check (company_id = current_company_id());

-- ---------------------------------------------------------------------
-- 3) إغلاق تسريب unit_media العام: كانت تعرض كل الصور لكل الشركات لأي
--    زائر بلا قيد. نقصرها على الوحدات المفعّلة للمشاركة العامة فقط،
--    بنفس منطق سياسة units الحالية.
-- ---------------------------------------------------------------------
drop policy if exists unit_media_public on public.unit_media;
create policy unit_media_public on public.unit_media for select
  to anon, authenticated
  using (exists (
    select 1 from public.units u
    where u.id = unit_media.unit_id
      and u.share_slug is not null
      and u.is_active = true
  ));

-- ---------------------------------------------------------------------
-- 4) الدالة الآمنة لصفحة مشاركة الوحدة العامة /u/:slug (كانت مفقودة تماماً)
-- ---------------------------------------------------------------------
create or replace function public.public_unit_by_slug(p_slug text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'unit',    to_jsonb(u),
    'company', (select jsonb_build_object('name', c.name, 'logo_url', c.logo_url, 'phone', c.phone)
                from companies c where c.id = u.company_id),
    'media',   coalesce((
                 select jsonb_agg(to_jsonb(m) order by m.sort_order)
                 from unit_media m where m.unit_id = u.id
               ), '[]'::jsonb)
  )
  from units u
  where u.share_slug = p_slug and u.is_active = true
  limit 1
$$;
revoke all on function public.public_unit_by_slug(text) from public;
grant execute on function public.public_unit_by_slug(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 5) حزمة documents (هويات العملاء وإيصالات الدفع) كانت public بالكامل
--    عبر سياسة storage_read_all — نحصرها على موظفي نفس المنشأة فقط
-- ---------------------------------------------------------------------
update storage.buckets set public = false where id = 'documents';

drop policy if exists storage_read_all on storage.objects;
drop policy if exists documents_read_own_company on storage.objects;
create policy documents_read_own_company on storage.objects for select
  to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select company_id::text from profiles where id = auth.uid())
  );

-- ---------------------------------------------------------------------
-- 6) تفعيل RLS على جداول قديمة كانت بلا أي حماية إطلاقاً (مع منح anon
--    قراءة كاملة) — جداول قديمة استُبدلت بأخرى أحدث ولا يستخدمها أي كود
--    حالياً، فتُغلق بالكامل (بلا سياسات = رفض افتراضي للجميع سوى service_role)
-- ---------------------------------------------------------------------
alter table public.assets enable row level security;
alter table public.checkins_checkouts enable row level security;
alter table public.contracts enable row level security;
alter table public.insurance enable row level security;
alter table public.keys enable row level security;
alter table public.loyalty_points enable row level security;
alter table public.reviews enable row level security;

-- ---------------------------------------------------------------------
-- 7) إصلاح دالة update_ejar_settings — كانت معطوبة تماماً (تحاول الكتابة
--    في عمود ejar_api_key المحذوف من companies) منذ إعادة عزل المفاتيح
--    الحساسة إلى جدول company_secrets. هذا يعيدها لتكتب في المكان الصحيح.
-- ---------------------------------------------------------------------
create or replace function public.update_ejar_settings(
  p_api_key text, p_enabled boolean, p_environment text, p_broker_license text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_role user_role; v_cid uuid;
begin
  select role, company_id into v_role, v_cid from profiles where id = auth.uid();
  if v_role is null or v_role not in ('owner','manager','accountant') then
    raise exception 'صلاحية ضبط إعدادات إيجار حصرية للمالك أو المدير أو المحاسب';
  end if;
  if p_environment not in ('sandbox','production') then
    raise exception 'قيمة البيئة غير صحيحة';
  end if;
  update companies set
    ejar_enabled = p_enabled,
    ejar_environment = p_environment,
    ejar_broker_license = nullif(btrim(coalesce(p_broker_license,'')), '')
  where id = v_cid;
  insert into public.company_secrets (company_id, ejar_api_key)
    values (v_cid, nullif(btrim(coalesce(p_api_key,'')), ''))
  on conflict (company_id) do update
    set ejar_api_key = excluded.ejar_api_key, updated_at = now();
end $$;

-- ============ تحقق سريع (اختياري) ============
--   select public.company_is_active('<company_uuid>');
--   select public.company_access_state('<company_uuid>');
