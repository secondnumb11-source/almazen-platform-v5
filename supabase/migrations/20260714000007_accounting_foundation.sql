-- =====================================================================
-- Migration 015: الأساس المحاسبي — شجرة الحسابات + القيود + السندات
-- =====================================================================
-- يبني هذا الملف طبقة محاسبية حقيقية فوق البيانات التشغيلية الموجودة
-- (payments/expenses): شجرة حسابات هرمية، قيود محاسبية بعمودي مدين/دائن
-- مع رصيد متحرك، سندات قبض/صرف احترافية، وترحيل تلقائي فوري عند كل
-- دفعة أو مصروف يُسجَّل من أي شاشة في النظام — دون أي تدخل يدوي.
-- =====================================================================

create type account_type as enum ('asset','liability','equity','revenue','expense');
create type voucher_type as enum ('receipt','payment');
create type party_type as enum ('tenant','vendor','employee','other');

-- ---------------------------------------------------------------------
-- شجرة الحسابات
-- ---------------------------------------------------------------------
create table chart_of_accounts (
  id               uuid primary key default uuid_generate_v4(),
  company_id       uuid not null references companies(id) on delete cascade,
  code             text not null,
  name             text not null,
  account_type     account_type not null,
  parent_id        uuid references chart_of_accounts(id) on delete set null,
  is_group         boolean not null default false,
  opening_balance  numeric(14,2) not null default 0,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  unique (company_id, code)
);
create index idx_coa_company on chart_of_accounts(company_id);
create index idx_coa_parent on chart_of_accounts(parent_id);

-- ---------------------------------------------------------------------
-- القيود المحاسبية (رأس القيد)
-- ---------------------------------------------------------------------
create table journal_entries (
  id            uuid primary key default uuid_generate_v4(),
  company_id    uuid not null references companies(id) on delete cascade,
  entry_number  text not null,
  entry_date    date not null default current_date,
  description   text,
  source_type   text not null default 'manual',   -- manual | payment | expense | payroll | voucher
  source_id     uuid,
  created_by    uuid references profiles(id),
  created_at    timestamptz not null default now(),
  unique (company_id, entry_number)
);
create index idx_je_company_date on journal_entries(company_id, entry_date);
create index idx_je_source on journal_entries(source_type, source_id);

-- سطور القيد (مدين / دائن)
create table journal_entry_lines (
  id           uuid primary key default uuid_generate_v4(),
  entry_id     uuid not null references journal_entries(id) on delete cascade,
  account_id   uuid not null references chart_of_accounts(id) on delete restrict,
  debit        numeric(14,2) not null default 0,
  credit       numeric(14,2) not null default 0,
  description  text,
  line_order   int not null default 0,
  check (debit >= 0 and credit >= 0 and not (debit > 0 and credit > 0))
);
create index idx_jel_entry on journal_entry_lines(entry_id);
create index idx_jel_account on journal_entry_lines(account_id);

-- ---------------------------------------------------------------------
-- السندات (قبض / صرف)
-- ---------------------------------------------------------------------
create table vouchers (
  id                uuid primary key default uuid_generate_v4(),
  company_id        uuid not null references companies(id) on delete cascade,
  voucher_type      voucher_type not null,
  voucher_number    text not null,
  voucher_date      date not null default current_date,
  amount            numeric(14,2) not null check (amount > 0),
  account_id        uuid references chart_of_accounts(id),   -- حساب النقدية/البنك
  party_type        party_type not null default 'other',
  party_name        text not null,
  description       text,
  payment_method    payment_method not null default 'cash',
  reference_number  text,
  attachment_url    text,
  booking_id        uuid references bookings(id) on delete set null,
  payment_id        uuid references payments(id) on delete set null,
  expense_id        uuid references expenses(id) on delete set null,
  journal_entry_id  uuid references journal_entries(id) on delete set null,
  created_by        uuid references profiles(id),
  created_at        timestamptz not null default now(),
  unique (company_id, voucher_type, voucher_number)
);
create index idx_vouchers_company on vouchers(company_id, voucher_date);

-- ---------------------------------------------------------------------
-- ربط المصروفات بشجرة الحسابات والمورد وطريقة الدفع
-- ---------------------------------------------------------------------
alter table expenses add column vendor_name text;
alter table expenses add column paid_from_account_id uuid references chart_of_accounts(id);
alter table expenses add column payment_method payment_method not null default 'cash';

-- =====================================================================
-- دوال الترقيم التلقائي
-- =====================================================================
create or replace function public.next_document_number(p_company_id uuid, p_kind text)
returns text
language plpgsql security definer set search_path = public as $$
declare v_count int; v_prefix text;
begin
  if p_kind = 'journal' then
    select count(*) into v_count from journal_entries where company_id = p_company_id;
    v_prefix := 'JE';
  elsif p_kind = 'receipt' then
    select count(*) into v_count from vouchers where company_id = p_company_id and voucher_type = 'receipt';
    v_prefix := 'RV';
  elsif p_kind = 'payment' then
    select count(*) into v_count from vouchers where company_id = p_company_id and voucher_type = 'payment';
    v_prefix := 'PV';
  else
    return null;
  end if;
  return v_prefix || '-' || to_char(current_date,'YYYY') || '-' || lpad((v_count + 1)::text, 5, '0');
end $$;
revoke all on function public.next_document_number(uuid, text) from public;
grant execute on function public.next_document_number(uuid, text) to authenticated;

-- =====================================================================
-- تهيئة شجرة حسابات افتراضية احترافية لكل منشأة (مرة واحدة فقط)
-- =====================================================================
create or replace function public.seed_default_chart_of_accounts(p_company_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_assets uuid; v_liab uuid; v_equity uuid; v_rev uuid; v_exp uuid;
  v_cash_grp uuid; v_recv_grp uuid; v_fixed_grp uuid;
  v_payable_grp uuid;
begin
  if exists (select 1 from chart_of_accounts where company_id = p_company_id) then return; end if;

  insert into chart_of_accounts (company_id, code, name, account_type, is_group) values
    (p_company_id, '1000', 'الأصول', 'asset', true) returning id into v_assets;
  insert into chart_of_accounts (company_id, code, name, account_type, is_group) values
    (p_company_id, '2000', 'الخصوم', 'liability', true) returning id into v_liab;
  insert into chart_of_accounts (company_id, code, name, account_type, is_group) values
    (p_company_id, '3000', 'حقوق الملكية', 'equity', true) returning id into v_equity;
  insert into chart_of_accounts (company_id, code, name, account_type, is_group) values
    (p_company_id, '4000', 'الإيرادات', 'revenue', true) returning id into v_rev;
  insert into chart_of_accounts (company_id, code, name, account_type, is_group) values
    (p_company_id, '5000', 'المصروفات', 'expense', true) returning id into v_exp;

  insert into chart_of_accounts (company_id, code, name, account_type, parent_id, is_group) values
    (p_company_id, '1100', 'النقدية والبنوك', 'asset', v_assets, true) returning id into v_cash_grp;
  insert into chart_of_accounts (company_id, code, name, account_type, parent_id) values
    (p_company_id, '1101', 'الصندوق (كاش)', 'asset', v_cash_grp),
    (p_company_id, '1102', 'البنك', 'asset', v_cash_grp);

  insert into chart_of_accounts (company_id, code, name, account_type, parent_id, is_group) values
    (p_company_id, '1200', 'المدينون', 'asset', v_assets, true) returning id into v_recv_grp;
  insert into chart_of_accounts (company_id, code, name, account_type, parent_id) values
    (p_company_id, '1201', 'ذمم المستأجرين', 'asset', v_recv_grp);

  insert into chart_of_accounts (company_id, code, name, account_type, parent_id, is_group) values
    (p_company_id, '1300', 'الأصول الثابتة', 'asset', v_assets, true) returning id into v_fixed_grp;
  insert into chart_of_accounts (company_id, code, name, account_type, parent_id) values
    (p_company_id, '1301', 'أصول ثابتة (أثاث ومعدات وعقارات)', 'asset', v_fixed_grp),
    (p_company_id, '1302', 'مجمع الإهلاك', 'asset', v_fixed_grp);

  insert into chart_of_accounts (company_id, code, name, account_type, parent_id, is_group) values
    (p_company_id, '2100', 'الدائنون', 'liability', v_liab, true) returning id into v_payable_grp;
  insert into chart_of_accounts (company_id, code, name, account_type, parent_id) values
    (p_company_id, '2101', 'ذمم الموردين', 'liability', v_payable_grp),
    (p_company_id, '2200', 'مصروفات مستحقة', 'liability', v_liab),
    (p_company_id, '2300', 'ضريبة القيمة المضافة المستحقة', 'liability', v_liab);

  insert into chart_of_accounts (company_id, code, name, account_type, parent_id) values
    (p_company_id, '3100', 'رأس المال', 'equity', v_equity),
    (p_company_id, '3200', 'الأرباح المرحلة', 'equity', v_equity);

  insert into chart_of_accounts (company_id, code, name, account_type, parent_id) values
    (p_company_id, '4100', 'إيرادات الإيجار', 'revenue', v_rev),
    (p_company_id, '4200', 'إيرادات التأمين', 'revenue', v_rev),
    (p_company_id, '4300', 'إيرادات أخرى', 'revenue', v_rev);

  insert into chart_of_accounts (company_id, code, name, account_type, parent_id) values
    (p_company_id, '5100', 'كهرباء', 'expense', v_exp),
    (p_company_id, '5200', 'ماء', 'expense', v_exp),
    (p_company_id, '5300', 'صيانة', 'expense', v_exp),
    (p_company_id, '5400', 'رواتب', 'expense', v_exp),
    (p_company_id, '5500', 'نظافة', 'expense', v_exp),
    (p_company_id, '5600', 'إنترنت', 'expense', v_exp),
    (p_company_id, '5700', 'إهلاك', 'expense', v_exp),
    (p_company_id, '5800', 'مصروفات أخرى', 'expense', v_exp);
end $$;
revoke all on function public.seed_default_chart_of_accounts(uuid) from public;
grant execute on function public.seed_default_chart_of_accounts(uuid) to authenticated;

-- تهيئة الشركات الموجودة حالياً فوراً
do $$
declare v_co record;
begin
  for v_co in select id from companies loop
    perform seed_default_chart_of_accounts(v_co.id);
  end loop;
end $$;

-- =====================================================================
-- الترحيل التلقائي: دفعة مستلمة → قيد + سند قبض
-- =====================================================================
create or replace function public.fn_payment_auto_post()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_cash_acc uuid; v_rev_acc uuid; v_entry_id uuid; v_entry_no text; v_voucher_no text;
  v_customer_name text;
begin
  select id into v_cash_acc from chart_of_accounts
    where company_id = new.company_id
      and code = case when new.method = 'bank_transfer' then '1102' else '1101' end;

  select id into v_rev_acc from chart_of_accounts
    where company_id = new.company_id
      and code = case when new.payment_type = 'insurance' then '4200' else '4100' end;

  if v_cash_acc is null or v_rev_acc is null then return new; end if;

  v_entry_no := next_document_number(new.company_id, 'journal');
  insert into journal_entries (company_id, entry_number, entry_date, description, source_type, source_id, created_by)
    values (new.company_id, v_entry_no, new.payment_date, 'قيد تلقائي — دفعة مستلمة', 'payment', new.id, new.received_by)
    returning id into v_entry_id;

  insert into journal_entry_lines (entry_id, account_id, debit, credit, description, line_order) values
    (v_entry_id, v_cash_acc, new.amount, 0, 'استلام دفعة', 1),
    (v_entry_id, v_rev_acc, 0, new.amount, 'استلام دفعة', 2);

  select c.full_name into v_customer_name
    from bookings b join customers c on c.id = b.customer_id where b.id = new.booking_id;

  v_voucher_no := next_document_number(new.company_id, 'receipt');
  insert into vouchers (
    company_id, voucher_type, voucher_number, voucher_date, amount, account_id,
    party_type, party_name, description, payment_method, reference_number,
    booking_id, payment_id, journal_entry_id, created_by
  ) values (
    new.company_id, 'receipt', v_voucher_no, new.payment_date, new.amount, v_cash_acc,
    'tenant', coalesce(v_customer_name, 'مستأجر'),
    case new.payment_type
      when 'insurance' then 'تأمين'
      when 'down_payment' then 'عربون'
      when 'penalty' then 'غرامة'
      when 'other' then 'دفعة أخرى'
      else 'دفعة إيجار'
    end,
    new.method, new.reference_number, new.booking_id, new.id, v_entry_id, new.received_by
  );

  return new;
end $$;

create trigger trg_payment_auto_post after insert on payments
  for each row execute function fn_payment_auto_post();

-- =====================================================================
-- الترحيل التلقائي: مصروف مسجّل → قيد + سند صرف
-- =====================================================================
create or replace function public.fn_expense_auto_post()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_exp_acc uuid; v_cash_acc uuid; v_entry_id uuid; v_entry_no text; v_voucher_no text;
begin
  select id into v_exp_acc from chart_of_accounts
    where company_id = new.company_id
      and code = case new.category
        when 'electricity' then '5100'
        when 'water' then '5200'
        when 'maintenance' then '5300'
        when 'salaries' then '5400'
        when 'cleaning' then '5500'
        when 'internet' then '5600'
        else '5800'
      end;

  v_cash_acc := coalesce(new.paid_from_account_id,
    (select id from chart_of_accounts where company_id = new.company_id and code = '1101'));

  if v_exp_acc is null or v_cash_acc is null then return new; end if;

  v_entry_no := next_document_number(new.company_id, 'journal');
  insert into journal_entries (company_id, entry_number, entry_date, description, source_type, source_id, created_by)
    values (new.company_id, v_entry_no, new.expense_date, 'قيد تلقائي — مصروف', 'expense', new.id, new.created_by)
    returning id into v_entry_id;

  insert into journal_entry_lines (entry_id, account_id, debit, credit, description, line_order) values
    (v_entry_id, v_exp_acc, new.amount, 0, coalesce(new.description, 'مصروف'), 1),
    (v_entry_id, v_cash_acc, 0, new.amount, coalesce(new.description, 'مصروف'), 2);

  v_voucher_no := next_document_number(new.company_id, 'payment');
  insert into vouchers (
    company_id, voucher_type, voucher_number, voucher_date, amount, account_id,
    party_type, party_name, description, payment_method, attachment_url,
    expense_id, journal_entry_id, created_by
  ) values (
    new.company_id, 'payment', v_voucher_no, new.expense_date, new.amount, v_cash_acc,
    'vendor', coalesce(new.vendor_name, 'مورد'), coalesce(new.description, 'مصروف'),
    coalesce(new.payment_method, 'cash'), new.invoice_url,
    new.id, v_entry_id, new.created_by
  );

  return new;
end $$;

create trigger trg_expense_auto_post after insert on expenses
  for each row execute function fn_expense_auto_post();

-- =====================================================================
-- قيد يدوي حر يُدخله المحاسب (بند مخصص / تسوية)
-- =====================================================================
create or replace function public.post_manual_journal_entry(
  p_company_id uuid, p_entry_date date, p_description text, p_lines jsonb
)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_role user_role; v_entry_id uuid; v_entry_no text;
  v_total_debit numeric := 0; v_total_credit numeric := 0;
  v_line jsonb; v_order int := 0;
begin
  select role into v_role from profiles where id = auth.uid();
  if v_role not in ('owner','manager','accountant') then
    raise exception 'صلاحية إضافة القيود حصرية للمحاسب أو المدير أو المالك';
  end if;
  if p_company_id <> current_company_id() then
    raise exception 'لا صلاحية على شركة أخرى';
  end if;
  if jsonb_array_length(p_lines) < 2 then
    raise exception 'القيد يحتاج سطرين على الأقل';
  end if;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_total_debit := v_total_debit + coalesce((v_line->>'debit')::numeric, 0);
    v_total_credit := v_total_credit + coalesce((v_line->>'credit')::numeric, 0);
  end loop;
  if round(v_total_debit, 2) <> round(v_total_credit, 2) then
    raise exception 'القيد غير متوازن: إجمالي المدين % لا يساوي إجمالي الدائن %', v_total_debit, v_total_credit;
  end if;

  v_entry_no := next_document_number(p_company_id, 'journal');
  insert into journal_entries (company_id, entry_number, entry_date, description, source_type, created_by)
    values (p_company_id, v_entry_no, p_entry_date, p_description, 'manual', auth.uid())
    returning id into v_entry_id;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_order := v_order + 1;
    insert into journal_entry_lines (entry_id, account_id, debit, credit, description, line_order)
    values (
      v_entry_id, (v_line->>'account_id')::uuid,
      coalesce((v_line->>'debit')::numeric, 0), coalesce((v_line->>'credit')::numeric, 0),
      v_line->>'description', v_order
    );
  end loop;

  return v_entry_id;
end $$;
revoke all on function public.post_manual_journal_entry(uuid, date, text, jsonb) from public;
grant execute on function public.post_manual_journal_entry(uuid, date, text, jsonb) to authenticated;

-- =====================================================================
-- شجرة الحسابات مع الأرصدة الفعلية (لعرض الشجرة والتقارير)
-- =====================================================================
create or replace function public.chart_of_accounts_with_balances(p_company_id uuid, p_as_of date default current_date)
returns table(id uuid, code text, name text, account_type account_type, parent_id uuid, is_group boolean, balance numeric)
language plpgsql security definer set search_path = public as $$
begin
  if p_company_id <> current_company_id() then raise exception 'لا صلاحية'; end if;
  return query
  select a.id, a.code, a.name, a.account_type, a.parent_id, a.is_group,
    a.opening_balance + coalesce((
      select sum(case when a.account_type in ('asset','expense') then (jel.debit - jel.credit) else (jel.credit - jel.debit) end)
      from journal_entry_lines jel join journal_entries je on je.id = jel.entry_id
      where jel.account_id = a.id and je.entry_date <= p_as_of
    ), 0) as balance
  from chart_of_accounts a
  where a.company_id = p_company_id
  order by a.code;
end $$;
revoke all on function public.chart_of_accounts_with_balances(uuid, date) from public;
grant execute on function public.chart_of_accounts_with_balances(uuid, date) to authenticated;

-- =====================================================================
-- كشف حساب مفصّل (رصيد متحرك سطراً بسطر) — لأي حساب في الشجرة
-- =====================================================================
create or replace function public.account_statement(p_account_id uuid, p_from date, p_to date)
returns table(entry_date date, entry_number text, description text, debit numeric, credit numeric, running_balance numeric)
language plpgsql security definer set search_path = public as $$
declare v_cid uuid; v_type account_type; v_opening numeric;
begin
  select company_id, account_type, opening_balance into v_cid, v_type, v_opening
    from chart_of_accounts where id = p_account_id;
  if v_cid is null or v_cid <> current_company_id() then raise exception 'حساب غير موجود'; end if;

  return query
  with lines as (
    select je.entry_date, je.entry_number,
      coalesce(nullif(jel.description, ''), je.description) as description,
      jel.debit, jel.credit
    from journal_entry_lines jel
    join journal_entries je on je.id = jel.entry_id
    where jel.account_id = p_account_id and je.entry_date between p_from and p_to
  )
  select l.entry_date, l.entry_number, l.description, l.debit, l.credit,
    v_opening + sum(
      case when v_type in ('asset','expense') then (l.debit - l.credit) else (l.credit - l.debit) end
    ) over (order by l.entry_date, l.entry_number rows between unbounded preceding and current row) as running_balance
  from lines l
  order by l.entry_date, l.entry_number;
end $$;
revoke all on function public.account_statement(uuid, date, date) from public;
grant execute on function public.account_statement(uuid, date, date) to authenticated;

-- =====================================================================
-- تهيئة شجرة الحسابات تلقائياً عند تأسيس منشأة جديدة
-- =====================================================================
create or replace function public.fn_seed_coa_on_company_insert()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform seed_default_chart_of_accounts(new.id);
  return new;
end $$;

create trigger trg_seed_coa_on_company_insert after insert on companies
  for each row execute function fn_seed_coa_on_company_insert();

-- =====================================================================
-- RLS
-- =====================================================================
alter table chart_of_accounts enable row level security;
alter table journal_entries enable row level security;
alter table journal_entry_lines enable row level security;
alter table vouchers enable row level security;

create policy coa_select on chart_of_accounts for select
  to authenticated using (company_id = current_company_id());
create policy coa_write on chart_of_accounts for all
  to authenticated
  using (company_id = current_company_id() and current_role_of_user() in ('owner','manager','accountant'))
  with check (company_id = current_company_id() and current_role_of_user() in ('owner','manager','accountant'));

create policy je_select on journal_entries for select
  to authenticated using (company_id = current_company_id());
create policy je_write on journal_entries for all
  to authenticated
  using (company_id = current_company_id() and current_role_of_user() in ('owner','manager','accountant'))
  with check (company_id = current_company_id() and current_role_of_user() in ('owner','manager','accountant'));

create policy jel_select on journal_entry_lines for select
  to authenticated using (
    exists (select 1 from journal_entries je where je.id = entry_id and je.company_id = current_company_id())
  );
create policy jel_write on journal_entry_lines for all
  to authenticated
  using (
    exists (select 1 from journal_entries je where je.id = entry_id and je.company_id = current_company_id()
      and current_role_of_user() in ('owner','manager','accountant'))
  )
  with check (
    exists (select 1 from journal_entries je where je.id = entry_id and je.company_id = current_company_id()
      and current_role_of_user() in ('owner','manager','accountant'))
  );

create policy vouchers_select on vouchers for select
  to authenticated using (company_id = current_company_id());
create policy vouchers_write on vouchers for all
  to authenticated
  using (company_id = current_company_id() and current_role_of_user() in ('owner','manager','accountant'))
  with check (company_id = current_company_id() and current_role_of_user() in ('owner','manager','accountant'));
