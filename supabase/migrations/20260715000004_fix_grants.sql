-- =====================================================================
-- Migration 019: إصلاح صلاحيات PostgREST المفقودة على الجداول الجديدة
-- =====================================================================
-- RLS policies تُقيّد الصفوف فقط، لكن الدور authenticated يحتاج أيضاً
-- GRANT صريح على الجدول نفسه وإلا يُرفض الطلب بالكامل (42501) قبل أن
-- تُقيَّم سياسات RLS أصلاً. الجداول التي أُنشئت هذه الجلسة لم تكتسب
-- المنح الافتراضية التي تحصل عليها الجداول المُنشأة من لوحة Supabase.
-- =====================================================================
grant select, insert, update, delete on public.chart_of_accounts to authenticated;
grant select, insert, update, delete on public.journal_entries to authenticated;
grant select, insert, update, delete on public.journal_entry_lines to authenticated;
grant select, insert, update, delete on public.vouchers to authenticated;
grant select, insert, update, delete on public.message_templates to authenticated;
grant select, insert, update, delete on public.employee_advances to authenticated;
grant select, insert, update, delete on public.employee_requests to authenticated;
