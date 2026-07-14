-- =====================================================================
-- Migration 007: App Bootstrap — تأسيس أول مالك + مخازن رفع الملفات
-- =====================================================================

-- ---------------------------------------------------------------------
-- سياسات التأسيس: مستخدم جديد (بلا ملف شخصي) ينشئ شركته ويصبح مالكها
-- ---------------------------------------------------------------------
create policy companies_bootstrap_insert on companies for insert
  with check (
    auth.uid() is not null
    and not exists (select 1 from profiles where id = auth.uid())
  );

create policy profiles_bootstrap_insert on profiles for insert
  with check (
    id = auth.uid()
    and role = 'owner'
    and not exists (select 1 from profiles p where p.id = auth.uid())
  );

-- ---------------------------------------------------------------------
-- مخازن الملفات (Storage Buckets)
--   unit-media : صور وفيديو الوحدات + شعار المنشأة (عام للعرض)
--   documents  : صور الهويات ومستندات السداد (عام مبسطاً للنسخة الأولى؛
--                يُشدد لاحقاً بروابط موقعة Signed URLs)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('unit-media', 'unit-media', true), ('documents', 'documents', true)
on conflict (id) do nothing;

-- الرفع والقراءة: كل مستخدم داخل مجلد شركته فقط (اسم المجلد = company_id)
create policy storage_upload_own_company on storage.objects for insert
  with check (
    bucket_id in ('unit-media','documents')
    and auth.uid() is not null
    and (storage.foldername(name))[1] = (select company_id::text from profiles where id = auth.uid())
  );

create policy storage_read_all on storage.objects for select
  using (bucket_id in ('unit-media','documents'));

create policy storage_delete_own_company on storage.objects for delete
  using (
    bucket_id in ('unit-media','documents')
    and (storage.foldername(name))[1] = (select company_id::text from profiles where id = auth.uid())
    and (select role from profiles where id = auth.uid()) in ('owner','manager')
  );
