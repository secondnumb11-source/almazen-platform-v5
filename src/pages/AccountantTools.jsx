import React, { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { supabase } from '../lib/supabase'
import { useAuth } from '../AuthContext'
import { SAR, num, today } from '../lib/helpers'
import {
  fetchPaymentsRows, fetchBookingsRows, fetchTenantsRows, fetchExpensesRows,
  downloadWorkbook
} from '../lib/excel'
import { downloadPDF } from '../lib/pdf'

/* موحّد إخراج التقارير: Excel أو PDF بنفس الفلاتر والبيانات */
function emitReport(fmt, filename, title, sheets, filters, company) {
  if (fmt === 'pdf') {
    return downloadPDF({ title, sheets, filters, company, subtitle: filename })
  }
  return downloadWorkbook(filename.endsWith('.xlsx') ? filename : filename + '.xlsx', sheets)
}


/* ==============================================================
   منشئ التقارير المخصص + أدوات المحاسب المتقدمة
   يسمح للمحاسب باختيار أي مجموعة بيانات + مدة + وحدة/فئة
   وإصدار ملف Excel جاهز بمعادلات SUM/AVERAGE
============================================================== */
export default function AccountantTools() {
  const { profile, company, toast } = useAuth()
  const [units, setUnits] = useState([])
  const [showAI, setShowAI] = useState(false)

  useEffect(() => {
    supabase.from('units').select('unit_number').eq('company_id', profile.company_id)
      .order('unit_number').then(({ data }) => setUnits(data || []))
  }, [profile])

  return (
    <>
      <div className="ai-toggle-bar">
        <button className={'ai-toggle-btn' + (showAI ? ' open' : '')} onClick={() => setShowAI(v => !v)}>
          <span className="ai-toggle-ico">🤖</span>
          <span className="ai-toggle-lbl">المساعد الذكي للمحاسب</span>
          <span className="ai-toggle-sub">اسأل بلغة طبيعية واحصل على تقارير وتحليلات فورية</span>
          <span className="ai-toggle-arrow">{showAI ? '▲' : '▼'}</span>
        </button>
        <div className={'ai-toggle-body' + (showAI ? ' open' : '')}>
          <EmbeddedAssistant />
        </div>
      </div>
      <ReportBuilder units={units} />
      <div className="tools-grid">
        <VatReportTool />
        <CashFlowTool />
        <AgingBucketsTool />
        <PeriodComparisonTool />
        <BalanceSheetTool />
        <IncomeStatementTool />
        <VouchersGroupedTool />
        <ExpensesGroupedTool />
        <UnitPricingListTool units={units} />
        <AttachmentsTool />
      </div>
    </>
  )
}

/* ================= الميزانية العمومية (مهم جداً) ================= */
function BalanceSheetTool() {
  const { profile, company, toast } = useAuth()
  const [busy, setBusy] = useState(false)
  const [asOf, setAsOf] = useState(today())
  const [rows, setRows] = useState(null)

  const load = async () => {
    const { data, error } = await supabase.rpc('balance_sheet', { p_company_id: profile.company_id, p_as_of: asOf })
    if (error) { toast('خطأ: ' + error.message, true); return null }
    return data || []
  }

  const view = async () => { setBusy(true); setRows(await load()); setBusy(false) }

  const run = async (fmt) => {
    setBusy(true)
    try {
      const data = await load()
      if (!data) return
      const bySection = { 'الأصول': [], 'الخصوم': [], 'حقوق الملكية': [] }
      for (const r of data) bySection[r.section]?.push({ 'الرمز': r.code, 'الحساب': r.name, 'الرصيد': num(r.balance) })
      const totalAssets = bySection['الأصول'].reduce((s, r) => s + r['الرصيد'], 0)
      const totalLiabEquity = [...bySection['الخصوم'], ...bySection['حقوق الملكية']].reduce((s, r) => s + r['الرصيد'], 0)
      const sheets = [
        { name: 'الأصول', rows: bySection['الأصول'], numeric: ['الرصيد'] },
        { name: 'الخصوم', rows: bySection['الخصوم'], numeric: ['الرصيد'] },
        { name: 'حقوق الملكية', rows: bySection['حقوق الملكية'], numeric: ['الرصيد'] },
        { name: 'ملخص التوازن', rows: [
          { 'البند': 'إجمالي الأصول', 'القيمة': totalAssets },
          { 'البند': 'إجمالي الخصوم وحقوق الملكية', 'القيمة': totalLiabEquity },
          { 'البند': 'الفرق (يجب أن يكون صفراً)', 'القيمة': Math.round((totalAssets - totalLiabEquity) * 100) / 100 }
        ], numeric: ['القيمة'] }
      ]
      emitReport(fmt, `الميزانية-العمومية-${asOf}`, 'الميزانية العمومية', sheets, { 'كما في تاريخ': asOf }, company)
      toast(`✓ صدرت الميزانية العمومية — إجمالي الأصول ${SAR(totalAssets)}`)
    } catch (e) { toast('خطأ: ' + e.message, true) } finally { setBusy(false) }
  }

  const totalAssets = rows?.filter(r => r.section === 'الأصول').reduce((s, r) => s + num(r.balance), 0) || 0
  const totalOther = rows?.filter(r => r.section !== 'الأصول').reduce((s, r) => s + num(r.balance), 0) || 0

  return (
    <div className="tool-card">
      <h4>⚖️ الميزانية العمومية</h4>
      <div className="desc">الأصول = الخصوم + حقوق الملكية — مبنية مباشرة من شجرة الحسابات والقيود الفعلية.</div>
      <div><label>كما في تاريخ</label><input type="date" value={asOf} onChange={e => setAsOf(e.target.value)} /></div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={view}>👁 عرض</button>
        <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => run('xlsx')}>📗 Excel</button>
        <button className="btn btn-blue btn-sm" disabled={busy} onClick={() => run('pdf')}>📄 PDF</button>
      </div>
      {rows && (
        <div style={{ marginTop: 10, fontSize: 13 }}>
          {['الأصول', 'الخصوم', 'حقوق الملكية'].map(sec => (
            <div key={sec} style={{ marginBottom: 8 }}>
              <b>{sec}</b>
              <table className="tbl">
                <tbody>
                  {rows.filter(r => r.section === sec).map(r => (
                    <tr key={r.code}><td dir="ltr">{r.code}</td><td>{r.name}</td><td className="money">{SAR(r.balance)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          <div style={{ fontWeight: 800 }}>
            إجمالي الأصول: <span className="money">{SAR(totalAssets)}</span> — إجمالي الخصوم وحقوق الملكية: <span className="money">{SAR(totalOther)}</span>
            {Math.abs(totalAssets - totalOther) < 0.5 ? <span style={{ color: 'var(--green)' }}> ✓ متوازنة</span> : <span className="neg"> ⚠ غير متوازنة</span>}
          </div>
        </div>
      )}
    </div>
  )
}

/* ================= قائمة الدخل (الأرباح والخسائر) ================= */
function IncomeStatementTool() {
  const { profile, company, toast } = useAuth()
  const [busy, setBusy] = useState(false)
  const [range, setRange] = useState({ from: today().slice(0, 8) + '01', to: today() })

  const run = async (fmt) => {
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('income_statement', { p_company_id: profile.company_id, p_from: range.from, p_to: range.to })
      if (error) return toast('خطأ: ' + error.message, true)
      const rev = (data || []).filter(r => r.section === 'الإيرادات')
      const exp = (data || []).filter(r => r.section === 'المصروفات')
      const totalRev = rev.reduce((s, r) => s + num(r.amount), 0)
      const totalExp = exp.reduce((s, r) => s + num(r.amount), 0)
      const sheets = [
        { name: 'الإيرادات', rows: rev.map(r => ({ 'الرمز': r.code, 'الحساب': r.name, 'المبلغ': num(r.amount) })), numeric: ['المبلغ'] },
        { name: 'المصروفات', rows: exp.map(r => ({ 'الرمز': r.code, 'الحساب': r.name, 'المبلغ': num(r.amount) })), numeric: ['المبلغ'] },
        { name: 'الملخص', rows: [
          { 'البند': 'إجمالي الإيرادات', 'القيمة': totalRev },
          { 'البند': 'إجمالي المصروفات', 'القيمة': totalExp },
          { 'البند': 'صافي الربح / الخسارة', 'القيمة': totalRev - totalExp }
        ], numeric: ['القيمة'] }
      ]
      emitReport(fmt, `قائمة-الدخل-${range.from}-${range.to}`, 'قائمة الدخل (الأرباح والخسائر)', sheets, { 'من': range.from, 'إلى': range.to }, company)
      toast(`✓ صدرت قائمة الدخل — صافي ${SAR(totalRev - totalExp)}`)
    } catch (e) { toast('خطأ: ' + e.message, true) } finally { setBusy(false) }
  }

  return (
    <div className="tool-card">
      <h4>📉 قائمة الدخل — الأرباح والخسائر</h4>
      <div className="desc">إجمالي الإيرادات ناقص إجمالي المصروفات حسب شجرة الحسابات لفترة محددة.</div>
      <div className="grid2" style={{ marginBottom: 8 }}>
        <div><label>من</label><input type="date" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} /></div>
        <div><label>إلى</label><input type="date" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} /></div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => run('xlsx')}>📗 Excel</button>
        <button className="btn btn-blue btn-sm" disabled={busy} onClick={() => run('pdf')}>📄 PDF</button>
      </div>
    </div>
  )
}

/* ================= تقرير السندات المجمّع (حسب الجهة/الفئة) ================= */
function VouchersGroupedTool() {
  const { profile, company, toast } = useAuth()
  const [type, setType] = useState('receipt')
  const [busy, setBusy] = useState(false)
  const [range, setRange] = useState({ from: today().slice(0, 8) + '01', to: today() })

  const run = async (fmt) => {
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('vouchers_summary', {
        p_company_id: profile.company_id, p_voucher_type: type, p_from: range.from, p_to: range.to
      })
      if (error) return toast('خطأ: ' + error.message, true)
      const PL = { tenant: 'مستأجر', vendor: 'مورد', employee: 'موظف', other: 'أخرى' }
      const rows = (data || []).map(r => ({ 'الجهة': r.party_name, 'التصنيف': PL[r.party_type] || r.party_type, 'عدد السندات': Number(r.voucher_count), 'الإجمالي': num(r.total_amount) }))
      const total = rows.reduce((s, r) => s + r['الإجمالي'], 0)
      emitReport(fmt, `تقرير-${type === 'receipt' ? 'سندات-القبض' : 'سندات-الصرف'}-${range.from}-${range.to}`,
        type === 'receipt' ? 'تقرير سندات القبض المجمّع' : 'تقرير سندات الصرف المجمّع',
        [{ name: 'التجميع', rows, numeric: ['عدد السندات', 'الإجمالي'] }],
        { 'من': range.from, 'إلى': range.to }, company)
      toast(`✓ صدر التقرير — إجمالي ${SAR(total)} عبر ${rows.length} جهة`)
    } catch (e) { toast('خطأ: ' + e.message, true) } finally { setBusy(false) }
  }

  return (
    <div className="tool-card">
      <h4>🧾 تقرير السندات المجمّع</h4>
      <div className="desc">سندات القبض أو الصرف مجمّعة حسب الجهة (مستأجر/مورد/موظف) لفترة محددة.</div>
      <div className="grid3" style={{ marginBottom: 8 }}>
        <div><label>النوع</label>
          <select value={type} onChange={e => setType(e.target.value)}>
            <option value="receipt">سندات القبض</option><option value="payment">سندات الصرف</option>
          </select></div>
        <div><label>من</label><input type="date" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} /></div>
        <div><label>إلى</label><input type="date" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} /></div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => run('xlsx')}>📗 Excel</button>
        <button className="btn btn-blue btn-sm" disabled={busy} onClick={() => run('pdf')}>📄 PDF</button>
      </div>
    </div>
  )
}

/* ================= تقرير المصروفات المجمّع (حسب البائع/النوع/الوحدة) ================= */
function ExpensesGroupedTool() {
  const { profile, company, toast } = useAuth()
  const [busy, setBusy] = useState(false)
  const [range, setRange] = useState({ from: today().slice(0, 8) + '01', to: today() })
  const EC = { electricity: 'كهرباء', water: 'ماء', maintenance: 'صيانة', salaries: 'رواتب', cleaning: 'نظافة', internet: 'إنترنت', other: 'أخرى' }

  const run = async (fmt) => {
    setBusy(true)
    try {
      const { data } = await supabase.from('expenses')
        .select('category, vendor_name, amount, units(unit_number)')
        .eq('company_id', profile.company_id).gte('expense_date', range.from).lte('expense_date', range.to)
      const byCat = {}, byVendor = {}
      for (const e of data || []) {
        const c = EC[e.category] || e.category
        byCat[c] = (byCat[c] || 0) + num(e.amount)
        const v = e.vendor_name || '—'
        byVendor[v] = (byVendor[v] || 0) + num(e.amount)
      }
      const rowsCat = Object.entries(byCat).map(([k, v]) => ({ 'التصنيف': k, 'الإجمالي': v }))
      const rowsVendor = Object.entries(byVendor).map(([k, v]) => ({ 'البائع/المورد': k, 'الإجمالي': v }))
      const total = rowsCat.reduce((s, r) => s + r['الإجمالي'], 0)
      emitReport(fmt, `تقرير-المصروفات-المجمع-${range.from}-${range.to}`, 'تقرير المصروفات المجمّع',
        [
          { name: 'حسب التصنيف', rows: rowsCat, numeric: ['الإجمالي'] },
          { name: 'حسب البائع', rows: rowsVendor, numeric: ['الإجمالي'] }
        ], { 'من': range.from, 'إلى': range.to }, company)
      toast(`✓ صدر تقرير المصروفات — إجمالي ${SAR(total)}`)
    } catch (e) { toast('خطأ: ' + e.message, true) } finally { setBusy(false) }
  }

  return (
    <div className="tool-card">
      <h4>💸 تقرير المصروفات المجمّع</h4>
      <div className="desc">مجمّع حسب التصنيف والبائع/المورد لفترة محددة — لتحليل بنود الصرف.</div>
      <div className="grid2" style={{ marginBottom: 8 }}>
        <div><label>من</label><input type="date" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} /></div>
        <div><label>إلى</label><input type="date" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} /></div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => run('xlsx')}>📗 Excel</button>
        <button className="btn btn-blue btn-sm" disabled={busy} onClick={() => run('pdf')}>📄 PDF</button>
      </div>
    </div>
  )
}

/* ================= قائمة أسعار الوحدات (يومي/شهري/سنوي) ================= */
function UnitPricingListTool() {
  const { profile, company, toast } = useAuth()
  const [busy, setBusy] = useState(false)

  const run = async (fmt) => {
    setBusy(true)
    try {
      const { data } = await supabase.from('units')
        .select('unit_number, category, daily_price, monthly_price, yearly_price, status')
        .eq('company_id', profile.company_id).order('unit_number')
      const CATS = { apartment: 'شقة سكنية', chalet: 'شاليه', furnished_unit: 'وحدة مفروشة', hotel_room: 'غرفة فندقية' }
      const ST = { available: 'متاح', reserved: 'محجوز', occupied: 'مسكون', cleaning: 'تنظيف', maintenance: 'صيانة' }
      const rows = (data || []).map(u => ({
        'الوحدة': u.unit_number, 'الفئة': CATS[u.category] || u.category, 'الحالة': ST[u.status] || u.status,
        'السعر اليومي': num(u.daily_price), 'السعر الشهري': num(u.monthly_price), 'السعر السنوي': num(u.yearly_price)
      }))
      emitReport(fmt, `قائمة-أسعار-الوحدات-${today()}`, 'قائمة أسعار الوحدات السكنية',
        [{ name: 'الأسعار', rows, numeric: ['السعر اليومي', 'السعر الشهري', 'السعر السنوي'] }], {}, company)
      toast(`✓ صدرت قائمة الأسعار — ${rows.length} وحدة`)
    } catch (e) { toast('خطأ: ' + e.message, true) } finally { setBusy(false) }
  }

  return (
    <div className="tool-card">
      <h4>🏷️ قائمة أسعار الوحدات</h4>
      <div className="desc">كل الوحدات بأسعارها اليومية والشهرية والسنوية — جاهزة للمشاركة مع العملاء أو الأرشفة.</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => run('xlsx')}>📗 Excel</button>
        <button className="btn btn-blue btn-sm" disabled={busy} onClick={() => run('pdf')}>📄 PDF</button>
      </div>
    </div>
  )
}

/* ================= مركز المرفقات — للمحاسب فقط ================= */
function AttachmentsTool() {
  const { profile, toast } = useAuth()
  const [kind, setKind] = useState('ids')
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(false)

  const load = async (k) => {
    setLoading(true)
    const cid = profile.company_id
    if (k === 'ids') {
      const { data } = await supabase.from('customers').select('full_name, id_number, id_document_url, phone')
        .eq('company_id', cid).not('id_document_url', 'is', null)
      setRows((data || []).map(c => ({ label: c.full_name, sub: c.id_number, url: c.id_document_url })))
    } else if (k === 'payment_proofs') {
      const { data } = await supabase.from('payments').select('amount, payment_date, document_url, bookings(customers(full_name))')
        .eq('company_id', cid).not('document_url', 'is', null).order('payment_date', { ascending: false })
      setRows((data || []).map(p => ({ label: p.bookings?.customers?.full_name || 'مستأجر', sub: `${p.payment_date} — ${SAR(p.amount)}`, url: p.document_url })))
    } else if (k === 'invoices') {
      const { data } = await supabase.from('expenses').select('description, vendor_name, expense_date, amount, invoice_url')
        .eq('company_id', cid).not('invoice_url', 'is', null).order('expense_date', { ascending: false })
      setRows((data || []).map(e => ({ label: e.vendor_name || e.description || 'مصروف', sub: `${e.expense_date} — ${SAR(e.amount)}`, url: e.invoice_url })))
    }
    setLoading(false)
  }
  useEffect(() => { load(kind) }, [kind, profile])

  return (
    <div className="tool-card" style={{ gridColumn: '1 / -1' }}>
      <h4>📎 مركز المرفقات — إيصالات، هويات، فواتير</h4>
      <div className="desc">كل المرفقات التي أدخلها الموظفون عند الحجز أو تسجيل المصروفات، في مكان واحد للمراجعة.</div>
      <div className="acc-tabs" style={{ marginBottom: 10 }}>
        <button className={kind === 'ids' ? 'on' : ''} onClick={() => setKind('ids')}>🪪 صور الهويات</button>
        <button className={kind === 'payment_proofs' ? 'on' : ''} onClick={() => setKind('payment_proofs')}>🧾 إيصالات السداد</button>
        <button className={kind === 'invoices' ? 'on' : ''} onClick={() => setKind('invoices')}>📄 فواتير المصروفات</button>
      </div>
      {loading ? <p style={{ color: 'var(--muted)' }}>جارٍ التحميل…</p> : (
        <table className="tbl">
          <thead><tr><th>الجهة</th><th>التفاصيل</th><th></th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد مرفقات من هذا النوع بعد</td></tr>}
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.label}</td><td>{r.sub}</td>
                <td><a className="btn btn-ghost btn-sm" href={r.url} target="_blank" rel="noreferrer">🔍 عرض</a></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/* ================= مساعد ذكي مدمج في بوابة المحاسب ================= */
function EmbeddedAssistant() {
  const { profile } = useAuth()
  const [input, setInput] = useState('')
  const box = useRef(null)

  const supaUrl = import.meta.env.VITE_SUPABASE_URL || 'https://drowmezlcrvowuhqmfef.supabase.co'
  const supaKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY

  const [transport] = useState(() => new DefaultChatTransport({
    api: `${supaUrl}/functions/v1/ai-assistant`,
    headers: async () => {
      const { data: { session } } = await supabase.auth.getSession()
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || supaKey}`,
        'apikey': supaKey || '',
      }
    },
    prepareSendMessagesRequest: ({ messages }) => ({
      body: { messages, company_id: profile?.company_id }
    }),
  }))

  const { messages, sendMessage, status, error } = useChat({ transport })
  useEffect(() => { box.current?.scrollTo(0, 1e9) }, [messages, status])
  const isLoading = status === 'submitted' || status === 'streaming'

  const ask = (text) => {
    const t = (text ?? input).trim()
    if (!t || isLoading) return
    setInput('')
    sendMessage({ text: t })
  }

  const renderPart = (p, i) => {
    if (p.type === 'text') return <ReactMarkdown key={i}>{p.text}</ReactMarkdown>
    if (p.type?.startsWith('tool-')) {
      return <div key={i} className="ai-tool"><b>⚙ {p.type.slice(5)}</b>
        {p.state === 'output-available' && <div className="ai-tool-out">✓ {p.output?.count != null ? `${p.output.count} سجل` : 'نُفّذ'}</div>}
      </div>
    }
    return null
  }

  const hints = [
    'ملخص إيرادات هذا الشهر مقارنة بالسابق',
    'المستأجرون المتأخرون عن السداد',
    'ضريبة القيمة المضافة المستحقة هذا الربع',
    'الوحدات الأعلى إيراداً هذا العام',
  ]

  return (
    <div className="ai-embedded panel">
      <div className="ai-box" style={{ height: 380 }}>
        <div className="ai-msgs" ref={box}>
          {messages.length === 0 && (
            <div className="msg a">
              <ReactMarkdown>{'اسألني عن أي تقرير مالي، تحليل إيرادات، متأخرات، أو استفسار محاسبي...'}</ReactMarkdown>
            </div>
          )}
          {messages.map(m => (
            <div key={m.id} className={'msg ' + (m.role === 'assistant' ? 'a' : 'u')}>
              {m.parts?.map(renderPart) || m.content}
            </div>
          ))}
          {status === 'submitted' && <div className="msg a"><i>⏳ جارٍ التحليل…</i></div>}
          {error && <div className="msg a" style={{ color: '#c00' }}>خطأ: {error.message}</div>}
        </div>
        <div className="suggest">{hints.map(s => <button key={s} onClick={() => ask(s)} disabled={isLoading}>{s}</button>)}</div>
        <div className="ai-in">
          <input value={input} onChange={e => setInput(e.target.value)}
            placeholder="اطلب تقريراً أو تحليلاً محاسبياً…"
            onKeyDown={e => e.key === 'Enter' && ask()} disabled={isLoading} />
          <button className="btn btn-gold btn-sm" onClick={() => ask()} disabled={isLoading}>
            {isLoading ? '…' : 'إرسال'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ================= منشئ التقارير المخصص ================= */
function ReportBuilder({ units }) {
  const { profile, company, toast } = useAuth()
  const [sel, setSel] = useState({ payments: true, bookings: true, expenses: false, tenants: false })
  const [f, setF] = useState({ from: '', to: '', unit: '' })
  const [busy, setBusy] = useState(false)

  const toggle = (k) => setSel(s => ({ ...s, [k]: !s[k] }))

  const build = async (fmt = 'xlsx') => {
    const wanted = Object.entries(sel).filter(([, v]) => v).map(([k]) => k)
    if (!wanted.length) return toast('اختر ورقة واحدة على الأقل', true)
    setBusy(true)
    try {
      const cid = profile.company_id
      const opts = { from: f.from || undefined, to: f.to || undefined, unit: f.unit || undefined }
      const sheets = []
      if (sel.payments) {
        const rows = await fetchPaymentsRows(supabase, cid, opts)
        sheets.push({ name: 'الدفعات', rows, numeric: ['المبلغ'] })
      }
      if (sel.bookings) {
        const rows = await fetchBookingsRows(supabase, cid, opts)
        sheets.push({ name: 'الحجوزات', rows,
          numeric: ['الإجمالي', 'الخصم', 'العربون', 'التأمين', 'المدفوع', 'المتبقي'] })
      }
      if (sel.expenses) {
        const rows = await fetchExpensesRows(supabase, cid, opts)
        sheets.push({ name: 'المصروفات', rows, numeric: ['المبلغ'] })
      }
      if (sel.tenants) {
        const rows = await fetchTenantsRows(supabase, cid)
        sheets.push({ name: 'المستأجرون', rows,
          numeric: ['عدد الإقامات', 'إجمالي التعاقدات', 'إجمالي المدفوع', 'نقاط الولاء'] })
      }
      const summary = []
      for (const s of sheets) {
        const numCol = s.numeric?.[0]
        const total = numCol ? s.rows.reduce((t, r) => t + Number(r[numCol] || 0), 0) : s.rows.length
        summary.push({ 'الورقة': s.name, 'عدد السجلات': s.rows.length, 'إجمالي الحقل الرئيسي': total })
      }
      sheets.unshift({ name: 'ملخص التقرير', rows: summary, numeric: ['عدد السجلات', 'إجمالي الحقل الرئيسي'] })

      const total = sheets.reduce((s, x) => s + (x.rows?.length || 0), 0)
      if (total === 0) return toast('لا توجد بيانات مطابقة للفلاتر — جرّب توسيع النطاق', true)
      const filenameParts = ['تقرير-مخصص', company?.name || 'المازن', new Date().toISOString().slice(0, 10)]
      const filters = { 'من': f.from || '—', 'إلى': f.to || '—', 'الوحدة': f.unit || 'الكل' }
      emitReport(fmt, filenameParts.join('-'), 'تقرير مخصص شامل', sheets, filters, company)
      toast(`✓ صدر التقرير (${fmt === 'pdf' ? 'PDF' : 'Excel'}): ${sheets.length} ورقة و ${total} سجل`)
    } catch (e) { toast('خطأ: ' + e.message, true) } finally { setBusy(false) }
  }


  return (
    <div className="builder">
      <h3>منشئ التقارير المخصص — اختر ما تريد استخراجه</h3>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
        حدد الأوراق التي تريدها، ثم قصّها بالمدة والوحدة، وسيتم إصدار ملف Excel احترافي بمعادلات جاهزة.
      </p>

      <div className="check-row">
        {[
          ['payments', '💳 الدفعات'],
          ['bookings', '📋 الحجوزات والعقود'],
          ['expenses', '💸 المصروفات'],
          ['tenants', '👥 المستأجرون']
        ].map(([k, label]) => (
          <label key={k} className={sel[k] ? 'on' : ''}>
            <input type="checkbox" checked={sel[k]} onChange={() => toggle(k)} />
            {label}
          </label>
        ))}
      </div>

      <div className="grid3">
        <div><label>من تاريخ (اختياري)</label>
          <input type="date" value={f.from} onChange={e => setF({ ...f, from: e.target.value })} /></div>
        <div><label>إلى تاريخ (اختياري)</label>
          <input type="date" value={f.to} onChange={e => setF({ ...f, to: e.target.value })} /></div>
        <div><label>وحدة محددة (اختياري)</label>
          <select value={f.unit} onChange={e => setF({ ...f, unit: e.target.value })}>
            <option value="">جميع الوحدات</option>
            {units.map(u => <option key={u.unit_number}>{u.unit_number}</option>)}
          </select></div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button className="btn btn-gold" disabled={busy} onClick={() => build('xlsx')}>
          📗 Excel مخصص
        </button>
        <button className="btn btn-blue btn-sm" disabled={busy} onClick={() => build('pdf')}>
          📄 PDF مخصص
        </button>

        <button className="btn btn-ghost btn-sm" onClick={() => {
          const q = today()
          setF({ from: q.slice(0, 8) + '01', to: q, unit: '' })
        }}>هذا الشهر</button>
        <button className="btn btn-ghost btn-sm" onClick={() => {
          const d = new Date()
          const from = new Date(d.getFullYear(), d.getMonth() - 2, 1).toISOString().slice(0, 10)
          setF({ from, to: today(), unit: '' })
        }}>آخر 3 أشهر</button>
        <button className="btn btn-ghost btn-sm" onClick={() => {
          const y = new Date().getFullYear()
          setF({ from: `${y}-01-01`, to: today(), unit: '' })
        }}>هذه السنة</button>
        <button className="btn btn-ghost btn-sm" onClick={() => setF({ from: '', to: '', unit: '' })}>
          مسح الفلاتر
        </button>
      </div>
    </div>
  )
}

/* ================= تقرير ضريبة القيمة المضافة ================= */
function VatReportTool() {
  const { profile, company, toast } = useAuth()
  const [busy, setBusy] = useState(false)
  const [range, setRange] = useState({ from: today().slice(0, 8) + '01', to: today() })

  const run = async (fmt = 'xlsx') => {
    setBusy(true)
    try {
      const cid = profile.company_id
      const vatRate = num(company?.default_vat_rate ?? 15)
      const { data: pays } = await supabase.from('payments')
        .select('amount, payment_date, payment_type, bookings(units(unit_number))')
        .eq('company_id', cid).gte('payment_date', range.from).lte('payment_date', range.to)
      const rows = (pays || []).map(p => {
        const gross = num(p.amount)
        const subtotal = Math.round(gross / (1 + vatRate / 100) * 100) / 100
        const vat = Math.round((gross - subtotal) * 100) / 100
        return {
          'التاريخ': p.payment_date, 'الوحدة': p.bookings?.units?.unit_number || '—',
          'نوع الدفعة': { rent: 'إيجار', down_payment: 'عربون', insurance: 'تأمين', penalty: 'غرامة', other: 'أخرى' }[p.payment_type] || p.payment_type,
          'الإجمالي شامل الضريبة': gross,
          'الأساس قبل الضريبة': subtotal,
          [`ض.ق.م ${vatRate}%`]: vat
        }
      })
      const total = rows.reduce((s, r) => s + r['الإجمالي شامل الضريبة'], 0)
      const vatSum = rows.reduce((s, r) => s + r[`ض.ق.م ${vatRate}%`], 0)
      const summary = [
        { 'البند': 'المنشأة', 'القيمة': company?.name || '' },
        { 'البند': 'الرقم الضريبي', 'القيمة': company?.vat_number || '—' },
        { 'البند': 'إجمالي المبيعات شامل الضريبة', 'القيمة': total },
        { 'البند': 'الأساس الخاضع للضريبة', 'القيمة': total - vatSum },
        { 'البند': `الضريبة المستحقة (${vatRate}%)`, 'القيمة': vatSum },
        { 'البند': 'عدد الفواتير/الدفعات', 'القيمة': rows.length }
      ]
      const sheets = [
        { name: 'ملخص الإقرار', rows: summary },
        { name: 'التفاصيل', rows, numeric: ['الإجمالي شامل الضريبة', 'الأساس قبل الضريبة', `ض.ق.م ${vatRate}%`] }
      ]
      emitReport(fmt, `تقرير-ضريبي-${range.from}-${range.to}`,
        `إقرار ضريبة القيمة المضافة (ZATCA)`, sheets,
        { 'من': range.from, 'إلى': range.to, 'نسبة الضريبة': vatRate + '%' }, company)
      toast(`✓ صدر إقرار ض.ق.م (${fmt.toUpperCase()}): إجمالي ${SAR(total)} — الضريبة ${SAR(vatSum)}`)
    } catch (e) { toast('خطأ: ' + e.message, true) } finally { setBusy(false) }
  }

  return (
    <div className="tool-card">
      <h4>🧾 إقرار ضريبة القيمة المضافة (ZATCA)</h4>
      <div className="desc">تقرير شامل لإقرار ض.ق.م: الإجمالي، الأساس، الضريبة المستحقة، عدد الفواتير — جاهز للتقديم.</div>
      <div className="grid2" style={{ marginBottom: 8 }}>
        <div><label>من</label><input type="date" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} /></div>
        <div><label>إلى</label><input type="date" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} /></div>
      </div>
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
        <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => run('xlsx')}>📗 Excel</button>
        <button className="btn btn-blue btn-sm" disabled={busy} onClick={() => run('pdf')}>📄 PDF</button>
      </div>
    </div>
  )
}


/* ================= التدفق النقدي ================= */
function CashFlowTool() {
  const { profile, toast } = useAuth()
  const [busy, setBusy] = useState(false)
  const [range, setRange] = useState({ from: today().slice(0, 8) + '01', to: today() })

  const run = async (fmt = 'xlsx') => {
    setBusy(true)
    try {
      const cid = profile.company_id
      const [{ data: pays }, { data: exps }] = await Promise.all([
        supabase.from('payments').select('amount, method, payment_date')
          .eq('company_id', cid).gte('payment_date', range.from).lte('payment_date', range.to),
        supabase.from('expenses').select('amount, category, expense_date')
          .eq('company_id', cid).gte('expense_date', range.from).lte('expense_date', range.to)
      ])
      const daily = {}
      for (const p of pays || []) {
        const d = p.payment_date
        daily[d] = daily[d] || { 'التاريخ': d, 'تدفق داخل': 0, 'تدفق خارج': 0, 'صافي': 0 }
        daily[d]['تدفق داخل'] += num(p.amount)
      }
      for (const e of exps || []) {
        const d = e.expense_date
        daily[d] = daily[d] || { 'التاريخ': d, 'تدفق داخل': 0, 'تدفق خارج': 0, 'صافي': 0 }
        daily[d]['تدفق خارج'] += num(e.amount)
      }
      const rows = Object.values(daily).sort((a, b) => a['التاريخ'].localeCompare(b['التاريخ']))
      let running = 0
      rows.forEach(r => { r['صافي'] = r['تدفق داخل'] - r['تدفق خارج']; running += r['صافي']; r['الرصيد التراكمي'] = running })

      const byMethod = {}
      for (const p of pays || []) {
        const m = { cash: 'كاش', bank_transfer: 'تحويل بنكي', card: 'بطاقة' }[p.method] || p.method
        byMethod[m] = (byMethod[m] || 0) + num(p.amount)
      }
      const methodRows = Object.entries(byMethod).map(([k, v]) => ({ 'طريقة الدفع': k, 'الإجمالي': v }))

      const totalIn = rows.reduce((s, r) => s + r['تدفق داخل'], 0)
      const totalOut = rows.reduce((s, r) => s + r['تدفق خارج'], 0)
      const summary = [
        { 'البند': 'إجمالي التدفق الداخل', 'القيمة': totalIn },
        { 'البند': 'إجمالي التدفق الخارج', 'القيمة': totalOut },
        { 'البند': 'صافي التدفق النقدي', 'القيمة': totalIn - totalOut },
        { 'البند': 'عدد أيام النشاط', 'القيمة': rows.length }
      ]
      const sheets = [
        { name: 'ملخص', rows: summary, numeric: ['القيمة'] },
        { name: 'يومي', rows, numeric: ['تدفق داخل', 'تدفق خارج', 'صافي', 'الرصيد التراكمي'] },
        { name: 'حسب طريقة الدفع', rows: methodRows, numeric: ['الإجمالي'] }
      ]
      emitReport(fmt, `تدفق-نقدي-${range.from}-${range.to}`, 'قائمة التدفق النقدي',
        sheets, { 'من': range.from, 'إلى': range.to }, null)
      toast(`✓ صدر التدفق النقدي (${fmt.toUpperCase()}): صافي ${SAR(totalIn - totalOut)}`)
    } catch (e) { toast('خطأ: ' + e.message, true) } finally { setBusy(false) }
  }

  return (
    <div className="tool-card">
      <h4>💰 قائمة التدفق النقدي</h4>
      <div className="desc">تدفق يومي داخل/خارج مع الرصيد التراكمي، وتوزيع الإيرادات حسب طريقة الدفع.</div>
      <div className="grid2" style={{ marginBottom: 8 }}>
        <div><label>من</label><input type="date" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} /></div>
        <div><label>إلى</label><input type="date" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} /></div>
      </div>
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
        <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => run('xlsx')}>📗 Excel</button>
        <button className="btn btn-blue btn-sm" disabled={busy} onClick={() => run('pdf')}>📄 PDF</button>
      </div>
    </div>
  )
}


/* ================= أعمار الديون (شرائح متعددة) ================= */
function AgingBucketsTool() {
  const { profile, toast } = useAuth()
  const [busy, setBusy] = useState(false)
  const [data, setData] = useState(null)

  const run = async (fmt = 'xlsx') => {
    setBusy(true)
    try {
      const cid = profile.company_id
      const { data: od } = await supabase.rpc('overdue_payments', { p_company: cid, p_days: 1 })
      const buckets = { '1-15': [], '16-30': [], '31-60': [], '61-90': [], '90+': [] }
      for (const o of od || []) {
        const d = o.days_late
        const k = d <= 15 ? '1-15' : d <= 30 ? '16-30' : d <= 60 ? '31-60' : d <= 90 ? '61-90' : '90+'
        buckets[k].push(o)
      }
      const summary = Object.entries(buckets).map(([bucket, arr]) => ({
        'الشريحة (أيام تأخير)': bucket,
        'عدد المستأجرون': arr.length,
        'إجمالي المستحق': arr.reduce((s, o) => s + num(o.amount_due), 0)
      }))
      setData({ buckets, summary })

      const rows = (od || []).map(o => ({
        'المستأجر': o.customer_name, 'الجوال': o.phone, 'الوحدة': o.unit_number,
        'الاستحقاق': o.due_date, 'المبلغ المستحق': num(o.amount_due), 'أيام التأخير': o.days_late,
        'الشريحة': o.days_late <= 15 ? '1-15' : o.days_late <= 30 ? '16-30' : o.days_late <= 60 ? '31-60' : o.days_late <= 90 ? '61-90' : '90+'
      }))
      const sheets = [
        { name: 'ملخص الشرائح', rows: summary, numeric: ['عدد المستأجرون', 'إجمالي المستحق'] },
        { name: 'التفاصيل', rows, numeric: ['المبلغ المستحق', 'أيام التأخير'] }
      ]
      emitReport(fmt, `أعمار-الديون-${today()}`, 'تقرير أعمار الديون', sheets, {}, null)
      toast(`✓ صدر تقرير أعمار الديون (${fmt.toUpperCase()}): ${od?.length || 0} حالة`)
    } catch (e) { toast('خطأ: ' + e.message, true) } finally { setBusy(false) }
  }

  return (
    <div className="tool-card">
      <h4>📊 أعمار الديون (شرائح)</h4>
      <div className="desc">توزيع المتأخرات على شرائح 1-15/16-30/31-60/61-90/90+ يوم لأولوية التحصيل.</div>
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
        <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => run('xlsx')}>📗 Excel</button>
        <button className="btn btn-blue btn-sm" disabled={busy} onClick={() => run('pdf')}>📄 PDF</button>
      </div>

      {data && (
        <table className="tbl" style={{ marginTop: 10 }}>
          <thead><tr><th>الشريحة</th><th>المستأجرون</th><th>المستحق</th></tr></thead>
          <tbody>
            {data.summary.map(r => (
              <tr key={r['الشريحة (أيام تأخير)']}>
                <td>{r['الشريحة (أيام تأخير)']} يوم</td>
                <td>{r['عدد المستأجرون']}</td>
                <td className={r['إجمالي المستحق'] > 0 ? 'neg' : ''}>{SAR(r['إجمالي المستحق'])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

/* ================= مقارنة الفترات ================= */
function PeriodComparisonTool() {
  const { profile, toast } = useAuth()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)

  const run = async (fmt = 'xlsx') => {
    setBusy(true)
    try {
      const cid = profile.company_id
      const now = new Date()
      const thisMonthFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
      const lastMonthFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10)
      const lastMonthTo = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10)
      const to = today()
      const fetchPeriod = async (from, upto) => {
        const [{ data: p }, { data: e }] = await Promise.all([
          supabase.from('payments').select('amount').eq('company_id', cid).gte('payment_date', from).lte('payment_date', upto),
          supabase.from('expenses').select('amount').eq('company_id', cid).gte('expense_date', from).lte('expense_date', upto)
        ])
        const rev = (p || []).reduce((s, x) => s + num(x.amount), 0)
        const exp = (e || []).reduce((s, x) => s + num(x.amount), 0)
        return { rev, exp, net: rev - exp, count: (p || []).length }
      }
      const [cur, prev] = await Promise.all([fetchPeriod(thisMonthFrom, to), fetchPeriod(lastMonthFrom, lastMonthTo)])
      const pct = (a, b) => b === 0 ? (a > 0 ? '+∞' : '0') : Math.round(((a - b) / b) * 100) + '%'
      const rows = [
        { 'المؤشر': 'الإيرادات', 'الشهر الحالي': cur.rev, 'الشهر السابق': prev.rev, 'التغيّر': pct(cur.rev, prev.rev) },
        { 'المؤشر': 'المصروفات', 'الشهر الحالي': cur.exp, 'الشهر السابق': prev.exp, 'التغيّر': pct(cur.exp, prev.exp) },
        { 'المؤشر': 'صافي الربح', 'الشهر الحالي': cur.net, 'الشهر السابق': prev.net, 'التغيّر': pct(cur.net, prev.net) },
        { 'المؤشر': 'عدد الدفعات', 'الشهر الحالي': cur.count, 'الشهر السابق': prev.count, 'التغيّر': pct(cur.count, prev.count) }
      ]
      setResult(rows)
      emitReport(fmt, `مقارنة-شهرية-${today()}`, 'مقارنة الأداء الشهري',
        [{ name: 'المقارنة', rows, numeric: ['الشهر الحالي', 'الشهر السابق'] }],
        { 'الحالي': `${thisMonthFrom} → ${to}`, 'السابق': `${lastMonthFrom} → ${lastMonthTo}` }, null)
      toast(`✓ صدرت المقارنة (${fmt.toUpperCase()}): ${SAR(cur.rev)} مقابل ${SAR(prev.rev)}`)
    } catch (e) { toast('خطأ: ' + e.message, true) } finally { setBusy(false) }
  }

  return (
    <div className="tool-card">
      <h4>📈 مقارنة الشهر الحالي بالسابق</h4>
      <div className="desc">مقارنة سريعة بين إيرادات ومصروفات وأرباح هذا الشهر والشهر السابق مع نسبة النمو.</div>
      <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
        <button className="btn btn-gold btn-sm" disabled={busy} onClick={() => run('xlsx')}>📗 Excel</button>
        <button className="btn btn-blue btn-sm" disabled={busy} onClick={() => run('pdf')}>📄 PDF</button>
      </div>

      {result && (
        <table className="tbl" style={{ marginTop: 10 }}>
          <thead><tr><th>المؤشر</th><th>الحالي</th><th>السابق</th><th>التغيّر</th></tr></thead>
          <tbody>{result.map(r => (
            <tr key={r['المؤشر']}>
              <td>{r['المؤشر']}</td>
              <td className="money">{typeof r['الشهر الحالي'] === 'number' ? r['الشهر الحالي'].toLocaleString() : r['الشهر الحالي']}</td>
              <td>{typeof r['الشهر السابق'] === 'number' ? r['الشهر السابق'].toLocaleString() : r['الشهر السابق']}</td>
              <td><span className="chip" style={{ background: String(r['التغيّر']).startsWith('-') ? '#FDECEC' : '#E7F7EE', color: String(r['التغيّر']).startsWith('-') ? 'var(--st-oc)' : 'var(--st-av)' }}>{r['التغيّر']}</span></td>
            </tr>))}</tbody>
        </table>
      )}
    </div>
  )
}
