-- =====================================================================
-- Migration 021: توسعة بيانات بوابة المستأجر لتغطية عقد الإيجار كاملاً
-- =====================================================================
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
        'address', co.address, 'vat_number', co.vat_number, 'cr_number', co.cr_number
      ) from companies co where co.id = v_acct.company_id
    ),
    'current_booking', (
      select jsonb_build_object(
        'id', b.id, 'status', b.status, 'check_in_date', b.check_in_date,
        'check_out_date', b.check_out_date, 'total_amount', b.total_amount,
        'base_price', b.base_price, 'discount_percent', b.discount_percent,
        'discount_amount', b.discount_amount, 'contract_number', b.contract_number,
        'down_payment', b.down_payment,
        'insurance_amount', b.insurance_amount, 'rent_period', b.rent_period,
        'ejar_status', b.ejar_status, 'ejar_contract_number', b.ejar_contract_number,
        'paid', coalesce((select sum(p.amount) from payments p where p.booking_id = b.id), 0),
        'employee_name', (select pr.full_name from profiles pr where pr.id = b.employee_id),
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
