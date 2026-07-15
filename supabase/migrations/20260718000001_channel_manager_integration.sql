-- ============================================================================
-- تكامل "مدير القنوات" (Channel Manager) — الربط مع منصات الحجز العالمية
-- (Booking.com / Airbnb / Expedia / Agoda / Hotels.com / Trip.com / Vrbo)
-- عبر وسيط معتمد واحد (Channex أو Beds24) بدل اتصال مباشر بكل منصة —
-- لأن هذه المنصات لا تمنح API مباشر لأنظمة PMS فردية، والوصول الرسمي
-- يتم حصرياً عبر شركاء "Channel Manager" معتمدين.
--
-- هذا الملف إضافي بالكامل (additive only): لا يحذف ولا يعدّل أي عمود أو
-- جدول أو صلاحية موجودة، باستثناء تعديل دقيق واحد على دالة
-- enforce_owner_only_cancel (مُوثّق أدناه) لازم لتمكين إلغاء الحجوزات
-- تلقائياً عند إلغائها من العميل على المنصة الخارجية.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1) جدول إعدادات الربط (تفعيل/تعطيل، البيئة، حالة الاتصال) — بلا أسرار
--    الأسرار (API Key, Webhook Secret) تُخزَّن في company_secrets المعزول
--    بنفس نمط zatca_api_key و ejar_api_key الحاليين.
-- ----------------------------------------------------------------------------
create table if not exists public.channel_manager_settings (
  company_id        uuid primary key references public.companies(id) on delete cascade,
  provider          text not null default 'channex' check (provider in ('channex','beds24')),
  enabled           boolean not null default false,
  environment       text not null default 'sandbox' check (environment in ('sandbox','production')),
  connection_status text not null default 'disconnected' check (connection_status in ('disconnected','connected','error')),
  channex_webhook_id text,   -- معرّف الـ webhook المُسجَّل فعلياً على حساب Channex (لإدارته لاحقاً: تحديث/حذف)
  last_tested_at    timestamptz,
  last_sync_at      timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

grant select, insert, update on public.channel_manager_settings to authenticated;
grant all on public.channel_manager_settings to service_role;

alter table public.channel_manager_settings enable row level security;

drop policy if exists channel_manager_settings_select on public.channel_manager_settings;
create policy channel_manager_settings_select on public.channel_manager_settings for select to authenticated
  using (company_id = public.current_company_id()
         and public.current_role_of_user() in ('owner','manager','accountant'));

-- الكتابة المباشرة من الواجهة غير مسموحة عمداً — تتم فقط عبر
-- update_channex_settings (security definer) بالأسفل، لضمان التحقق من
-- الصلاحية والتحقق من صحة قيمة environment في مكان واحد موثوق.

-- ----------------------------------------------------------------------------
-- 2) أسرار Channex — أعمدة إضافية على company_secrets الموجود مسبقاً
-- ----------------------------------------------------------------------------
alter table public.company_secrets add column if not exists channex_api_key text;
alter table public.company_secrets add column if not exists channex_webhook_secret text;

-- ----------------------------------------------------------------------------
-- 3) ربط الوحدة بالوحدة المقابلة على Channex (Property Mapping)
-- ----------------------------------------------------------------------------
alter table public.units add column if not exists channex_property_id  text;
alter table public.units add column if not exists channex_room_type_id text;
alter table public.units add column if not exists channex_rate_plan_id text;
alter table public.units add column if not exists ota_sync_enabled     boolean not null default false;

create index if not exists idx_units_channex_room on public.units(channex_room_type_id) where channex_room_type_id is not null;

-- ----------------------------------------------------------------------------
-- 4) مصدر الحجز وبياناته الخارجية على bookings
--    booking_source نص حر (بدون check enum) عمداً — حتى تُضاف منصات
--    مستقبلية دون أي تعديل على مخطط قاعدة البيانات الأساسي، بحسب
--    القائمة المدعومة فعلياً داخل كود وحدة التكامل نفسها.
-- ----------------------------------------------------------------------------
alter table public.bookings add column if not exists booking_source       text not null default 'direct';
alter table public.bookings add column if not exists ota_reservation_id   text;   -- رقم الحجز الظاهر للعميل على المنصة (OTA reservation code)
alter table public.bookings add column if not exists ota_channel_booking_id text; -- معرّف الحجز الداخلي لدى Channex نفسه (لضمان عدم التكرار)
alter table public.bookings add column if not exists ota_commission      numeric(12,2);
alter table public.bookings add column if not exists ota_raw_payload     jsonb;

-- منع معالجة نفس حجز القناة مرتين لو أُعيد إرسال نفس الـ webhook.
-- المفتاح الحقيقي المضمون الحضور في كل حمولة من Channex هو
-- ota_reservation_code (رمز الحجز الظاهر للضيف على المنصة) — وليس
-- معرّف Channex الداخلي (booking.id) الذي لا يصل دائماً ضمن الـ webhook
-- الخام حسب توثيق Channex الرسمي (يظهر فقط عبر استعلام booking_revisions).
create unique index if not exists uq_bookings_ota_reservation
  on public.bookings(company_id, booking_source, ota_reservation_id)
  where ota_reservation_id is not null;

-- نُبقي فهرساً ثانوياً على معرّف Channex الداخلي كإثراء اختياري عند توفره
create unique index if not exists uq_bookings_ota_channel_booking
  on public.bookings(company_id, ota_channel_booking_id)
  where ota_channel_booking_id is not null;

create index if not exists idx_bookings_source on public.bookings(company_id, booking_source);

-- ----------------------------------------------------------------------------
-- 5) سجل كل Webhook وارد من مدير القنوات (Logging)
-- ----------------------------------------------------------------------------
create table if not exists public.ota_webhook_logs (
  id                 uuid primary key default uuid_generate_v4(),
  company_id         uuid references public.companies(id) on delete cascade,
  provider           text not null default 'channex',
  event_type         text,
  external_booking_id text,
  request_payload    jsonb,
  http_status        int,
  processed          boolean not null default false,
  error              text,
  created_at         timestamptz not null default now()
);

create index if not exists idx_ota_webhook_logs_company on public.ota_webhook_logs(company_id, created_at desc);

grant select on public.ota_webhook_logs to authenticated;
grant all on public.ota_webhook_logs to service_role;

alter table public.ota_webhook_logs enable row level security;

drop policy if exists ota_webhook_logs_select on public.ota_webhook_logs;
create policy ota_webhook_logs_select on public.ota_webhook_logs for select to authenticated
  using (company_id = public.current_company_id()
         and public.current_role_of_user() in ('owner','manager','accountant'));
-- لا توجد سياسة insert/update لـ authenticated عمداً: الكتابة حصراً عبر
-- service_role داخل Edge Function الـ webhook (لا يمكن تزوير السجل من المتصفح).

-- ----------------------------------------------------------------------------
-- 6) طابور المزامنة الصادرة (الأسعار/الإتاحة) — QUEUE + BACKGROUND JOBS
-- ----------------------------------------------------------------------------
create table if not exists public.ota_sync_queue (
  id            uuid primary key default uuid_generate_v4(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  unit_id       uuid references public.units(id) on delete cascade,
  job_type      text not null check (job_type in ('push_price','push_availability','push_restrictions','pull_reservations')),
  payload       jsonb not null default '{}',
  status        text not null default 'pending' check (status in ('pending','processing','done','failed')),
  attempts      int not null default 0,
  last_error    text,
  created_at    timestamptz not null default now(),
  processed_at  timestamptz
);

create index if not exists idx_ota_sync_queue_pending on public.ota_sync_queue(status, created_at) where status in ('pending','failed');
create index if not exists idx_ota_sync_queue_company on public.ota_sync_queue(company_id, created_at desc);

grant select on public.ota_sync_queue to authenticated;
grant all on public.ota_sync_queue to service_role;

alter table public.ota_sync_queue enable row level security;

drop policy if exists ota_sync_queue_select on public.ota_sync_queue;
create policy ota_sync_queue_select on public.ota_sync_queue for select to authenticated
  using (company_id = public.current_company_id()
         and public.current_role_of_user() in ('owner','manager','accountant'));

-- ----------------------------------------------------------------------------
-- 7) دالة آمنة لحفظ إعدادات وأسرار Channex — نفس نمط update_ejar_settings
-- ----------------------------------------------------------------------------
create or replace function public.update_channex_settings(
  p_api_key text, p_webhook_secret text, p_enabled boolean, p_environment text
) returns void
language plpgsql security definer set search_path = public as $$
declare v_role user_role; v_cid uuid;
begin
  select role, company_id into v_role, v_cid from profiles where id = auth.uid();
  if v_role is null or v_role not in ('owner','manager','accountant') then
    raise exception 'صلاحية ضبط إعدادات ربط منصات الحجز حصرية للمالك أو المدير أو المحاسب';
  end if;
  if p_environment not in ('sandbox','production') then
    raise exception 'قيمة البيئة غير صحيحة';
  end if;

  insert into public.channel_manager_settings (company_id, provider, enabled, environment)
    values (v_cid, 'channex', p_enabled, p_environment)
  on conflict (company_id) do update
    set enabled = p_enabled, environment = p_environment, updated_at = now();

  insert into public.company_secrets (company_id, channex_api_key, channex_webhook_secret)
    values (v_cid, nullif(btrim(coalesce(p_api_key,'')), ''), nullif(btrim(coalesce(p_webhook_secret,'')), ''))
  on conflict (company_id) do update
    set channex_api_key       = coalesce(excluded.channex_api_key, public.company_secrets.channex_api_key),
        channex_webhook_secret = coalesce(excluded.channex_webhook_secret, public.company_secrets.channex_webhook_secret),
        updated_at = now();
end $$;

revoke all on function public.update_channex_settings(text, text, boolean, text) from public;
grant execute on function public.update_channex_settings(text, text, boolean, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 8) دالة آمنة لربط وحدة محلية بوحدة/خطة سعر على Channex (Property Mapping)
-- ----------------------------------------------------------------------------
create or replace function public.set_unit_channex_mapping(
  p_unit_id uuid, p_property_id text, p_room_type_id text, p_rate_plan_id text, p_sync_enabled boolean
) returns void
language plpgsql security definer set search_path = public as $$
declare v_role user_role; v_cid uuid;
begin
  select role, company_id into v_role, v_cid from profiles where id = auth.uid();
  if v_role is null or v_role not in ('owner','manager','accountant') then
    raise exception 'صلاحية ربط الوحدات بمنصات الحجز حصرية للمالك أو المدير أو المحاسب';
  end if;

  update public.units set
    channex_property_id  = nullif(btrim(coalesce(p_property_id,'')), ''),
    channex_room_type_id = nullif(btrim(coalesce(p_room_type_id,'')), ''),
    channex_rate_plan_id = nullif(btrim(coalesce(p_rate_plan_id,'')), ''),
    ota_sync_enabled     = p_sync_enabled,
    updated_at = now()
  where id = p_unit_id and company_id = v_cid;

  if not found then
    raise exception 'الوحدة غير موجودة أو لا تتبع شركتك';
  end if;
end $$;

revoke all on function public.set_unit_channex_mapping(uuid, text, text, text, boolean) from public;
grant execute on function public.set_unit_channex_mapping(uuid, text, text, text, boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- 9) تصحيح دقيق على enforce_owner_only_cancel: السماح بالإلغاء التلقائي
--    القادم من خدمة موثوقة (service_role — أي Edge Function للنظام، مثل
--    استقبال إلغاء حجز من منصة خارجية) بينما تبقى الحماية كما هي تماماً
--    لأي طلب صادر من متصفح مستخدم حقيقي (auth.uid() موجود دائماً حينها).
--    service_role لا يُكشف للواجهة الأمامية أبداً — يُستخدم فقط داخل
--    Edge Functions على الخادم، تماماً كبقية دوال ejar-* الحالية.
-- ----------------------------------------------------------------------------
create or replace function enforce_owner_only_cancel()
returns trigger language plpgsql security definer as $$
declare v_role user_role;
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    if auth.uid() is not null then
      select role into v_role from profiles where id = auth.uid();
      if v_role is distinct from 'owner' then
        raise exception 'إلغاء الحجز صلاحية حصرية لحساب المالك | Only the owner can cancel bookings';
      end if;
      new.cancelled_by := auth.uid();
    end if;
    -- auth.uid() = null ⇐ الطلب صادر من عملية نظام موثوقة (service_role)،
    -- مثل إشعار إلغاء وارد فعلياً من منصة حجز خارجية عبر مدير القنوات.
  end if;
  return new;
end $$;

-- ----------------------------------------------------------------------------
-- 10) مساعد إدراج في طابور المزامنة (تُستدعى من المُشغّلات وأيضاً يمكن
--     استدعاؤها يدوياً لإعادة محاولة عنصر فشل)
-- ----------------------------------------------------------------------------
create or replace function public.enqueue_ota_sync(
  p_company_id uuid, p_unit_id uuid, p_job_type text, p_payload jsonb
) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.ota_sync_queue (company_id, unit_id, job_type, payload)
  values (p_company_id, p_unit_id, p_job_type, p_payload);
end $$;

-- ----------------------------------------------------------------------------
-- 11) مُشغّل: عند تغيير السعر اليومي لوحدة مرتبطة ومُفعَّلة المزامنة،
--     أدرج مهمة "دفع السعر" في الطابور تلقائياً (Price Synchronization)
-- ----------------------------------------------------------------------------
create or replace function trg_fn_enqueue_price_sync()
returns trigger language plpgsql security definer as $$
begin
  if new.ota_sync_enabled and new.channex_room_type_id is not null and new.channex_rate_plan_id is not null
     and (new.daily_price is distinct from old.daily_price) then
    perform public.enqueue_ota_sync(new.company_id, new.id, 'push_price',
      jsonb_build_object('daily_price', new.daily_price));
  end if;
  return new;
end $$;

drop trigger if exists trg_enqueue_price_sync on public.units;
create trigger trg_enqueue_price_sync
after update of daily_price on public.units
for each row execute function trg_fn_enqueue_price_sync();

-- ----------------------------------------------------------------------------
-- 12) مُشغّل: عند إنشاء/تعديل/إلغاء حجز "مباشر" داخل المازن (وليس قادماً
--     أصلاً من نفس القناة) على وحدة مرتبطة، أدرج مهمة "دفع الإتاحة" حتى
--     تُغلَق التواريخ فوراً على Booking.com/Airbnb وتُمنع الحجوزات المزدوجة
-- ----------------------------------------------------------------------------
create or replace function trg_fn_enqueue_availability_sync()
returns trigger language plpgsql security definer as $$
declare v_unit units%rowtype;
begin
  select * into v_unit from public.units where id = new.unit_id;
  if v_unit.ota_sync_enabled and v_unit.channex_room_type_id is not null and coalesce(new.booking_source,'direct') = 'direct' then
    perform public.enqueue_ota_sync(new.company_id, new.unit_id, 'push_availability',
      jsonb_build_object(
        'check_in', new.check_in_date, 'check_out', new.check_out_date,
        'status', new.status, 'booking_id', new.id
      ));
  end if;
  return new;
end $$;

drop trigger if exists trg_enqueue_availability_sync on public.bookings;
create trigger trg_enqueue_availability_sync
after insert or update of status, check_in_date, check_out_date on public.bookings
for each row execute function trg_fn_enqueue_availability_sync();
