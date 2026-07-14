// supabase/functions/ejar-submit-contract/index.ts
//
// يُستدعى من الواجهة عبر: supabase.functions.invoke('ejar-submit-contract', { body: { booking_id } })
// نشره: supabase functions deploy ejar-submit-contract
//
// ⚠️ ملاحظة صادقة ومهمة قبل التفعيل الفعلي:
// التكامل مع منصة إيجار عملية شراكة رسمية مع الهيئة العامة للعقار
// (اسمها الرسمي: "التكامل الرقمي بين شبكة إيجار ومنصات التسويق العقاري")
// وليست واجهة برمجية عامة موثّقة للعموم. قبل هذه الشراكة لا يوجد عنوان
// REST رسمي يمكن الوثوق به. لذلك فإن EJAR_API_BASE أدناه هو قيمة
// Placeholder صراحة — استبدلها بالعنوان الرسمي فور استلامه من إيجار.
// بقية هذا الملف (التحقق من الصلاحيات، تجميع بيانات العقد من قاعدة
// البيانات، التحقق من اكتمالها، تحديث حالة التوثيق، معالجة الأخطاء)
// هو تكامل حقيقي وكامل وجاهز للعمل فور توفر تلك النقطة الرسمية.

import { serviceClient, requireFinanceRole, jsonResponse } from '../_shared/ejar-auth.ts'

const EJAR_API_BASE = {
  // Placeholder — يُستبدل بالعنوان الرسمي الذي يزوّدكم به فريق التكامل في إيجار
  sandbox: 'https://REPLACE-WITH-EJAR-SANDBOX-ENDPOINT.example/v1',
  production: 'https://REPLACE-WITH-EJAR-PRODUCTION-ENDPOINT.example/v1',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return jsonResponse({ ok: true })

  try {
    const { booking_id } = await req.json()
    if (!booking_id) return jsonResponse({ error: 'booking_id مطلوب' }, 400)

    const db = serviceClient()

    // 1) جلب بيانات الحجز الكاملة من قاعدة البيانات (لا نثق بأي بيانات
    //    مالية أو تعاقدية قادمة من المتصفح مباشرة)
    const { data: booking, error: bErr } = await db
      .from('bookings')
      .select(`
        id, company_id, unit_id, customer_id, check_in_date, check_out_date,
        total_amount, down_payment, insurance_amount, ejar_status,
        units ( unit_number, deed_number, category ),
        customers ( full_name, id_type, id_number, phone ),
        companies ( name, cr_number, ejar_enabled, ejar_environment, ejar_broker_license )
      `)
      .eq('id', booking_id).maybeSingle()

    if (bErr || !booking) return jsonResponse({ error: 'الحجز غير موجود' }, 404)

    // 2) التحقق من الصلاحية (owner/manager/accountant لنفس الشركة)
    await requireFinanceRole(req, booking.company_id)

    const company = booking.companies as any
    const unit = booking.units as any
    const customer = booking.customers as any

    // مفتاح إيجار السرّي يُقرأ من جدول company_secrets المعزول (service_role يتجاوز RLS)
    const { data: secret } = await db
      .from('company_secrets').select('ejar_api_key').eq('company_id', booking.company_id).maybeSingle()
    const ejarApiKey = (secret as any)?.ejar_api_key

    if (!company?.ejar_enabled) {
      return jsonResponse({ error: 'الربط مع إيجار غير مُفعّل في الإعدادات' }, 400)
    }
    if (!ejarApiKey) {
      return jsonResponse({ error: 'لم يُدخَل مفتاح API الخاص بإيجار بعد' }, 400)
    }

    // 3) التحقق من اكتمال الحقول المطلوبة لتوثيق عقد حقيقي
    const missing: string[] = []
    if (!company.ejar_broker_license && !company.cr_number) missing.push('رقم رخصة الوساطة أو السجل التجاري')
    if (!unit?.deed_number) missing.push('رقم الصك العقاري للوحدة')
    if (!customer?.id_number) missing.push('رقم هوية المستأجر')
    if (!customer?.phone) missing.push('جوال المستأجر')
    if (missing.length) {
      return jsonResponse({ error: 'بيانات ناقصة: ' + missing.join('، ') }, 400)
    }

    // 4) بناء طلب التسجيل (شكل الحقول يُضبط لاحقاً حسب التوثيق الرسمي
    //    الذي يستلمه فريقكم من إيجار — هذا التمثيل مبني على "رحلة تسجيل
    //    العقود" المُعلنة رسمياً: بيانات العقار/الوحدة، طرفا العقد، والمدة)
    const payload = {
      landlord: {
        name: company.name,
        commercial_registration: company.cr_number || null,
        broker_license: company.ejar_broker_license || null,
      },
      property: {
        deed_number: unit.deed_number,
        unit_number: unit.unit_number,
        category: unit.category,
      },
      tenant: {
        full_name: customer.full_name,
        id_type: customer.id_type,
        id_number: customer.id_number,
        phone: customer.phone,
      },
      contract: {
        start_date: booking.check_in_date,
        end_date: booking.check_out_date,
        annual_or_total_value: booking.total_amount,
        deposit: booking.down_payment,
      },
    }

    await db.from('bookings').update({ ejar_payload: payload, ejar_submitted_at: new Date().toISOString() }).eq('id', booking.id)

    // 5) الاستدعاء الفعلي لإيجار — placeholder حتى استلام العنوان الرسمي
    const base = EJAR_API_BASE[company.ejar_environment as 'sandbox' | 'production'] || EJAR_API_BASE.sandbox
    let ejarResult: any = null
    let ejarError: string | null = null

    try {
      const resp = await fetch(`${base}/contracts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ejarApiKey}`,
        },
        body: JSON.stringify(payload),
      })
      ejarResult = await resp.json().catch(() => ({}))
      if (!resp.ok) ejarError = ejarResult?.message || `فشل الاتصال بإيجار (HTTP ${resp.status})`
    } catch (netErr) {
      ejarError = 'تعذّر الوصول لمنصة إيجار — تأكد من ضبط العنوان الرسمي في الكود بعد استكمال الشراكة: ' + (netErr as Error).message
    }

    if (ejarError) {
      await db.from('bookings').update({ ejar_error: ejarError, ejar_response: ejarResult }).eq('id', booking.id)
      return jsonResponse({ error: ejarError }, 502)
    }

    // وفق التوثيق الرسمي المُعلن: الإرسال لا يعني التوثيق الفوري، بل
    // يدخل العقد حالة انتظار موافقة الأطراف عبر قنوات إيجار الخاصة
    await db.from('bookings').update({
      ejar_status: 'pending_tenant',
      ejar_contract_number: ejarResult?.contract_number || null,
      ejar_response: ejarResult,
      ejar_error: null,
    }).eq('id', booking.id)

    return jsonResponse({ ok: true, status: 'pending_tenant', ejar_response: ejarResult })
  } catch (e) {
    const msg = (e as Error).message
    const code = msg === 'AUTH_REQUIRED' ? 401 : msg.includes('صلاحية') ? 403 : 500
    return jsonResponse({ error: msg }, code)
  }
})
