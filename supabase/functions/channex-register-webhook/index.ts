// supabase/functions/channex-register-webhook/index.ts
//
// يسجّل الـ webhook فعلياً على حساب Channex عبر POST /webhooks (بدل أن
// يطلب من المالك نسخ الرابط ولصقه يدوياً في لوحة Channex) — يغطي كل
// العقارات دفعة واحدة (is_global: true). زر "إزالة الربط" يستدعيه بـ
// action: 'remove' فيحذف الـ webhook من Channex عبر DELETE /webhooks/{id}.
//
// نشره: supabase functions deploy channex-register-webhook

import { serviceClient, requireFinanceRole, jsonResponse } from '../_shared/ejar-auth.ts'
import { registerWebhook, removeWebhook, ChannexError } from '../_shared/channex-client.ts'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return jsonResponse({ ok: true })

  try {
    const { company_id, action } = await req.json()
    if (!company_id) return jsonResponse({ error: 'company_id مطلوب' }, 400)

    await requireFinanceRole(req, company_id)
    const db = serviceClient()

    const { data: settings } = await db
      .from('channel_manager_settings').select('*').eq('company_id', company_id).maybeSingle()
    const { data: secret } = await db
      .from('company_secrets').select('channex_api_key, channex_webhook_secret').eq('company_id', company_id).maybeSingle()

    const apiKey = (secret as any)?.channex_api_key
    const webhookSecret = (secret as any)?.channex_webhook_secret
    const environment = (settings?.environment as 'sandbox' | 'production') || 'sandbox'

    if (!apiKey) return jsonResponse({ error: 'احفظ مفتاح API الخاص بـ Channex أولاً' }, 400)

    if (action === 'remove') {
      if (settings?.channex_webhook_id) {
        try { await removeWebhook(environment, apiKey, settings.channex_webhook_id) } catch { /* حتى لو فشل الحذف على Channex، نمسح الربط محلياً */ }
      }
      await db.from('channel_manager_settings').update({ channex_webhook_id: null }).eq('company_id', company_id)
      return jsonResponse({ ok: true, removed: true })
    }

    if (!webhookSecret) return jsonResponse({ error: 'احفظ سر الـ webhook أولاً من "إعدادات الاتصال"' }, 400)

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const callbackUrl = `${supabaseUrl}/functions/v1/channex-webhook?company=${company_id}&secret=${webhookSecret}`

    try {
      const webhook = await registerWebhook(environment, apiKey, { callbackUrl, secretHeaderValue: webhookSecret })
      await db.from('channel_manager_settings').update({ channex_webhook_id: webhook?.id || null }).eq('company_id', company_id)
      return jsonResponse({ ok: true, webhook_id: webhook?.id })
    } catch (e) {
      const ce = e as ChannexError
      return jsonResponse({ error: ce.message || 'فشل تسجيل الـ webhook على Channex' }, 502)
    }
  } catch (e) {
    const msg = (e as Error).message
    const code = msg === 'AUTH_REQUIRED' ? 401 : msg.includes('صلاحية') ? 403 : 500
    return jsonResponse({ error: msg }, code)
  }
})
