-- =====================================================================
-- المازن | AlMazen — ملف الإعداد الشامل لقاعدة البيانات
-- نفّذ هذا الملف وحده مرة واحدة في SQL Editor — يغني عن الملفات 001 إلى 007
-- آمن لإعادة التنفيذ: ينظف أي بقايا من محاولات سابقة ثم يبني كل شيء
-- =====================================================================

-- ---------------------------------------------------------------------
-- (أ) تنظيف أي بقايا من محاولات سابقة
-- ---------------------------------------------------------------------
drop table if exists audit_logs, ai_insights, ai_conversations, service_requests,
  tenant_portal_accounts, loyalty_transactions, automation_logs, notifications,
  checklists, checkin_logs, key_logs, maintenance_requests, expenses, invoices,
  insurance_records, payment_schedules, payments, booking_companions, bookings,
  customers, pricing_rules, unit_assets, unit_media, units, properties,
  profiles, companies cascade;

drop function if exists set_updated_at, calc_booking_totals, sync_unit_status,
  enforce_owner_only_cancel, enforce_owner_only_pricing, automate_on_check_in,
  apply_payment_to_schedule, next_invoice_number, dashboard_today,
  occupancy_rate, unit_history, overdue_payments,
  current_company_id, current_role_of_user cascade;

drop type if exists user_role, unit_category, unit_status, booking_status,
  rent_period, payment_method, payment_type, id_document_type, insurance_status,
  maintenance_type, maintenance_status, invoice_type, invoice_status,
  notification_channel, notification_status, expense_category, key_action,
  checkin_type, service_request_type, service_request_status cascade;

drop policy if exists storage_upload_own_company on storage.objects;
drop policy if exists storage_read_all on storage.objects;
drop policy if exists storage_delete_own_company on storage.objects;


-- =====================================================================
-- المازن | AlMazen - نظام إدارة الوحدات السكنية والشاليهات والشقق المفروشة
-- Migration 001: Extensions, Enums, Multi-Tenant Core
-- =====================================================================

create extension if not exists "uuid-ossp";
create extension if not exists btree_gist; -- لمنع الحجز المزدوج عبر exclusion constraint
create extension if not exists pg_trgm;    -- للبحث النصي السريع
create extension if not exists pgcrypto;   -- لتوليد توكن بوابة الساكن

-- ---------------------------------------------------------------------
-- الأنواع (Enums)
-- ---------------------------------------------------------------------
do $$ begin
create type user_role as enum ('owner', 'manager', 'accountant', 'employee');
exception when duplicate_object then null; end $$;

do $$ begin
create type unit_category as enum ('apartment', 'chalet', 'furnished_unit', 'hotel_room');
exception when duplicate_object then null; end $$;

do $$ begin
create type unit_status as enum (
  'available',      -- متاح للإيجار (أخضر)
  'reserved',       -- محجوز مسبقاً (برتقالي)
  'occupied',       -- مسكون (أحمر)
  'cleaning',       -- قيد التنظيف (أصفر)
  'maintenance'     -- تحت الصيانة (أصفر)
);
exception when duplicate_object then null; end $$;

do $$ begin
create type booking_status as enum (
  'pending',        -- بانتظار التأكيد
  'confirmed',      -- مؤكد (محجوز)
  'checked_in',     -- تم تسليم الوحدة (مسكون)
  'checked_out',    -- تم الإخلاء
  'cancelled'       -- ملغي (صلاحية المالك فقط)
);
exception when duplicate_object then null; end $$;

do $$ begin
create type rent_period as enum ('daily', 'monthly', 'yearly');
exception when duplicate_object then null; end $$;

do $$ begin
create type payment_method as enum ('cash', 'bank_transfer', 'card');
exception when duplicate_object then null; end $$;

do $$ begin
create type payment_type as enum ('rent', 'down_payment', 'insurance', 'penalty', 'other');
exception when duplicate_object then null; end $$;
-- down_payment = العربون | insurance = التأمين

do $$ begin
create type id_document_type as enum ('national_id', 'iqama', 'passport');
exception when duplicate_object then null; end $$;

do $$ begin
create type insurance_status as enum ('paid', 'held', 'deducted', 'refunded');
exception when duplicate_object then null; end $$;

do $$ begin
create type maintenance_type as enum ('cleaning', 'maintenance');
exception when duplicate_object then null; end $$;
do $$ begin
create type maintenance_status as enum ('open', 'in_progress', 'done');
exception when duplicate_object then null; end $$;

do $$ begin
create type invoice_type as enum ('simplified', 'standard');
exception when duplicate_object then null; end $$; -- مبسطة / معتمدة
do $$ begin
create type invoice_status as enum ('draft', 'issued', 'reported_to_zatca', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
create type notification_channel as enum ('in_app', 'whatsapp', 'sms', 'email');
exception when duplicate_object then null; end $$;
do $$ begin
create type notification_status as enum ('pending', 'sent', 'failed', 'read');
exception when duplicate_object then null; end $$;

do $$ begin
create type expense_category as enum ('electricity', 'water', 'maintenance', 'salaries', 'cleaning', 'internet', 'other');
exception when duplicate_object then null; end $$;

do $$ begin
create type key_action as enum ('issued', 'returned', 'lost');
exception when duplicate_object then null; end $$;

do $$ begin
create type checkin_type as enum ('check_in', 'check_out');
exception when duplicate_object then null; end $$;

do $$ begin
create type service_request_type as enum ('extension', 'extra_service', 'complaint', 'maintenance');
exception when duplicate_object then null; end $$;
do $$ begin
create type service_request_status as enum ('new', 'in_progress', 'done', 'rejected');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- 1) الشركات (Multi-Tenant Root)
-- ---------------------------------------------------------------------
create table companies (
  id                uuid primary key default uuid_generate_v4(),
  name              text not null,                 -- الاسم بالعربية
  name_en           text,
  logo_url          text,                          -- يستبدل شعار النظام تلقائياً
  vat_number        text,                          -- الرقم الضريبي
  cr_number         text,                          -- السجل التجاري
  address           text,
  city              text,
  phone             text,
  email             text,
  invoice_footer    text,                          -- نص أسفل الفاتورة
  zatca_api_key     text,                          -- يضاف لاحقاً من بوابة المالك
  zatca_enabled     boolean not null default false,
  default_vat_rate  numeric(5,2) not null default 15.00,
  currency          text not null default 'SAR',
  settings          jsonb not null default '{}',   -- إعدادات مرنة (لغة، تنبيهات..)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2) المستخدمون (مرتبطون بـ auth.users في Supabase)
-- ---------------------------------------------------------------------
create table profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  company_id    uuid not null references companies(id) on delete cascade,
  role          user_role not null default 'employee',
  full_name     text not null,
  username      text,                              -- اسم مستخدم للموظف (ينشئه المالك)
  phone         text,
  avatar_url    text,
  is_active     boolean not null default true,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (company_id, username)
);

create index idx_profiles_company on profiles(company_id);

-- ---------------------------------------------------------------------
-- 3) العقارات / المباني
-- ---------------------------------------------------------------------
create table properties (
  id          uuid primary key default uuid_generate_v4(),
  company_id  uuid not null references companies(id) on delete cascade,
  name        text not null,
  city        text,
  address     text,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index idx_properties_company on properties(company_id);

-- ---------------------------------------------------------------------
-- 4) الوحدات السكنية
-- ---------------------------------------------------------------------
create table units (
  id             uuid primary key default uuid_generate_v4(),
  company_id     uuid not null references companies(id) on delete cascade,
  property_id    uuid references properties(id) on delete set null,
  unit_number    text not null,                    -- رقم الوحدة/الشقة
  category       unit_category not null,
  status         unit_status not null default 'available',
  daily_price    numeric(12,2),                    -- السعر اليومي
  monthly_price  numeric(12,2),                    -- السعر الشهري
  yearly_price   numeric(12,2),                    -- السعر السنوي
  description    text,                             -- نبذة عن الوصف
  floor_no       text,
  bedrooms       int,
  bathrooms      int,
  area_sqm       numeric(8,2),
  features       jsonb not null default '[]',      -- مزايا (واي فاي، مسبح..)
  is_active      boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (company_id, unit_number)
);

create index idx_units_company_status on units(company_id, status);

-- صور وفيديوهات الوحدة
create table unit_media (
  id          uuid primary key default uuid_generate_v4(),
  company_id  uuid not null references companies(id) on delete cascade,
  unit_id     uuid not null references units(id) on delete cascade,
  media_type  text not null check (media_type in ('image','video')),
  url         text not null,
  caption     text,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

create index idx_unit_media_unit on unit_media(unit_id);

-- أصول ومحتويات الوحدة (تلفزيون، ثلاجة، مكيف..)
create table unit_assets (
  id          uuid primary key default uuid_generate_v4(),
  company_id  uuid not null references companies(id) on delete cascade,
  unit_id     uuid not null references units(id) on delete cascade,
  name        text not null,
  quantity    int not null default 1,
  condition   text not null default 'good' check (condition in ('good','fair','damaged','missing')),
  notes       text,
  photo_url   text,
  updated_at  timestamptz not null default now()
);

create index idx_unit_assets_unit on unit_assets(unit_id);

-- قواعد التسعير الموسمي / الديناميكي
create table pricing_rules (
  id                 uuid primary key default uuid_generate_v4(),
  company_id         uuid not null references companies(id) on delete cascade,
  unit_id            uuid references units(id) on delete cascade, -- null = يطبق على الكل
  name               text not null,               -- مثال: موسم الصيف، عيد الفطر
  date_from          date not null,
  date_to            date not null,
  adjustment_percent numeric(6,2) not null,       -- +20 أو -15
  is_ai_suggested    boolean not null default false,
  is_active          boolean not null default true,
  created_by         uuid references profiles(id),
  created_at         timestamptz not null default now(),
  check (date_to >= date_from)
);

create index idx_pricing_rules_company on pricing_rules(company_id, date_from, date_to);

-- =====================================================================
-- Migration 002: CRM, Bookings, Payments, Insurance, Invoices (ZATCA)
-- =====================================================================

-- ---------------------------------------------------------------------
-- 5) العملاء (CRM)
-- ---------------------------------------------------------------------
create table customers (
  id               uuid primary key default uuid_generate_v4(),
  company_id       uuid not null references companies(id) on delete cascade,
  full_name        text not null,
  id_type          id_document_type not null,
  id_number        text not null,                 -- هوية / إقامة / جواز
  id_document_url  text,                          -- صورة إثبات الشخصية
  phone            text not null,
  email            text,
  nationality      text,
  is_vip           boolean not null default false,
  rating           int check (rating between 1 and 5),
  loyalty_points   int not null default 0,
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (company_id, id_number)
);

create index idx_customers_company on customers(company_id);
create index idx_customers_search on customers using gin (full_name gin_trgm_ops);

-- ---------------------------------------------------------------------
-- 6) الحجوزات
-- ---------------------------------------------------------------------
create table bookings (
  id                uuid primary key default uuid_generate_v4(),
  company_id        uuid not null references companies(id) on delete cascade,
  unit_id           uuid not null references units(id) on delete restrict,
  customer_id       uuid not null references customers(id) on delete restrict,
  employee_id       uuid references profiles(id),          -- الموظف المسؤول
  contract_number   text,                                   -- رقم العقد
  status            booking_status not null default 'pending',
  rent_period       rent_period not null,
  check_in_date     date not null,
  check_out_date    date not null,
  actual_check_in   timestamptz,
  actual_check_out  timestamptz,
  base_price        numeric(12,2) not null,                 -- السعر الأساسي المسجل
  discount_percent  numeric(5,2) not null default 0,
  discount_amount   numeric(12,2) not null default 0,       -- يحسب تلقائياً
  total_amount      numeric(12,2) not null,                 -- الإجمالي بعد الخصم
  down_payment      numeric(12,2) not null default 0,       -- قيمة العربون
  insurance_amount  numeric(12,2) not null default 0,       -- قيمة التأمين
  cancel_reason     text,
  cancelled_by      uuid references profiles(id),           -- المالك فقط
  cancelled_at      timestamptz,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (check_out_date > check_in_date),
  -- منع الحجز المزدوج لنفس الوحدة في تواريخ متداخلة (للحجوزات النشطة)
  constraint no_double_booking exclude using gist (
    unit_id with =,
    daterange(check_in_date, check_out_date, '[)') with &&
  ) where (status in ('confirmed', 'checked_in'))
);

create index idx_bookings_company on bookings(company_id, status);
create index idx_bookings_unit on bookings(unit_id, check_in_date);
create index idx_bookings_customer on bookings(customer_id);

-- المرافقون للمستأجر
create table booking_companions (
  id          uuid primary key default uuid_generate_v4(),
  company_id  uuid not null references companies(id) on delete cascade,
  booking_id  uuid not null references bookings(id) on delete cascade,
  full_name   text not null,
  id_type     id_document_type,
  id_number   text,
  relation    text,
  created_at  timestamptz not null default now()
);

create index idx_companions_booking on booking_companions(booking_id);

-- ---------------------------------------------------------------------
-- 7) الدفعات
-- ---------------------------------------------------------------------
create table payments (
  id               uuid primary key default uuid_generate_v4(),
  company_id       uuid not null references companies(id) on delete cascade,
  booking_id       uuid not null references bookings(id) on delete cascade,
  payment_type     payment_type not null default 'rent',
  amount           numeric(12,2) not null check (amount > 0),
  payment_date     date not null default current_date,
  method           payment_method not null,
  reference_number text,                          -- رقم الإيصال / التحويل
  document_url     text,                          -- مستند التحويل أو السداد
  received_by      uuid references profiles(id),
  notes            text,
  created_at       timestamptz not null default now()
);

create index idx_payments_booking on payments(booking_id);
create index idx_payments_company_date on payments(company_id, payment_date);

-- جدولة الدفعات (للتنبيهات التلقائية عن التأخير)
create table payment_schedules (
  id           uuid primary key default uuid_generate_v4(),
  company_id   uuid not null references companies(id) on delete cascade,
  booking_id   uuid not null references bookings(id) on delete cascade,
  due_date     date not null,
  amount_due   numeric(12,2) not null,
  is_paid      boolean not null default false,
  paid_at      timestamptz,
  reminder_sent_at timestamptz,                   -- آخر تذكير واتساب
  created_at   timestamptz not null default now()
);

create index idx_schedules_due on payment_schedules(company_id, due_date) where not is_paid;

-- ---------------------------------------------------------------------
-- 8) دورة حياة التأمين
-- ---------------------------------------------------------------------
create table insurance_records (
  id               uuid primary key default uuid_generate_v4(),
  company_id       uuid not null references companies(id) on delete cascade,
  booking_id       uuid not null references bookings(id) on delete cascade,
  amount           numeric(12,2) not null,
  status           insurance_status not null default 'paid',
  deduction_amount numeric(12,2) not null default 0,
  deduction_reason text,
  photos           jsonb not null default '[]',   -- صور الأضرار
  report_url       text,                          -- المحضر
  refunded_at      timestamptz,
  updated_by       uuid references profiles(id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index idx_insurance_booking on insurance_records(booking_id);

-- ---------------------------------------------------------------------
-- 9) الفواتير الضريبية (ZATCA)
-- ---------------------------------------------------------------------
create table invoices (
  id                 uuid primary key default uuid_generate_v4(),
  company_id         uuid not null references companies(id) on delete cascade,
  booking_id         uuid references bookings(id) on delete set null,
  invoice_number     text not null,
  invoice_type       invoice_type not null default 'simplified',
  status             invoice_status not null default 'issued',
  -- لقطة بيانات العميل وقت الإصدار (لا تتغير لاحقاً)
  customer_name      text not null,
  customer_vat       text,                        -- للشركات (فاتورة معتمدة)
  customer_cr        text,
  customer_address   text,
  subtotal           numeric(12,2) not null,
  vat_rate           numeric(5,2) not null default 15.00,
  vat_amount         numeric(12,2) not null,
  total              numeric(12,2) not null,
  qr_code_data       text,                        -- TLV Base64 وفق ZATCA
  zatca_uuid         text,
  zatca_reported_at  timestamptz,
  pdf_url            text,
  issued_by          uuid references profiles(id),
  issued_at          timestamptz not null default now(),
  created_at         timestamptz not null default now(),
  unique (company_id, invoice_number)
);

create index idx_invoices_company on invoices(company_id, issued_at);

-- ---------------------------------------------------------------------
-- 10) المصروفات (لحساب صافي الربح)
-- ---------------------------------------------------------------------
create table expenses (
  id            uuid primary key default uuid_generate_v4(),
  company_id    uuid not null references companies(id) on delete cascade,
  unit_id       uuid references units(id) on delete set null, -- null = مصروف عام
  category      expense_category not null,
  amount        numeric(12,2) not null check (amount > 0),
  expense_date  date not null default current_date,
  description   text,
  invoice_url   text,                             -- صورة فاتورة المصروف
  ocr_extracted jsonb,                            -- ناتج قراءة الفاتورة بالذكاء الاصطناعي
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now()
);

create index idx_expenses_company on expenses(company_id, expense_date);
create index idx_expenses_unit on expenses(unit_id);

-- =====================================================================
-- Migration 003: Operations — Maintenance, Keys, Check-in/out,
-- Checklists, Notifications, Loyalty, Tenant Portal, AI, Audit
-- =====================================================================

-- ---------------------------------------------------------------------
-- 11) الصيانة والتنظيف
-- ---------------------------------------------------------------------
create table maintenance_requests (
  id           uuid primary key default uuid_generate_v4(),
  company_id   uuid not null references companies(id) on delete cascade,
  unit_id      uuid not null references units(id) on delete cascade,
  booking_id   uuid references bookings(id) on delete set null,
  request_type maintenance_type not null,
  status       maintenance_status not null default 'open',
  description  text,
  cost         numeric(12,2) not null default 0,
  photos       jsonb not null default '[]',
  assigned_to  uuid references profiles(id),
  opened_by    uuid references profiles(id),
  opened_at    timestamptz not null default now(),
  closed_at    timestamptz
);

create index idx_maintenance_unit on maintenance_requests(unit_id, status);

-- ---------------------------------------------------------------------
-- 12) إدارة المفاتيح
-- ---------------------------------------------------------------------
create table key_logs (
  id           uuid primary key default uuid_generate_v4(),
  company_id   uuid not null references companies(id) on delete cascade,
  unit_id      uuid not null references units(id) on delete cascade,
  booking_id   uuid references bookings(id) on delete set null,
  action       key_action not null,
  person_name  text not null,                     -- من استلم/أعاد
  fine_amount  numeric(12,2) not null default 0,  -- غرامة الفقدان
  notes        text,
  employee_id  uuid references profiles(id),
  created_at   timestamptz not null default now()
);

create index idx_key_logs_unit on key_logs(unit_id);

-- ---------------------------------------------------------------------
-- 13) سجل الدخول والخروج (Check-in / Check-out)
-- ---------------------------------------------------------------------
create table checkin_logs (
  id                     uuid primary key default uuid_generate_v4(),
  company_id             uuid not null references companies(id) on delete cascade,
  booking_id             uuid not null references bookings(id) on delete cascade,
  log_type               checkin_type not null,
  occurred_at            timestamptz not null default now(),
  photo_url              text,
  gps_lat                numeric(10,7),
  gps_lng                numeric(10,7),
  customer_signature_url text,
  employee_signature_url text,
  employee_id            uuid references profiles(id),
  notes                  text
);

create index idx_checkin_booking on checkin_logs(booking_id);

-- ---------------------------------------------------------------------
-- 14) قوائم الاستلام والتسليم (Checklist احترافية)
-- ---------------------------------------------------------------------
create table checklists (
  id            uuid primary key default uuid_generate_v4(),
  company_id    uuid not null references companies(id) on delete cascade,
  booking_id    uuid not null references bookings(id) on delete cascade,
  phase         checkin_type not null,            -- استلام أو تسليم
  -- items: [{name, status: ok|damaged|missing, note, photo_url}]
  items         jsonb not null default '[]',
  photos_before jsonb not null default '[]',
  photos_after  jsonb not null default '[]',
  completed_by  uuid references profiles(id),
  completed_at  timestamptz,
  created_at    timestamptz not null default now()
);

create index idx_checklists_booking on checklists(booking_id);

-- ---------------------------------------------------------------------
-- 15) الإشعارات وسجل الأتمتة
-- ---------------------------------------------------------------------
create table notifications (
  id           uuid primary key default uuid_generate_v4(),
  company_id   uuid not null references companies(id) on delete cascade,
  user_id      uuid references profiles(id) on delete cascade,  -- null = حسب الدور
  target_role  user_role,                          -- إشعار لكل من يحمل الدور
  customer_id  uuid references customers(id) on delete cascade, -- إشعارات العميل
  channel      notification_channel not null default 'in_app',
  status       notification_status not null default 'pending',
  event_type   text not null,  -- new_booking | contract_ending | late_payment |
                               -- checkout_soon | transfer_received | cancellation |
                               -- maintenance_request | welcome_message ...
  title        text not null,
  body         text,
  booking_id   uuid references bookings(id) on delete set null,
  unit_id      uuid references units(id) on delete set null,
  sent_at      timestamptz,
  read_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index idx_notifications_user on notifications(user_id, status);
create index idx_notifications_company on notifications(company_id, created_at);

-- سجل الأتمتة (كل رسالة واتساب/SMS/إيميل/فاتورة تلقائية)
create table automation_logs (
  id          uuid primary key default uuid_generate_v4(),
  company_id  uuid not null references companies(id) on delete cascade,
  action      text not null,          -- send_whatsapp | send_sms | send_email |
                                      -- create_invoice | notify_accountant ...
  payload     jsonb not null default '{}',
  success     boolean,
  error       text,
  booking_id  uuid references bookings(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 16) نظام الولاء
-- ---------------------------------------------------------------------
create table loyalty_transactions (
  id          uuid primary key default uuid_generate_v4(),
  company_id  uuid not null references companies(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  booking_id  uuid references bookings(id) on delete set null,
  points      int not null,                       -- موجب = كسب، سالب = استبدال
  reason      text,
  created_at  timestamptz not null default now()
);

create index idx_loyalty_customer on loyalty_transactions(customer_id);

-- ---------------------------------------------------------------------
-- 17) بوابة الساكن (تنشأ تلقائياً عند بدء الإيجار)
-- ---------------------------------------------------------------------
create table tenant_portal_accounts (
  id            uuid primary key default uuid_generate_v4(),
  company_id    uuid not null references companies(id) on delete cascade,
  customer_id   uuid not null references customers(id) on delete cascade,
  booking_id    uuid not null references bookings(id) on delete cascade,
  username      text not null,
  access_token  text not null,                    -- رابط دخول (يرسل بالواتساب)
  is_active     boolean not null default true,
  last_login_at timestamptz,
  created_at    timestamptz not null default now(),
  unique (company_id, username)
);

-- طلبات الساكن (تمديد / خدمات إضافية / شكاوى)
create table service_requests (
  id           uuid primary key default uuid_generate_v4(),
  company_id   uuid not null references companies(id) on delete cascade,
  booking_id   uuid not null references bookings(id) on delete cascade,
  request_type service_request_type not null,
  status       service_request_status not null default 'new',
  details      text,
  handled_by   uuid references profiles(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index idx_service_requests_company on service_requests(company_id, status);

-- ---------------------------------------------------------------------
-- 18) مركز الذكاء الاصطناعي
-- ---------------------------------------------------------------------
create table ai_conversations (
  id          uuid primary key default uuid_generate_v4(),
  company_id  uuid not null references companies(id) on delete cascade,
  user_id     uuid not null references profiles(id) on delete cascade,
  assistant   text not null check (assistant in ('accountant','employee','analytics')),
  messages    jsonb not null default '[]',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table ai_insights (
  id           uuid primary key default uuid_generate_v4(),
  company_id   uuid not null references companies(id) on delete cascade,
  insight_type text not null,  -- price_suggestion | discount_suggestion |
                               -- fraud_alert | anomaly_booking | occupancy_forecast |
                               -- revenue_forecast | monthly_summary
  unit_id      uuid references units(id) on delete cascade,
  payload      jsonb not null default '{}',
  is_dismissed boolean not null default false,
  created_at   timestamptz not null default now()
);

create index idx_ai_insights_company on ai_insights(company_id, insight_type);

-- ---------------------------------------------------------------------
-- 19) سجل التدقيق (Audit Log)
-- ---------------------------------------------------------------------
create table audit_logs (
  id          uuid primary key default uuid_generate_v4(),
  company_id  uuid not null references companies(id) on delete cascade,
  user_id     uuid references profiles(id),
  action      text not null,                      -- create | update | delete | cancel
  entity      text not null,                      -- bookings | units | payments ...
  entity_id   uuid,
  old_data    jsonb,
  new_data    jsonb,
  created_at  timestamptz not null default now()
);

create index idx_audit_company on audit_logs(company_id, created_at);

-- =====================================================================
-- Migration 004: Functions & Triggers — الأتمتة الكاملة بدون تدخل بشري
-- =====================================================================

-- ---------------------------------------------------------------------
-- تحديث updated_at تلقائياً
-- ---------------------------------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['companies','profiles','properties','units','customers',
    'bookings','insurance_records','service_requests','ai_conversations','unit_assets']
  loop
    execute format(
      'create trigger trg_%s_updated before update on %s
       for each row execute function set_updated_at()', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- الحساب التلقائي للخصم والإجمالي في الحجز
-- ---------------------------------------------------------------------
create or replace function calc_booking_totals()
returns trigger language plpgsql as $$
begin
  if new.discount_percent > 0 then
    new.discount_amount := round(new.base_price * new.discount_percent / 100, 2);
  end if;
  new.total_amount := new.base_price - new.discount_amount;
  return new;
end $$;

create trigger trg_booking_totals
before insert or update of base_price, discount_percent, discount_amount on bookings
for each row execute function calc_booking_totals();

-- ---------------------------------------------------------------------
-- مزامنة لون/حالة الوحدة فورياً مع حالة الحجز
-- confirmed → reserved (برتقالي) | checked_in → occupied (أحمر)
-- checked_out → cleaning (أصفر) | cancelled → available (أخضر)
-- ---------------------------------------------------------------------
create or replace function sync_unit_status()
returns trigger language plpgsql security definer as $$
begin
  if new.status = 'confirmed' then
    update units set status = 'reserved' where id = new.unit_id;
  elsif new.status = 'checked_in' then
    update units set status = 'occupied' where id = new.unit_id;
    new.actual_check_in := coalesce(new.actual_check_in, now());
  elsif new.status = 'checked_out' then
    update units set status = 'cleaning' where id = new.unit_id;
    new.actual_check_out := coalesce(new.actual_check_out, now());
  elsif new.status = 'cancelled' then
    update units set status = 'available'
    where id = new.unit_id and status in ('reserved');
    new.cancelled_at := coalesce(new.cancelled_at, now());
  end if;
  return new;
end $$;

create trigger trg_sync_unit_status
before insert or update of status on bookings
for each row execute function sync_unit_status();

-- ---------------------------------------------------------------------
-- صلاحية إلغاء الحجز: المالك فقط
-- ---------------------------------------------------------------------
create or replace function enforce_owner_only_cancel()
returns trigger language plpgsql security definer as $$
declare v_role user_role;
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    select role into v_role from profiles where id = auth.uid();
    if v_role is distinct from 'owner' then
      raise exception 'إلغاء الحجز صلاحية حصرية لحساب المالك | Only the owner can cancel bookings';
    end if;
    new.cancelled_by := auth.uid();
  end if;
  return new;
end $$;

create trigger trg_owner_only_cancel
before update of status on bookings
for each row execute function enforce_owner_only_cancel();

-- ---------------------------------------------------------------------
-- صلاحية تعديل أسعار الوحدات: المالك فقط
-- ---------------------------------------------------------------------
create or replace function enforce_owner_only_pricing()
returns trigger language plpgsql security definer as $$
declare v_role user_role;
begin
  if (new.daily_price   is distinct from old.daily_price or
      new.monthly_price is distinct from old.monthly_price or
      new.yearly_price  is distinct from old.yearly_price) then
    select role into v_role from profiles where id = auth.uid();
    if v_role is distinct from 'owner' then
      raise exception 'تحديد سعر الإيجار صلاحية حصرية لحساب المالك | Only the owner can set unit prices';
    end if;
  end if;
  return new;
end $$;

create trigger trg_owner_only_pricing
before update on units
for each row execute function enforce_owner_only_pricing();

-- ---------------------------------------------------------------------
-- الأتمتة عند بدء السكن (checked_in):
-- 1) إنشاء بوابة الساكن  2) إشعار المحاسب والمدير
-- 3) قيد رسالة الواتساب الترحيبية  4) نقاط الولاء  5) سجل التأمين
-- ---------------------------------------------------------------------
create or replace function automate_on_check_in()
returns trigger language plpgsql security definer as $$
declare
  v_customer customers%rowtype;
  v_unit units%rowtype;
  v_username text;
  v_paid numeric;
begin
  if new.status = 'checked_in' and old.status is distinct from 'checked_in' then
    select * into v_customer from customers where id = new.customer_id;
    select * into v_unit from units where id = new.unit_id;
    select coalesce(sum(amount),0) into v_paid
      from payments where booking_id = new.id;

    -- 1) إنشاء بوابة دخول الساكن تلقائياً
    v_username := 'guest_' || replace(v_customer.phone, '+', '');
    insert into tenant_portal_accounts (company_id, customer_id, booking_id, username, access_token)
    values (new.company_id, new.customer_id, new.id, v_username,
            encode(gen_random_bytes(24), 'hex'))
    on conflict (company_id, username) do update
      set booking_id = excluded.booking_id, is_active = true,
          access_token = excluded.access_token;

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
    insert into notifications (company_id, customer_id, channel, event_type, title, body, booking_id, unit_id, status)
    values (new.company_id, new.customer_id, 'whatsapp', 'welcome_message',
            'رسالة ترحيبية',
            format('مرحباً بك %s! تم تأكيد سكنك في الوحدة رقم %s ابتداءً من %s. قيمة الإيجار: %s ر.س | المدفوع: %s ر.س | المتبقي: %s ر.س. رابط بوابتك: /tenant/%s',
                   v_customer.full_name, v_unit.unit_number, new.check_in_date,
                   new.total_amount, v_paid, new.total_amount - v_paid, v_username),
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

create trigger trg_automate_check_in
after insert or update of status on bookings
for each row execute function automate_on_check_in();

-- ---------------------------------------------------------------------
-- تحديث جدولة الدفعات عند تسجيل دفعة
-- ---------------------------------------------------------------------
create or replace function apply_payment_to_schedule()
returns trigger language plpgsql security definer as $$
begin
  update payment_schedules
     set is_paid = true, paid_at = now()
   where id = (
     select id from payment_schedules
      where booking_id = new.booking_id and not is_paid
      order by due_date limit 1
   ) and new.payment_type = 'rent';
  return new;
end $$;

create trigger trg_payment_schedule
after insert on payments
for each row execute function apply_payment_to_schedule();

-- ---------------------------------------------------------------------
-- توليد رقم فاتورة تسلسلي لكل شركة + بيانات QR (ZATCA TLV تُبنى في Edge Function)
-- ---------------------------------------------------------------------
create or replace function next_invoice_number(p_company uuid)
returns text language plpgsql as $$
declare n int;
begin
  select count(*) + 1 into n from invoices where company_id = p_company;
  return 'INV-' || to_char(now(),'YYYY') || '-' || lpad(n::text, 6, '0');
end $$;

-- ---------------------------------------------------------------------
-- دوال التقارير (تستدعى من البوابات ومساعد الذكاء الاصطناعي)
-- ---------------------------------------------------------------------

-- ملخص لوحة التحكم اليومية — يتحقق من ملكية الشركة (يمنع تسريب بيانات شركة أخرى)
create or replace function dashboard_today(p_company uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if p_company is null or p_company <> current_company_id() then
    raise exception 'FORBIDDEN';
  end if;
  return (select jsonb_build_object(
    'bookings_today',   (select count(*) from bookings  where company_id = p_company and created_at::date = current_date),
    'vacant_units',     (select count(*) from units     where company_id = p_company and status = 'available' and is_active),
    'occupied_units',   (select count(*) from units     where company_id = p_company and status = 'occupied'),
    'departures_today', (select count(*) from bookings  where company_id = p_company and check_out_date = current_date and status = 'checked_in'),
    'arrivals_today',   (select count(*) from bookings  where company_id = p_company and check_in_date = current_date and status = 'confirmed')
  ));
end $$;

-- نسبة الإشغال لفترة
create or replace function occupancy_rate(p_company uuid, p_from date, p_to date)
returns numeric language plpgsql stable security definer set search_path = public as $$
begin
  if p_company is null or p_company <> current_company_id() then
    raise exception 'FORBIDDEN';
  end if;
  return (select round(
    100.0 * coalesce(sum(least(b.check_out_date, p_to) - greatest(b.check_in_date, p_from)), 0)
    / nullif((select count(*) from units where company_id = p_company and is_active) * (p_to - p_from), 0), 2)
  from bookings b
  where b.company_id = p_company
    and b.status in ('checked_in','checked_out','confirmed')
    and daterange(b.check_in_date, b.check_out_date, '[)') && daterange(p_from, p_to, '[)'));
end $$;

-- التاريخ الكامل للوحدة (History) — يتحقق أن الوحدة تخص شركة المستخدم
create or replace function unit_history(p_unit uuid, p_from date default null, p_to date default null, p_customer uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from units where id = p_unit and company_id = current_company_id()) then
    raise exception 'FORBIDDEN';
  end if;
  return (select jsonb_build_object(
    'bookings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'booking_id', b.id, 'customer', c.full_name, 'from', b.check_in_date,
        'to', b.check_out_date, 'total', b.total_amount, 'status', b.status,
        'down_payment', b.down_payment, 'insurance', b.insurance_amount,
        'paid', (select coalesce(sum(p.amount),0) from payments p where p.booking_id = b.id)
      ) order by b.check_in_date desc)
      from bookings b join customers c on c.id = b.customer_id
      where b.unit_id = p_unit
        and (p_from is null or b.check_out_date >= p_from)
        and (p_to   is null or b.check_in_date  <= p_to)
        and (p_customer is null or b.customer_id = p_customer)
    ), '[]'::jsonb),
    'times_rented',    (select count(*) from bookings where unit_id = p_unit and status <> 'cancelled'),
    'total_revenue',   (select coalesce(sum(p.amount),0) from payments p join bookings b on b.id = p.booking_id where b.unit_id = p_unit),
    'total_expenses',  (select coalesce(sum(amount),0) from expenses where unit_id = p_unit),
    'maintenance_count', (select count(*) from maintenance_requests where unit_id = p_unit),
    'net_profit',      (select coalesce((select sum(p.amount) from payments p join bookings b on b.id = p.booking_id where b.unit_id = p_unit),0)
                        - coalesce((select sum(amount) from expenses where unit_id = p_unit),0))
  ));
end $$;

-- المتأخرون عن السداد أكثر من N يوم — يتحقق من ملكية الشركة
create or replace function overdue_payments(p_company uuid, p_days int default 1)
returns table (booking_id uuid, customer_name text, phone text, unit_number text,
               due_date date, amount_due numeric, days_late int)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_company is null or p_company <> current_company_id() then
    raise exception 'FORBIDDEN';
  end if;
  return query
    select ps.booking_id, c.full_name, c.phone, u.unit_number,
           ps.due_date, ps.amount_due, (current_date - ps.due_date)::int
    from payment_schedules ps
    join bookings b on b.id = ps.booking_id
    join customers c on c.id = b.customer_id
    join units u on u.id = b.unit_id
    where ps.company_id = p_company and not ps.is_paid
      and current_date - ps.due_date >= p_days
    order by ps.due_date;
end $$;

-- =====================================================================
-- Migration 005: Row Level Security — عزل منطقي كامل لكل شركة (SaaS)
-- =====================================================================

-- دالة مساعدة: شركة المستخدم الحالي
create or replace function current_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select p.company_id from public.profiles p where p.id = auth.uid() limit 1;
$$;

-- دالة مساعدة: دور المستخدم الحالي
create or replace function current_role_of_user()
returns user_role
language sql
stable
security definer
set search_path = public
as $$
  select p.role from public.profiles p where p.id = auth.uid() limit 1;
$$;

-- تفعيل RLS على جميع الجداول
do $$
declare t text;
begin
  foreach t in array array[
    'companies','profiles','properties','units','unit_media','unit_assets',
    'pricing_rules','customers','bookings','booking_companions','payments',
    'payment_schedules','insurance_records','invoices','expenses',
    'maintenance_requests','key_logs','checkin_logs','checklists',
    'notifications','automation_logs','loyalty_transactions',
    'tenant_portal_accounts','service_requests','ai_conversations',
    'ai_insights','audit_logs']
  loop
    execute format('alter table %s enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- الشركات: كل مستخدم يرى شركته فقط، والتعديل للمالك فقط
-- ---------------------------------------------------------------------
create policy companies_select on companies for select
  using (id = current_company_id());
create policy companies_update on companies for update
  using (id = current_company_id() and current_role_of_user() = 'owner');

-- ---------------------------------------------------------------------
-- المستخدمون: عرض داخل الشركة، إدارة الحسابات للمالك والمدير
-- ---------------------------------------------------------------------
create policy profiles_select_self on profiles for select
  using (id = auth.uid());
create policy profiles_select_company on profiles for select
  using (company_id = current_company_id());
create policy profiles_insert on profiles for insert
  with check (company_id = current_company_id()
              and current_role_of_user() in ('owner','manager'));
create policy profiles_update on profiles for update
  using (company_id = current_company_id()
         and (id = auth.uid() or current_role_of_user() in ('owner','manager')));
create policy profiles_delete on profiles for delete
  using (company_id = current_company_id() and current_role_of_user() = 'owner');

-- ---------------------------------------------------------------------
-- سياسة عامة لجداول الشركة: قراءة وكتابة داخل نفس الشركة
-- (القيود الدقيقة — الأسعار والإلغاء — تفرضها المحفزات في Migration 004)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'properties','units','unit_media','unit_assets','customers','bookings',
    'booking_companions','payments','payment_schedules','insurance_records',
    'invoices','maintenance_requests','key_logs','checkin_logs','checklists',
    'notifications','loyalty_transactions','tenant_portal_accounts',
    'service_requests','ai_conversations']
  loop
    execute format(
      'create policy %I_select on %I for select using (company_id = current_company_id())', t, t);
    execute format(
      'create policy %I_insert on %I for insert with check (company_id = current_company_id())', t, t);
    execute format(
      'create policy %I_update on %I for update using (company_id = current_company_id())', t, t);
  end loop;
end $$;

-- الحذف: للمالك والمدير فقط
do $$
declare t text;
begin
  foreach t in array array[
    'properties','units','unit_media','unit_assets','customers',
    'booking_companions','maintenance_requests']
  loop
    execute format(
      'create policy %I_delete on %I for delete
       using (company_id = current_company_id()
              and current_role_of_user() in (''owner'',''manager''))', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- البيانات المالية الحساسة: المصروفات وقواعد التسعير والرؤى
-- عرض المصروفات والأرباح: المالك والمحاسب والمدير (ليس الموظف)
-- ---------------------------------------------------------------------
create policy expenses_select on expenses for select
  using (company_id = current_company_id()
         and current_role_of_user() in ('owner','manager','accountant'));
create policy expenses_insert on expenses for insert
  with check (company_id = current_company_id());
create policy expenses_update on expenses for update
  using (company_id = current_company_id()
         and current_role_of_user() in ('owner','manager','accountant'));
create policy expenses_delete on expenses for delete
  using (company_id = current_company_id() and current_role_of_user() = 'owner');

create policy pricing_rules_select on pricing_rules for select
  using (company_id = current_company_id());
create policy pricing_rules_write on pricing_rules for insert
  with check (company_id = current_company_id()
              and current_role_of_user() in ('owner','manager'));
create policy pricing_rules_update on pricing_rules for update
  using (company_id = current_company_id()
         and current_role_of_user() in ('owner','manager'));

create policy ai_insights_select on ai_insights for select
  using (company_id = current_company_id());
create policy ai_insights_write on ai_insights for insert
  with check (company_id = current_company_id());
create policy ai_insights_update on ai_insights for update
  using (company_id = current_company_id());

-- سجلات الأتمتة والتدقيق: قراءة للمالك والمدير فقط، الكتابة من الخادم
create policy automation_logs_select on automation_logs for select
  using (company_id = current_company_id()
         and current_role_of_user() in ('owner','manager'));
create policy automation_logs_insert on automation_logs for insert
  with check (company_id = current_company_id());

create policy audit_select on audit_logs for select
  using (company_id = current_company_id()
         and current_role_of_user() in ('owner','manager'));
create policy audit_insert on audit_logs for insert
  with check (company_id = current_company_id());

-- ---------------------------------------------------------------------
-- تفعيل البث الفوري (Realtime) لتحديث ألوان الوحدات لحظياً
-- ---------------------------------------------------------------------
do $$
begin
  alter publication supabase_realtime add table units;
exception when duplicate_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table bookings;
exception when duplicate_object then null; end $$;
do $$
begin
  alter publication supabase_realtime add table notifications;
exception when duplicate_object then null; end $$;

-- =====================================================================
-- Migration 007: App Bootstrap — تأسيس أول مالك + مخازن رفع الملفات
-- =====================================================================

-- ---------------------------------------------------------------------
-- سياسات التأسيس: مستخدم جديد (بلا ملف شخصي) ينشئ شركته ويصبح مالكها
-- ---------------------------------------------------------------------
create policy companies_bootstrap_insert on companies for insert
  with check (
    auth.uid() is not null
    and not exists (select 1 from profiles where id = auth.uid())
  );

create policy profiles_bootstrap_insert on profiles for insert
  with check (
    id = auth.uid()
    and role = 'owner'
    and not exists (select 1 from profiles p where p.id = auth.uid())
  );

-- ---------------------------------------------------------------------
-- مخازن الملفات (Storage Buckets)
--   unit-media : صور وفيديو الوحدات + شعار المنشأة (عام للعرض التسويقي)
--   documents  : صور الهويات ومستندات السداد — خاص، قراءته مقصورة على
--                أعضاء نفس الشركة الموثّقين (لا وصول عام)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('unit-media', 'unit-media', true), ('documents', 'documents', false)
on conflict (id) do update set public = excluded.public;

-- الرفع: كل مستخدم داخل مجلد شركته فقط (اسم المجلد = company_id)
create policy storage_upload_own_company on storage.objects for insert
  to authenticated
  with check (
    bucket_id in ('unit-media','documents')
    and (storage.foldername(name))[1] = (select company_id::text from profiles where id = auth.uid())
  );

-- القراءة الخاصة للمستندات: أعضاء نفس الشركة الموثّقون فقط
-- (unit-media عام عبر رابط الـ CDN لأنه محتوى تسويقي معروض للزوار)
create policy documents_read_own_company on storage.objects for select
  to authenticated
  using (
    bucket_id = 'documents'
    and (storage.foldername(name))[1] = (select company_id::text from profiles where id = auth.uid())
  );

create policy storage_delete_own_company on storage.objects for delete
  to authenticated
  using (
    bucket_id in ('unit-media','documents')
    and (storage.foldername(name))[1] = (select company_id::text from profiles where id = auth.uid())
    and (select role from profiles where id = auth.uid()) in ('owner','manager')
  );
