// supabase/functions/channex-process-queue/index.ts
//
// يستهلك طابور ota_sync_queue (BACKGROUND JOBS): يدفع الأسعار والإتاحة
// فعلياً إلى Channex عبر endpoint /restrictions الرسمي، ويكتشف الحجوزات
// المفقودة (Detect Missing Reservations). يُستدعى إما يدوياً بزر "مزامنة
// الآن" من لوحة المالك، أو دورياً عبر Supabase Cron / استدعاء خارجي مجدوَل
// (راجع تعليق الجدولة أسفل الملف).
//
// نشره: supabase functions deploy channex-process-queue

import { serviceClient, requireFinanceRole, jsonResponse } from '../_shared/ejar-auth.ts'
import { pushRestrictions, listBookings, ChannexError, type ChannexEnv } from '../_shared/channex-client.ts'
import { handleUpsert } from '../_shared/channex-sync.ts'

const MAX_ATTEMPTS = 5
const BATCH_SIZE = 20

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return jsonResponse({ ok: true })

  try {
    const { company_id } = await req.json()
    if (!company_id) return jsonResponse({ error: 'company_id مطلوب' }, 400)

    await requireFinanceRole(req, company_id)
    const db = serviceClient()

    const { data: settings } = await db
      .from('channel_manager_settings').select('*').eq('company_id', company_id).maybeSingle()
    const { data: secret } = await db
      .from('company_secrets').select('channex_api_key').eq('company_id', company_id).maybeSingle()
    const apiKey = (secret as any)?.channex_api_key
    const environment: ChannexEnv = (settings?.environment as ChannexEnv) || 'sandbox'

    if (!settings?.enabled) return jsonResponse({ error: 'الربط مع Channex غير مفعّل من الإعدادات' }, 400)
    if (!apiKey) return jsonResponse({ error: 'لم يُحفظ مفتاح API الخاص بـ Channex بعد' }, 400)

    const { data: jobs } = await db
      .from('ota_sync_queue').select('*')
      .eq('company_id', company_id)
      .in('status', ['pending', 'failed'])
      .lt('attempts', MAX_ATTEMPTS)
      .order('created_at', { ascending: true })
      .limit(BATCH_SIZE)

    let done = 0, failed = 0
    const errors: string[] = []

    for (const job of jobs || []) {
      await db.from('ota_sync_queue').update({ status: 'processing', attempts: job.attempts + 1 }).eq('id', job.id)
      try {
        if (job.job_type === 'push_price') await processPushPrice(db, environment, apiKey, job)
        else if (job.job_type === 'push_availability') await processPushAvailability(db, environment, apiKey, job)
        else if (job.job_type === 'pull_reservations') await processPullReservations(db, company_id, environment, apiKey, job)
        else throw new Error('نوع مهمة غير مدعوم: ' + job.job_type)

        await db.from('ota_sync_queue').update({ status: 'done', processed_at: new Date().toISOString(), last_error: null }).eq('id', job.id)
        done++
      } catch (e) {
        const msg = (e as Error).message
        await db.from('ota_sync_queue').update({ status: 'failed', last_error: msg }).eq('id', job.id)
        failed++
        errors.push(msg)
      }
    }

    await db.from('channel_manager_settings').update({
      last_sync_at: new Date().toISOString(),
      last_error: errors[0] || null,
    }).eq('company_id', company_id)

    return jsonResponse({ ok: true, processed: (jobs || []).length, done, failed, errors })
  } catch (e) {
    const msg = (e as Error).message
    const code = msg === 'AUTH_REQUIRED' ? 401 : msg.includes('صلاحية') ? 403 : 500
    return jsonResponse({ error: msg }, code)
  }
})

async function processPushPrice(db: any, environment: ChannexEnv, apiKey: string, job: any) {
  const { data: unit } = await db
    .from('units').select('channex_property_id, channex_room_type_id, channex_rate_plan_id')
    .eq('id', job.unit_id).maybeSingle()
  if (!unit?.channex_property_id || !unit?.channex_room_type_id || !unit?.channex_rate_plan_id) {
    throw new Error('الوحدة غير مربوطة بالكامل بـ Channex (عقار/نوع غرفة/خطة سعر)')
  }
  const rate = Number(job.payload?.daily_price)
  if (!rate || rate <= 0) throw new Error('سعر غير صالح للدفع إلى Channex')

  const dateFrom = new Date().toISOString().slice(0, 10)
  const dateTo = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10)

  try {
    await pushRestrictions(environment, apiKey, [{
      property_id: unit.channex_property_id,
      room_type_id: unit.channex_room_type_id,
      rate_plan_id: unit.channex_rate_plan_id,
      date_from: dateFrom,
      date_to: dateTo,
      rate,
    }])
  } catch (e) {
    throw new Error((e as ChannexError).message || 'فشل دفع السعر إلى Channex')
  }
}

async function processPushAvailability(db: any, environment: ChannexEnv, apiKey: string, job: any) {
  const { data: unit } = await db
    .from('units').select('channex_property_id, channex_room_type_id, channex_rate_plan_id')
    .eq('id', job.unit_id).maybeSingle()
  if (!unit?.channex_property_id || !unit?.channex_room_type_id) {
    throw new Error('الوحدة غير مربوطة بالكامل بـ Channex (عقار/نوع غرفة)')
  }
  const status = job.payload?.status
  const blocked = ['confirmed', 'checked_in'].includes(status)
  const checkIn = job.payload?.check_in
  const checkOut = job.payload?.check_out
  if (!checkIn || !checkOut) throw new Error('تواريخ الحجز مفقودة من مهمة المزامنة')

  try {
    await pushRestrictions(environment, apiKey, [{
      property_id: unit.channex_property_id,
      room_type_id: unit.channex_room_type_id,
      rate_plan_id: unit.channex_rate_plan_id || undefined,
      date_from: checkIn,
      date_to: checkOut,
      availability: blocked ? 0 : 1,
      stop_sell: blocked,
    }])
  } catch (e) {
    throw new Error((e as ChannexError).message || 'فشل دفع تحديث الإتاحة إلى Channex')
  }
}

// اكتشاف الحجوزات المفقودة: يجلب حجوزات Channex الحديثة لكل عقار مرتبط
// ويُنشئ محلياً أي حجز لم يصلنا الـ webhook الخاص به (شبكة غير مستقرة، إلخ)
async function processPullReservations(db: any, companyId: string, environment: ChannexEnv, apiKey: string, job: any) {
  const { data: units } = await db
    .from('units').select('channex_property_id')
    .eq('company_id', companyId).eq('ota_sync_enabled', true).not('channex_property_id', 'is', null)
  const propertyIds = [...new Set((units || []).map((u: any) => u.channex_property_id))]

  const since = job.payload?.updated_since || new Date(Date.now() - 7 * 86400000).toISOString()
  let created = 0
  for (const propertyId of propertyIds) {
    let remote: any[] = []
    try {
      remote = await listBookings(environment, apiKey, propertyId as string, since)
    } catch (e) {
      throw new Error((e as ChannexError).message || 'فشل جلب حجوزات Channex')
    }
    for (const r of remote) {
      const channelBookingId = String(r.id)
      const { data: exists } = await db
        .from('bookings').select('id').eq('company_id', companyId).eq('ota_channel_booking_id', channelBookingId).maybeSingle()
      if (exists) continue
      try {
        await handleUpsert(db, companyId, { id: r.id, ...(r.attributes || {}) })
        created++
      } catch {
        // يُترك للمالك لمراجعته يدوياً من سجل المزامنة — لا نُفشل كل الدفعة لأجل حجز واحد متعارض
      }
    }
  }
  if (created === 0 && propertyIds.length === 0) {
    throw new Error('لا توجد وحدات مفعّلة المزامنة مع Channex بعد')
  }
}

/*
  الجدولة الدورية: هذا النظام لا يفترض توفر pg_cron/pg_net (غير مُفعّلين
  حالياً في هذا المشروع). لتشغيل هذه الدالة تلقائياً كل عدة دقائق دون
  الاعتماد على ضغط المالك لزر "مزامنة الآن" يدوياً، اختر أحد الخيارين:
    1) فعّل Supabase Cron (pg_cron) من لوحة المشروع وأضف جدولة تستدعي
       هذه الدالة عبر HTTP لكل شركة مفعَّلة.
    2) اربط أي مجدوِل خارجي (GitHub Actions cron, cron-job.org, ...)
       يستدعي هذا الـ endpoint بنفس ترويسة Authorization لكل شركة.
*/
