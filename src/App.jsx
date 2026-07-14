import React, { useState, useEffect, useRef } from 'react'
import { AuthProvider, useAuth } from './AuthContext'
import { supabase, hasSupabaseConfig } from './lib/supabase'
import Login from './pages/Login'
import Landing from './pages/Landing'
import Dashboard from './pages/Dashboard'
import Reports from './pages/Reports'
import ReportCenter from './pages/ReportCenter'
import Settings from './pages/Settings'
import CustomersManagement from './pages/CustomersManagement'
import EmployeeManagement from './pages/EmployeeManagement'
import EmployeeOps from './pages/EmployeeOps'
import Assistant from './pages/Assistant'
import Home from './pages/Home'
import PublicUnit from './pages/PublicUnit'
import TenantPortal from './pages/TenantPortal'
import ResetPassword from './pages/ResetPassword'
import EjarPanel from './pages/EjarPanel'
import Privacy from './pages/Privacy'
import Terms from './pages/Terms'
import AppSidebar from './components/AppSidebar'
import DrawerWidget from './components/DrawerWidget'
import RlsHealthBanner from './components/RlsHealthBanner'
import ConfigErrorScreen from './components/ConfigErrorScreen'
import TrialBanner from './components/TrialBanner'
import TrialExpired from './pages/TrialExpired'
import { FullPageLoading } from './components/Skeleton'
import { ROLES } from './lib/helpers'

function Shell() {
  const { session, profile, company, access, loading, isOwner, canFinance, toast } = useAuth()
  const [forceUpgrade, setForceUpgrade] = useState(false)
  const [page, setPage] = useState('home')
  const [notifs, setNotifs] = useState([])
  const [evictionAlerts, setEvictionAlerts] = useState([])
  const [drawer, setDrawer] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const presenceRef = useRef(null)

  useEffect(() => {
    if (!profile) return
    const load = async () => {
      const { data } = await supabase.from('notifications')
        .select('*').eq('company_id', profile.company_id)
        .order('created_at', { ascending: false }).limit(25)
      setNotifs(data || [])
    }
    load()
    const ch = supabase.channel('notifs')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications' }, load)
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [profile])

  useEffect(() => {
    if (!profile) return
    const loadEvictions = async () => {
      const today = new Date().toISOString().split('T')[0]
      const { data } = await supabase
        .from('bookings')
        .select('id, unit_id, check_out_date, customers(full_name), units(name)')
        .eq('company_id', profile.company_id)
        .eq('status', 'checked_in')
        .eq('check_out_date', today)
      setEvictionAlerts(data || [])
    }
    loadEvictions()
    const t = setInterval(loadEvictions, 10 * 60 * 1000)
    return () => clearInterval(t)
  }, [profile])

  // بث الحضور الحيّ (بديل TeamViewer): كل مستخدم يبث الصفحة الحالية عبر Realtime Presence
  // ليطّلع المدير/المحاسب على مَن هو متصل الآن وعلى أي شاشة، دون الحاجة لسجلات في قاعدة البيانات.
  useEffect(() => {
    if (!profile) return
    const ch = supabase.channel(`presence:${profile.company_id}`, {
      config: { presence: { key: profile.id } }
    })
    ch.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await ch.track({
          user_id: profile.id,
          full_name: profile.full_name,
          role: profile.role,
          page,
          at: new Date().toISOString()
        })
      }
    })
    presenceRef.current = ch
    return () => { supabase.removeChannel(ch); presenceRef.current = null }
  }, [profile])

  useEffect(() => {
    const ch = presenceRef.current
    if (!ch || !profile) return
    ch.track({
      user_id: profile.id,
      full_name: profile.full_name,
      role: profile.role,
      page,
      at: new Date().toISOString()
    })
  }, [page, profile])

  // تنبيه فوري للعمليات الحساسة (حذف/إلغاء/خصم/استرداد) لمَن لديه صلاحية مالية
  useEffect(() => {
    if (!profile || !canFinance) return
    const SENSITIVE = new Set(['delete', 'cancel', 'discount', 'refund', 'price_change'])
    const ACTION_AR = { delete: 'حذف', cancel: 'إلغاء', discount: 'خصم', refund: 'استرداد', price_change: 'تعديل سعر' }
    const ch = supabase.channel('sensitive-ops')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'audit_logs' }, ({ new: row }) => {
        if (!row || row.company_id !== profile.company_id) return
        if (row.user_id === profile.id) return
        const sens = row.new_data?.sensitive === true || SENSITIVE.has(row.action)
        if (!sens) return
        const actor = row.new_data?.actor || 'موظف'
        const label = ACTION_AR[row.action] || row.action
        toast(`⚠️ عملية حساسة: ${label} بواسطة ${actor} — ${row.new_data?.summary || ''}`, true)
      })
      .subscribe()
    return () => supabase.removeChannel(ch)
  }, [profile, canFinance])

  const [showLogin, setShowLogin] = useState(false)
  if (loading) return <FullPageLoading />
  if (!session || !profile) {
    return showLogin || session
      ? <Login onBack={() => setShowLogin(false)} />
      : <Landing onLogin={() => setShowLogin(true)} />
  }

  // فرض شاشة انتهاء التجربة / الاشتراك عند انقطاع الوصول
  if (access && access.active === false) {
    return <TrialExpired mode="expired" />
  }
  if (forceUpgrade) {
    return <TrialExpired mode="upgrade" />
  }

  const unread = notifs.filter(n => !n.read_at && n.channel === 'in_app').length + evictionAlerts.length
  const pageTitles = { home:'الرئيسية', dash:'إدارة الوحدات', customers:'إدارة العملاء والمستأجرين', ops:'العمليات اليومية', staff:'إدارة الموظفين', reports:'بوابة المحاسب', center:'مركز التقارير والمراقبة', ejar:'التكامل مع منصة إيجار', ai:'المساعد الذكي', settings:'الإعدادات' }

  return (
    <div className={'app-shell' + (collapsed ? ' sb-collapsed' : '')}>
      <AppSidebar page={page} setPage={setPage} collapsed={collapsed} onToggle={() => setCollapsed(c => !c)} />

      <div className="app-main">
        <TrialBanner plan={access?.plan} secondsLeft={access?.seconds_left} onUpgrade={() => setForceUpgrade(true)} />
        <header className="app-header">
          <div className="hdr-title">
            <button className="hdr-mobile-toggle" onClick={() => setCollapsed(c => !c)}>☰</button>
            <h1>{pageTitles[page] || 'المازن'}</h1>
          </div>
          <div className="hdr-actions">
            <button className="bell" onClick={() => setDrawer(d => !d)} title="الإشعارات">
              🔔{unread > 0 && <span className="dot">{unread}</span>}
            </button>
            <div className="who">
              <b>{profile.full_name}</b>
              <span>{ROLES[profile.role]}</span>
            </div>
          </div>
        </header>

        {drawer && (
          <div className="notif-drawer">
            <h4>الإشعارات</h4>
            {evictionAlerts.length > 0 && (
              <div className="notif-evict-section">
                <div className="notif-evict-hdr">⚠ إخلاء اليوم</div>
                {evictionAlerts.map(b => (
                  <div className="notif-item notif-evict" key={`ev-${b.id}`}>
                    <b>🚨 الوحدة {b.units?.name || b.unit_id}</b>
                    <span>{b.customers?.full_name || 'مستأجر'} — موعد الإخلاء اليوم</span>
                  </div>
                ))}
              </div>
            )}
            {notifs.length === 0 && evictionAlerts.length === 0 && <div className="notif-item">لا توجد إشعارات بعد</div>}
            {notifs.map(n => (
              <div className="notif-item" key={n.id}>
                <b>{n.title} {n.channel !== 'in_app' && <span className="chip" style={{ background: 'var(--soft)', color: 'var(--green)' }}>{n.channel === 'whatsapp' ? 'واتساب' : n.channel}</span>}</b>
                {n.body}
                <br /><time>{new Date(n.created_at).toLocaleString('ar-SA')}</time>
              </div>
            ))}
          </div>
        )}

        <div className="app-body">
          {/* RlsHealthBanner مخفي بناءً على طلب المستخدم */}
          {page === 'home' && <Home onNav={setPage} />}
          {page === 'dash' && <Dashboard />}
          {page === 'customers' && <CustomersManagement />}
          {page === 'ops' && <EmployeeOps />}
          {page === 'staff' && canFinance && <EmployeeManagement />}
          {page === 'reports' && canFinance && <Reports />}
          {page === 'center' && canFinance && <ReportCenter />}
          {page === 'ejar' && canFinance && <EjarPanel />}
          {page === 'ai' && <Assistant />}
          {page === 'settings' && isOwner && <Settings />}
        </div>
        <DrawerWidget />
      </div>
    </div>
  )
}

export default function App() {
  // إذا كانت متغيرات .env ناقصة أو غير صحيحة، نُظهر شاشة تنبيه بدل الانهيار الصامت
  if (!hasSupabaseConfig) return <ConfigErrorScreen />
  const path = typeof window !== 'undefined' ? window.location.pathname : '/'
  if (path === '/reset-password') return <ResetPassword />
  if (path === '/privacy') return <Privacy />
  if (path === '/terms') return <Terms />
  const pubMatch = path.match(/^\/u\/([^/?#]+)/)
  if (pubMatch) return <PublicUnit slug={pubMatch[1]} />
  const portalMatch = path.match(/^\/portal\/([^/?#]+)/)
  if (portalMatch) return <TenantPortal token={portalMatch[1]} />
  return <AuthProvider><Shell /></AuthProvider>
}
