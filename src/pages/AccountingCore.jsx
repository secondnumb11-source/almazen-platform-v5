import React, { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../AuthContext'
import { SAR, num, today, PAY_METHODS, uploadFile } from '../lib/helpers'

const ACCOUNT_TYPE_LABEL = { asset: 'أصول', liability: 'خصوم', equity: 'حقوق ملكية', revenue: 'إيرادات', expense: 'مصروفات' }
const PARTY_LABEL = { tenant: 'مستأجر', vendor: 'مورد', employee: 'موظف', other: 'أخرى' }

/* الأساس المحاسبي — شجرة الحسابات + القيود المحاسبية + السندات */
export default function AccountingCore() {
  const [tab, setTab] = useState('tree')

  return (
    <div className="panel" style={{ gridColumn: '1 / -1' }}>
      <div className="pg-title" style={{ marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>🧮 الأساس المحاسبي</h3>
      </div>
      <div className="acc-tabs">
        <button className={tab === 'tree' ? 'on' : ''} onClick={() => setTab('tree')}>🌳 شجرة الحسابات</button>
        <button className={tab === 'ledger' ? 'on' : ''} onClick={() => setTab('ledger')}>📒 القيود وكشف الحساب</button>
        <button className={tab === 'vouchers' ? 'on' : ''} onClick={() => setTab('vouchers')}>🧾 السندات</button>
      </div>
      {tab === 'tree' && <ChartOfAccountsTab />}
      {tab === 'ledger' && <LedgerTab />}
      {tab === 'vouchers' && <VouchersTab />}
    </div>
  )
}

/* =====================================================================
   شجرة الحسابات
   ===================================================================== */
function ChartOfAccountsTab() {
  const { profile, toast } = useAuth()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [na, setNa] = useState({ code: '', name: '', account_type: 'expense', parent_id: '' })

  const load = async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('chart_of_accounts_with_balances', { p_company_id: profile.company_id })
    if (!error) setRows(data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [profile])

  const byParent = useMemo(() => {
    const m = {}
    for (const r of rows) { const k = r.parent_id || 'root'; (m[k] = m[k] || []).push(r) }
    return m
  }, [rows])

  const addAccount = async () => {
    if (!na.code.trim() || !na.name.trim()) return toast('أدخل الرمز والاسم', true)
    const { error } = await supabase.from('chart_of_accounts').insert({
      company_id: profile.company_id, code: na.code.trim(), name: na.name.trim(),
      account_type: na.account_type, parent_id: na.parent_id || null
    })
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ أُضيف الحساب لشجرة الحسابات')
    setNa({ code: '', name: '', account_type: 'expense', parent_id: '' })
    setAdding(false); load()
  }

  const Node = ({ r, depth }) => (
    <>
      <tr className={r.is_group ? 'coa-group' : ''}>
        <td style={{ paddingRight: depth * 20 }} dir="ltr">{r.code}</td>
        <td>{r.name}</td>
        <td>{ACCOUNT_TYPE_LABEL[r.account_type]}</td>
        <td className={r.balance < 0 ? 'neg' : 'money'}>{r.is_group ? '—' : SAR(r.balance)}</td>
      </tr>
      {(byParent[r.id] || []).map(c => <Node key={c.id} r={c} depth={depth + 1} />)}
    </>
  )

  if (loading) return <p style={{ color: 'var(--muted)' }}>جارٍ التحميل…</p>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 10 }}>
        <button className="btn btn-gold btn-sm" onClick={() => setAdding(v => !v)}>
          {adding ? '✕ إلغاء' : '+ إضافة حساب فرعي'}
        </button>
      </div>
      {adding && (
        <div className="grid3" style={{ marginBottom: 14, background: 'var(--soft)', padding: 10, borderRadius: 8 }}>
          <div><label>رمز الحساب</label><input dir="ltr" value={na.code} onChange={e => setNa({ ...na, code: e.target.value })} placeholder="1103" /></div>
          <div><label>اسم الحساب</label><input value={na.name} onChange={e => setNa({ ...na, name: e.target.value })} /></div>
          <div><label>النوع</label>
            <select value={na.account_type} onChange={e => setNa({ ...na, account_type: e.target.value })}>
              {Object.entries(ACCOUNT_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></div>
          <div style={{ gridColumn: '1 / -1' }}><label>الحساب الرئيسي (اختياري)</label>
            <select value={na.parent_id} onChange={e => setNa({ ...na, parent_id: e.target.value })}>
              <option value="">— بدون (حساب رئيسي جديد) —</option>
              {rows.filter(r => r.is_group).map(r => <option key={r.id} value={r.id}>{r.code} — {r.name}</option>)}
            </select></div>
          <div><button className="btn btn-green btn-sm" onClick={addAccount}>حفظ الحساب</button></div>
        </div>
      )}
      <table className="tbl">
        <thead><tr><th>الرمز</th><th>اسم الحساب</th><th>التصنيف</th><th>الرصيد</th></tr></thead>
        <tbody>
          {(byParent['root'] || []).map(r => <Node key={r.id} r={r} depth={0} />)}
        </tbody>
      </table>
    </div>
  )
}

/* =====================================================================
   القيود المحاسبية + كشف الحساب (مدين / دائن / رصيد)
   ===================================================================== */
function LedgerTab() {
  const { profile, toast } = useAuth()
  const [accounts, setAccounts] = useState([])
  const [entries, setEntries] = useState([])
  const [selAccount, setSelAccount] = useState('')
  const [range, setRange] = useState({ from: today().slice(0, 8) + '01', to: today() })
  const [statement, setStatement] = useState(null)
  const [showManual, setShowManual] = useState(false)
  const [manual, setManual] = useState({ date: today(), description: '', lines: [{ account_id: '', debit: '', credit: '' }, { account_id: '', debit: '', credit: '' }] })

  useEffect(() => {
    supabase.rpc('chart_of_accounts_with_balances', { p_company_id: profile.company_id })
      .then(({ data }) => setAccounts((data || []).filter(a => !a.is_group)))
    loadEntries()
  }, [profile])

  const loadEntries = async () => {
    const { data } = await supabase.from('journal_entries')
      .select('*, journal_entry_lines(debit, credit)')
      .eq('company_id', profile.company_id)
      .order('entry_date', { ascending: false }).order('entry_number', { ascending: false })
      .limit(50)
    setEntries(data || [])
  }

  const loadStatement = async () => {
    if (!selAccount) return toast('اختر حساباً أولاً', true)
    const { data, error } = await supabase.rpc('account_statement', { p_account_id: selAccount, p_from: range.from, p_to: range.to })
    if (error) return toast('خطأ: ' + error.message, true)
    setStatement(data || [])
  }

  const addLine = () => setManual(m => ({ ...m, lines: [...m.lines, { account_id: '', debit: '', credit: '' }] }))
  const setLine = (i, patch) => setManual(m => ({ ...m, lines: m.lines.map((l, idx) => idx === i ? { ...l, ...patch } : l) }))
  const removeLine = (i) => setManual(m => ({ ...m, lines: m.lines.filter((_, idx) => idx !== i) }))

  const totalDebit = manual.lines.reduce((s, l) => s + num(l.debit), 0)
  const totalCredit = manual.lines.reduce((s, l) => s + num(l.credit), 0)
  const balanced = manual.lines.length >= 2 && totalDebit > 0 && Math.abs(totalDebit - totalCredit) < 0.01

  const postManual = async () => {
    if (!balanced) return toast('القيد غير متوازن — تأكد أن إجمالي المدين = إجمالي الدائن', true)
    if (manual.lines.some(l => !l.account_id)) return toast('اختر الحساب لكل سطر', true)
    const { error } = await supabase.rpc('post_manual_journal_entry', {
      p_company_id: profile.company_id, p_entry_date: manual.date, p_description: manual.description,
      p_lines: manual.lines.map(l => ({ account_id: l.account_id, debit: num(l.debit), credit: num(l.credit), description: manual.description }))
    })
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ تم ترحيل القيد بنجاح')
    setManual({ date: today(), description: '', lines: [{ account_id: '', debit: '', credit: '' }, { account_id: '', debit: '', credit: '' }] })
    setShowManual(false); loadEntries()
  }

  return (
    <div>
      {/* كشف الحساب */}
      <h4 className="ts-h4">كشف حساب (مدين / دائن / رصيد متحرك)</h4>
      <div className="grid3" style={{ marginBottom: 10 }}>
        <div><label>الحساب</label>
          <select value={selAccount} onChange={e => setSelAccount(e.target.value)}>
            <option value="">اختر حساباً…</option>
            {accounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
          </select></div>
        <div><label>من</label><input type="date" value={range.from} onChange={e => setRange({ ...range, from: e.target.value })} /></div>
        <div><label>إلى</label><input type="date" value={range.to} onChange={e => setRange({ ...range, to: e.target.value })} /></div>
      </div>
      <button className="btn btn-blue btn-sm" onClick={loadStatement} style={{ marginBottom: 12 }}>عرض كشف الحساب</button>

      {statement && (
        <table className="tbl" style={{ marginBottom: 20 }}>
          <thead><tr><th>التاريخ</th><th>رقم القيد</th><th>البيان</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead>
          <tbody>
            {statement.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد حركات في هذه الفترة</td></tr>}
            {statement.map((s, i) => (
              <tr key={i}>
                <td>{s.entry_date}</td><td dir="ltr">{s.entry_number}</td><td>{s.description}</td>
                <td className="money">{s.debit > 0 ? SAR(s.debit) : '—'}</td>
                <td className="neg">{s.credit > 0 ? SAR(s.credit) : '—'}</td>
                <td className={s.running_balance < 0 ? 'neg' : 'money'}>{SAR(s.running_balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* آخر القيود */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h4 className="ts-h4" style={{ marginBottom: 0 }}>آخر القيود المحاسبية</h4>
        <button className="btn btn-gold btn-sm" onClick={() => setShowManual(v => !v)}>
          {showManual ? '✕ إلغاء' : '+ إضافة قيد يدوي'}
        </button>
      </div>

      {showManual && (
        <div className="panel" style={{ margin: '10px 0', background: 'var(--soft)' }}>
          <div className="grid2" style={{ marginBottom: 8 }}>
            <div><label>التاريخ</label><input type="date" value={manual.date} onChange={e => setManual({ ...manual, date: e.target.value })} /></div>
            <div><label>بيان القيد</label><input value={manual.description} onChange={e => setManual({ ...manual, description: e.target.value })} placeholder="وصف القيد أو التسوية" /></div>
          </div>
          {manual.lines.map((l, i) => (
            <div key={i} className="grid3" style={{ marginBottom: 6, alignItems: 'end' }}>
              <div><label>الحساب</label>
                <select value={l.account_id} onChange={e => setLine(i, { account_id: e.target.value })}>
                  <option value="">اختر حساباً…</option>
                  {accounts.map(a => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                </select></div>
              <div><label>مدين</label><input type="number" value={l.debit} onChange={e => setLine(i, { debit: e.target.value, credit: e.target.value ? '' : l.credit })} /></div>
              <div style={{ display: 'flex', gap: 6 }}>
                <div style={{ flex: 1 }}><label>دائن</label><input type="number" value={l.credit} onChange={e => setLine(i, { credit: e.target.value, debit: e.target.value ? '' : l.debit })} /></div>
                {manual.lines.length > 2 && <button className="btn btn-ghost btn-sm" onClick={() => removeLine(i)}>✕</button>}
              </div>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            <button className="btn btn-ghost btn-sm" onClick={addLine}>+ سطر جديد</button>
            <div style={{ fontSize: 13 }}>
              إجمالي مدين: <b className="money">{SAR(totalDebit)}</b> — إجمالي دائن: <b className="neg">{SAR(totalCredit)}</b>
              {balanced ? <span style={{ color: 'var(--green)', marginRight: 8 }}>✓ متوازن</span> : <span className="neg" style={{ marginRight: 8 }}>غير متوازن</span>}
            </div>
          </div>
          <button className="btn btn-green btn-sm" style={{ marginTop: 10 }} disabled={!balanced} onClick={postManual}>ترحيل القيد</button>
        </div>
      )}

      <table className="tbl">
        <thead><tr><th>التاريخ</th><th>رقم القيد</th><th>البيان</th><th>المصدر</th><th>الإجمالي</th></tr></thead>
        <tbody>
          {entries.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد قيود بعد</td></tr>}
          {entries.map(e => {
            const total = (e.journal_entry_lines || []).reduce((s, l) => s + num(l.debit), 0)
            const srcLabel = { manual: 'يدوي', payment: 'دفعة', expense: 'مصروف', payroll: 'رواتب', voucher: 'سند' }[e.source_type] || e.source_type
            return (
              <tr key={e.id}>
                <td>{e.entry_date}</td><td dir="ltr">{e.entry_number}</td><td>{e.description}</td>
                <td><span className="chip chip-muted">{srcLabel}</span></td><td className="money">{SAR(total)}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/* =====================================================================
   السندات — قبض وصرف بتصميم فاخر مع الترويسة
   ===================================================================== */
function VouchersTab() {
  const { profile, company } = useAuth()
  const [type, setType] = useState('receipt')
  const [rows, setRows] = useState([])
  const [printing, setPrinting] = useState(null)

  useEffect(() => {
    supabase.from('vouchers').select('*')
      .eq('company_id', profile.company_id).eq('voucher_type', type)
      .order('voucher_date', { ascending: false }).limit(100)
      .then(({ data }) => setRows(data || []))
  }, [profile, type])

  return (
    <div>
      <div className="acc-tabs" style={{ marginBottom: 12 }}>
        <button className={type === 'receipt' ? 'on' : ''} onClick={() => setType('receipt')}>💰 سندات القبض</button>
        <button className={type === 'payment' ? 'on' : ''} onClick={() => setType('payment')}>💸 سندات الصرف</button>
      </div>
      <table className="tbl">
        <thead><tr><th>الرقم</th><th>التاريخ</th><th>الجهة</th><th>البيان</th><th>طريقة الدفع</th><th>المبلغ</th><th></th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد سندات بعد — تُصدر تلقائياً عند تسجيل دفعة أو مصروف</td></tr>}
          {rows.map(v => (
            <tr key={v.id}>
              <td dir="ltr">{v.voucher_number}</td><td>{v.voucher_date}</td>
              <td>{v.party_name} <small style={{ color: 'var(--muted)' }}>({PARTY_LABEL[v.party_type]})</small></td>
              <td>{v.description}</td><td>{PAY_METHODS[v.payment_method]}</td>
              <td className="money">{SAR(v.amount)}</td>
              <td><button className="btn btn-ghost btn-sm" onClick={() => setPrinting(v)}>🖨 طباعة</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      {printing && <VoucherPrintModal voucher={printing} company={company} onClose={() => setPrinting(null)} />}
    </div>
  )
}

function VoucherPrintModal({ voucher: v, company, onClose }) {
  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(680px,100%)' }}>
        <div className="modal-h">
          <h3>{v.voucher_type === 'receipt' ? 'سند قبض' : 'سند صرف'}</h3>
          <button className="x" onClick={onClose}>✕</button>
        </div>
        <div className="modal-b" id="voucher-print">
          <div className="voucher-doc">
            <div className="voucher-head">
              {company?.logo_url && <img src={company.logo_url} alt="logo" />}
              <div className="voucher-head-info">
                <h2>{company?.name || 'المازن'}</h2>
                <div>الرقم الضريبي: {company?.vat_number || '—'} · {company?.address || ''}</div>
              </div>
              <div className={'voucher-badge ' + (v.voucher_type === 'receipt' ? 'in' : 'out')}>
                {v.voucher_type === 'receipt' ? 'سند قبض' : 'سند صرف'}
              </div>
            </div>
            <div className="voucher-grid">
              <div><b>رقم السند</b><span dir="ltr">{v.voucher_number}</span></div>
              <div><b>التاريخ</b><span>{v.voucher_date}</span></div>
              <div><b>{v.voucher_type === 'receipt' ? 'استلمنا من' : 'صرفنا إلى'}</b><span>{v.party_name}</span></div>
              <div><b>التصنيف</b><span>{PARTY_LABEL[v.party_type]}</span></div>
              <div><b>طريقة الدفع</b><span>{PAY_METHODS[v.payment_method]}</span></div>
              <div><b>رقم المرجع</b><span dir="ltr">{v.reference_number || '—'}</span></div>
            </div>
            <div className="voucher-amount">
              <span>وذلك مبلغ وقدره</span>
              <b className="money">{SAR(v.amount)}</b>
            </div>
            <div className="voucher-desc"><b>البيان:</b> {v.description || '—'}</div>
            <div className="voucher-sign">
              <div><span>توقيع المُسلِّم</span><i /></div>
              <div><span>توقيع المستلم</span><i /></div>
            </div>
          </div>
        </div>
        <div className="modal-f no-print">
          <button className="btn btn-gold" onClick={() => window.print()}>🖨 طباعة</button>
        </div>
      </div>
    </div>
  )
}
