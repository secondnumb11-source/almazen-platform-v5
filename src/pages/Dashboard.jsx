import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../AuthContext'
import { SAR, today } from '../lib/helpers'
import Units from './Units'

export default function Dashboard() {
  const { profile, isOwner } = useAuth()
  const [t, setT] = useState(null)       // إحصائيات اليوم (RPC)
  const [m, setM] = useState(null)       // إحصائيات الشهر
  const [fin, setFin] = useState(null)   // مالية المدير

  useEffect(() => {
    (async () => {
      const cid = profile.company_id
      const { data: td } = await supabase.rpc('dashboard_today', { p_company: cid })
      setT(td)

      const first = today().slice(0, 8) + '01'
      const { data: occ } = await supabase.rpc('occupancy_rate', { p_company: cid, p_from: first, p_to: today() })
      const { data: contracts } = await supabase.from('bookings')
        .select('id', { count: 'exact', head: true }).eq('company_id', cid)
        .gte('created_at', first).neq('status', 'cancelled')
      // أعلى/أقل وحدة دخلاً هذا الشهر
      const { data: pays } = await supabase.from('payments')
        .select('amount, booking_id, bookings(unit_id, units(unit_number))')
        .eq('company_id', cid).gte('payment_date', first)
      const byUnit = {}
      for (const p of pays || []) {
        const un = p.bookings?.units?.unit_number || '—'
        byUnit[un] = (byUnit[un] || 0) + Number(p.amount)
      }
      const sorted = Object.entries(byUnit).sort((a, b) => b[1] - a[1])
      setM({
        occ: occ ?? 0,
        contracts: contracts?.count ?? 0,
        top: sorted[0]?.[0] || '—',
        low: sorted.at(-1)?.[0] || '—'
      })

      if (isOwner) {
        const rev = (pays || []).reduce((s, p) => s + Number(p.amount), 0)
        const { data: exps } = await supabase.from('expenses')
          .select('amount').eq('company_id', cid).gte('expense_date', first)
        const exp = (exps || []).reduce((s, e) => s + Number(e.amount), 0)
        setFin({ rev, exp, net: rev - exp })
      }
    })()
  }, [profile, isOwner])

  return (
    <div>
      <div className="pg-title"><h2>لوحة التحكم</h2>
        <span className="chip" style={{ background: '#fff', color: 'var(--green)', border: '1px solid var(--line)' }}>
          {new Date().toLocaleDateString('ar-SA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        </span>
      </div>

      <div className="panel"><h3>اليوم</h3>
        <div className="kpis">
          <div className="kpi"><div className="v">{t?.bookings_today ?? '…'}</div><div className="l">عدد الحجوزات</div></div>
          <div className="kpi"><div className="v">{t?.vacant_units ?? '…'}</div><div className="l">الوحدات الشاغرة</div></div>
          <div className="kpi"><div className="v">{t?.occupied_units ?? '…'}</div><div className="l">الوحدات المشغولة</div></div>
          <div className="kpi"><div className="v">{t?.departures_today ?? '…'}</div><div className="l">المغادرون اليوم</div></div>
          <div className="kpi"><div className="v">{t?.arrivals_today ?? '…'}</div><div className="l">القادمون اليوم</div></div>
        </div>
      </div>

      <div className="panel"><h3>هذا الشهر</h3>
        <div className="kpis">
          <div className="kpi"><div className="v">{m ? m.occ + '%' : '…'}</div><div className="l">نسبة الإشغال</div></div>
          <div className="kpi"><div className="v">{m?.top ?? '…'}</div><div className="l">أعلى وحدة دخلاً</div></div>
          <div className="kpi"><div className="v">{m?.low ?? '…'}</div><div className="l">أقل وحدة دخلاً</div></div>
          <div className="kpi"><div className="v">{m?.contracts ?? '…'}</div><div className="l">عدد العقود</div></div>
        </div>
      </div>

      {isOwner && (
        <div className="panel"><h3>الإيرادات والمصروفات والأرباح (للمدير فقط)</h3>
          <div className="kpis" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
            <div className="kpi"><div className="v">{fin ? SAR(fin.rev) : '…'}</div><div className="l">إيرادات الشهر</div></div>
            <div className="kpi"><div className="v neg" style={{ color: 'var(--st-oc)' }}>{fin ? SAR(fin.exp) : '…'}</div><div className="l">مصروفات الشهر</div></div>
            <div className="kpi"><div className="v">{fin ? SAR(fin.net) : '…'}</div><div className="l">صافي الربح</div></div>
          </div>
        </div>
      )}

      {/* الوحدات وحالاتها داخل لوحة البيانات الرئيسية مباشرة */}
      <Units />
    </div>
  )
}
