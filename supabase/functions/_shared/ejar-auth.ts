// supabase/functions/_shared/ejar-auth.ts
// وحدة مشتركة بين دوال إيجار: التحقق من هوية المستخدم ودوره، وبناء
// عميل service_role الموثوق للقراءة/الكتابة الرسمية في قاعدة البيانات.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

export function serviceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
}

/*
  يتحقق من:
  1) أن الطلب يحمل توكن مستخدم Supabase Auth صحيح (رأس Authorization).
  2) أن دوره في الشركة صاحبة الحجز هو owner أو manager أو accountant.
  هذا تحقق مستقل عن قاعدة البيانات (لا يعتمد على إخفاء الزر في الواجهة
  فقط) — لأن Edge Function تعمل بمفتاح service_role الذي يتجاوز RLS.
*/
export async function requireFinanceRole(req: Request, companyId: string) {
  const authHeader = req.headers.get('Authorization') || ''
  const token = authHeader.replace('Bearer ', '')
  if (!token) throw new Error('AUTH_REQUIRED')

  const caller = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  )
  const { data: userData, error: userErr } = await caller.auth.getUser(token)
  if (userErr || !userData?.user) throw new Error('AUTH_REQUIRED')

  const db = serviceClient()
  const { data: profile, error: pErr } = await db
    .from('profiles').select('role, company_id').eq('id', userData.user.id).maybeSingle()
  if (pErr || !profile) throw new Error('PROFILE_NOT_FOUND')
  if (profile.company_id !== companyId) throw new Error('COMPANY_MISMATCH')
  if (!['owner', 'manager', 'accountant'].includes(profile.role)) {
    throw new Error('صلاحية توثيق العقد على إيجار حصرية للمالك أو المدير أو المحاسب')
  }
  return profile
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      // بدون هذين الرأسين يرفض المتصفح طلب الـ preflight (OPTIONS) لأن
      // supabase-js يرسل تلقائياً رؤوس Authorization/apikey/Content-Type —
      // وهذا كان السبب الحقيقي لفشل "اختبار الاتصال" في المتصفح الفعلي.
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    }
  })
}
