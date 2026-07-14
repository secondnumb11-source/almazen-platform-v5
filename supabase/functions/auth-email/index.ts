// auth-email — إرسال رسائل تفعيل الحساب واستعادة كلمة المرور عبر Resend
// يعالج رسائل Auth خارج SMTP الافتراضي حتى لا تفشل العملية عند خطأ mailer داخلي.

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

type AuthEmailType = 'signup' | 'signup-resend' | 'recovery'

interface Payload {
  type?: AuthEmailType
  email?: string
  password?: string
  redirectTo?: string
  metadata?: Record<string, unknown>
}

const APP_NAME = 'المازن'
const FROM = (Deno.env.get('EMAIL_FROM') || Deno.env.get('RESEND_FROM') || '').trim()

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    const payload = (await req.json().catch(() => null)) as Payload | null
    const type = payload?.type
    const email = normalizeEmail(payload?.email)
    const redirectTo = safeRedirect(payload?.redirectTo)

    if (!type || !['signup', 'signup-resend', 'recovery'].includes(type)) {
      return json({ error: 'نوع رسالة المصادقة غير صحيح.' }, 400)
    }
    if (!email) return json({ error: 'صيغة البريد الإلكتروني غير صحيحة.' }, 400)
    if (type === 'signup' && (!payload?.password || payload.password.length < 8)) {
      return json({ error: 'كلمة المرور يجب ألا تقل عن 8 أحرف.' }, 400)
    }

    const resendKey = Deno.env.get('RESEND_API_KEY')
    const configCheck = resendKey ? await validateResendConfiguration(resendKey, FROM) : { ok: false, error: 'مفتاح Resend غير مضبوط في أسرار المشروع.' }

    // recovery / signup-resend لا معنى لهما بدون بريد فعلي يصل — تبقى صارمة كما كانت.
    if (type !== 'signup' && !configCheck.ok) {
      return json({ error: configCheck.error, status: configCheck.status, details: configCheck.details }, configCheck.status || 500)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: 'إعدادات خدمة المصادقة غير مكتملة.' }, 500)
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const linkResult = await createAuthLink(admin, { ...payload, type, email, redirectTo })
    if (linkResult.error) {
      const status = linkResult.error.status || 500
      return json({
        error: translateAdminError(linkResult.error),
        code: linkResult.error.code,
        details: linkResult.error.message,
      }, status)
    }

    const actionLink = linkResult.data?.properties?.action_link
    if (!actionLink) return json({ error: 'تعذر إنشاء رابط البريد.' }, 500)

    // مؤقت: بريد Resend/الدومين غير جاهز حالياً — نفعّل حساب المستخدم الجديد مباشرة
    // بدل حرمانه من التجربة، بانتظار توثيق الدومين. يعود تلقائياً للمسار الطبيعي
    // (تأكيد عبر رابط البريد) بمجرد أن يصبح configCheck.ok صحيحاً.
    if (type === 'signup' && !configCheck.ok) {
      const newUserId = linkResult.data?.user?.id
      if (newUserId) {
        await admin.auth.admin.updateUserById(newUserId, { email_confirm: true })
      }
      return json({ ok: true, autoConfirmed: true, emailSent: false })
    }

    const content = buildEmail(type, actionLink, email)
    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        to: [email],
        subject: content.subject,
        html: content.html,
        text: content.text,
      }),
    })

    const sendBody = await readJson(sendRes)
    if (!sendRes.ok) {
      console.error('Resend auth email error', sendRes.status, sendBody)
      return json({
        error: translateResendError(sendBody),
        status: sendRes.status,
        details: sendBody,
      }, sendRes.status)
    }

    return json({ ok: true, id: sendBody?.id })
  } catch (e) {
    console.error('auth-email exception', e)
    return json({ error: (e as Error).message || 'خطأ داخلي في إرسال البريد.' }, 500)
  }
})

async function validateResendConfiguration(apiKey: string, from: string) {
  if (!/^re_[A-Za-z0-9_\-]+/.test(apiKey)) {
    return { ok: false, status: 500, error: 'صيغة RESEND_API_KEY غير صحيحة. يجب أن يبدأ المفتاح بـ re_.' }
  }

  const fromEmail = extractEmail(from)
  if (!fromEmail) {
    return { ok: false, status: 500, error: 'EMAIL_FROM غير مضبوط أو صيغته غير صحيحة. استخدم صيغة مثل: المازن <no-reply@your-domain.com>.' }
  }

  const domain = fromEmail.split('@')[1]?.toLowerCase()
  if (!domain) return { ok: false, status: 500, error: 'تعذر قراءة دومين EMAIL_FROM.' }
  if (domain === 'resend.dev' || /^(gmail|yahoo|hotmail|outlook|icloud)\./i.test(domain)) {
    return { ok: false, status: 500, error: 'EMAIL_FROM يجب أن يكون بريداً من دومين موثق داخل Resend، وليس Gmail/Outlook أو onboarding@resend.dev.' }
  }

  const res = await fetch('https://api.resend.com/domains', {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  const body = await readJson(res)
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: 500, error: 'مفتاح RESEND_API_KEY غير صالح أو لا يملك صلاحية التحقق من الدومينات.', details: body }
  }
  if (!res.ok) {
    return { ok: false, status: 500, error: 'تعذر التحقق من إعدادات Resend قبل إرسال البريد.', details: body }
  }

  const domains = Array.isArray(body?.data) ? body.data : []
  const matched = domains.find((item: Record<string, unknown>) => String(item?.name || '').toLowerCase() === domain)
  if (!matched) {
    return { ok: false, status: 500, error: `الدومين ${domain} غير موجود ضمن دومينات Resend المرتبطة بالمفتاح الحالي.`, details: { domain, available: domains.map((d: Record<string, unknown>) => d?.name).filter(Boolean) } }
  }
  if (!/verified/i.test(String(matched.status || ''))) {
    return { ok: false, status: 500, error: `الدومين ${domain} موجود في Resend لكنه غير موثق بعد. أكمل DNS verification ثم أعد المحاولة.`, details: matched }
  }
  return { ok: true }
}

async function createAuthLink(admin: ReturnType<typeof createClient>, payload: Required<Pick<Payload, 'type' | 'email' | 'redirectTo'>> & Payload) {
  if (payload.type === 'recovery') {
    return await admin.auth.admin.generateLink({
      type: 'recovery',
      email: payload.email,
      options: { redirectTo: payload.redirectTo },
    })
  }

  if (payload.type === 'signup-resend') {
    return await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: payload.email,
      options: { redirectTo: payload.redirectTo },
    })
  }

  return await admin.auth.admin.generateLink({
    type: 'signup',
    email: payload.email,
    password: payload.password!,
    options: {
      data: payload.metadata || {},
      redirectTo: payload.redirectTo,
    },
  })
}

function buildEmail(type: AuthEmailType, actionLink: string, email: string) {
  const isRecovery = type === 'recovery'
  const subject = isRecovery ? 'استعادة كلمة مرور المازن' : 'تفعيل حسابك في المازن'
  const title = isRecovery ? 'استعادة كلمة المرور' : 'مرحباً بك في المازن'
  const intro = isRecovery
    ? 'وصلنا طلب لتعيين كلمة مرور جديدة لحسابك. اضغط الزر بالأسفل لإكمال العملية بأمان.'
    : 'تم إنشاء طلب تسجيلك بنجاح. اضغط الزر بالأسفل لتفعيل حسابك والبدء في استخدام المنصة.'
  const cta = isRecovery ? 'تعيين كلمة مرور جديدة' : 'تفعيل الحساب'
  const note = isRecovery
    ? 'إذا لم تطلب استعادة كلمة المرور، تجاهل هذه الرسالة.'
    : 'إذا لم تقم بإنشاء هذا الحساب، يمكنك تجاهل هذه الرسالة.'
  const text = `${title}\n\n${intro}\n\n${actionLink}\n\n${note}`
  const html = `
    <div dir="rtl" style="margin:0;padding:32px;background:#f5f7fb;font-family:Tahoma,Arial,sans-serif;color:#18365d">
      <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:18px;overflow:hidden;box-shadow:0 18px 48px rgba(15,23,42,.10)">
        <div style="background:#0f2747;padding:26px 30px;color:#ffffff">
          <div style="font-size:26px;font-weight:900;letter-spacing:0">${APP_NAME}</div>
          <div style="margin-top:7px;color:#d7e6f7;font-size:14px">منصة إدارة الضيافة والتأجير</div>
        </div>
        <div style="padding:30px">
          <h1 style="margin:0 0 12px;font-size:24px;line-height:1.4;color:#18365d">${title}</h1>
          <p style="margin:0 0 22px;font-size:16px;line-height:1.9;color:#52677f">${intro}</p>
          <a href="${escapeAttr(actionLink)}" style="display:block;text-align:center;background:#0f2747;color:#ffffff;text-decoration:none;border-radius:12px;padding:15px 18px;font-size:17px;font-weight:800">${cta}</a>
          <p style="margin:22px 0 0;font-size:13px;line-height:1.8;color:#7a8ca3">${note}</p>
          <p dir="ltr" style="margin:16px 0 0;font-size:12px;color:#8a9bb0;text-align:left;word-break:break-all">${escapeHtml(email)}</p>
        </div>
      </div>
    </div>`
  return { subject, html, text }
}

function normalizeEmail(value?: string) {
  const email = String(value || '').trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : ''
}

function extractEmail(value: string) {
  const trimmed = String(value || '').trim()
  const betweenAngles = trimmed.match(/<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>/)
  const raw = betweenAngles?.[1] || trimmed
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw.toLowerCase() : ''
}

function safeRedirect(value?: string) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol === 'https:' || url.hostname === 'localhost') return url.toString()
  } catch { /* ignore */ }
  return Deno.env.get('SITE_URL') || 'http://localhost:8080'
}

function translateAdminError(error: { message?: string; code?: string; status?: number }) {
  const raw = `${error.message || ''} ${error.code || ''}`
  if (/already|registered|exists/i.test(raw)) return 'هذا البريد مسجل مسبقاً. استخدم استعادة كلمة المرور أو سجل الدخول مباشرة.'
  if (/not.?found|no user/i.test(raw)) return 'لا يوجد حساب مسجل بهذا البريد الإلكتروني.'
  if (/rate/i.test(raw)) return 'تم تجاوز الحد المسموح للإرسال. انتظر دقيقة ثم أعد المحاولة.'
  if (/invalid.*email/i.test(raw)) return 'صيغة البريد الإلكتروني غير صحيحة.'
  return error.message || 'تعذر إنشاء رابط البريد.'
}

function translateResendError(body: Record<string, unknown>) {
  const message = String(body?.message || body?.error || 'فشل إرسال البريد عبر Resend.')
  if (/domain.*not.*verified|verify.*domain|onboarding@resend\.dev|from/i.test(message)) {
    return 'فشل إرسال البريد لأن عنوان المرسل غير موثق في Resend. اضبط EMAIL_FROM على بريد من دومين موثق في Resend.'
  }
  if (/api.?key|unauthorized|invalid/i.test(message)) return 'مفتاح Resend غير صحيح أو لا يملك صلاحية الإرسال.'
  return message
}

async function readJson(response: Response) {
  const raw = await response.text().catch(() => '')
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return { message: raw } }
}

function escapeHtml(v: unknown) {
  return String(v ?? '').replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

function escapeAttr(v: unknown) {
  return escapeHtml(v)
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}