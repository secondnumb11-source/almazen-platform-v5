-- =====================================================================
-- Migration 016: القوائم المالية الكبرى — الميزانية العمومية وقائمة الدخل
-- =====================================================================
create or replace function public.income_statement(p_company_id uuid, p_from date, p_to date)
returns table(section text, code text, name text, amount numeric)
language plpgsql security definer set search_path = public as $$
begin
  if p_company_id <> current_company_id() then raise exception 'لا صلاحية'; end if;
  return query
  select
    case a.account_type when 'revenue' then 'الإيرادات' else 'المصروفات' end as section,
    a.code, a.name,
    coalesce((
      select sum(case when a.account_type = 'revenue' then (jel.credit - jel.debit) else (jel.debit - jel.credit) end)
      from journal_entry_lines jel join journal_entries je on je.id = jel.entry_id
      where jel.account_id = a.id and je.entry_date between p_from and p_to
    ), 0) as amount
  from chart_of_accounts a
  where a.company_id = p_company_id and a.account_type in ('revenue', 'expense') and not a.is_group
  order by a.account_type desc, a.code;
end $$;
revoke all on function public.income_statement(uuid, date, date) from public;
grant execute on function public.income_statement(uuid, date, date) to authenticated;

create or replace function public.balance_sheet(p_company_id uuid, p_as_of date default current_date)
returns table(section text, code text, name text, balance numeric)
language plpgsql security definer set search_path = public as $$
declare v_net_income numeric;
begin
  if p_company_id <> current_company_id() then raise exception 'لا صلاحية'; end if;

  select coalesce(sum(inc.amt), 0) into v_net_income from (
    select case when inc.section = 'الإيرادات' then inc.amount else -inc.amount end as amt
    from income_statement(p_company_id, '1970-01-01'::date, p_as_of) inc
  ) inc;

  return query
  select
    case a.account_type when 'asset' then 'الأصول' when 'liability' then 'الخصوم' else 'حقوق الملكية' end as section,
    a.code, a.name,
    a.opening_balance + coalesce((
      select sum(case when a.account_type = 'asset' then (jel.debit - jel.credit) else (jel.credit - jel.debit) end)
      from journal_entry_lines jel join journal_entries je on je.id = jel.entry_id
      where jel.account_id = a.id and je.entry_date <= p_as_of
    ), 0) as balance
  from chart_of_accounts a
  where a.company_id = p_company_id and a.account_type in ('asset', 'liability', 'equity') and not a.is_group
  union all
  select 'حقوق الملكية', '3900', 'صافي الربح (حتى تاريخه)', v_net_income
  order by section, code;
end $$;
revoke all on function public.balance_sheet(uuid, date) from public;
grant execute on function public.balance_sheet(uuid, date) to authenticated;

-- =====================================================================
-- تقرير مجمّع للسندات (قبض/صرف) — حسب التصنيف/الجهة/الفترة
-- =====================================================================
create or replace function public.vouchers_summary(p_company_id uuid, p_voucher_type voucher_type, p_from date, p_to date)
returns table(party_name text, party_type party_type, voucher_count bigint, total_amount numeric)
language plpgsql security definer set search_path = public as $$
begin
  if p_company_id <> current_company_id() then raise exception 'لا صلاحية'; end if;
  return query
  select v.party_name, v.party_type, count(*)::bigint, sum(v.amount)
  from vouchers v
  where v.company_id = p_company_id and v.voucher_type = p_voucher_type
    and v.voucher_date between p_from and p_to
  group by v.party_name, v.party_type
  order by sum(v.amount) desc;
end $$;
revoke all on function public.vouchers_summary(uuid, voucher_type, date, date) from public;
grant execute on function public.vouchers_summary(uuid, voucher_type, date, date) to authenticated;
