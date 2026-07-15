// supabase/functions/channex-webhook/index.ts
//
// يستقبل إشعارات Channex الحقيقية (حجز جديد/معدَّل/ملغى) وينفّذ تلقائياً:
//   1) إنشاء/تحديث سجل حجز في bookings ببيانات العميل والوحدة.
//   2) تحديث حالة الوحدة (يتم تلقائياً عبر المُشغّل sync_unit_status
//      الموجود مسبقاً في النظام بمجرد أن يصبح status = 'confirmed' —
//      فيتحوّل لون الوحدة للبرتقالي فوراً في الواجهة دون أي كود إضافي).
//
// رابط الـ webhook المطلوب تسجيله في لوحة Channex (يُعرض جاهزاً في شاشة
// "ربط منصات الحجز" داخل النظام):
//   https://<project-ref>.functions.supabase.co/channex-webhook?company=<company_id>&secret=<webhook_secret>
//
// ⚠️ ملاحظة صادقة: شكل حمولة Channex أدناه مبني على البنية العامة
// الموثّقة (event, booking{ id, ota_name, unique_id, arrival_date,
// departure_date, status, customer{...}, rooms[...] }). راجع توثيق
// Channex الحالي في حسابكم وحدّث المسارات المُعلَّقة إن تغيّرت تسمية حقل معيّن.

import { serviceClient, jsonResponse } from '../_shared/ejar-auth.ts'
import { handleUpsert, handleCancellation, resolveEventType } from '../_shared/channex-sync.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return jsonResponse({ ok: true })

  const url = new URL(req.url)
  const companyId = url.searchParams.get('company')
  // نتحقّق أولاً من الترويسة المخصّصة (تُرسَل تلقائياً لو سُجِّل الـ webhook
  // عبر channex-register-webhook) ونعود لسر الرابط كخيار احتياطي (تسجيل يدوي)
  const secret = req.headers.get('x-channex-webhook-secret') || url.searchParams.get('secret')
  const db = serviceClient()

  let payload: any = null
  let logId: string | null = null

  try {
    payload = await req.json().catch(() => ({}))

    if (!companyId) return jsonResponse({ error: 'رابط الـ webhook ناقص: معامل company مطلوب' }, 400)

    // تحقق التوثيق: مقارنة السر المرسل في الرابط بالسر المحفوظ للمنشأة.
    // (نمط "secret في رابط الـ webhook نفسه" شائع وآمن كفاية بشرط أن يبقى
    // الرابط سرّياً — لا يُعرض إلا للمالك/المدير داخل النظام).
    const { data: secretRow } = await db
      .from('company_secrets').select('channex_webhook_secret').eq('company_id', companyId).maybeSingle()
    const expectedSecret = (secretRow as any)?.channex_webhook_secret

    // سجل الطلب فوراً قبل أي معالجة — حتى لو فشل التحقق، حتى لا يضيع أي دليل تدقيق
    const eventType = resolveEventType(payload)
    const { data: logRow } = await db.from('ota_webhook_logs').insert({
      company_id: companyId,
      provider: 'channex',
      event_type: eventType,
      external_booking_id: payload?.booking?.ota_reservation_code || payload?.booking?.unique_id || null,
      request_payload: payload,
    }).select('id').maybeSingle()
    logId = (logRow as any)?.id || null

    if (!expectedSecret || secret !== expectedSecret) {
      await markLog(db, logId, 401, false, 'فشل التحقق: السر غير مطابق')
      return jsonResponse({ error: 'توقيع الـ webhook غير صحيح' }, 401)
    }

    const { data: settings } = await db
      .from('channel_manager_settings').select('enabled').eq('company_id', companyId).maybeSingle()
    if (!settings?.enabled) {
      await markLog(db, logId, 200, false, 'الربط معطَّل حالياً من الإعدادات — تم تجاهل الحدث')
      return jsonResponse({ ok: true, ignored: true })
    }

    const booking = payload?.booking || {}

    if (eventType === 'booking_cancellation') {
      await handleCancellation(db, companyId, booking)
      await markLog(db, logId, 200, true, null)
      return jsonResponse({ ok: true })
    }

    // booking_new و booking_modification يُعالَجان بنفس منطق upsert
    await handleUpsert(db, companyId, booking)
    await markLog(db, logId, 200, true, null)
    return jsonResponse({ ok: true })
  } catch (e) {
    const err = e as any
    await markLog(db, logId, 500, false, err?.message || String(err))
    return jsonResponse({ error: 'خطأ داخلي أثناء معالجة الـ webhook' }, 500)
  }
})

async function markLog(db: any, logId: string | null, status: number, processed: boolean, error: string | null) {
  if (!logId) return
  await db.from('ota_webhook_logs').update({ http_status: status, processed, error }).eq('id', logId)
}
