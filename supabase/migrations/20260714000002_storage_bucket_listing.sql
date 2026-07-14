-- =====================================================================
-- Migration 010: إصلاح فحص التخزين الكاذب (Storage Check false negative)
-- =====================================================================
-- المشكلة: storage.buckets كانت مفعّلة RLS بلا أي سياسة قراءة، فكانت
-- listBuckets() تُعيد قائمة فارغة دائماً لأي مستخدم — رغم أن المخازن
-- (unit-media، handover-signatures، وغيرها) موجودة فعلياً وتعمل بشكل
-- صحيح عبر سياسات storage.objects المنفصلة. هذا جعل شاشة "فحص التخزين"
-- في مركز التقارير تُبلّغ خطأً بأن المخازن ناقصة رغم عملها الفعلي.
--
-- مجرد عرض أسماء المخازن وحالتها (عام/خاص) غير حسّاس — التحكم الفعلي
-- بالملفات نفسها يبقى محصوراً بالكامل عبر سياسات storage.objects.
-- =====================================================================

drop policy if exists buckets_list_authenticated on storage.buckets;
create policy buckets_list_authenticated on storage.buckets for select
  to authenticated
  using (true);
