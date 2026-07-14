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

-- ملخص لوحة التحكم اليومية
create or replace function dashboard_today(p_company uuid)
returns jsonb language sql stable security definer as $$
  select jsonb_build_object(
    'bookings_today',   (select count(*) from bookings  where company_id = p_company and created_at::date = current_date),
    'vacant_units',     (select count(*) from units     where company_id = p_company and status = 'available' and is_active),
    'occupied_units',   (select count(*) from units     where company_id = p_company and status = 'occupied'),
    'departures_today', (select count(*) from bookings  where company_id = p_company and check_out_date = current_date and status = 'checked_in'),
    'arrivals_today',   (select count(*) from bookings  where company_id = p_company and check_in_date = current_date and status = 'confirmed')
  );
$$;

-- نسبة الإشغال لفترة
create or replace function occupancy_rate(p_company uuid, p_from date, p_to date)
returns numeric language sql stable security definer as $$
  select round(
    100.0 * coalesce(sum(least(b.check_out_date, p_to) - greatest(b.check_in_date, p_from)), 0)
    / nullif((select count(*) from units where company_id = p_company and is_active) * (p_to - p_from), 0), 2)
  from bookings b
  where b.company_id = p_company
    and b.status in ('checked_in','checked_out','confirmed')
    and daterange(b.check_in_date, b.check_out_date, '[)') && daterange(p_from, p_to, '[)');
$$;

-- التاريخ الكامل للوحدة (History)
create or replace function unit_history(p_unit uuid, p_from date default null, p_to date default null, p_customer uuid default null)
returns jsonb language sql stable security definer as $$
  select jsonb_build_object(
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
  );
$$;

-- المتأخرون عن السداد أكثر من N يوم
create or replace function overdue_payments(p_company uuid, p_days int default 1)
returns table (booking_id uuid, customer_name text, phone text, unit_number text,
               due_date date, amount_due numeric, days_late int)
language sql stable security definer as $$
  select ps.booking_id, c.full_name, c.phone, u.unit_number,
         ps.due_date, ps.amount_due, (current_date - ps.due_date)::int
  from payment_schedules ps
  join bookings b on b.id = ps.booking_id
  join customers c on c.id = b.customer_id
  join units u on u.id = b.unit_id
  where ps.company_id = p_company and not ps.is_paid
    and current_date - ps.due_date >= p_days
  order by ps.due_date;
$$;
