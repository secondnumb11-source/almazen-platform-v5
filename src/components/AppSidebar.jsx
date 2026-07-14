import React, { useEffect, useState } from 'react'
import { useAuth } from '../AuthContext'
import { ROLES } from '../lib/helpers'

const items = [
  { k: 'home', label: 'الرئيسية', icon: '🏠', roles: 'all' },
  { k: 'dash', label: 'إدارة الوحدات', icon: '🏢', roles: 'all' },
  { k: 'reports', label: 'بوابة المحاسب', icon: '📊', roles: 'finance' },
  { k: 'center', label: 'مركز التقارير والمراقبة', icon: '🛰️', roles: 'finance' },
  { k: 'ejar', label: 'التكامل مع منصة إيجار', icon: '🏛️', roles: 'finance', soon: true },
  { k: 'ai', label: 'المساعد الذكي', icon: '🤖', roles: 'all' },
  { k: 'settings', label: 'الإعدادات', icon: '⚙️', roles: 'owner' }
]

function pad(n) { return String(n).padStart(2, '0') }

function SidebarClock({ collapsed }) {
  const [now, setNow] = useState(new Date())
  const [hijri, setHijri] = useState(false)

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const hh = pad(now.getHours())
  const mm = pad(now.getMinutes())
  const ss = pad(now.getSeconds())

  const dateStr = hijri
    ? now.toLocaleDateString('ar-SA-u-ca-islamic', { year: 'numeric', month: 'short', day: 'numeric' })
    : now.toLocaleDateString('ar-SA', { weekday: 'short', day: 'numeric', month: 'short' })

  if (collapsed) return (
    <div className="sb-clock-mini" title={`${hh}:${mm}`}>
      <span className="sb-clock-dot" />
    </div>
  )

  return (
    <div className="sb-clock">
      <div className="sb-clock-time">
        <span>{hh}</span>
        <span className="sb-colon">:</span>
        <span>{mm}</span>
        <span className="sb-colon">:</span>
        <span className="sb-sec">{ss}</span>
      </div>
      <div className="sb-clock-date">{dateStr}</div>
      <button
        className="sb-cal-toggle"
        onClick={() => setHijri(h => !h)}
        title={hijri ? 'التاريخ الميلادي' : 'التاريخ الهجري'}
      >
        {hijri ? '🗓 م' : '🌙 هـ'}
      </button>
    </div>
  )
}

export default function AppSidebar({ page, setPage, collapsed, onToggle }) {
  const { profile, company, isOwner, canFinance, signOut } = useAuth()

  const visible = items.filter(i =>
    i.roles === 'all' ||
    (i.roles === 'finance' && canFinance) ||
    (i.roles === 'owner' && isOwner))

  return (
    <aside className={'app-sidebar' + (collapsed ? ' collapsed' : '')}>
      <div className="sb-head">
        <div className="sb-brand" title={company?.name || 'المازن'}>
          {company?.logo_url
            ? <img src={company.logo_url} alt="logo" className="sb-logo" />
            : <span className="sb-mark">م</span>}
          {!collapsed && <div className="sb-brand-txt">
            <b>{company?.name || 'منصة المازن'}</b>
            <span>لوحة الإدارة</span>
          </div>}
        </div>
        <button className="sb-toggle" onClick={onToggle} title={collapsed ? 'توسيع' : 'طيّ'}>
          {collapsed ? '›' : '‹'}
        </button>
      </div>

      <SidebarClock collapsed={collapsed} />

      <nav className="sb-nav">
        {visible.map(it => (
          <button key={it.k}
            className={'sb-item' + (page === it.k ? ' on' : '')}
            onClick={() => setPage(it.k)}
            title={it.label}>
            <span className="sb-ico">{it.icon}</span>
            {!collapsed && <span className="sb-label">{it.label}{it.soon && <small className="sb-soon"> (قريباً)</small>}</span>}
            {page === it.k && <span className="sb-active" />}
          </button>
        ))}
      </nav>

      <div className="sb-foot">
        {!collapsed && (
          <div className="sb-user">
            <div className="sb-avatar">{(profile?.full_name || '?').charAt(0)}</div>
            <div>
              <b>{profile?.full_name}</b>
              <span>{ROLES[profile?.role]}</span>
            </div>
          </div>
        )}
        <button className="sb-signout" onClick={signOut} title="خروج">
          {collapsed ? '⎋' : '⎋ تسجيل الخروج'}
        </button>
      </div>
    </aside>
  )
}
