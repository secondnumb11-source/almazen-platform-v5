import React, { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { supabase } from './lib/supabase'

const Ctx = createContext(null)
export const useAuth = () => useContext(Ctx)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [company, setCompany] = useState(null)
  const [access, setAccess] = useState(null) // { plan, active, seconds_left, ends_at }
  const [profileLoadError, setProfileLoadError] = useState(null)
  const [loading, setLoading] = useState(true)
  const [toasts, setToasts] = useState([])

  const toast = useCallback((msg, err = false) => {
    const id = Date.now()
    setToasts(t => [...t, { id, msg, err }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4500)
  }, [])

  const loadAccessState = useCallback(async (companyId) => {
    if (!companyId) { setAccess(null); return }
    const { data, error } = await supabase.rpc('company_access_state', { _company: companyId })
    if (error) {
      // إذا لم تكن الدالة موجودة بعد (لم يُنفَّذ ملف SQL) نعتبر الحساب نشط لعدم كسر الأنظمة الحالية
      setAccess({ plan: 'active', active: true, seconds_left: null, ends_at: null, _fallback: true })
      return
    }
    const row = Array.isArray(data) ? data[0] : data
    setAccess(row || { plan: 'active', active: true, seconds_left: null, ends_at: null })
  }, [])

  const loadProfile = useCallback(async (uid) => {
    setProfileLoadError(null)
    const { data: p, error } = await supabase.from('profiles').select('*').eq('id', uid).maybeSingle()
    if (error) {
      setProfile(null); setCompany(null); setAccess(null)
      setProfileLoadError(error)
      const msg = error.code === '42P17'
        ? 'تعذر تحميل ملف المستخدم بسبب تعارض في سياسات قاعدة البيانات. نفّذ ملف إصلاح الإعداد ثم أعد تسجيل الدخول.'
        : 'تعذر تحميل ملف المستخدم: ' + error.message
      toast(msg, true)
      return
    }
    setProfile(p || null)
    if (p) {
      const { data: c } = await supabase.from('companies').select('*').eq('id', p.company_id).maybeSingle()
      setCompany(c || null)
      await loadAccessState(p.company_id)
    } else { setCompany(null); setAccess(null) }
  }, [toast, loadAccessState])

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s)
      if (s) setTimeout(() => { loadProfile(s.user.id) }, 0)
      else { setProfile(null); setCompany(null); setAccess(null); setProfileLoadError(null) }
      if (event === 'SIGNED_OUT') setLoading(false)
    })
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      if (data.session) loadProfile(data.session.user.id).finally(() => setLoading(false))
      else setLoading(false)
    }).catch(() => setLoading(false))
    return () => sub.subscription.unsubscribe()
  }, [loadProfile])

  // إعادة فحص حالة الوصول كل 5 دقائق لضمان انتهاء التجربة تلقائياً
  useEffect(() => {
    if (!company?.id) return
    const t = setInterval(() => loadAccessState(company.id), 5 * 60 * 1000)
    return () => clearInterval(t)
  }, [company, loadAccessState])

  const refreshCompany = async () => {
    if (!profile) return
    const { data: c } = await supabase.from('companies').select('*').eq('id', profile.company_id).maybeSingle()
    setCompany(c)
    await loadAccessState(profile.company_id)
  }

  const value = {
    session, profile, company, access, profileLoadError, loading, toast,
    isOwner: profile?.role === 'owner',
    canFinance: ['owner', 'manager', 'accountant'].includes(profile?.role),
    reloadProfile: () => session && loadProfile(session.user.id),
    refreshAccess: () => company && loadAccessState(company.id),
    refreshCompany,
    signOut: () => supabase.auth.signOut()
  }

  return (
    <Ctx.Provider value={value}>
      {children}
      <div>{toasts.map(t =>
        <div key={t.id} className={'toast' + (t.err ? ' err' : '')} style={{ bottom: 22 + toasts.indexOf(t) * 62 }}>{t.msg}</div>)}
      </div>
    </Ctx.Provider>
  )
}
