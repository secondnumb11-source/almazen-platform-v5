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
create type user_role as enum ('owner', 'manager', 'accountant', 'employee');

create type unit_category as enum ('apartment', 'chalet', 'furnished_unit', 'hotel_room');

create type unit_status as enum (
  'available',      -- متاح للإيجار (أخضر)
  'reserved',       -- محجوز مسبقاً (برتقالي)
  'occupied',       -- مسكون (أحمر)
  'cleaning',       -- قيد التنظيف (أصفر)
  'maintenance'     -- تحت الصيانة (أصفر)
);

create type booking_status as enum (
  'pending',        -- بانتظار التأكيد
  'confirmed',      -- مؤكد (محجوز)
  'checked_in',     -- تم تسليم الوحدة (مسكون)
  'checked_out',    -- تم الإخلاء
  'cancelled'       -- ملغي (صلاحية المالك فقط)
);

create type rent_period as enum ('daily', 'monthly', 'yearly');

create type payment_method as enum ('cash', 'bank_transfer', 'card');

create type payment_type as enum ('rent', 'down_payment', 'insurance', 'penalty', 'other');
-- down_payment = العربون | insurance = التأمين

create type id_document_type as enum ('national_id', 'iqama', 'passport');

create type insurance_status as enum ('paid', 'held', 'deducted', 'refunded');

create type maintenance_type as enum ('cleaning', 'maintenance');
create type maintenance_status as enum ('open', 'in_progress', 'done');

create type invoice_type as enum ('simplified', 'standard'); -- مبسطة / معتمدة
create type invoice_status as enum ('draft', 'issued', 'reported_to_zatca', 'cancelled');

create type notification_channel as enum ('in_app', 'whatsapp', 'sms', 'email');
create type notification_status as enum ('pending', 'sent', 'failed', 'read');

create type expense_category as enum ('electricity', 'water', 'maintenance', 'salaries', 'cleaning', 'internet', 'other');

create type key_action as enum ('issued', 'returned', 'lost');

create type checkin_type as enum ('check_in', 'check_out');

create type service_request_type as enum ('extension', 'extra_service', 'complaint', 'maintenance');
create type service_request_status as enum ('new', 'in_progress', 'done', 'rejected');

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
