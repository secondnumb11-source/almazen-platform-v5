-- =====================================================================
-- Migration 020: تتبّع منشئ العميل، نقاط الولاء المتناسبة، استبدال النقاط،
-- وطلبات الخصم الموسّعة (نسبة أو نقاط) مع الترحيل المحاسبي التلقائي
-- =====================================================================

-- من أضاف سجل العميل (للعرض في مركز المرفقات ولإسناد المسؤولية)
alter table customers add column created_by uuid references profiles(id);

-- =====================================================================
-- نقاط الولاء: 10 نقاط لكل 100 ر.س من قيمة الحجز بدل رقم ثابت
-- =====================================================================
create or replace function public.automate_on_check_in()
returns trigger language plpgsql security definer as $$
declare
  v_customer customers%rowtype;
  v_unit units%rowtype;
  v_username text;
  v_paid numeric;
  v_points int;
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

    -- 3) رسالة الواتساب الترحيبية
    insert into notifications (company_id, customer_id, channel, event_type, title, body, booking_id, unit_id, status)
    values (new.company_id, new.customer_id, 'whatsapp', 'welcome_message',
            'رسالة ترحيبية',
            format('مرحباً بك %s! تم تأكيد سكنك في الوحدة رقم %s ابتداءً من %s. قيمة الإيجار: %s ر.س | المدفوع: %s ر.س | المتبقي: %s ر.س. رابط بوابتك: /tenant/%s',
                   v_customer.full_name, v_unit.unit_number, new.check_in_date,
                   new.total_amount, v_paid, new.total_amount - v_paid, v_username),
            new.id, new.unit_id, 'pending');

    -- 4) نقاط الولاء: 10 نقاط لكل 100 ر.س من إجمالي الحجز
    v_points := floor(new.total_amount / 100) * 10;
    if v_points > 0 then
      insert into loyalty_transactions (company_id, customer_id, booking_id, points, reason)
      values (new.company_id, new.customer_id, new.id, v_points,
              format('إقامة جديدة — %s ر.س (10 نقاط/100 ر.س)', new.total_amount));
      update customers set loyalty_points = loyalty_points + v_points where id = new.customer_id;
    end if;

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

-- =====================================================================
-- استبدال نقاط الولاء (10 نقاط = 1 ر.س) — للمالك والمحاسب فقط
-- =====================================================================
create or replace function public.redeem_loyalty_points(p_customer_id uuid, p_points int, p_note text default null)
returns numeric
language plpgsql security definer set search_path = public as $$
declare v_cid uuid; v_balance int; v_value numeric;
begin
  if current_role_of_user() not in ('owner','accountant') then
    raise exception 'صلاحية استبدال النقاط حصرية للمالك أو المحاسب';
  end if;
  if p_points <= 0 then raise exception 'أدخل عدد نقاط صحيحاً'; end if;

  select company_id, loyalty_points into v_cid, v_balance from customers where id = p_customer_id;
  if v_cid is null or v_cid <> current_company_id() then raise exception 'عميل غير موجود'; end if;
  if v_balance < p_points then raise exception 'رصيد النقاط غير كافٍ (المتاح % نقطة)', v_balance; end if;

  v_value := round(p_points::numeric / 10, 2);
  update customers set loyalty_points = loyalty_points - p_points where id = p_customer_id;
  insert into loyalty_transactions (company_id, customer_id, points, reason)
  values (v_cid, p_customer_id, -p_points, format('استبدال %s نقطة = %s ر.س%s', p_points, v_value, case when p_note is not null then ' — ' || p_note else '' end));

  return v_value;
end $$;
revoke all on function public.redeem_loyalty_points(uuid, int, text) from public;
grant execute on function public.redeem_loyalty_points(uuid, int, text) to authenticated;

-- =====================================================================
-- طلبات الخصم الموسّعة: نسبة أو نقاط، مع اعتماد يُحدّث الحجز والحسابات تلقائياً
-- =====================================================================
alter table discount_requests add column points_used integer not null default 0;
alter table discount_requests add column reason_type text not null default 'percent' check (reason_type in ('percent','points'));
alter table discount_requests add column customer_id uuid references customers(id);

create or replace function public.decide_discount_request(p_request_id uuid, p_approve boolean, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_req discount_requests%rowtype; v_booking bookings%rowtype;
  v_amount numeric; v_entry_id uuid; v_entry_no text; v_rev_acc uuid; v_recv_acc uuid;
  v_new_discount_amt numeric; v_new_percent numeric;
begin
  if current_role_of_user() not in ('owner','manager','accountant') then
    raise exception 'صلاحية اعتماد الخصومات حصرية للإدارة';
  end if;
  select * into v_req from discount_requests where id = p_request_id;
  if v_req.id is null or v_req.company_id <> current_company_id() then raise exception 'الطلب غير موجود'; end if;
  if v_req.status <> 'pending' then raise exception 'الطلب تمت مراجعته مسبقاً'; end if;

  if not p_approve then
    update discount_requests set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
      where id = p_request_id;
    return;
  end if;

  if v_req.booking_id is not null then
    select * into v_booking from bookings where id = v_req.booking_id;
  end if;

  -- المسار القديم: خصم طُلب أثناء الحجز نفسه (الحجز لا يزال pending_approval)
  if v_booking.id is not null and v_booking.status = 'pending_approval' then
    update bookings set status = 'confirmed' where id = v_booking.id;
    update discount_requests set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
      where id = p_request_id;
    return;
  end if;

  -- المسار الجديد: خصم لاحق على حجز قائم بالفعل — يُحدَّث المبلغ ويُرحَّل محاسبياً
  if v_req.reason_type = 'points' then
    v_amount := round(v_req.points_used::numeric / 10, 2);
  else
    v_amount := round(coalesce(v_booking.total_amount, 0) * v_req.percent / 100, 2);
  end if;

  if v_booking.id is not null and v_amount > 0 then
    -- ملاحظة: trg_booking_totals (calc_booking_totals) يُعيد احتساب discount_amount
    -- و total_amount من discount_percent تلقائياً عند أي تعديل — لذا نُحدِّث النسبة
    -- المئوية المكافئة للخصم الإجمالي الجديد بدل الكتابة المباشرة فوق المبلغ، وإلا
    -- يُبطِل ذلك التريغر تحديثنا صامتاً ويُعيد القيم الأصلية.
    v_new_discount_amt := coalesce(v_booking.discount_amount, 0) + v_amount;
    v_new_percent := case when coalesce(v_booking.base_price, 0) > 0
      then round(v_new_discount_amt / v_booking.base_price * 100, 4) else 0 end;
    update bookings set discount_percent = v_new_percent where id = v_booking.id;

    select id into v_rev_acc from chart_of_accounts where company_id = v_req.company_id and code = '4100';
    select id into v_recv_acc from chart_of_accounts where company_id = v_req.company_id and code = '1201';
    if v_rev_acc is not null and v_recv_acc is not null then
      v_entry_no := next_document_number(v_req.company_id, 'journal');
      insert into journal_entries (company_id, entry_number, entry_date, description, source_type, source_id, created_by)
        values (v_req.company_id, v_entry_no, current_date, 'قيد تلقائي — خصم معتمد على حجز', 'discount', v_req.id, auth.uid())
        returning id into v_entry_id;
      insert into journal_entry_lines (entry_id, account_id, debit, credit, description, line_order) values
        (v_entry_id, v_rev_acc, v_amount, 0, coalesce(v_req.reason, 'خصم معتمد'), 1),
        (v_entry_id, v_recv_acc, 0, v_amount, coalesce(v_req.reason, 'خصم معتمد'), 2);
    end if;
  end if;

  if v_req.reason_type = 'points' and v_req.points_used > 0 and v_req.customer_id is not null then
    update customers set loyalty_points = greatest(0, loyalty_points - v_req.points_used) where id = v_req.customer_id;
    insert into loyalty_transactions (company_id, customer_id, booking_id, points, reason)
    values (v_req.company_id, v_req.customer_id, v_req.booking_id, -v_req.points_used,
            format('استبدال %s نقطة مقابل خصم %s ر.س', v_req.points_used, v_amount));
  end if;

  update discount_requests set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), review_note = p_note
    where id = p_request_id;
end $$;
revoke all on function public.decide_discount_request(uuid, boolean, text) from public;
grant execute on function public.decide_discount_request(uuid, boolean, text) to authenticated;
