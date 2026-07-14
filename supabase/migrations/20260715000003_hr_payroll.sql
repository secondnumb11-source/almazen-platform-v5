-- =====================================================================
-- Migration 018: إدارة الموظفين والرواتب والسلف والطلبات
-- =====================================================================
create type request_type as enum ('leave', 'advance', 'other');
create type request_status as enum ('new', 'approved', 'rejected');

-- ---------------------------------------------------------------------
-- توسيع ملف الموظف (phone/hire_date/birth_date/nationality/id_number موجودة مسبقاً)
-- ---------------------------------------------------------------------
alter table profiles add column address text;
alter table profiles add column job_title text;
alter table profiles add column manager_id uuid references profiles(id) on delete set null;
alter table profiles add column salary numeric(12,2) not null default 0;
alter table profiles add column iqama_expiry date;
alter table profiles add column hr_notes text;
alter table profiles add column id_photo_url text;
alter table profiles add column contract_url text;

-- ربط المصروف بموظف محدد (لصرف الرواتب من داخل شجرة الحسابات)
alter table expenses add column employee_id uuid references profiles(id) on delete set null;

-- حساب سلف الموظفين في شجرة الحسابات (لكل شركة قائمة)
do $$
declare v_co record; v_recv_grp uuid;
begin
  for v_co in select id from companies loop
    if not exists (select 1 from chart_of_accounts where company_id = v_co.id and code = '1202') then
      select id into v_recv_grp from chart_of_accounts where company_id = v_co.id and code = '1200';
      if v_recv_grp is not null then
        insert into chart_of_accounts (company_id, code, name, account_type, parent_id)
          values (v_co.id, '1202', 'سلف الموظفين', 'asset', v_recv_grp);
      end if;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- سلف الموظفين — مرتبطة تلقائياً بالحسابات والسندات
-- ---------------------------------------------------------------------
create table employee_advances (
  id           uuid primary key default uuid_generate_v4(),
  company_id   uuid not null references companies(id) on delete cascade,
  employee_id  uuid not null references profiles(id) on delete cascade,
  amount       numeric(12,2) not null check (amount > 0),
  advance_date date not null default current_date,
  reason       text,
  journal_entry_id uuid references journal_entries(id),
  voucher_id   uuid references vouchers(id),
  created_by   uuid references profiles(id),
  created_at   timestamptz not null default now()
);
create index idx_advances_company on employee_advances(company_id, employee_id);

create or replace function public.fn_advance_auto_post()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_recv_acc uuid; v_cash_acc uuid; v_entry_id uuid; v_entry_no text; v_voucher_no text; v_emp_name text; v_voucher_id uuid;
begin
  select id into v_recv_acc from chart_of_accounts where company_id = new.company_id and code = '1202';
  select id into v_cash_acc from chart_of_accounts where company_id = new.company_id and code = '1101';
  select full_name into v_emp_name from profiles where id = new.employee_id;
  if v_recv_acc is null or v_cash_acc is null then return new; end if;

  v_entry_no := next_document_number(new.company_id, 'journal');
  insert into journal_entries (company_id, entry_number, entry_date, description, source_type, source_id, created_by)
    values (new.company_id, v_entry_no, new.advance_date, 'قيد تلقائي — سلفة موظف: ' || coalesce(v_emp_name,''), 'advance', new.id, new.created_by)
    returning id into v_entry_id;

  insert into journal_entry_lines (entry_id, account_id, debit, credit, description, line_order) values
    (v_entry_id, v_recv_acc, new.amount, 0, coalesce(new.reason, 'سلفة موظف'), 1),
    (v_entry_id, v_cash_acc, 0, new.amount, coalesce(new.reason, 'سلفة موظف'), 2);

  v_voucher_no := next_document_number(new.company_id, 'payment');
  insert into vouchers (company_id, voucher_type, voucher_number, voucher_date, amount, account_id, party_type, party_name, description, payment_method, journal_entry_id, created_by)
  values (new.company_id, 'payment', v_voucher_no, new.advance_date, new.amount, v_cash_acc, 'employee', coalesce(v_emp_name, 'موظف'), coalesce(new.reason, 'سلفة موظف'), 'cash', v_entry_id, new.created_by)
  returning id into v_voucher_id;

  update employee_advances set journal_entry_id = v_entry_id, voucher_id = v_voucher_id where id = new.id;
  return new;
end $$;

create trigger trg_advance_auto_post after insert on employee_advances
  for each row execute function fn_advance_auto_post();

alter table employee_advances enable row level security;
create policy advances_select on employee_advances for select
  to authenticated using (
    company_id = current_company_id() and
    (current_role_of_user() in ('owner','manager','accountant') or employee_id = auth.uid())
  );
create policy advances_write on employee_advances for insert
  to authenticated with check (
    company_id = current_company_id() and current_role_of_user() in ('owner','manager','accountant')
  );

-- ---------------------------------------------------------------------
-- طلبات الموظفين (إجازة / سلفة / أخرى)
-- ---------------------------------------------------------------------
create table employee_requests (
  id           uuid primary key default uuid_generate_v4(),
  company_id   uuid not null references companies(id) on delete cascade,
  employee_id  uuid not null references profiles(id) on delete cascade,
  request_type request_type not null,
  status       request_status not null default 'new',
  amount       numeric(12,2),
  start_date   date,
  end_date     date,
  reason       text,
  decided_by   uuid references profiles(id),
  decided_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index idx_emp_requests_company on employee_requests(company_id, status);

alter table employee_requests enable row level security;
create policy emp_requests_select on employee_requests for select
  to authenticated using (
    company_id = current_company_id() and
    (current_role_of_user() in ('owner','manager','accountant') or employee_id = auth.uid())
  );
create policy emp_requests_insert on employee_requests for insert
  to authenticated with check (company_id = current_company_id() and employee_id = auth.uid());
create policy emp_requests_update on employee_requests for update
  to authenticated using (company_id = current_company_id() and current_role_of_user() in ('owner','manager','accountant'))
  with check (company_id = current_company_id() and current_role_of_user() in ('owner','manager','accountant'));

-- الموافقة على طلب سلفة تُنشئ سلفة فعلية تلقائياً
create or replace function public.approve_advance_request(p_request_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_req employee_requests%rowtype; v_adv_id uuid;
begin
  select * into v_req from employee_requests where id = p_request_id;
  if v_req.id is null or v_req.company_id <> current_company_id() then raise exception 'الطلب غير موجود'; end if;
  if current_role_of_user() not in ('owner','manager','accountant') then raise exception 'صلاحية حصرية للإدارة'; end if;
  if v_req.request_type <> 'advance' then raise exception 'هذا الطلب ليس طلب سلفة'; end if;

  insert into employee_advances (company_id, employee_id, amount, advance_date, reason, created_by)
  values (v_req.company_id, v_req.employee_id, v_req.amount, current_date, v_req.reason, auth.uid())
  returning id into v_adv_id;

  update employee_requests set status = 'approved', decided_by = auth.uid(), decided_at = now() where id = p_request_id;
  return v_adv_id;
end $$;
revoke all on function public.approve_advance_request(uuid) from public;
grant execute on function public.approve_advance_request(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- صرف راتب موظف (يُسجَّل كمصروف مرتبط بشجرة الحسابات تلقائياً)
-- ---------------------------------------------------------------------
create or replace function public.pay_employee_salary(p_employee_id uuid, p_amount numeric, p_pay_date date, p_note text default null)
returns uuid
language plpgsql security definer set search_path = public as $$
declare v_cid uuid; v_emp_name text; v_exp_id uuid;
begin
  if current_role_of_user() not in ('owner','manager','accountant') then raise exception 'صلاحية حصرية للإدارة';
  end if;
  v_cid := current_company_id();
  select full_name into v_emp_name from profiles where id = p_employee_id and company_id = v_cid;
  if v_emp_name is null then raise exception 'الموظف غير موجود'; end if;

  insert into expenses (company_id, category, amount, description, vendor_name, employee_id, payment_method, created_by)
  values (v_cid, 'salaries', p_amount, coalesce(p_note, 'صرف راتب — ' || v_emp_name), v_emp_name, p_employee_id, 'bank_transfer', auth.uid())
  returning id into v_exp_id;

  return v_exp_id;
end $$;
revoke all on function public.pay_employee_salary(uuid, numeric, date, text) from public;
grant execute on function public.pay_employee_salary(uuid, numeric, date, text) to authenticated;
