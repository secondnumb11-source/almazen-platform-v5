-- =====================================================================
-- Migration 017: قوالب الرسائل الجاهزة لإدارة العملاء والمستأجرين
-- =====================================================================
create table message_templates (
  id          uuid primary key default uuid_generate_v4(),
  company_id  uuid not null references companies(id) on delete cascade,
  name        text not null,
  category    text not null default 'other',  -- welcome | expiry_reminder | payment_reminder | other
  body        text not null,
  created_at  timestamptz not null default now()
);
create index idx_msg_templates_company on message_templates(company_id);

alter table message_templates enable row level security;
create policy msg_templates_select on message_templates for select
  to authenticated using (company_id = current_company_id());
create policy msg_templates_write on message_templates for all
  to authenticated
  using (company_id = current_company_id() and current_role_of_user() in ('owner','manager','accountant'))
  with check (company_id = current_company_id() and current_role_of_user() in ('owner','manager','accountant'));

create or replace function public.seed_default_message_templates(p_company_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from message_templates where company_id = p_company_id) then return; end if;
  insert into message_templates (company_id, name, category, body) values
    (p_company_id, 'رسالة ترحيب', 'welcome',
     'مرحباً {name} 🌸، يسعدنا استقبالك في {company}. وحدتك رقم {unit} جاهزة لك من {checkin} حتى {checkout}. لأي استفسار نحن بخدمتك.'),
    (p_company_id, 'تذكير قرب انتهاء الإيجار', 'expiry_reminder',
     'مرحباً {name}، نود تذكيرك بأن مدة إيجار الوحدة {unit} تنتهي بتاريخ {checkout}. يسعدنا تجديد إقامتك — تواصل معنا للتجديد أو التسليم.'),
    (p_company_id, 'تذكير بموعد الدفعة', 'payment_reminder',
     'مرحباً {name}، نود تذكيرك بوجود دفعة إيجارية مستحقة قدرها {amount} ر.س للوحدة {unit}. نرجو السداد في أقرب وقت. شكراً لتفهمك.');
end $$;
revoke all on function public.seed_default_message_templates(uuid) from public;
grant execute on function public.seed_default_message_templates(uuid) to authenticated;

do $$
declare v_co record;
begin
  for v_co in select id from companies loop
    perform seed_default_message_templates(v_co.id);
  end loop;
end $$;

create or replace function public.fn_seed_templates_on_company_insert()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform seed_default_message_templates(new.id);
  return new;
end $$;

create trigger trg_seed_templates_on_company_insert after insert on companies
  for each row execute function fn_seed_templates_on_company_insert();
