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
