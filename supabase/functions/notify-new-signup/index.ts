// notify-new-signup — إشعار صاحب النظام بأي تسجيل جديد أو إيصال دفع
// يُستدعى من الواجهة عبر supabase.functions.invoke
// يستخدم Resend عبر RESEND_API_KEY (نفس ما تستخدمه send-email)

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const ADMIN_EMAIL = 'shadyabdelwahab99@gmail.com'
const FROM = Deno.env.get('EMAIL_FROM') ?? 'المازن <onboarding@resend.dev>'

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  try {
    const apiKey = Deno.env.get('RESEND_API_KEY')
    if (!apiKey) return json({ error: 'RESEND_API_KEY missing' }, 500)

    const body = await req.json().catch(() => ({}))
    const kind = body.kind || 'new_signup'

    let subject = ''
    let html = ''
    if (kind === 'payment_receipt') {
      subject = `💰 إيصال دفع جديد — ${body.company_name || 'منشأة'}`
      html = `
        <div style="font-family:Tahoma,Arial;direction:rtl;line-height:1.8">
          <h2>إيصال دفع جديد لتفعيل اشتراك</h2>
          <p><b>المنشأة:</b> ${escape(body.company_name)}</p>
          <p><b>معرّف المنشأة:</b> <code>${escape(body.company_id)}</code></p>
          <p><b>المبلغ:</b> ${escape(body.amount)} ر.س</p>
          <p><b>المرجع:</b> ${escape(body.reference)}</p>
          <p><b>ملاحظات:</b> ${escape(body.notes || '—')}</p>
          <p><b>مسار الإيصال:</b> <code>${escape(body.receipt_path)}</code></p>
          <hr/>
          <p>لتفعيل الاشتراك يدوياً نفّذ في SQL Editor:</p>
          <pre>select public.admin_activate_subscription('${escape(body.company_id)}', 12);</pre>
        </div>`
    } else {
      subject = `🆕 تسجيل جديد على المازن — ${body.company_name || 'منشأة جديدة'}`
      html = `
        <div style="font-family:Tahoma,Arial;direction:rtl;line-height:1.8">
          <h2>تسجيل عميل جديد لفترة التجربة (7 أيام)</h2>
          <p><b>اسم العميل:</b> ${escape(body.full_name)}</p>
          <p><b>اسم المنشأة:</b> ${escape(body.company_name)}</p>
          <p><b>السجل التجاري / الهوية:</b> ${escape(body.id_or_cr)}</p>
          <p><b>الجوال:</b> ${escape(body.phone)}</p>
          <p><b>البريد الإلكتروني:</b> ${escape(body.email)}</p>
          <p><b>وقت التسجيل:</b> ${new Date().toLocaleString('ar-SA')}</p>
        </div>`
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [ADMIN_EMAIL], subject, html }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return json({ error: data?.message || 'send failed', details: data }, res.status)
    return json({ ok: true, id: data?.id })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})

function escape(v: unknown) {
  return String(v ?? '').replace(/[<>&"']/g, (c) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}
function json(p: unknown, status = 200) {
  return new Response(JSON.stringify(p), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}
