// supabase/functions/ejar-test-connection/index.ts
//
// اختبار اتصال بمنصة إيجار: يتحقق من وجود مفتاح API محفوظ للشركة،
// ثم يجرّب ping على نقطة نهاية إيجار الرسمية (Placeholder) ويعيد النتيجة.
// نشره: supabase functions deploy ejar-test-connection

import { serviceClient, requireFinanceRole, jsonResponse } from '../_shared/ejar-auth.ts'

const EJAR_API_BASE = {
  sandbox: 'https://REPLACE-WITH-EJAR-SANDBOX-ENDPOINT.example/v1',
  production: 'https://REPLACE-WITH-EJAR-PRODUCTION-ENDPOINT.example/v1',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return jsonResponse({ ok: true })

  try {
    const { company_id, sample_unit_id } = await req.json()
    if (!company_id) return jsonResponse({ error: 'company_id مطلوب' }, 400)

    await requireFinanceRole(req, company_id)
    const db = serviceClient()

    const { data: company } = await db
      .from('companies').select('id, name, ejar_environment, ejar_enabled, ejar_broker_license, vat_number, cr_number')
      .eq('id', company_id).maybeSingle()
    if (!company) return jsonResponse({ error: 'الشركة غير موجودة' }, 404)

    const { data: secret } = await db
      .from('company_secrets').select('ejar_api_key').eq('company_id', company_id).maybeSingle()
    const apiKey = (secret as any)?.ejar_api_key
    if (!apiKey) {
      return jsonResponse({
        ok: false,
        stage: 'missing_api_key',
        message: 'لا يوجد مفتاح API محفوظ للشركة. احفظه أولاً من شاشة "إعدادات الربط".',
        company: { name: company.name, environment: company.ejar_environment },
      })
    }

    // جلب عيّنة وحدة (تسهيلاً للتحقق من جاهزية البيانات المطلوبة لإيجار)
    let sample: any = null
    if (sample_unit_id) {
      const { data: u } = await db
        .from('units').select('id, unit_number, deed_number, category, city, district, address_line')
        .eq('id', sample_unit_id).eq('company_id', company_id).maybeSingle()
      sample = u
    }

    // ping فعلي لنقطة إيجار — سيفشل حالياً حتى إعداد الاتفاقية الرسمية
    const base = EJAR_API_BASE[company.ejar_environment as 'sandbox' | 'production'] || EJAR_API_BASE.sandbox
    let httpStatus = 0
    let httpBody: any = null
    let networkError: string | null = null
    try {
      const resp = await fetch(`${base}/ping`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json',
        },
      })
      httpStatus = resp.status
      httpBody = await resp.json().catch(() => ({}))
    } catch (e) {
      networkError = (e as Error).message
    }

    const reachable = httpStatus >= 200 && httpStatus < 300
    return jsonResponse({
      ok: reachable,
      stage: reachable ? 'connected' : (networkError ? 'network_error' : 'http_error'),
      http_status: httpStatus,
      response: httpBody,
      network_error: networkError,
      company: {
        name: company.name,
        environment: company.ejar_environment,
        enabled: company.ejar_enabled,
        broker_license: company.ejar_broker_license,
        vat_number: company.vat_number,
        cr_number: company.cr_number,
      },
      sample_unit: sample,
      note: reachable
        ? 'تم الاتصال بنجاح بمنصة إيجار.'
        : 'لم يُستكمل الاتصال. إذا لم تكن نقطة النهاية الرسمية لإيجار مُعدّة بعد ضمن اتفاقية التكامل الرقمي، هذا متوقع.',
    })
  } catch (e) {
    const msg = (e as Error).message
    const code = msg === 'AUTH_REQUIRED' ? 401 : msg.includes('صلاحية') ? 403 : 500
    return jsonResponse({ error: msg }, code)
  }
})
