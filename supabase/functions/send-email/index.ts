// Edge Function: send-email
// إرسال إيميلات عبر Resend API. يستخدم متغير البيئة RESEND_API_KEY المخزّن
// في Supabase → Project Settings → Edge Functions → Secrets.
//
// طريقة الاستدعاء من الواجهة:
//   const { data, error } = await supabase.functions.invoke('send-email', {
//     body: { to: 'a@b.com', subject: 'مرحباً', html: '<p>محتوى</p>' }
//   })

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const FROM_DEFAULT = Deno.env.get('EMAIL_FROM') ?? 'المازن <onboarding@resend.dev>'

interface Payload {
  to: string | string[]
  subject: string
  html?: string
  text?: string
  from?: string
  reply_to?: string
}

// التحقق من هوية المستدعي: لا يُسمح بإرسال أي بريد إلا لمستخدم مسجّل دخول
// (توكن Supabase Auth صالح). يمنع إساءة استخدام مفتاح Resend للتصيّد/السبام.
async function requireAuth(req: Request): Promise<boolean> {
  const authHeader = req.headers.get('Authorization') || ''
  const token = authHeader.replace('Bearer ', '')
  if (!token) return false
  try {
    const client = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    )
    const { data, error } = await client.auth.getUser(token)
    return !error && !!data?.user
  } catch {
    return false
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    if (!(await requireAuth(req))) {
      return json({ error: 'غير مصرّح — يجب تسجيل الدخول' }, 401)
    }

    const apiKey = Deno.env.get('RESEND_API_KEY')
    if (!apiKey) {
      return json({ error: 'RESEND_API_KEY غير مضبوط في Edge Function Secrets' }, 500)
    }

    const body = (await req.json().catch(() => null)) as Payload | null
    if (!body || !body.to || !body.subject || (!body.html && !body.text)) {
      return json({ error: 'المطلوب: to + subject + html أو text' }, 400)
    }

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: body.from ?? FROM_DEFAULT,
        to: Array.isArray(body.to) ? body.to : [body.to],
        subject: body.subject,
        html: body.html,
        text: body.text,
        reply_to: body.reply_to,
      }),
    })

    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      console.error('Resend error', res.status, data)
      return json({ error: data?.message || 'فشل إرسال البريد', status: res.status, details: data }, res.status)
    }
    return json({ ok: true, id: data?.id })
  } catch (e) {
    console.error('send-email exception', e)
    return json({ error: (e as Error).message || 'خطأ داخلي' }, 500)
  }
})

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
