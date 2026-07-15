-- ============================================================================
-- تفعيل ربط منصات الحجز + ربط كل الوحدات الفعلية بعقار/نوع غرفة/خطة سعر
-- حقيقية أُنشئت فعلياً على حساب Channex التجريبي (Sandbox) الخاص بالمنشأة،
-- وإدراج مهمة "دفع السعر الحالي" فوراً لكل وحدة حتى لا ننتظر أول تغيير سعر.
--
-- المعرّفات أدناه حقيقية (تم التحقق منها والتأكد من إنشائها فعلياً عبر
-- استدعاء API حقيقي على حساب Channex الخاص بالمستخدم — وليست قيماً وهمية):
--   property_id  = adc2a00c-97e5-4d83-87f1-8dbdff9d26bb  (al-mazen platform)
--   room_type_id = fbc461a2-6566-4016-a015-0363b292020b  (غرفة فندقية)
--   rate_plan_id = c6a25bb3-55cb-43f9-a33f-3b98930542ec  (السعر القياسي)
--
-- ⚠️ ملاحظة مهمة: حساب Channex هذا يحتوي حالياً نوع غرفة واحداً فقط
-- (يمثّل حتى 20 وحدة بنفس السعر على مستوى القناة). كل وحداتنا الفعلية
-- تُربط به مبدئياً لتفعيل المزامنة فوراً؛ لفصل كل وحدة بسعرها الحقيقي
-- الخاص على منصات الحجز لاحقاً، يُنشئ المالك نوع غرفة وخطة سعر مستقلة
-- لكل فئة وحدة من داخل لوحة Channex نفسها ثم يُعاد الربط من تبويب
-- "ربط الوحدات" (كل وحدة إلى نوع غرفتها الخاص).
-- ============================================================================

do $$
declare
  v_company_id uuid;
  v_property_id  text := 'adc2a00c-97e5-4d83-87f1-8dbdff9d26bb';
  v_room_type_id text := 'fbc461a2-6566-4016-a015-0363b292020b';
  v_rate_plan_id text := 'c6a25bb3-55cb-43f9-a33f-3b98930542ec';
begin
  select id into v_company_id from public.companies where name = 'شركة المازن للعقارات' limit 1;
  if v_company_id is null then
    raise notice 'لم يُعثر على شركة باسم «شركة المازن للعقارات» — لم يُنفَّذ أي ربط تلقائي.';
    return;
  end if;

  -- 1) تفعيل الربط مع Channex لهذه المنشأة تحديداً
  update public.channel_manager_settings
    set enabled = true, environment = 'sandbox', connection_status = 'connected', updated_at = now()
  where company_id = v_company_id;

  -- 2) ربط كل وحدات هذه المنشأة (بغض النظر عن حالتها الحالية — الحالة تتغيّر
  --    ديناميكياً، والمزامنة تعتمد على ota_sync_enabled + المُعرّفات لا على status)
  update public.units set
    channex_property_id  = v_property_id,
    channex_room_type_id = v_room_type_id,
    channex_rate_plan_id = v_rate_plan_id,
    ota_sync_enabled     = true,
    updated_at = now()
  where company_id = v_company_id;

  -- 3) إدراج مهمة "دفع السعر الحالي" فوراً لكل وحدة (بدل انتظار أول تعديل سعر)
  insert into public.ota_sync_queue (company_id, unit_id, job_type, payload)
  select v_company_id, id, 'push_price', jsonb_build_object('daily_price', daily_price)
  from public.units
  where company_id = v_company_id and daily_price is not null and daily_price > 0;

  raise notice 'تم تفعيل وربط % وحدة للمنشأة %', (select count(*) from public.units where company_id = v_company_id), v_company_id;
end $$;

-- ----------------------------------------------------------------------------
-- تصحيح أمني: enqueue_ota_sync كانت بلا صلاحيات execute مُقيَّدة صراحة،
-- ما يجعلها قابلة للاستدعاء افتراضياً عبر REST API من أي مستخدم مسجَّل
-- بأي company_id (حتى لو لشركة أخرى) — نقيّدها الآن على service_role فقط.
-- المُشغّلات الداخلية (trg_fn_enqueue_price_sync/availability_sync) تبقى
-- تعمل بلا تأثير لأنها SECURITY DEFINER مملوكة لنفس دور الإنشاء.
-- ----------------------------------------------------------------------------
revoke all on function public.enqueue_ota_sync(uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_ota_sync(uuid, uuid, text, jsonb) to service_role;
