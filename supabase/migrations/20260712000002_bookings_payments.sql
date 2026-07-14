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
