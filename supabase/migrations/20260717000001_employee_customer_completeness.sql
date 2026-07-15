-- =====================================================================
-- Migration 023: إكمال ملفات الموظفين والعملاء
--   - تاريخ ميلاد العميل
--   - دالة إصدار سند قبض/صرف يدوي (للموظفين: راتب/سلفة/أخرى) مع QR
--   - دالة إرفاق السند الموقّع لاحقاً
-- =====================================================================

-- تاريخ ميلاد العميل (كان ناقصاً في جدول العملاء)
alter table customers add column if not exists birth_date date;

-- =====================================================================
-- إصدار سند يدوي (قبض/صرف) — يُرقّم تلقائياً ويُتاح للإدارة فقط.
-- يُستخدم لإصدار سندات قبض للموظف (راتب/سلفة/أخرى) قابلة للطباعة.
-- =====================================================================
create or replace function public.issue_manual_voucher(
  p_voucher_type voucher_type,
  p_amount numeric,
  p_party_type party_type,
  p_party_name text,
  p_description text default null,
  p_payment_method text default 'cash',
  p_reference_number text default null,
  p_employee_id uuid default null
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_cid uuid; v_voucher_no text; v_voucher_id uuid; v_cash_acc uuid;
begin
  if current_role_of_user() not in ('owner','manager','accountant') then
    raise exception 'إصدار السندات صلاحية حصرية للإدارة';
  end if;
  if coalesce(p_amount,0) <= 0 then raise exception 'أدخل مبلغاً صحيحاً'; end if;
  v_cid := current_company_id();

  select id into v_cash_acc from chart_of_accounts where company_id = v_cid and code = '1101';

  v_voucher_no := next_document_number(v_cid, p_voucher_type::text);
  insert into vouchers (
    company_id, voucher_type, voucher_number, voucher_date, amount, account_id,
    party_type, party_name, description, payment_method, reference_number, created_by
  ) values (
    v_cid, p_voucher_type, v_voucher_no, current_date, p_amount, v_cash_acc,
    p_party_type, coalesce(p_party_name,'—'), p_description, p_payment_method::payment_method, p_reference_number, auth.uid()
  ) returning id into v_voucher_id;

  return v_voucher_id;
end $$;
revoke all on function public.issue_manual_voucher(voucher_type, numeric, party_type, text, text, text, text, uuid) from public;
grant execute on function public.issue_manual_voucher(voucher_type, numeric, party_type, text, text, text, text, uuid) to authenticated;

-- =====================================================================
-- إرفاق نسخة موقّعة من السند بعد طباعته وتوقيعه
-- =====================================================================
create or replace function public.attach_voucher_signed(p_voucher_id uuid, p_url text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if current_role_of_user() not in ('owner','manager','accountant') then
    raise exception 'صلاحية حصرية للإدارة';
  end if;
  update vouchers set attachment_url = p_url
   where id = p_voucher_id and company_id = current_company_id();
end $$;
revoke all on function public.attach_voucher_signed(uuid, text) from public;
grant execute on function public.attach_voucher_signed(uuid, text) to authenticated;

-- =====================================================================
-- تقرير الوحدة الشامل: تاريخ التأجير + المصروفات + الصيانة + المدفوعات
-- + الإيرادات + مدد الإيجار + نسبة الإشغال — لفترة زمنية محددة.
-- =====================================================================
create or replace function public.unit_full_report(p_unit_id uuid, p_from date, p_to date)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_cid uuid; v_result jsonb; v_occupied_days int; v_total_days int;
begin
  v_cid := current_company_id();
  if not exists (select 1 from units where id = p_unit_id and company_id = v_cid) then
    raise exception 'الوحدة غير موجودة';
  end if;

  v_total_days := greatest(1, (p_to - p_from) + 1);

  -- أيام الإشغال داخل الفترة (تقاطع مدة كل حجز نشط مع الفترة المطلوبة)
  select coalesce(sum(
    greatest(0, (least(b.check_out_date, p_to) - greatest(b.check_in_date, p_from)) + 1)
  ), 0) into v_occupied_days
  from bookings b
  where b.unit_id = p_unit_id and b.company_id = v_cid
    and b.status in ('checked_in','checked_out','confirmed')
    and b.check_in_date <= p_to and b.check_out_date >= p_from;

  select jsonb_build_object(
    'unit', (select jsonb_build_object(
        'unit_number', u.unit_number, 'category', u.category, 'status', u.status,
        'daily_price', u.daily_price, 'monthly_price', u.monthly_price, 'yearly_price', u.yearly_price,
        'description', u.description
      ) from units u where u.id = p_unit_id),
    'period', jsonb_build_object('from', p_from, 'to', p_to, 'total_days', v_total_days),
    'occupancy', jsonb_build_object(
      'occupied_days', v_occupied_days,
      'vacant_days', greatest(0, v_total_days - v_occupied_days),
      'occupancy_rate', round(v_occupied_days::numeric / v_total_days * 100, 1)
    ),
    'bookings', coalesce((select jsonb_agg(jsonb_build_object(
        'check_in_date', b.check_in_date, 'check_out_date', b.check_out_date,
        'rent_period', b.rent_period, 'status', b.status, 'total_amount', b.total_amount,
        'down_payment', b.down_payment, 'insurance_amount', b.insurance_amount,
        'customer_name', (select full_name from customers c where c.id = b.customer_id),
        'paid', coalesce((select sum(p.amount) from payments p where p.booking_id = b.id), 0)
      ) order by b.check_in_date desc)
      from bookings b where b.unit_id = p_unit_id and b.company_id = v_cid
        and b.check_in_date <= p_to and b.check_out_date >= p_from), '[]'::jsonb),
    'payments', coalesce((select jsonb_agg(jsonb_build_object(
        'payment_date', p.payment_date, 'amount', p.amount, 'payment_type', p.payment_type, 'method', p.method
      ) order by p.payment_date desc)
      from payments p join bookings b on b.id = p.booking_id
      where b.unit_id = p_unit_id and p.company_id = v_cid
        and p.payment_date between p_from and p_to), '[]'::jsonb),
    'expenses', coalesce((select jsonb_agg(jsonb_build_object(
        'expense_date', e.expense_date, 'category', e.category, 'amount', e.amount, 'description', e.description
      ) order by e.expense_date desc)
      from expenses e where e.unit_id = p_unit_id and e.company_id = v_cid
        and e.expense_date between p_from and p_to), '[]'::jsonb),
    'maintenance', coalesce((select jsonb_agg(jsonb_build_object(
        'opened_at', m.opened_at, 'status', m.status, 'description', m.description, 'cost', m.cost
      ) order by m.opened_at desc)
      from maintenance_requests m where m.unit_id = p_unit_id and m.company_id = v_cid
        and m.opened_at::date between p_from and p_to), '[]'::jsonb),
    'totals', jsonb_build_object(
      'revenue', coalesce((select sum(p.amount) from payments p join bookings b on b.id=p.booking_id
                   where b.unit_id = p_unit_id and p.company_id = v_cid and p.payment_date between p_from and p_to), 0),
      'expenses', coalesce((select sum(e.amount) from expenses e where e.unit_id = p_unit_id and e.company_id = v_cid
                   and e.expense_date between p_from and p_to), 0)
    )
  ) into v_result;

  return v_result;
end $$;
revoke all on function public.unit_full_report(uuid, date, date) from public;
grant execute on function public.unit_full_report(uuid, date, date) to authenticated;
