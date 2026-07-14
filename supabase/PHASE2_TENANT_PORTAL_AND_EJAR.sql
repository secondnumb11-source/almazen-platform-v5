-- =====================================================================
-- ALMAZEN — PHASE 2: بوابة العميل (المستأجر) + الربط مع منصة إيجار
-- انسخ محتوى هذا الملف كاملاً وألصقه في SQL Editor بمشروع Supabase بعد
-- تنفيذ ALMAZEN_FULL_SETUP.sql ثم PHASE1_UNITS_EXPANSION.sql ثم POST_SETUP_FIX.sql
-- Idempotent — يمكن إعادة تنفيذه بأمان.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0) إصلاح خلل موجود: الكود يستخدم حالة حجز 'pending_approval'
--    (طلبات موافقة المالك على خصم > 20%) لكنها غير مسجّلة في نوع
--    booking_status، ما يجعل أي حجز بخصم كبير من موظف يفشل بخطأ قاعدة
--    بيانات. هذا السطر يضيف القيمة الناقصة فقط ولا يُغيّر أي سلوك آخر.
-- ---------------------------------------------------------------------
alter type booking_status add value if not exists 'pending_approval';

-- ---------------------------------------------------------------------
-- 1) الربط مع منصة إيجار — حالة توثيق العقد
--    التسجيل في إيجار عملية بموافقة الطرفين: تُرسل المنشأة العقد
--    (pending_landlord/pending_tenant) ثم يوافق المستأجر من قنوات
--    إيجار الخاصة، فيصبح "registered" برقم عقد رسمي.
-- ---------------------------------------------------------------------
do $$ begin
create type ejar_status as enum (
  'not_linked',        -- لم يُرسل بعد (الحالة الافتراضية — الميزة اختيارية)
  'pending_landlord',  -- بانتظار موافقة المؤجر على إيجار
  'pending_tenant',    -- أُرسل، بانتظار موافقة المستأجر على إيجار
  'registered',        -- موثّق رسمياً وله رقم عقد
  'rejected',          -- رفضه أحد الطرفين على إيجار
  'cancelled',          -- أُلغي التوثيق
  'expired'             -- انتهت صلاحية طلب التوثيق
);
exception when duplicate_object then null; end $$;

-- إعدادات الربط على مستوى المنشأة (تُدخل من بوابة المالك/المدير/المحاسب فقط)
alter table public.companies add column if not exists ejar_api_key        text;
alter table public.companies add column if not exists ejar_enabled       boolean not null default false;
alter table public.companies add column if not exists ejar_environment   text not null default 'sandbox';
alter table public.companies add column if not exists ejar_broker_license text;   -- رقم رخصة الوساطة العقارية / المنشأة على إيجار
alter table public.companies add column if not exists ejar_last_test_at  timestamptz;
alter table public.companies add column if not exists ejar_last_test_ok  boolean;
-- رابط الموقع المنشور — يُستخدم لبناء رابط بوابة الساكن داخل رسالة الواتساب
-- التلقائية (الأتمتة تعمل من داخل قاعدة البيانات ولا "تعرف" نطاق موقعك تلقائياً)
alter table public.companies add column if not exists public_base_url    text;

do $$ begin
  alter table public.companies add constraint companies_ejar_env_chk
    check (ejar_environment in ('sandbox','production'));
exception when duplicate_object then null; end $$;

-- بيانات إضافية على الوحدة مطلوبة لتوثيق عقد إيجار حقيقي (اختيارية تماماً،
-- لا تمنع أي استخدام آخر للنظام إن تُركت فارغة)
alter table public.units add column if not exists deed_number text;  -- رقم الصك العقاري

-- حالة توثيق كل حجز على منصة إيجار
alter table public.bookings add column if not exists ejar_status         ejar_status not null default 'not_linked';
alter table public.bookings add column if not exists ejar_contract_number text;      -- الرقم الرسمي من إيجار
alter table public.bookings add column if not exists ejar_submitted_at   timestamptz;
alter table public.bookings add column if not exists ejar_registered_at  timestamptz;
alter table public.bookings add column if not exists ejar_last_synced_at timestamptz;
alter table public.bookings add column if not exists ejar_error         text;
alter table public.bookings add column if not exists ejar_payload       jsonb;       -- لقطة ما أُرسل (تدقيق)
alter table public.bookings add column if not exists ejar_response      jsonb;       -- آخر استجابة خام (تدقيق)

create index if not exists idx_bookings_ejar_status on public.bookings(company_id, ejar_status);

-- الحماية: تعديل أعمدة ejar_* على الحجز صلاحية حصرية لـ (مالك/مدير/محاسب)
-- + مسموح دائماً لعمليات الخادم الموثوقة (Edge Function بمفتاح service_role)
create or replace function public.enforce_ejar_finance_only()
returns trigger language plpgsql security definer as $$
declare v_role user_role;
begin
  if current_user = 'service_role' then
    return new; -- عمليات الخادم الموثوقة (Edge Function) لا تُحجب
  end if;
  if (new.ejar_status           is distinct from old.ejar_status or
      new.ejar_contract_number  is distinct from old.ejar_contract_number or
      new.ejar_submitted_at     is distinct from old.ejar_submitted_at or
      new.ejar_registered_at    is distinct from old.ejar_registered_at or
      new.ejar_payload          is distinct from old.ejar_payload) then
    select role into v_role from public.profiles where id = auth.uid();
    if v_role is distinct from 'owner' and v_role is distinct from 'manager' and v_role is distinct from 'accountant' then
      raise exception 'توثيق العقد على منصة إيجار صلاحية حصرية للمالك أو المدير أو المحاسب | Ejar linking is restricted to owner/manager/accountant';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_ejar_finance_only on public.bookings;
create trigger trg_ejar_finance_only
before update on public.bookings
for each row execute function public.enforce_ejar_finance_only();

-- سياسة التحديث الأصلية لجدول companies تسمح للمالك فقط (companies_update)
-- وهذا مقصود لبقية الحقول (الشعار، الاسم، VAT...). لكن طلب هذه الميزة أن
-- يتحكم بإعدادات إيجار: المالك أو المدير أو المحاسب. بدلاً من توسيع
-- صلاحية تحديث الشركة كاملة (ما كان سيفتح تعديل بقية الإعدادات الحساسة
-- لغير المالك)، ننشئ دالة آمنة ضيّقة النطاق تُحدّث أعمدة إيجار فقط.
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
    ejar_api_key = nullif(btrim(coalesce(p_api_key,'')), ''),
    ejar_enabled = p_enabled,
    ejar_environment = p_environment,
    ejar_broker_license = nullif(btrim(coalesce(p_broker_license,'')), '')
  where id = v_cid;
end $$;

revoke all on function public.update_ejar_settings(text, boolean, text, text) from public;
grant execute on function public.update_ejar_settings(text, boolean, text, text) to authenticated;

-- ---------------------------------------------------------------------
-- 2) بوابة العميل (المستأجر) — أعمدة تكميلية على جداول موجودة
-- ---------------------------------------------------------------------
-- تقييم المستأجر بعد الإخلاء (مستقل عن ملاحظات الموظف الداخلية)
alter table public.customers add column if not exists review_comment      text;
alter table public.customers add column if not exists review_submitted_at timestamptz;

-- صورة مرفقة لطلب صيانة يرسله الساكن من بوابته
alter table public.service_requests add column if not exists photo_url text;

-- تأكيد/توقيع الساكن على نموذج تسليم أو استلام موجود (لا يُنشئ سجلاً جديداً
-- ولا يغيّر حالة الحجز أو الوحدة — إقرار توثيقي إضافي فقط)
alter table public.handovers add column if not exists tenant_confirmed_at timestamptz;
alter table public.handovers add column if not exists tenant_signature   text;

-- ---------------------------------------------------------------------
-- تصحيح رابط بوابة الساكن داخل رسالة الواتساب الترحيبية التلقائية:
-- كانت تضمّن "اسم المستخدم" (مشتق من رقم الجوال ويمكن تخمينه)، والصحيح
-- هو استخدام access_token السري الفعلي ومسار /portal/ الذي بنيناه الآن.
-- بقية منطق الدالة الأصلية لم يتغيّر — استبدال جزء بناء الرسالة فقط.
-- ---------------------------------------------------------------------
create or replace function automate_on_check_in()
returns trigger language plpgsql security definer as $$
declare
  v_customer customers%rowtype;
  v_unit units%rowtype;
  v_company companies%rowtype;
  v_username text;
  v_token text;
  v_paid numeric;
  v_portal_link text;
begin
  if new.status = 'checked_in' and old.status is distinct from 'checked_in' then
    select * into v_customer from customers where id = new.customer_id;
    select * into v_unit from units where id = new.unit_id;
    select * into v_company from companies where id = new.company_id;
    select coalesce(sum(amount),0) into v_paid
      from payments where booking_id = new.id;

    -- 1) إنشاء بوابة دخول الساكن تلقائياً
    v_username := 'guest_' || replace(v_customer.phone, '+', '');
    v_token := encode(gen_random_bytes(24), 'hex');
    insert into tenant_portal_accounts (company_id, customer_id, booking_id, username, access_token)
    values (new.company_id, new.customer_id, new.id, v_username, v_token)
    on conflict (company_id, username) do update
      set booking_id = excluded.booking_id, is_active = true,
          access_token = excluded.access_token
    returning access_token into v_token;

    v_portal_link := case when coalesce(v_company.public_base_url, '') <> ''
      then rtrim(v_company.public_base_url, '/') || '/portal/' || v_token
      else '/portal/' || v_token
    end;

    -- 2) إشعار المحاسب
    insert into notifications (company_id, target_role, channel, event_type, title, body, booking_id, unit_id)
    values (new.company_id, 'accountant', 'in_app', 'new_lease_started',
            'بداية عقد إيجار جديد',
            format('بدأ إيجار الوحدة %s للمستأجر %s — الإجمالي %s ر.س، المدفوع %s ر.س، العربون %s ر.س، التأمين %s ر.س',
                   v_unit.unit_number, v_customer.full_name, new.total_amount, v_paid,
                   new.down_payment, new.insurance_amount),
            new.id, new.unit_id);

    -- إشعار المدير
    insert into notifications (company_id, target_role, channel, event_type, title, body, booking_id, unit_id)
    values (new.company_id, 'manager', 'in_app', 'new_lease_started',
            'بداية عقد إيجار جديد',
            format('الوحدة %s أصبحت مسكونة — المستأجر: %s', v_unit.unit_number, v_customer.full_name),
            new.id, new.unit_id);

    -- 3) رسالة الواتساب الترحيبية (تُرسل عبر Edge Function تقرأ صف pending)
    --    تتضمن الآن رابط بوابة الساكن الفعلي والآمن (access_token)
    insert into notifications (company_id, customer_id, channel, event_type, title, body, booking_id, unit_id, status)
    values (new.company_id, new.customer_id, 'whatsapp', 'welcome_message',
            'رسالة ترحيبية',
            format('مرحباً بك %s! تم تأكيد سكنك في الوحدة رقم %s ابتداءً من %s. قيمة الإيجار: %s ر.س | المدفوع: %s ر.س | المتبقي: %s ر.س. بوابتك الخاصة لمتابعة إقامتك وطلب التمديد أو الخدمات: %s',
                   v_customer.full_name, v_unit.unit_number, new.check_in_date,
                   new.total_amount, v_paid, new.total_amount - v_paid, v_portal_link),
            new.id, new.unit_id, 'pending');

    -- 4) نقاط الولاء (10 نقاط لكل إقامة)
    insert into loyalty_transactions (company_id, customer_id, booking_id, points, reason)
    values (new.company_id, new.customer_id, new.id, 10, 'إقامة جديدة');
    update customers set loyalty_points = loyalty_points + 10 where id = new.customer_id;

    -- 5) فتح سجل دورة حياة التأمين
    if new.insurance_amount > 0 then
      insert into insurance_records (company_id, booking_id, amount, status)
      values (new.company_id, new.id, new.insurance_amount, 'held');
    end if;
  end if;

  -- إشعار عند تأكيد حجز جديد (للموظفين)
  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status is distinct from 'confirmed') then
    insert into notifications (company_id, target_role, channel, event_type, title, body, booking_id, unit_id)
    values (new.company_id, 'employee', 'in_app', 'new_booking',
            'حجز جديد', 'تم استلام حجز جديد بانتظار التسليم', new.id, new.unit_id);
  end if;

  return new;
end $$;
-- (المشغّل trg_automate_check_in الحالي يستدعي هذه الدالة نفسها بالاسم؛
--  create or replace يكفي ولا حاجة لإعادة إنشاء المشغّل)

-- ---------------------------------------------------------------------
-- 3) دوال بوابة العميل — بوابة دخول آمنة برمز سري (بدون حساب Supabase Auth)
--    كل الوصول من طرف الساكن يمر حصراً عبر هذه الدوال (security definer)
--    ولا تُمنح أي صلاحية SELECT/INSERT مباشرة لدور anon على الجداول
--    الحساسة (customers, bookings, payments...)، حفاظاً على العزل الكامل
--    بين المنشآت وعلى خصوصية بيانات المستأجرين.
-- ---------------------------------------------------------------------

-- القراءة الشاملة: كل بيانات بوابة الساكن في استدعاء واحد
create or replace function public.portal_get_context(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_acct   tenant_portal_accounts%rowtype;
  v_result jsonb;
begin
  if p_token is null or length(p_token) < 20 then
    raise exception 'INVALID_TOKEN';
  end if;

  select * into v_acct from tenant_portal_accounts
   where access_token = p_token and is_active = true;
  if not found then
    raise exception 'INVALID_TOKEN';
  end if;

  update tenant_portal_accounts set last_login_at = now() where id = v_acct.id;

  select jsonb_build_object(
    'customer', (
      select jsonb_build_object(
        'id', c.id, 'full_name', c.full_name, 'phone', c.phone,
        'id_type', c.id_type, 'id_number', c.id_number,
        'loyalty_points', c.loyalty_points, 'is_vip', c.is_vip,
        'rating', c.rating, 'review_comment', c.review_comment
      ) from customers c where c.id = v_acct.customer_id
    ),
    'company', (
      select jsonb_build_object(
        'name', co.name, 'logo_url', co.logo_url, 'phone', co.phone,
        'address', co.address, 'vat_number', co.vat_number
      ) from companies co where co.id = v_acct.company_id
    ),
    'current_booking', (
      select jsonb_build_object(
        'id', b.id, 'status', b.status, 'check_in_date', b.check_in_date,
        'check_out_date', b.check_out_date, 'total_amount', b.total_amount,
        'discount_percent', b.discount_percent, 'down_payment', b.down_payment,
        'insurance_amount', b.insurance_amount, 'rent_period', b.rent_period,
        'ejar_status', b.ejar_status, 'ejar_contract_number', b.ejar_contract_number,
        'paid', coalesce((select sum(p.amount) from payments p where p.booking_id = b.id), 0),
        'unit', (select jsonb_build_object(
                   'unit_number', u.unit_number, 'category', u.category,
                   'description', u.description, 'bedrooms', u.bedrooms, 'bathrooms', u.bathrooms
                 ) from units u where u.id = b.unit_id),
        'media', coalesce((select jsonb_agg(jsonb_build_object('url', m.url, 'media_type', m.media_type) order by m.sort_order)
                   from unit_media m where m.unit_id = b.unit_id), '[]'::jsonb),
        'payments', coalesce((select jsonb_agg(jsonb_build_object(
                       'amount', p.amount, 'payment_type', p.payment_type, 'method', p.method,
                       'payment_date', p.payment_date, 'reference_number', p.reference_number
                     ) order by p.payment_date) from payments p where p.booking_id = b.id), '[]'::jsonb),
        'insurance', coalesce((select jsonb_agg(jsonb_build_object(
                       'amount', ir.amount, 'status', ir.status,
                       'deduction_amount', ir.deduction_amount, 'deduction_reason', ir.deduction_reason,
                       'refunded_at', ir.refunded_at
                     )) from insurance_records ir where ir.booking_id = b.id), '[]'::jsonb),
        'invoices', coalesce((select jsonb_agg(jsonb_build_object(
                       'invoice_number', inv.invoice_number, 'total', inv.total,
                       'vat_amount', inv.vat_amount, 'issued_at', inv.issued_at
                     ) order by inv.issued_at desc) from invoices inv where inv.booking_id = b.id), '[]'::jsonb),
        'handovers', coalesce((select jsonb_agg(jsonb_build_object(
                       'id', h.id, 'kind', h.kind, 'checklist', h.checklist, 'notes', h.notes,
                       'signed_by', h.signed_by, 'created_at', h.created_at,
                       'tenant_confirmed_at', h.tenant_confirmed_at
                     ) order by h.created_at) from handovers h where h.booking_id = b.id), '[]'::jsonb),
        'companions', coalesce((select jsonb_agg(jsonb_build_object(
                       'full_name', bc.full_name, 'relation', bc.relation
                     )) from booking_companions bc where bc.booking_id = b.id), '[]'::jsonb),
        'service_requests', coalesce((select jsonb_agg(jsonb_build_object(
                       'id', sr.id, 'request_type', sr.request_type, 'status', sr.status,
                       'details', sr.details, 'created_at', sr.created_at
                     ) order by sr.created_at desc) from service_requests sr where sr.booking_id = b.id), '[]'::jsonb)
      ) from bookings b where b.id = v_acct.booking_id
    ),
    'past_bookings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'unit_number', u.unit_number, 'check_in_date', b.check_in_date, 'check_out_date', b.check_out_date,
        'status', b.status, 'total_amount', b.total_amount
      ) order by b.check_in_date desc)
      from bookings b join units u on u.id = b.unit_id
      where b.customer_id = v_acct.customer_id and b.id <> v_acct.booking_id and b.status <> 'cancelled'
    ), '[]'::jsonb),
    'loyalty_history', coalesce((
      select jsonb_agg(jsonb_build_object('points', lt.points, 'reason', lt.reason, 'created_at', lt.created_at) order by lt.created_at desc)
      from loyalty_transactions lt where lt.customer_id = v_acct.customer_id
    ), '[]'::jsonb),
    'available_units', coalesce((
      select jsonb_agg(jsonb_build_object(
        'unit_number', u.unit_number, 'category', u.category, 'daily_price', u.daily_price,
        'monthly_price', u.monthly_price, 'description', u.description
      )) from (
        select * from units where company_id = v_acct.company_id and status = 'available' and is_active
        order by unit_number limit 6
      ) u
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end $$;

revoke all on function public.portal_get_context(text) from public;
grant execute on function public.portal_get_context(text) to anon, authenticated;

-- إنشاء طلب خدمة (تمديد / خدمة إضافية / صيانة بصورة / شكوى)
create or replace function public.portal_create_service_request(
  p_token text, p_type service_request_type, p_details text, p_photo_url text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_acct tenant_portal_accounts%rowtype;
  v_id uuid;
  v_unit_number text;
begin
  select * into v_acct from tenant_portal_accounts where access_token = p_token and is_active = true;
  if not found then raise exception 'INVALID_TOKEN'; end if;

  insert into service_requests (company_id, booking_id, request_type, details, photo_url, status)
  values (v_acct.company_id, v_acct.booking_id, p_type, p_details, p_photo_url, 'new')
  returning id into v_id;

  select u.unit_number into v_unit_number from bookings b join units u on u.id = b.unit_id where b.id = v_acct.booking_id;

  insert into notifications (company_id, target_role, channel, event_type, title, body, booking_id)
  values (v_acct.company_id, 'employee', 'in_app', 'tenant_service_request',
          'طلب جديد من الساكن',
          format('طلب %s من الوحدة %s: %s',
                 case p_type when 'extension' then 'تمديد إيجار' when 'maintenance' then 'صيانة'
                      when 'complaint' then 'شكوى' else 'خدمة إضافية' end,
                 coalesce(v_unit_number,'—'), coalesce(p_details,'—')),
          v_acct.booking_id);

  return v_id;
end $$;

revoke all on function public.portal_create_service_request(text, service_request_type, text, text) from public;
grant execute on function public.portal_create_service_request(text, service_request_type, text, text) to anon, authenticated;

-- إضافة مرافق لحجزه الحالي
create or replace function public.portal_add_companion(
  p_token text, p_full_name text, p_id_type id_document_type default null, p_id_number text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_acct tenant_portal_accounts%rowtype;
  v_id uuid;
begin
  select * into v_acct from tenant_portal_accounts where access_token = p_token and is_active = true;
  if not found then raise exception 'INVALID_TOKEN'; end if;
  if coalesce(btrim(p_full_name), '') = '' then raise exception 'الاسم مطلوب'; end if;

  insert into booking_companions (company_id, booking_id, full_name, id_type, id_number)
  values (v_acct.company_id, v_acct.booking_id, btrim(p_full_name), p_id_type, p_id_number)
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.portal_add_companion(text, text, id_document_type, text) from public;
grant execute on function public.portal_add_companion(text, text, id_document_type, text) to anon, authenticated;

-- تقييم بعد الإخلاء
create or replace function public.portal_submit_rating(p_token text, p_rating int, p_comment text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare v_acct tenant_portal_accounts%rowtype;
begin
  select * into v_acct from tenant_portal_accounts where access_token = p_token and is_active = true;
  if not found then raise exception 'INVALID_TOKEN'; end if;
  if p_rating < 1 or p_rating > 5 then raise exception 'التقييم يجب أن يكون بين 1 و 5'; end if;

  update customers set rating = p_rating, review_comment = p_comment, review_submitted_at = now()
   where id = v_acct.customer_id;
end $$;

revoke all on function public.portal_submit_rating(text, int, text) from public;
grant execute on function public.portal_submit_rating(text, int, text) to anon, authenticated;

-- توقيع/تأكيد الساكن على نموذج تسليم أو استلام موجود مسبقاً (لا يُنشئ
-- سجلاً جديداً ولا يُغيّر حالة الحجز — إقرار توثيقي إضافي فقط)
create or replace function public.portal_confirm_handover(p_token text, p_handover_id uuid, p_signature text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_acct tenant_portal_accounts%rowtype;
begin
  select * into v_acct from tenant_portal_accounts where access_token = p_token and is_active = true;
  if not found then raise exception 'INVALID_TOKEN'; end if;
  if coalesce(btrim(p_signature), '') = '' then raise exception 'التوقيع مطلوب'; end if;

  update handovers set tenant_confirmed_at = now(), tenant_signature = btrim(p_signature)
   where id = p_handover_id and booking_id = v_acct.booking_id;
  if not found then raise exception 'HANDOVER_NOT_FOUND'; end if;
end $$;

revoke all on function public.portal_confirm_handover(text, uuid, text) from public;
grant execute on function public.portal_confirm_handover(text, uuid, text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- 4) مخزن رفع صور طلبات الصيانة من بوابة الساكن — بدون Edge Function:
--    الحماية تعتمد على معرفة access_token السري نفسه (مسار الملف يبدأ
--    به)، ونتحقق أنه ينتمي فعلاً لحساب بوابة نشط قبل قبول الرفع.
--
--    ملاحظة إصلاح: سياستا رفع/حذف storage.objects الأصليتان
--    (storage_upload_own_company / storage_delete_own_company) لم تكونا
--    مقيّدتين بـ "to authenticated" صراحة، فكانتا تنطبقان ضمنياً على كل
--    الأدوار بما فيها anon. بما أن Postgres يحتاج فحص صلاحية كل السياسات
--    المطابقة على نفس العملية، فإن وجود سياسة anon جديدة (أدناه) كان
--    سيتعارض معهما ويفشل برسالة "permission denied for table profiles"
--    لأن anon لا تملك صلاحية قراءة profiles أصلاً. الإصلاح: تقييدهما
--    صراحة بـ authenticated فقط (وهو المقصود منهما أصلاً).
-- ---------------------------------------------------------------------
drop policy if exists storage_upload_own_company on storage.objects;
create policy storage_upload_own_company on storage.objects for insert
  to authenticated
  with check (
    bucket_id in ('unit-media','documents')
    and (storage.foldername(name))[1] = (select company_id::text from profiles where id = auth.uid())
  );

drop policy if exists storage_delete_own_company on storage.objects;
create policy storage_delete_own_company on storage.objects for delete
  to authenticated
  using (
    bucket_id in ('unit-media','documents')
    and (storage.foldername(name))[1] = (select company_id::text from profiles where id = auth.uid())
    and (select role from profiles where id = auth.uid()) in ('owner','manager')
  );

insert into storage.buckets (id, name, public)
values ('portal-uploads', 'portal-uploads', true)
on conflict (id) do nothing;

-- دالة تحقق مساعدة (security definer): سياسات RLS العادية على
-- tenant_portal_accounts تمنع anon من رؤية أي صف إطلاقاً (auth.uid() فارغ
-- له)، فحتى subquery "exists" داخل سياسة التخزين كان سيُقيَّم بلا نتائج
-- دائماً رغم صحة التوكن. الحل الصحيح: دالة معزولة الصلاحيات تتحقق فقط من
-- وجود التوكن وتُرجع true/false دون كشف أي بيانات فعلية من الجدول.
create or replace function public.portal_token_valid(p_prefix text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from tenant_portal_accounts
    where access_token = p_prefix and is_active = true
  )
$$;
revoke all on function public.portal_token_valid(text) from public;
grant execute on function public.portal_token_valid(text) to anon, authenticated;

drop policy if exists portal_upload_by_token on storage.objects;
create policy portal_upload_by_token on storage.objects for insert
  to anon, authenticated
  with check (
    bucket_id = 'portal-uploads'
    and public.portal_token_valid((storage.foldername(name))[1])
  );

drop policy if exists portal_uploads_read on storage.objects;
create policy portal_uploads_read on storage.objects for select
  using (bucket_id = 'portal-uploads');

-- ---------------------------------------------------------------------
-- 5) بث لحظي لطلبات الساكن (لتحديث لوحة الموظف/المحاسب فوراً)
-- ---------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table service_requests;
exception when duplicate_object then null; end $$;
