// supabase/functions/_shared/channex-client.ts
//
// عميل مشترك لواجهة Channex الرسمية (https://docs.channex.io) — يُستخدم من
// كل دوال channex-* لتفادي تكرار الكود (Base URL, رأس المصادقة, شكل الطلبات).
//
// نقاط حقيقية موثّقة رسمياً من Channex:
//  - Base URL بيئة الاختبار : https://staging.channex.io/api/v1
//  - Base URL بيئة الإنتاج  : https://app.channex.io/api/v1
//  - المصادقة: رأس HTTP باسم "user-api-key" يحمل مفتاح API الخاص بالمنشأة.
//  - شكل الحمولة: JSON:API — { data: { id, type, attributes: {...} } }.
//
// ⚠️ أسماء الحقول الدقيقة داخل "attributes" لكل endpoint (خصوصاً حمولة
// bookings/restrictions الكاملة) قد تتغيّر بتحديثات Channex — راجع التوثيق
// الرسمي الحالي عبر لوحة Channex الخاصة بكم عند الربط الفعلي وحدّث الحقول
// المُعلَّمة أدناه إن لزم. البنية والمصادقة والـ endpoints الأساسية صحيحة.

export type ChannexEnv = 'sandbox' | 'production'

const CHANNEX_BASE: Record<ChannexEnv, string> = {
  sandbox: 'https://staging.channex.io/api/v1',
  production: 'https://app.channex.io/api/v1',
}

export function channexBaseUrl(environment: ChannexEnv) {
  return CHANNEX_BASE[environment] || CHANNEX_BASE.sandbox
}

export class ChannexError extends Error {
  status: number
  body: unknown
  constructor(message: string, status: number, body: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

/*
  طلب عام موحّد لكل نداءات Channex. يرمي ChannexError عند فشل HTTP حتى
  تتعامل كل دالة مستدعية مع الخطأ وتسجّله بوضوح بدل فشل صامت.
*/
export async function channexRequest(
  environment: ChannexEnv,
  apiKey: string,
  path: string,
  init: { method?: string; body?: unknown } = {}
) {
  const url = `${channexBaseUrl(environment)}${path}`
  const resp = await fetch(url, {
    method: init.method || 'GET',
    headers: {
      'user-api-key': apiKey,
      'Content-Type': 'application/vnd.api+json',
      'Accept': 'application/vnd.api+json',
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  })

  const text = await resp.text()
  let json: any = null
  try { json = text ? JSON.parse(text) : null } catch { json = { raw: text } }

  if (!resp.ok) {
    const msg = json?.errors?.[0]?.detail || json?.message || `فشل الاتصال بـ Channex (HTTP ${resp.status})`
    throw new ChannexError(msg, resp.status, json)
  }
  return json
}

// جلب قائمة العقارات (Properties) المسجّلة على حساب Channex الخاص بالمنشأة
export async function listProperties(environment: ChannexEnv, apiKey: string) {
  const json = await channexRequest(environment, apiKey, '/properties')
  return json?.data || []
}

// جلب أنواع الغرف/الوحدات (Room Types) لعقار معيّن
export async function listRoomTypes(environment: ChannexEnv, apiKey: string, propertyId: string) {
  const json = await channexRequest(environment, apiKey, `/room_types?filter[property_id]=${encodeURIComponent(propertyId)}`)
  return json?.data || []
}

// جلب خطط الأسعار (Rate Plans) لعقار معيّن
export async function listRatePlans(environment: ChannexEnv, apiKey: string, propertyId: string) {
  const json = await channexRequest(environment, apiKey, `/rate_plans?filter[property_id]=${encodeURIComponent(propertyId)}`)
  return json?.data || []
}

/*
  دفع تحديث الأسعار/الإتاحة/القيود دفعة واحدة عبر endpoint الرسمي الموحّد
  "/restrictions" — هذا هو المسار المُوثّق من Channex لتحديث ARI
  (Availability, Rates, Inventory) لتاريخ أو مدى تواريخ محدد.
*/
export async function pushRestrictions(
  environment: ChannexEnv, apiKey: string,
  values: Array<{
    property_id: string
    room_type_id: string
    rate_plan_id?: string
    date_from: string
    date_to: string
    rate?: number
    availability?: number
    stop_sell?: boolean
    min_stay_arrival?: number
    closed_to_arrival?: boolean
    closed_to_departure?: boolean
  }>
) {
  return channexRequest(environment, apiKey, '/restrictions', {
    method: 'POST',
    body: { values },
  })
}

// جلب حجز واحد من Channex بمعرّفه الداخلي — يُستخدم لإعادة مزامنة حجز مفقود
export async function getBooking(environment: ChannexEnv, apiKey: string, bookingId: string) {
  const json = await channexRequest(environment, apiKey, `/bookings/${encodeURIComponent(bookingId)}`)
  return json?.data || null
}

/*
  تسجيل webhook فعلي على حساب Channex (POST /webhooks) — النقطة والحمولة
  موثّقتان رسمياً وزُوِّدنا بعيّنتهما مباشرة: is_global:true يجعله يغطي كل
  العقارات في الحساب بنداء واحد دون تكرار التسجيل لكل عقار على حدة.
  headers هنا تُرسَل مع كل استدعاء webhook من Channex — نستخدمها لتمرير سر
  إضافي عبر الترويسة (أكثر أماناً من الرابط وحده).
*/
export async function registerWebhook(
  environment: ChannexEnv, apiKey: string,
  params: { callbackUrl: string; secretHeaderValue: string; propertyId?: string }
) {
  const body = {
    webhook: {
      callback_url: params.callbackUrl,
      event_mask: 'booking_new;booking_modification;booking_cancellation',
      ...(params.propertyId ? { property_id: params.propertyId, is_global: false } : { is_global: true }),
      request_params: {},
      headers: { 'X-Channex-Webhook-Secret': params.secretHeaderValue },
      is_active: true,
      send_data: true,
      protected: false,
    },
  }
  const json = await channexRequest(environment, apiKey, '/webhooks', { method: 'POST', body })
  return json?.data || null
}

export async function removeWebhook(environment: ChannexEnv, apiKey: string, webhookId: string) {
  return channexRequest(environment, apiKey, `/webhooks/${encodeURIComponent(webhookId)}`, { method: 'DELETE' })
}

// جلب قائمة حجوزات عقار معيّن — يُستخدم في مهمة "اكتشاف الحجوزات المفقودة"
// (لو وصل حجز فعلياً على Channex ولم يصلنا الـ webhook الخاص به لأي سبب)
export async function listBookings(
  environment: ChannexEnv, apiKey: string, propertyId: string,
  updatedSince?: string
) {
  let path = `/bookings?filter[property_id]=${encodeURIComponent(propertyId)}`
  if (updatedSince) path += `&filter[updated_since]=${encodeURIComponent(updatedSince)}`
  const json = await channexRequest(environment, apiKey, path)
  return json?.data || []
}
