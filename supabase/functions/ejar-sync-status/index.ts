// supabase/functions/ejar-sync-status/index.ts
//
// يُستدعى من الواجهة عبر: supabase.functions.invoke('ejar-sync-status', { body: { booking_id } })
// نشره: supabase functions deploy ejar-sync-status
// نفس ملاحظة نقطة النهاية Placeholder الموجودة في ejar-submit-contract.

import { serviceClient, requireFinanceRole, jsonResponse } from '../_shared/ejar-auth.ts'

const EJAR_API_BASE = {
  sandbox: 'https://REPLACE-WITH-EJAR-SANDBOX-ENDPOINT.example/v1',
  production: 'https://REPLACE-WITH-EJAR-PRODUCTION-ENDPOINT.example/v1',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return jsonResponse({ ok: true })

  try {
    const { booking_id } = await req.json()
    if (!booking_id) return jsonResponse({ error: 'booking_id مطلوب' }, 400)

    const db = serviceClient()
    const { data: booking, error: bErr } = await db
      .from('bookings')
      .select('id, company_id, ejar_status, ejar_contract_number, companies ( ejar_environment )')
      .eq('id', booking_id).maybeSingle()
    if (bErr || !booking) return jsonResponse({ error: 'الحجز غير موجود' }, 404)

    await requireFinanceRole(req, booking.company_id)

    if (!booking.ejar_contract_number) {
      return jsonResponse({ error: 'لم يُرسل هذا العقد لإيجار بعد' }, 400)
    }

    const company = booking.companies as any
    // مفتاح إيجار السرّي يُقرأ من جدول company_secrets المعزول (service_role يتجاوز RLS)
    const { data: secret } = await db
      .from('company_secrets').select('ejar_api_key').eq('company_id', booking.company_id).maybeSingle()
    const ejarApiKey = (secret as any)?.ejar_api_key
    const base = EJAR_API_BASE[company.ejar_environment as 'sandbox' | 'production'] || EJAR_API_BASE.sandbox

    let result: any = null
    try {
      const resp = await fetch(`${base}/contracts/${booking.ejar_contract_number}`, {
        headers: { 'Authorization': `Bearer ${ejarApiKey}` },
      })
      result = await resp.json().catch(() => ({}))
      if (!resp.ok) throw new Error(result?.message || `HTTP ${resp.status}`)
    } catch (netErr) {
      await db.from('bookings').update({ ejar_error: (netErr as Error).message }).eq('id', booking.id)
      return jsonResponse({ error: (netErr as Error).message }, 502)
    }

    // يُعدَّل مطابقاً لأسماء الحالات الحقيقية في استجابة إيجار الرسمية
    const mappedStatus = result?.status || booking.ejar_status
    await db.from('bookings').update({
      ejar_status: mappedStatus,
      ejar_registered_at: mappedStatus === 'registered' ? new Date().toISOString() : null,
      ejar_last_synced_at: new Date().toISOString(),
      ejar_response: result,
      ejar_error: null,
    }).eq('id', booking.id)

    return jsonResponse({ ok: true, status: mappedStatus })
  } catch (e) {
    const msg = (e as Error).message
    const code = msg === 'AUTH_REQUIRED' ? 401 : msg.includes('صلاحية') ? 403 : 500
    return jsonResponse({ error: msg }, code)
  }
})
