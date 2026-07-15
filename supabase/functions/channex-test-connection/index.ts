// supabase/functions/channex-test-connection/index.ts
//
// اختبار اتصال حقيقي بحساب Channex الخاص بالمنشأة: يتحقق من وجود مفتاح
// API محفوظ، ثم يستدعي فعلياً GET /properties (نقطة نهاية Channex الرسمية)
// ويحدّث حالة الاتصال المخزّنة. نشره: supabase functions deploy channex-test-connection

import { serviceClient, requireFinanceRole, jsonResponse } from '../_shared/ejar-auth.ts'
import { listProperties, ChannexError } from '../_shared/channex-client.ts'

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
    const environment = (settings?.environment as 'sandbox' | 'production') || 'sandbox'

    if (!apiKey) {
      return jsonResponse({
        ok: false,
        stage: 'missing_api_key',
        message: 'لم يُحفظ مفتاح API الخاص بـ Channex بعد. أدخله أولاً من تبويب "إعدادات الاتصال".',
      })
    }

    let properties: any[] = []
    let stage = 'connected'
    let errorMessage: string | null = null

    try {
      properties = await listProperties(environment, apiKey)
    } catch (e) {
      const ce = e as ChannexError
      stage = 'error'
      errorMessage = ce.message
    }

    const ok = stage === 'connected'

    await db.from('channel_manager_settings').upsert({
      company_id,
      provider: 'channex',
      environment,
      enabled: settings?.enabled ?? false,
      connection_status: ok ? 'connected' : 'error',
      last_tested_at: new Date().toISOString(),
      last_error: errorMessage,
    }, { onConflict: 'company_id' })

    return jsonResponse({
      ok,
      stage,
      message: ok
        ? `تم الاتصال بنجاح — عدد العقارات المسجّلة على حسابكم في Channex: ${properties.length}`
        : errorMessage,
      properties_count: properties.length,
      properties: properties.slice(0, 20).map((p: any) => ({ id: p.id, title: p?.attributes?.title || p?.attributes?.name })),
      environment,
    })
  } catch (e) {
    const msg = (e as Error).message
    const code = msg === 'AUTH_REQUIRED' ? 401 : msg.includes('صلاحية') ? 403 : 500
    return jsonResponse({ error: msg }, code)
  }
})
