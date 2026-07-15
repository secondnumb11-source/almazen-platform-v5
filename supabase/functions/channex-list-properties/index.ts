// supabase/functions/channex-list-properties/index.ts
//
// يغذّي شاشة "ربط الوحدات" بقوائم حقيقية من حساب Channex بدل أن يكتب
// المالك مُعرّفات IDs يدوياً: يرجع العقارات، أو أنواع الغرف وخطط الأسعار
// لعقار معيّن. نشره: supabase functions deploy channex-list-properties

import { serviceClient, requireFinanceRole, jsonResponse } from '../_shared/ejar-auth.ts'
import { listProperties, listRoomTypes, listRatePlans, ChannexError } from '../_shared/channex-client.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return jsonResponse({ ok: true })

  try {
    const { company_id, property_id } = await req.json()
    if (!company_id) return jsonResponse({ error: 'company_id مطلوب' }, 400)

    await requireFinanceRole(req, company_id)
    const db = serviceClient()

    const { data: settings } = await db
      .from('channel_manager_settings').select('environment').eq('company_id', company_id).maybeSingle()
    const { data: secret } = await db
      .from('company_secrets').select('channex_api_key').eq('company_id', company_id).maybeSingle()
    const apiKey = (secret as any)?.channex_api_key
    const environment = (settings?.environment as 'sandbox' | 'production') || 'sandbox'

    if (!apiKey) return jsonResponse({ error: 'احفظ مفتاح API الخاص بـ Channex أولاً' }, 400)

    try {
      if (property_id) {
        const [roomTypes, ratePlans] = await Promise.all([
          listRoomTypes(environment, apiKey, property_id),
          listRatePlans(environment, apiKey, property_id),
        ])
        return jsonResponse({
          ok: true,
          room_types: roomTypes.map((r: any) => ({ id: r.id, title: r?.attributes?.title || r?.attributes?.name })),
          rate_plans: ratePlans.map((r: any) => ({ id: r.id, title: r?.attributes?.title || r?.attributes?.name })),
        })
      }

      const properties = await listProperties(environment, apiKey)
      return jsonResponse({
        ok: true,
        properties: properties.map((p: any) => ({ id: p.id, title: p?.attributes?.title || p?.attributes?.name })),
      })
    } catch (e) {
      const ce = e as ChannexError
      return jsonResponse({ error: ce.message || 'تعذّر جلب البيانات من Channex' }, 502)
    }
  } catch (e) {
    const msg = (e as Error).message
    const code = msg === 'AUTH_REQUIRED' ? 401 : msg.includes('صلاحية') ? 403 : 500
    return jsonResponse({ error: msg }, code)
  }
})
