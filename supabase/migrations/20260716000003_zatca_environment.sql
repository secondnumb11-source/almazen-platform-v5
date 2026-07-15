-- =====================================================================
-- Migration 022: بيئة الربط مع ZATCA (تجريبية/إنتاجية)
-- =====================================================================
alter table company_secrets add column zatca_environment text not null default 'sandbox' check (zatca_environment in ('sandbox','production'));
