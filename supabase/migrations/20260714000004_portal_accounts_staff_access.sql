-- =====================================================================
-- Migration 012: صلاحية الموظفين المالية على حسابات بوابة المستأجر
-- =====================================================================
-- tenant_portal_accounts كانت بلا أي سياسة RLS إطلاقاً — قرار مقصود
-- سابقاً لأن وصول المستأجر نفسه يمر حصرياً عبر دوال portal_* الآمنة
-- (SECURITY DEFINER) وليس عبر REST مباشر. لكن هذا يمنع أيضاً موظفي
-- المنشأة (المالك/المدير/المحاسب) من رؤية أو تعديل اسم المستخدم أو
-- توليد كلمة مرور جديدة لضيوفهم من واجهة "ملخص الإيجار" — وهي حاجة
-- تشغيلية حقيقية. نضيف صلاحية محصورة بنفس الشركة وبأدوار مالية فقط.
-- =====================================================================

drop policy if exists tenant_portal_accounts_staff_select on public.tenant_portal_accounts;
create policy tenant_portal_accounts_staff_select on public.tenant_portal_accounts for select
  to authenticated
  using (company_id = current_company_id() and current_role_of_user() in ('owner','manager','accountant'));

drop policy if exists tenant_portal_accounts_staff_update on public.tenant_portal_accounts;
create policy tenant_portal_accounts_staff_update on public.tenant_portal_accounts for update
  to authenticated
  using (company_id = current_company_id() and current_role_of_user() in ('owner','manager','accountant'))
  with check (company_id = current_company_id() and current_role_of_user() in ('owner','manager','accountant'));
