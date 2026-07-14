-- =====================================================================
-- Migration 005: Row Level Security — عزل منطقي كامل لكل شركة (SaaS)
-- =====================================================================

-- دالة مساعدة: شركة المستخدم الحالي
create or replace function current_company_id()
returns uuid language sql stable security definer as $$
  select company_id from profiles where id = auth.uid();
$$;

-- دالة مساعدة: دور المستخدم الحالي
create or replace function current_role_of_user()
returns user_role language sql stable security definer as $$
  select role from profiles where id = auth.uid();
$$;

-- تفعيل RLS على جميع الجداول
do $$
declare t text;
begin
  foreach t in array array[
    'companies','profiles','properties','units','unit_media','unit_assets',
    'pricing_rules','customers','bookings','booking_companions','payments',
    'payment_schedules','insurance_records','invoices','expenses',
    'maintenance_requests','key_logs','checkin_logs','checklists',
    'notifications','automation_logs','loyalty_transactions',
    'tenant_portal_accounts','service_requests','ai_conversations',
    'ai_insights','audit_logs']
  loop
    execute format('alter table %s enable row level security', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- الشركات: كل مستخدم يرى شركته فقط، والتعديل للمالك فقط
-- ---------------------------------------------------------------------
create policy companies_select on companies for select
  using (id = current_company_id());
create policy companies_update on companies for update
  using (id = current_company_id() and current_role_of_user() = 'owner');

-- ---------------------------------------------------------------------
-- المستخدمون: عرض داخل الشركة، إدارة الحسابات للمالك والمدير
-- ---------------------------------------------------------------------
create policy profiles_select on profiles for select
  using (company_id = current_company_id());
create policy profiles_insert on profiles for insert
  with check (company_id = current_company_id()
              and current_role_of_user() in ('owner','manager'));
create policy profiles_update on profiles for update
  using (company_id = current_company_id()
         and (id = auth.uid() or current_role_of_user() in ('owner','manager')));
create policy profiles_delete on profiles for delete
  using (company_id = current_company_id() and current_role_of_user() = 'owner');

-- ---------------------------------------------------------------------
-- سياسة عامة لجداول الشركة: قراءة وكتابة داخل نفس الشركة
-- (القيود الدقيقة — الأسعار والإلغاء — تفرضها المحفزات في Migration 004)
-- ---------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'properties','units','unit_media','unit_assets','customers','bookings',
    'booking_companions','payments','payment_schedules','insurance_records',
    'invoices','maintenance_requests','key_logs','checkin_logs','checklists',
    'notifications','loyalty_transactions','tenant_portal_accounts',
    'service_requests','ai_conversations']
  loop
    execute format(
      'create policy %I_select on %I for select using (company_id = current_company_id())', t, t);
    execute format(
      'create policy %I_insert on %I for insert with check (company_id = current_company_id())', t, t);
    execute format(
      'create policy %I_update on %I for update using (company_id = current_company_id())', t, t);
  end loop;
end $$;

-- الحذف: للمالك والمدير فقط
do $$
declare t text;
begin
  foreach t in array array[
    'properties','units','unit_media','unit_assets','customers',
    'booking_companions','maintenance_requests']
  loop
    execute format(
      'create policy %I_delete on %I for delete
       using (company_id = current_company_id()
              and current_role_of_user() in (''owner'',''manager''))', t, t);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- البيانات المالية الحساسة: المصروفات وقواعد التسعير والرؤى
-- عرض المصروفات والأرباح: المالك والمحاسب والمدير (ليس الموظف)
-- ---------------------------------------------------------------------
create policy expenses_select on expenses for select
  using (company_id = current_company_id()
         and current_role_of_user() in ('owner','manager','accountant'));
create policy expenses_insert on expenses for insert
  with check (company_id = current_company_id());
create policy expenses_update on expenses for update
  using (company_id = current_company_id()
         and current_role_of_user() in ('owner','manager','accountant'));
create policy expenses_delete on expenses for delete
  using (company_id = current_company_id() and current_role_of_user() = 'owner');

create policy pricing_rules_select on pricing_rules for select
  using (company_id = current_company_id());
create policy pricing_rules_write on pricing_rules for insert
  with check (company_id = current_company_id()
              and current_role_of_user() in ('owner','manager'));
create policy pricing_rules_update on pricing_rules for update
  using (company_id = current_company_id()
         and current_role_of_user() in ('owner','manager'));

create policy ai_insights_select on ai_insights for select
  using (company_id = current_company_id());
create policy ai_insights_write on ai_insights for insert
  with check (company_id = current_company_id());
create policy ai_insights_update on ai_insights for update
  using (company_id = current_company_id());

-- سجلات الأتمتة والتدقيق: قراءة للمالك والمدير فقط، الكتابة من الخادم
create policy automation_logs_select on automation_logs for select
  using (company_id = current_company_id()
         and current_role_of_user() in ('owner','manager'));
create policy automation_logs_insert on automation_logs for insert
  with check (company_id = current_company_id());

create policy audit_select on audit_logs for select
  using (company_id = current_company_id()
         and current_role_of_user() in ('owner','manager'));
create policy audit_insert on audit_logs for insert
  with check (company_id = current_company_id());

-- ---------------------------------------------------------------------
-- تفعيل البث الفوري (Realtime) لتحديث ألوان الوحدات لحظياً
-- ---------------------------------------------------------------------
alter publication supabase_realtime add table units;
alter publication supabase_realtime add table bookings;
alter publication supabase_realtime add table notifications;
