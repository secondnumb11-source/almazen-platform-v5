import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../AuthContext'
import { SAR, num, today, exportCSV, CATS, STATUS, uploadFile } from '../lib/helpers'
import { exportFullAccounts, fetchBookingsRows, fetchTenantsRows, fetchPaymentsRows, downloadWorkbook } from '../lib/excel'
import AdvancedAnalytics from './AdvancedAnalytics'
import ReceiptOCR from './ReceiptOCR'
import AccountantTools from './AccountantTools'
import AccountingCore from './AccountingCore'
import DiscountApprovals from '../components/DiscountApprovals'
import { ReportGenerator } from '../components/ReportGenerator'

export default function Reports() {
  const { profile, isOwner, toast } = useAuth()
  const [profit, setProfit] = useState([])     // ربحية الوحدات
  const [overdue, setOverdue] = useState([])   // المتأخرات
  const [byType, setByType] = useState([])     // الإيراد حسب النوع
  const [kpi, setKpi] = useState(null)

  useEffect(() => {
    (async () => {
      const cid = profile.company_id
      const first = today().slice(0, 8) + '01'

      // الإيرادات لكل وحدة + المصروفات = صافي الربح
      const { data: pays } = await supabase.from('payments')
        .select('amount, bookings(unit_id, units(unit_number, category))')
        .eq('company_id', cid)
      const { data: exps } = await supabase.from('expenses').select('amount, unit_id').eq('company_id', cid)
      const map = {}
      for (const p of pays || []) {
        const u = p.bookings?.units; if (!u) continue
        const k = p.bookings.unit_id
        map[k] = map[k] || { unit: u.unit_number, cat: u.category, rev: 0, exp: 0 }
        map[k].rev += num(p.amount)
      }
      for (const e of exps || []) {
        if (e.unit_id && map[e.unit_id]) map[e.unit_id].exp += num(e.amount)
      }
      const rows = Object.values(map).map(r => ({ ...r, net: r.rev - r.exp })).sort((a, b) => b.net - a.net)
      setProfit(rows)

      const tMap = {}
      rows.forEach(r => { tMap[r.cat] = (tMap[r.cat] || 0) + r.rev })
      setByType(Object.entries(tMap))

      // المتأخرات عبر الدالة الجاهزة
      const { data: od } = await supabase.rpc('overdue_payments', { p_company: cid, p_days: 1 })
      setOverdue(od || [])

      // مؤشرات
      const { data: occ } = await supabase.rpc('occupancy_rate', { p_company: cid, p_from: first, p_to: today() })
      const { data: bks } = await supabase.from('bookings').select('status, check_in_date, check_out_date')
        .eq('company_id', cid)
      const done = (bks || []).filter(b => b.status !== 'cancelled')
      const cancelled = (bks || []).filter(b => b.status === 'cancelled').length
      const stayAvg = done.length
        ? (done.reduce((s, b) => s + (new Date(b.check_out_date) - new Date(b.check_in_date)) / 86400000, 0) / done.length).toFixed(1)
        : 0
      const { count: unitsCount } = await supabase.from('units').select('id', { count: 'exact', head: true }).eq('company_id', cid)
      const monthRev = rows.reduce((s, r) => s + r.rev, 0)
      setKpi({
        occ: occ ?? 0, stayAvg,
        cancelRate: bks?.length ? Math.round(cancelled / bks.length * 100) : 0,
        revpar: unitsCount ? Math.round(monthRev / unitsCount) : 0
      })
    })()
  }, [profile])

  const maxType = Math.max(...byType.map(([, v]) => v), 1)

  return (
    <div>
      <div className="pg-title"><h2>قسم المحاسبة — التقارير والأدوات الذكية</h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-gold btn-sm" onClick={async () => {
            toast('جارٍ تجهيز ملف الحسابات الشامل…')
            const r = await exportFullAccounts(supabase, profile.company_id)
            toast(`✓ صدر ملف إكسيل بـ 5 أوراق ومعادلات جاهزة — إيرادات ${SAR(r.rev)} ومصروفات ${SAR(r.exp)}`)
          }}>📗 ملف الحسابات الشامل (Excel)</button>
        </div>
      </div>

      <ReportGenerator companyId={profile.company_id} />
      <AccountantTools />
      <AccountingCore />
      <DiscountApprovals />
      <ExtractionTools />
      <ChartsRow profit={profit} />
      <AdvancedAnalytics />
      <ReceiptOCR />


      <div className="kpis">
        <div className="kpi"><div className="v">{kpi ? kpi.occ + '%' : '…'}</div><div className="l">نسبة الإشغال</div></div>
        <div className="kpi"><div className="v">{kpi ? SAR(kpi.revpar) : '…'}</div><div className="l">RevPAR — متوسط الإيراد لكل وحدة</div></div>
        <div className="kpi"><div className="v">{kpi ? kpi.stayAvg + ' يوم' : '…'}</div><div className="l">متوسط مدة الإقامة</div></div>
        <div className="kpi"><div className="v">{kpi ? kpi.cancelRate + '%' : '…'}</div><div className="l">معدل الإلغاء</div></div>
      </div>

      <div className="grid2">
        <div className="panel"><h3>الإيرادات حسب نوع الوحدة</h3>
          {byType.length === 0 ? <p style={{ color: 'var(--muted)', fontSize: 13 }}>لا توجد إيرادات مسجلة بعد</p> :
            <div className="bars">
              {byType.map(([cat, v]) =>
                <div className="bar" key={cat}><b>{Math.round(v / 1000)}K</b>
                  <i style={{ height: (v / maxType * 100) + '%' }} />{CATS[cat]}</div>)}
            </div>}
        </div>

        <div className="panel"><h3>أكثر الوحدات ربحاً (صافي وليس إيراداً فقط)</h3>
          <table className="tbl">
            <thead><tr><th>الوحدة</th><th>الإيراد</th><th>المصروف</th><th>صافي الربح</th></tr></thead>
            <tbody>
              {profit.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد بيانات بعد</td></tr>}
              {profit.slice(0, 8).map(r =>
                <tr key={r.unit}><td>{r.unit}</td><td className="money">{SAR(r.rev)}</td>
                  <td className="neg">{SAR(r.exp)}</td><td className="money">{SAR(r.net)}</td></tr>)}
            </tbody>
          </table>
        </div>

        <div className="panel" style={{ gridColumn: '1 / -1' }}><h3>أعمار الديون — الدفعات المتأخرة</h3>
          <table className="tbl">
            <thead><tr><th>المستأجر</th><th>الجوال</th><th>الوحدة</th><th>الاستحقاق</th><th>المستحق</th><th>أيام التأخير</th></tr></thead>
            <tbody>
              {overdue.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد متأخرات 🎉</td></tr>}
              {overdue.map((o, i) =>
                <tr key={i}><td>{o.customer_name}</td><td dir="ltr">{o.phone}</td><td>{o.unit_number}</td>
                  <td>{o.due_date}</td><td className="neg">{SAR(o.amount_due)}</td>
                  <td><span className="chip" style={{ background: o.days_late > 15 ? '#FDECEC' : '#FFF4E3', color: o.days_late > 15 ? 'var(--st-oc)' : 'var(--st-rs)' }}>{o.days_late} يوم</span></td></tr>)}
            </tbody>
          </table>
          {overdue.length > 0 &&
            <button className="btn btn-green btn-sm" style={{ marginTop: 10 }} onClick={async () => {
              for (const o of overdue) await supabase.from('notifications').insert({
                company_id: profile.company_id, channel: 'whatsapp', event_type: 'late_payment',
                title: 'تذكير دفعة متأخرة', body: `تذكير للمستأجر ${o.customer_name}: دفعة ${o.amount_due} ر.س متأخرة ${o.days_late} يوماً للوحدة ${o.unit_number}`,
                booking_id: o.booking_id, status: 'pending'
              })
              toast('✓ قُيدت تذكيرات الواتساب وسترسلها الأتمتة تلقائياً')
            }}>إرسال تذكير واتساب للجميع</button>}
        </div>

        {isOwner && <ExpenseEntry />}
      </div>
    </div>
  )
}

/* تسجيل المصروفات (كهرباء، ماء، صيانة، رواتب) لكل وحدة — مربوطة بشجرة الحسابات
   وتُصدر تلقائياً قيداً محاسبياً وسند صرف عند الحفظ (عبر trigger في القاعدة) */
function ExpenseEntry() {
  const { profile, toast } = useAuth()
  const [units, setUnits] = useState([])
  const [cashAccounts, setCashAccounts] = useState([])
  const [e, setE] = useState({ unit_id: '', category: 'electricity', amount: '', description: '', vendor_name: '', payment_method: 'cash', paid_from_account_id: '' })
  const [file, setFile] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase.from('units').select('id, unit_number').eq('company_id', profile.company_id)
      .then(({ data }) => setUnits(data || []))
    supabase.rpc('chart_of_accounts_with_balances', { p_company_id: profile.company_id })
      .then(({ data }) => setCashAccounts((data || []).filter(a => a.account_type === 'asset' && !a.is_group && (a.code === '1101' || a.code === '1102'))))
  }, [profile])

  const save = async () => {
    if (!num(e.amount)) return toast('أدخل المبلغ', true)
    setSaving(true)
    const invoice_url = file ? await uploadFile(supabase, 'documents', profile.company_id, file) : null
    const { error } = await supabase.from('expenses').insert({
      company_id: profile.company_id, unit_id: e.unit_id || null,
      category: e.category, amount: num(e.amount), description: e.description,
      vendor_name: e.vendor_name || null, payment_method: e.payment_method,
      paid_from_account_id: e.paid_from_account_id || null,
      invoice_url, created_by: profile.id
    })
    setSaving(false)
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ سُجل المصروف مع قيد محاسبي وسند صرف تلقائي')
    setE({ unit_id: '', category: 'electricity', amount: '', description: '', vendor_name: '', payment_method: 'cash', paid_from_account_id: '' })
    setFile(null)
  }
  return (
    <div className="panel" style={{ gridColumn: '1 / -1' }}><h3>تسجيل مصروف (لحساب صافي الربح الفعلي)</h3>
      <div className="grid3">
        <div><label>الوحدة (اختياري — فارغ = مصروف عام)</label>
          <select value={e.unit_id} onChange={ev => setE({ ...e, unit_id: ev.target.value })}>
            <option value="">مصروف عام</option>
            {units.map(u => <option key={u.id} value={u.id}>{u.unit_number}</option>)}
          </select></div>
        <div><label>النوع</label>
          <select value={e.category} onChange={ev => setE({ ...e, category: ev.target.value })}>
            <option value="electricity">كهرباء</option><option value="water">ماء</option>
            <option value="maintenance">صيانة</option><option value="salaries">رواتب</option>
            <option value="cleaning">نظافة</option><option value="internet">إنترنت</option><option value="other">أخرى</option>
          </select></div>
        <div><label>المبلغ (ر.س)</label><input type="number" value={e.amount} onChange={ev => setE({ ...e, amount: ev.target.value })} /></div>
        <div><label>البائع / المورد</label>
          <input value={e.vendor_name} onChange={ev => setE({ ...e, vendor_name: ev.target.value })} placeholder="اسم البائع أو المورد" /></div>
        <div><label>طريقة الدفع</label>
          <select value={e.payment_method} onChange={ev => setE({ ...e, payment_method: ev.target.value })}>
            <option value="cash">كاش</option><option value="bank_transfer">تحويل بنكي</option><option value="card">بطاقة بنكية</option>
          </select></div>
        <div><label>الصرف من حساب</label>
          <select value={e.paid_from_account_id} onChange={ev => setE({ ...e, paid_from_account_id: ev.target.value })}>
            <option value="">افتراضي (الصندوق)</option>
            {cashAccounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
          </select></div>
        <div style={{ gridColumn: '1 / span 2' }}><label>الوصف</label>
          <input value={e.description} onChange={ev => setE({ ...e, description: ev.target.value })} /></div>
        <div><label>إرفاق الفاتورة</label>
          <input type="file" accept="image/*,.pdf" onChange={ev => setFile(ev.target.files?.[0] || null)} /></div>
        <div style={{ alignSelf: 'end' }}><button className="btn btn-green btn-sm" disabled={saving} onClick={save}>{saving ? '…جارٍ الحفظ' : 'حفظ المصروف'}</button></div>
      </div>
    </div>
  )
}


/* ===== أدوات الاستخراج الفوري للمحاسب ===== */
function ExtractionTools() {
  const { profile, company, toast } = useAuth()
  const [units, setUnits] = useState([])
  const [sel, setSel] = useState('')
  const [range, setRange] = useState({ from: '', to: '' })
  const [hist, setHist] = useState(null)

  useEffect(() => {
    supabase.from('units').select('unit_number').eq('company_id', profile.company_id)
      .order('unit_number').then(({ data }) => setUnits(data || []))
  }, [profile])

  const loadHistory = async () => {
    if (!sel) return toast('اختر وحدة أولاً', true)
    const rows = await fetchBookingsRows(supabase, profile.company_id,
      { unit: sel, from: range.from || undefined, to: range.to || undefined })
    setHist(rows)
    toast(rows.length ? `وُجد ${rows.length} سجل إيجار للوحدة ${sel}` : 'لا يوجد تاريخ إيجار لهذه الوحدة في المدة المحددة')
  }

  return (
    <div className="panel"><h3>الاستخراج الفوري — تاريخ الوحدات وبيانات المستأجرين</h3>
      <div className="grid3" style={{ alignItems: 'end' }}>
        <div><label>الوحدة السكنية</label>
          <select value={sel} onChange={e => setSel(e.target.value)}>
            <option value="">اختر وحدة…</option>
            {units.map(u => <option key={u.unit_number}>{u.unit_number}</option>)}
          </select></div>
        <div><label>من تاريخ (اختياري)</label><input type="date" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} /></div>
        <div><label>إلى تاريخ (اختياري)</label><input type="date" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} /></div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-blue btn-sm" onClick={loadHistory}>عرض تاريخ إيجار الوحدة</button>
        {hist?.length > 0 && <button className="btn btn-gold btn-sm" onClick={() => {
          downloadWorkbook(`تاريخ-الوحدة-${sel}.xlsx`, [{ name: `الوحدة ${sel}`, rows: hist,
            numeric: ['الإجمالي', 'الخصم', 'العربون', 'التأمين', 'المدفوع', 'المتبقي'] }])
          toast('✓ صدر ملف إكسيل بتاريخ الوحدة مع معادلات الإجمالي')
        }}>📗 تصدير التاريخ Excel</button>}
        <button className="btn btn-ghost btn-sm" onClick={async () => {
          const rows = await fetchTenantsRows(supabase, profile.company_id)
          if (!rows.length) return toast('لا يوجد مستأجرون بعد', true)
          downloadWorkbook('بيانات-المستأجرين.xlsx', [{ name: 'المستأجرون', rows,
            numeric: ['عدد الإقامات', 'إجمالي التعاقدات', 'إجمالي المدفوع', 'نقاط الولاء'] }])
          toast(`✓ صدر ملف ببيانات ${rows.length} مستأجر`)
        }}>📇 تصدير بيانات كل المستأجرين</button>
        <button className="btn btn-ghost btn-sm" onClick={async () => {
          const rows = await fetchPaymentsRows(supabase, profile.company_id,
            { from: range.from || undefined, to: range.to || undefined, unit: sel || undefined })
          if (!rows.length) return toast('لا توجد دفعات مطابقة', true)
          downloadWorkbook('الدفعات.xlsx', [{ name: 'الدفعات', rows, numeric: ['المبلغ'] }])
          toast(`✓ صدر ملف بـ ${rows.length} دفعة`)
        }}>💳 تصدير الدفعات</button>
      </div>
      {hist && hist.length > 0 && (
        <div style={{ marginTop: 14, overflowX: 'auto' }}>
          <table className="tbl">
            <thead><tr>{Object.keys(hist[0]).map(h => <th key={h}>{h}</th>)}</tr></thead>
            <tbody>{hist.map((r, i) => <tr key={i}>{Object.entries(r).map(([k, v]) =>
              <td key={k} className={['الإجمالي','المدفوع'].includes(k) ? 'money' : k === 'المتبقي' && v > 0 ? 'neg' : ''}>
                {typeof v === 'number' ? v.toLocaleString() : v}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
    </div>
  )
}

/* ===== الرسومات البيانية الحية ===== */
function ChartsRow({ profit }) {
  const { profile } = useAuth()
  const [monthly, setMonthly] = useState([])
  const [statusDist, setStatusDist] = useState([])

  useEffect(() => {
    (async () => {
      const cid = profile.company_id
      // إيراد آخر 6 أشهر
      const start = new Date(); start.setMonth(start.getMonth() - 5); start.setDate(1)
      const { data: pays } = await supabase.from('payments').select('amount, payment_date')
        .eq('company_id', cid).gte('payment_date', start.toISOString().slice(0, 10))
      const buckets = {}
      for (let i = 0; i < 6; i++) {
        const d = new Date(); d.setMonth(d.getMonth() - (5 - i))
        buckets[d.toISOString().slice(0, 7)] = { label: d.toLocaleDateString('ar-SA', { month: 'short' }), v: 0 }
      }
      for (const p of pays || []) {
        const k = p.payment_date.slice(0, 7)
        if (buckets[k]) buckets[k].v += num(p.amount)
      }
      setMonthly(Object.values(buckets))
      // توزيع حالات الوحدات
      const { data: us } = await supabase.from('units').select('status').eq('company_id', cid)
      const dist = {}
      for (const u of us || []) dist[u.status] = (dist[u.status] || 0) + 1
      setStatusDist(Object.entries(dist))
    })()
  }, [profile])

  const maxM = Math.max(...monthly.map(m => m.v), 1)
  const totalU = statusDist.reduce((s, [, v]) => s + v, 0) || 1
  const COLORS = { available: 'var(--st-av)', reserved: 'var(--st-rs)', occupied: 'var(--st-oc)', cleaning: 'var(--st-cl)', maintenance: 'var(--st-cl)' }
  let acc = 0
  const segs = statusDist.map(([st, v]) => {
    const from = acc / totalU * 360; acc += v
    return `${COLORS[st]} ${from}deg ${acc / totalU * 360}deg`
  }).join(', ')

  return (
    <div className="grid2">
      <div className="panel"><h3>الإيراد الشهري — آخر 6 أشهر (من بياناتك)</h3>
        <div className="bars">{monthly.map((m, i) =>
          <div className="bar" key={i}><b>{m.v ? Math.round(m.v / 1000) + 'K' : '0'}</b>
            <i style={{ height: (m.v / maxM * 100) + '%' }} />{m.label}</div>)}</div>
      </div>
      <div className="panel"><h3>توزيع حالات الوحدات الآن</h3>
        <div style={{ display: 'flex', gap: 22, alignItems: 'center' }}>
          <div style={{ width: 140, height: 140, borderRadius: '50%', flexShrink: 0,
            background: statusDist.length ? `conic-gradient(${segs})` : 'var(--soft)',
            boxShadow: 'inset 0 0 0 34px #fff, 0 6px 18px rgba(14,35,64,.12)' }} />
          <div>{statusDist.map(([st, v]) =>
            <div key={st} style={{ fontSize: 13.5, fontWeight: 700, marginBottom: 6 }}>
              <i style={{ display: 'inline-block', width: 11, height: 11, borderRadius: 3, background: COLORS[st], marginInlineEnd: 7 }} />
              {STATUS[st].label}: {v} ({Math.round(v / totalU * 100)}%)</div>)}
            {!statusDist.length && <span style={{ color: 'var(--muted)', fontSize: 13 }}>لا توجد وحدات بعد</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
