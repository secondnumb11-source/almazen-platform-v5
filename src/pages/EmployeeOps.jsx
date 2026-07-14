import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../AuthContext'
import { SAR, num, today, uploadFile } from '../lib/helpers'

const REQ_TYPE = { leave: 'إجازة', advance: 'سلفة', other: 'أخرى' }
const REQ_STATUS = { new: 'قيد المراجعة', approved: 'مقبول', rejected: 'مرفوض' }

/* العمليات اليومية للموظف — تسجيل مصروف/صيانة + إرسال طلبات للإدارة */
export default function EmployeeOps() {
  const [tab, setTab] = useState('expense')
  return (
    <div>
      <div className="pg-title"><h2>🧰 العمليات اليومية</h2></div>
      <div className="acc-tabs" style={{ marginBottom: 16 }}>
        <button className={tab === 'expense' ? 'on' : ''} onClick={() => setTab('expense')}>💸 مصروف / صيانة</button>
        <button className={tab === 'requests' ? 'on' : ''} onClick={() => setTab('requests')}>📨 طلباتي إلى الإدارة</button>
      </div>
      {tab === 'expense' && <ExpenseMaintenanceEntry />}
      {tab === 'requests' && <MyRequests />}
    </div>
  )
}

function ExpenseMaintenanceEntry() {
  const { profile, toast } = useAuth()
  const [kind, setKind] = useState('expense')
  const [units, setUnits] = useState([])
  const [f, setF] = useState({ unit_id: '', category: 'maintenance', amount: '', description: '', vendor_name: '', payment_method: 'cash' })
  const [file, setFile] = useState(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    supabase.from('units').select('id, unit_number').eq('company_id', profile.company_id)
      .then(({ data }) => setUnits(data || []))
  }, [profile])

  const save = async () => {
    if (!num(f.amount)) return toast('أدخل المبلغ', true)
    setSaving(true)
    const doc = file ? await uploadFile(supabase, 'documents', profile.company_id, file) : null

    if (kind === 'maintenance') {
      const { error } = await supabase.from('maintenance_requests').insert({
        company_id: profile.company_id, unit_id: f.unit_id || null,
        request_type: 'maintenance', status: 'done', description: f.description,
        cost: num(f.amount), photos: doc ? [doc] : [], opened_by: profile.id, closed_at: new Date().toISOString()
      })
      if (error) { setSaving(false); return toast('خطأ: ' + error.message, true) }
    }

    // كل صيانة أو مصروف له تكلفة يُسجَّل أيضاً في المصروفات ليُحتسب في الحسابات تلقائياً
    const { error: expErr } = await supabase.from('expenses').insert({
      company_id: profile.company_id, unit_id: f.unit_id || null,
      category: kind === 'maintenance' ? 'maintenance' : f.category,
      amount: num(f.amount), description: f.description, vendor_name: f.vendor_name || null,
      payment_method: f.payment_method, invoice_url: doc, created_by: profile.id
    })
    setSaving(false)
    if (expErr) return toast('خطأ: ' + expErr.message, true)
    toast(`✓ سُجّل ${kind === 'maintenance' ? 'طلب الصيانة' : 'المصروف'} مع قيد وسند صرف تلقائي`)
    setF({ unit_id: '', category: 'maintenance', amount: '', description: '', vendor_name: '', payment_method: 'cash' })
    setFile(null)
  }

  return (
    <div className="panel">
      <div className="acc-tabs" style={{ marginBottom: 12 }}>
        <button className={kind === 'expense' ? 'on' : ''} onClick={() => setKind('expense')}>💸 مصروف</button>
        <button className={kind === 'maintenance' ? 'on' : ''} onClick={() => setKind('maintenance')}>🔧 صيانة</button>
      </div>
      <div className="grid3">
        <div><label>الوحدة (اختياري)</label>
          <select value={f.unit_id} onChange={e => setF({ ...f, unit_id: e.target.value })}>
            <option value="">عام</option>
            {units.map(u => <option key={u.id} value={u.id}>{u.unit_number}</option>)}
          </select></div>
        {kind === 'expense' && (
          <div><label>النوع</label>
            <select value={f.category} onChange={e => setF({ ...f, category: e.target.value })}>
              <option value="electricity">كهرباء</option><option value="water">ماء</option>
              <option value="maintenance">صيانة</option><option value="cleaning">نظافة</option>
              <option value="internet">إنترنت</option><option value="other">أخرى</option>
            </select></div>
        )}
        <div><label>المبلغ (ر.س)</label><input type="number" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></div>
        <div><label>البائع / المورد</label><input value={f.vendor_name} onChange={e => setF({ ...f, vendor_name: e.target.value })} /></div>
        <div><label>طريقة الدفع</label>
          <select value={f.payment_method} onChange={e => setF({ ...f, payment_method: e.target.value })}>
            <option value="cash">كاش</option><option value="bank_transfer">تحويل بنكي</option><option value="card">بطاقة بنكية</option>
          </select></div>
        <div style={{ gridColumn: '1 / span 2' }}><label>الوصف</label><input value={f.description} onChange={e => setF({ ...f, description: e.target.value })} /></div>
        <div><label>إرفاق الفاتورة/الصورة</label><input type="file" accept="image/*,.pdf" onChange={e => setFile(e.target.files?.[0] || null)} /></div>
        <div style={{ alignSelf: 'end' }}><button className="btn btn-green btn-sm" disabled={saving} onClick={save}>{saving ? '…' : 'حفظ وإصدار سند صرف'}</button></div>
      </div>
    </div>
  )
}

function MyRequests() {
  const { profile, toast } = useAuth()
  const [rows, setRows] = useState([])
  const [f, setF] = useState({ request_type: 'leave', amount: '', start_date: today(), end_date: today(), reason: '' })
  const [saving, setSaving] = useState(false)

  const load = () => {
    supabase.from('employee_requests').select('*').eq('employee_id', profile.id).order('created_at', { ascending: false })
      .then(({ data }) => setRows(data || []))
  }
  useEffect(load, [profile])

  const submit = async () => {
    if (f.request_type === 'advance' && !num(f.amount)) return toast('أدخل مبلغ السلفة المطلوبة', true)
    setSaving(true)
    const { error } = await supabase.from('employee_requests').insert({
      company_id: profile.company_id, employee_id: profile.id, request_type: f.request_type,
      amount: f.request_type === 'advance' ? num(f.amount) : null,
      start_date: f.request_type === 'leave' ? f.start_date : null,
      end_date: f.request_type === 'leave' ? f.end_date : null,
      reason: f.reason
    })
    setSaving(false)
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ أُرسل طلبك للإدارة')
    setF({ request_type: 'leave', amount: '', start_date: today(), end_date: today(), reason: '' })
    load()
  }

  return (
    <div className="panel">
      <h3>طلب جديد</h3>
      <div className="grid3" style={{ marginBottom: 14 }}>
        <div><label>نوع الطلب</label>
          <select value={f.request_type} onChange={e => setF({ ...f, request_type: e.target.value })}>
            <option value="leave">إجازة</option><option value="advance">سلفة</option><option value="other">أخرى</option>
          </select></div>
        {f.request_type === 'advance' && (
          <div><label>المبلغ المطلوب</label><input type="number" value={f.amount} onChange={e => setF({ ...f, amount: e.target.value })} /></div>
        )}
        {f.request_type === 'leave' && (
          <>
            <div><label>من</label><input type="date" value={f.start_date} onChange={e => setF({ ...f, start_date: e.target.value })} /></div>
            <div><label>إلى</label><input type="date" value={f.end_date} onChange={e => setF({ ...f, end_date: e.target.value })} /></div>
          </>
        )}
        <div style={{ gridColumn: '1 / -1' }}><label>السبب / التفاصيل</label><input value={f.reason} onChange={e => setF({ ...f, reason: e.target.value })} /></div>
      </div>
      <button className="btn btn-gold btn-sm" disabled={saving} onClick={submit}>{saving ? '…' : 'إرسال الطلب'}</button>

      <h3 style={{ marginTop: 20 }}>طلباتي السابقة</h3>
      <table className="tbl">
        <thead><tr><th>التاريخ</th><th>النوع</th><th>التفاصيل</th><th>الحالة</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد طلبات بعد</td></tr>}
          {rows.map(r => (
            <tr key={r.id}>
              <td>{r.created_at?.slice(0, 10)}</td>
              <td>{REQ_TYPE[r.request_type]}</td>
              <td>{r.request_type === 'advance' ? SAR(r.amount) : r.request_type === 'leave' ? `${r.start_date} → ${r.end_date}` : r.reason}</td>
              <td>
                <span className={'chip ' + (r.status === 'approved' ? 'chip-ok' : r.status === 'rejected' ? 'chip-danger' : 'chip-warn')}>
                  {REQ_STATUS[r.status]}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
