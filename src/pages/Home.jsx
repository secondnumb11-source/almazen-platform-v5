import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../AuthContext'
import { SAR, num, today } from '../lib/helpers'
import { SkeletonKpis } from '../components/Skeleton'

function BookingsPaymentsCard({ companyId }) {
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!companyId) return
    ;(async () => {
      const first = today().slice(0, 8) + '01'
      const { data: bkData } = await supabase.from('bookings')
        .select(`id, total_amount, discount_amount, check_in_date, customers(full_name), units(unit_number)`)
        .eq('company_id', companyId)
        .gte('created_at', first)
        .in('status', ['confirmed', 'checked_in'])
        .limit(10)
      setData(bkData || [])
      setLoading(false)
    })()
  }, [companyId])

  return (
    <div className="panel">
      <h3>📋 آخر الحجوزات والدفعات (هذا الشهر)</h3>
      {loading ? (
        <div style={{ textAlign: 'center', padding: '20px', color: 'var(--muted)' }}>جارٍ التحميل…</div>
      ) : data.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px', color: 'var(--muted)' }}>لا توجد حجوزات هذا الشهر</div>
      ) : (
        <table className="tbl" style={{ width: '100%', fontSize: 13 }}>
          <thead>
            <tr>
              <th>الوحدة</th>
              <th>العميل</th>
              <th>المبلغ</th>
              <th>الخصم</th>
              <th>الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {data.map(b => (
              <tr key={b.id}>
                <td>{b.units?.unit_number}</td>
                <td>{b.customers?.full_name}</td>
                <td>{SAR(b.total_amount)}</td>
                <td>{SAR(b.discount_amount || 0)}</td>
                <td style={{ fontWeight: 'bold', color: 'var(--green)' }}>{SAR((b.total_amount || 0) - (b.discount_amount || 0))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

function PendingPaymentsCard({ companyId }) {
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!companyId) return
    ;(async () => {
      const { data: pendingData } = await supabase.rpc('overdue_payments', { p_company: companyId, p_days: 1 })
      setData(pendingData || [])
      setLoading(false)
    })()
  }, [companyId])

  const totalOverdue = data.reduce((sum, p) => sum + (p.amount_due || 0), 0)

  return (
    <div className="panel">
      <h3>⚠️ المتأخرات والدفعات المعلقة</h3>
      {loading ? (
        <div style={{ textAlign: 'center', padding: '20px', color: 'var(--muted)' }}>جارٍ التحميل…</div>
      ) : data.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px', color: 'var(--green)' }}>✓ لا توجد متأخرات</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <div style={{ padding: 12, background: 'var(--bg-secondary)', borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>عدد المتأخرين</div>
              <div style={{ fontSize: 18, fontWeight: 'bold', color: 'var(--st-oc)' }}>{data.length}</div>
            </div>
            <div style={{ padding: 12, background: 'var(--bg-secondary)', borderRadius: 8 }}>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>إجمالي المتأخرات</div>
              <div style={{ fontSize: 18, fontWeight: 'bold', color: 'var(--st-oc)' }}>{SAR(totalOverdue)}</div>
            </div>
          </div>
          <table className="tbl" style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr>
                <th>العميل</th>
                <th>الوحدة</th>
                <th>المبلغ</th>
                <th>الأيام</th>
              </tr>
            </thead>
            <tbody>
              {data.slice(0, 8).map((p, i) => (
                <tr key={i}>
                  <td>{p.customer_name}</td>
                  <td>{p.unit_number}</td>
                  <td style={{ color: 'var(--st-oc)', fontWeight: 'bold' }}>{SAR(p.amount_due)}</td>
                  <td>{p.days_overdue} يوم</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

function TodayRentalsCard({ companyId }) {
  const [rentals, setRentals] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!companyId) return
    ;(async () => {
      try {
        const { data } = await supabase.from('bookings')
          .select(`id, check_in_date, unit_id, units(unit_number), customers(full_name), base_price`)
          .eq('company_id', companyId)
          .eq('check_in_date', today())
          .in('status', ['confirmed', 'checked_in'])
        setRentals(data || [])
      } catch (err) {
        console.error('Rentals load error:', err)
      }
      setLoading(false)
    })()
  }, [companyId])

  return (
    <div className="panel" style={{ flex: 1, minWidth: 300 }}>
      <h3>🛬 الوحدات المؤجرة اليوم</h3>
      {loading ? (
        <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '20px' }}>جارٍ التحميل…</div>
      ) : rentals.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '20px' }}>لا توجد حجوزات اليوم</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rentals.map(r => (
            <div key={r.id} style={{
              padding: 12,
              background: 'var(--bg-secondary)',
              borderRadius: 8,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div>
                <div style={{ fontWeight: 'bold', marginBottom: 4 }}>
                  وحدة {r.units?.unit_number}
                </div>
                <div style={{ fontSize: 14, color: 'var(--muted)' }}>
                  {r.customers?.full_name}
                </div>
              </div>
              <div style={{ textAlign: 'left', color: 'var(--green)' }}>
                {SAR(r.base_price)}
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)', textAlign: 'center', fontWeight: 'bold' }}>
        إجمالي: {rentals.length} حجز
      </div>
    </div>
  )
}

function TodayCheckoutsCard({ companyId }) {
  const [checkouts, setCheckouts] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!companyId) return
    ;(async () => {
      try {
        const { data } = await supabase.from('bookings')
          .select(`id, check_out_date, unit_id, units(unit_number), customers(full_name), base_price`)
          .eq('company_id', companyId)
          .eq('check_out_date', today())
          .in('status', ['confirmed', 'checked_in'])
        setCheckouts(data || [])
      } catch (err) {
        console.error('Checkouts load error:', err)
      }
      setLoading(false)
    })()
  }, [companyId])

  return (
    <div className="panel" style={{ flex: 1, minWidth: 300 }}>
      <h3>🛫 الوحدات المسلمة اليوم (المغادرون)</h3>
      {loading ? (
        <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '20px' }}>جارٍ التحميل…</div>
      ) : checkouts.length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--muted)', padding: '20px' }}>لا توجد مغادرات اليوم</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {checkouts.map(c => (
            <div key={c.id} style={{
              padding: 12,
              background: 'var(--bg-secondary)',
              borderRadius: 8,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div>
                <div style={{ fontWeight: 'bold', marginBottom: 4 }}>
                  وحدة {c.units?.unit_number}
                </div>
                <div style={{ fontSize: 14, color: 'var(--muted)' }}>
                  {c.customers?.full_name}
                </div>
              </div>
              <div style={{ textAlign: 'left', color: 'var(--orange)' }}>
                {SAR(c.base_price)}
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)', textAlign: 'center', fontWeight: 'bold' }}>
        إجمالي: {checkouts.length} مغادر
      </div>
    </div>
  )
}

/*
  الصفحة الرئيسية بعد تسجيل الدخول — تظهر حسب دور المستخدم:
  • موظف → قادمون/مغادرون اليوم + الوحدات المتاحة + إجراءات سريعة
  • محاسب/مالك → إيراد الشهر + متأخرات + تدفق + مقترحات
*/
export default function Home({ onNav }) {
  const { profile, company, canFinance, isOwner } = useAuth()
  const [s, setS] = useState(null)

  useEffect(() => {
    if (!profile) return
    (async () => {
      const cid = profile.company_id
      const t = today()
      const first = t.slice(0, 8) + '01'
      const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
      const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)
      const [{ data: units }, { data: bkAll }, { data: pays }, { data: od }, { data: soon }] = await Promise.all([
        supabase.from('units').select('status').eq('company_id', cid),
        supabase.from('bookings').select('status, check_in_date, check_out_date').eq('company_id', cid),
        supabase.from('payments').select('amount, payment_date').eq('company_id', cid).gte('payment_date', first),
        supabase.rpc('overdue_payments', { p_company: cid, p_days: 1 }).then(r => r).catch(() => ({ data: [] })),
        supabase.from('bookings')
          .select('id, check_in_date, check_out_date, status, units(unit_number), customers(full_name, phone)')
          .eq('company_id', cid).in('status', ['confirmed','checked_in'])
          .lte('check_out_date', in7).gte('check_out_date', t)
      ])
      const arrivals = (bkAll || []).filter(b => b.check_in_date === t && b.status !== 'cancelled').length
      const departures = (bkAll || []).filter(b => b.check_out_date === t && b.status !== 'cancelled').length
      const dist = {}
      for (const u of units || []) dist[u.status] = (dist[u.status] || 0) + 1
      const monthRev = (pays || []).reduce((s, p) => s + num(p.amount), 0)
      const overdueTotal = (od || []).reduce((s, o) => s + num(o.amount_due), 0)
      const todayDepartures = (soon || []).filter(b => b.check_out_date === t)
      const tomorrowDepartures = (soon || []).filter(b => b.check_out_date === tomorrow)
      const weekDepartures = (soon || []).filter(b => b.check_out_date > tomorrow)
      setS({ arrivals, departures, dist, monthRev, overdueTotal,
        unitsCount: (units || []).length, overdueCount: (od || []).length,
        todayDepartures, tomorrowDepartures, weekDepartures })
    })()
  }, [profile])

  const hour = new Date().getHours()
  const greet = hour < 12 ? 'صباح الخير' : hour < 18 ? 'مساء الخير' : 'أهلاً بك'

  if (!s) return <div><div className="hero-strip"><h2>مرحباً {profile?.full_name} 👋</h2></div><SkeletonKpis /></div>

  return (
    <div>
      <div className="hero-strip">
        <div>
          <div className="hero-hi">{greet} {profile?.full_name?.split(' ')[0]} 👋</div>
          <h2>{company?.name || 'المازن'}</h2>
          <div className="hero-sub">اليوم {new Date().toLocaleDateString('ar-SA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</div>
        </div>
        <div className="hero-actions">
          <button className="btn btn-gold btn-sm" onClick={() => onNav?.('dash')}>إدارة الوحدات →</button>
          {profile?.role === 'accountant' && <button className="btn btn-ghost btn-sm" onClick={() => onNav?.('reports')}>قسم المحاسبة →</button>}
        </div>
      </div>

      <div className="kpis home-kpis">
        <div className="kpi kpi-gold">
          <div className="v">{s.arrivals}</div>
          <div className="l">وصول اليوم 🛬</div>
        </div>
        <div className="kpi">
          <div className="v">{s.departures}</div>
          <div className="l">مغادرة اليوم 🛫</div>
        </div>
        <div className="kpi">
          <div className="v">{s.dist.available || 0}</div>
          <div className="l">وحدات متاحة الآن</div>
        </div>
        <div className="kpi">
          <div className="v">{s.dist.occupied || 0}</div>
          <div className="l">وحدات مسكونة</div>
        </div>
        {canFinance && <>
          <div className="kpi kpi-gold">
            <div className="v">{SAR(s.monthRev)}</div>
            <div className="l">إيرادات هذا الشهر</div>
          </div>
          <div className="kpi" style={{ borderColor: s.overdueTotal > 0 ? 'var(--st-oc)' : '' }}>
            <div className="v" style={{ color: s.overdueTotal > 0 ? 'var(--st-oc)' : '' }}>{SAR(s.overdueTotal)}</div>
            <div className="l">متأخرات ({s.overdueCount})</div>
          </div>
        </>}
      </div>

      <div className="grid2" style={{ marginTop: 22 }}>
        <div className="panel">
          <h3>إجراءات سريعة</h3>
          <div className="quick-actions">
            <button className="qa-btn" onClick={() => onNav?.('dash')}>
              <span className="qa-ico">🏢</span><b>إدارة الوحدات</b>
              <span>حجز، إخلاء، صيانة، تعديل</span>
            </button>
            {profile?.role === 'accountant' && <button className="qa-btn" onClick={() => onNav?.('reports')}>
              <span className="qa-ico">📊</span><b>قسم المحاسبة</b>
              <span>Excel + PDF بالفلاتر التي تختارها</span>
            </button>}
            {(isOwner || profile?.role === 'accountant') && <button className="qa-btn" onClick={() => onNav?.('settings')}>
              <span className="qa-ico">⚙️</span><b>الإعدادات</b>
              <span>المستخدمون، الفروع، الهوية</span>
            </button>}
          </div>
        </div>

        <div className="panel">
          <h3>حالة الوحدات</h3>
          <div className="status-strip">
            {[
              ['available', 'متاحة', 'var(--st-av)'],
              ['reserved', 'محجوزة', 'var(--st-rs)'],
              ['occupied', 'مسكونة', 'var(--st-oc)'],
              ['cleaning', 'تنظيف', 'var(--st-cl)'],
              ['maintenance', 'صيانة', 'var(--st-cl)']
            ].map(([k, label, c]) => (
              <div key={k} className="status-item">
                <span className="status-dot" style={{ background: c }} />
                <b>{s.dist[k] || 0}</b>
                <span>{label}</span>
              </div>
            ))}
          </div>
          <div className="mini-note">
            الإجمالي: {s.unitsCount} وحدة —
            نسبة الإشغال: {s.unitsCount ? Math.round(((s.dist.occupied || 0) + (s.dist.reserved || 0)) / s.unitsCount * 100) : 0}%
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 18 }}>
        <h3>⏰ التسليمات القادمة (تنبيهات الموظف)</h3>
        <div className="upcoming-grid">
          <UpcomingCol color="var(--st-oc)" label="مغادرة اليوم" list={s.todayDepartures} empty="لا مغادرين اليوم" />
          <UpcomingCol color="var(--st-rs)" label="مغادرة غداً" list={s.tomorrowDepartures} empty="لا مغادرين غداً" />
          <UpcomingCol color="var(--gold-d)" label="خلال الأسبوع" list={s.weekDepartures} empty="لا مغادرين خلال 7 أيام" />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, marginTop: 24, marginBottom: 24, flexWrap: 'wrap' }}>
        <TodayRentalsCard companyId={profile.company_id} />
        <TodayCheckoutsCard companyId={profile.company_id} />
      </div>

      <BookingsPaymentsCard companyId={profile.company_id} />
      <PendingPaymentsCard companyId={profile.company_id} />
    </div>
  )
}



function UpcomingCol({ color, label, list, empty }) {
  return (
    <div className="upcoming-col">
      <div className="upcoming-h"><span style={{ background: color }} />{label} ({list.length})</div>
      {list.length === 0
        ? <div className="upcoming-empty">{empty}</div>
        : list.map(b => (
          <div key={b.id} className="upcoming-item">
            <b>وحدة {b.units?.unit_number}</b>
            <span>{b.customers?.full_name}</span>
            <small dir="ltr">{b.check_out_date}</small>
          </div>
        ))}
    </div>
  )
}
