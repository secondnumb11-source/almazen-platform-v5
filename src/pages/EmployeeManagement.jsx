import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../AuthContext'
import { SAR, num, today, ROLES, uploadFile } from '../lib/helpers'

const REQ_TYPE = { leave: 'إجازة', advance: 'سلفة', other: 'أخرى' }
const REQ_STATUS = { new: 'جديد', approved: 'مقبول', rejected: 'مرفوض' }

/* إدارة الموظفين — ملف كامل، رواتب وسلف، طلبات، سجل نشاط، شكاوى */
export default function EmployeeManagement() {
  const { profile, toast } = useAuth()
  const [staff, setStaff] = useState([])
  const [selected, setSelected] = useState(null)
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    setLoading(true)
    const { data } = await supabase.from('profiles').select('*').eq('company_id', profile.company_id).order('full_name')
    setStaff(data || [])
    const { data: reqs } = await supabase.from('employee_requests')
      .select('*, profiles!employee_requests_employee_id_fkey(full_name)')
      .eq('company_id', profile.company_id).eq('status', 'new').order('created_at', { ascending: false })
    setRequests(reqs || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [profile])

  const decide = async (req, status) => {
    if (status === 'approved' && req.request_type === 'advance') {
      const { error } = await supabase.rpc('approve_advance_request', { p_request_id: req.id })
      if (error) return toast('خطأ: ' + error.message, true)
      toast('✓ اعتُمدت السلفة وسُجّلت في الحسابات تلقائياً')
    } else {
      const { error } = await supabase.from('employee_requests')
        .update({ status, decided_by: profile.id, decided_at: new Date().toISOString() }).eq('id', req.id)
      if (error) return toast('خطأ: ' + error.message, true)
      toast(status === 'approved' ? '✓ تمت الموافقة' : '✓ تم الرفض')
    }
    load()
  }

  return (
    <div>
      <div className="pg-title"><h2>🧑‍💼 إدارة الموظفين</h2></div>

      {requests.length > 0 && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h3>طلبات بانتظار القرار ({requests.length})</h3>
          <table className="tbl">
            <thead><tr><th>الموظف</th><th>النوع</th><th>التفاصيل</th><th>السبب</th><th></th></tr></thead>
            <tbody>
              {requests.map(r => (
                <tr key={r.id}>
                  <td>{r.profiles?.full_name}</td>
                  <td><span className="chip chip-muted">{REQ_TYPE[r.request_type]}</span></td>
                  <td>{r.request_type === 'advance' ? SAR(r.amount) : r.request_type === 'leave' ? `${r.start_date} → ${r.end_date}` : '—'}</td>
                  <td>{r.reason || '—'}</td>
                  <td>
                    <button className="btn btn-green btn-sm" onClick={() => decide(r, 'approved')}>✓ قبول</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => decide(r, 'rejected')}>✕ رفض</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <table className="tbl">
          <thead><tr><th>الاسم</th><th>الدور</th><th>المسمى الوظيفي</th><th>الراتب</th><th>تاريخ التعيين</th><th>انتهاء الإقامة</th><th></th></tr></thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)' }}>جارٍ التحميل…</td></tr>}
            {staff.map(s => (
              <tr key={s.id}>
                <td>{s.full_name}</td><td>{ROLES[s.role]}</td><td>{s.job_title || '—'}</td>
                <td className="money">{SAR(s.salary)}</td><td dir="ltr">{s.hire_date || '—'}</td>
                <td dir="ltr" className={s.iqama_expiry && new Date(s.iqama_expiry) < new Date() ? 'neg' : ''}>{s.iqama_expiry || '—'}</td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => setSelected(s)}>عرض الملف</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && <EmployeeProfile employee={selected} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  )
}

function EmployeeProfile({ employee, onClose, onChanged }) {
  const { profile, toast } = useAuth()
  const [f, setF] = useState({
    job_title: employee.job_title || '', address: employee.address || '', salary: employee.salary || 0,
    manager_id: employee.manager_id || '', iqama_expiry: employee.iqama_expiry || '', hr_notes: employee.hr_notes || ''
  })
  const [managers, setManagers] = useState([])
  const [advances, setAdvances] = useState([])
  const [activity, setActivity] = useState([])
  const [complaints, setComplaints] = useState(0)
  const [saving, setSaving] = useState(false)
  const [payAmount, setPayAmount] = useState(employee.salary || 0)
  const [advAmount, setAdvAmount] = useState('')
  const [advReason, setAdvReason] = useState('')
  const [idFile, setIdFile] = useState(null)
  const [contractFile, setContractFile] = useState(null)

  useEffect(() => {
    supabase.from('profiles').select('id, full_name').eq('company_id', profile.company_id).neq('id', employee.id)
      .then(({ data }) => setManagers(data || []))
    supabase.from('employee_advances').select('*').eq('employee_id', employee.id).order('advance_date', { ascending: false })
      .then(({ data }) => setAdvances(data || []))
    supabase.from('audit_logs').select('*').eq('user_id', employee.id).order('created_at', { ascending: false }).limit(15)
      .then(({ data }) => setActivity(data || []))
    supabase.from('service_requests').select('id', { count: 'exact', head: true }).eq('handled_by', employee.id).eq('request_type', 'complaint')
      .then(({ count }) => setComplaints(count || 0))
  }, [employee, profile])

  const save = async () => {
    setSaving(true)
    let id_photo_url = employee.id_photo_url, contract_url = employee.contract_url
    if (idFile) id_photo_url = await uploadFile(supabase, 'documents', profile.company_id, idFile)
    if (contractFile) contract_url = await uploadFile(supabase, 'documents', profile.company_id, contractFile)
    const { error } = await supabase.from('profiles').update({
      job_title: f.job_title || null, address: f.address || null, salary: num(f.salary),
      manager_id: f.manager_id || null, iqama_expiry: f.iqama_expiry || null, hr_notes: f.hr_notes || null,
      id_photo_url, contract_url
    }).eq('id', employee.id)
    setSaving(false)
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ حُفظ ملف الموظف')
    onChanged(); onClose()
  }

  const paySalary = async () => {
    if (!num(payAmount)) return toast('أدخل مبلغ الراتب', true)
    const { error } = await supabase.rpc('pay_employee_salary', { p_employee_id: employee.id, p_amount: num(payAmount), p_pay_date: today() })
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ صُرف الراتب وسُجّل في الحسابات والقيود تلقائياً')
    onChanged()
  }

  const giveAdvance = async () => {
    if (!num(advAmount)) return toast('أدخل مبلغ السلفة', true)
    const { error } = await supabase.from('employee_advances').insert({
      company_id: profile.company_id, employee_id: employee.id, amount: num(advAmount), reason: advReason, created_by: profile.id
    })
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ سُجّلت السلفة وأُنشئ قيد وسند صرف تلقائياً')
    setAdvAmount(''); setAdvReason('')
    supabase.from('employee_advances').select('*').eq('employee_id', employee.id).order('advance_date', { ascending: false })
      .then(({ data }) => setAdvances(data || []))
  }

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(880px,100%)' }}>
        <div className="modal-h"><h3>ملف الموظف — {employee.full_name}</h3><button className="x" onClick={onClose}>✕</button></div>
        <div className="modal-b">
          <h4 className="ts-h4">البيانات الوظيفية</h4>
          <div className="grid3" style={{ marginBottom: 16 }}>
            <div className="fld"><label>المسمى الوظيفي</label><input value={f.job_title} onChange={e => setF({ ...f, job_title: e.target.value })} /></div>
            <div className="fld"><label>العنوان</label><input value={f.address} onChange={e => setF({ ...f, address: e.target.value })} /></div>
            <div className="fld"><label>الراتب الشهري (ر.س)</label><input type="number" value={f.salary} onChange={e => setF({ ...f, salary: e.target.value })} /></div>
            <div className="fld"><label>المدير المباشر</label>
              <select value={f.manager_id} onChange={e => setF({ ...f, manager_id: e.target.value })}>
                <option value="">— بدون —</option>
                {managers.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select></div>
            <div className="fld"><label>تاريخ انتهاء الإقامة</label><input type="date" value={f.iqama_expiry} onChange={e => setF({ ...f, iqama_expiry: e.target.value })} /></div>
            <div className="fld"><label>صورة الهوية/الإقامة</label><input type="file" accept="image/*,.pdf" onChange={e => setIdFile(e.target.files?.[0] || null)} /></div>
            <div className="fld"><label>عقد العمل</label><input type="file" accept="image/*,.pdf" onChange={e => setContractFile(e.target.files?.[0] || null)} /></div>
            <div className="fld" style={{ gridColumn: '1 / -1' }}><label>ملاحظات</label><input value={f.hr_notes} onChange={e => setF({ ...f, hr_notes: e.target.value })} /></div>
          </div>
          <button className="btn btn-gold btn-sm" disabled={saving} onClick={save}>{saving ? '…' : 'حفظ البيانات'}</button>

          <h4 className="ts-h4" style={{ marginTop: 20 }}>مؤشرات الأداء</h4>
          <div className="kpis" style={{ marginBottom: 16 }}>
            <div className="kpi"><div className="v">{complaints}</div><div className="l">شكاوى المستأجرين</div></div>
            <div className="kpi"><div className="v">{advances.length}</div><div className="l">عدد السلف</div></div>
            <div className="kpi"><div className="v">{SAR(advances.reduce((s, a) => s + num(a.amount), 0))}</div><div className="l">إجمالي السلف</div></div>
          </div>

          <h4 className="ts-h4">صرف الراتب</h4>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'end' }}>
            <div className="fld" style={{ flex: 1 }}><label>المبلغ</label><input type="number" value={payAmount} onChange={e => setPayAmount(e.target.value)} /></div>
            <button className="btn btn-green btn-sm" onClick={paySalary}>💰 صرف الراتب الآن</button>
          </div>

          <h4 className="ts-h4">تسجيل سلفة</h4>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'end', flexWrap: 'wrap' }}>
            <div className="fld"><label>المبلغ</label><input type="number" value={advAmount} onChange={e => setAdvAmount(e.target.value)} /></div>
            <div className="fld" style={{ flex: 1 }}><label>السبب</label><input value={advReason} onChange={e => setAdvReason(e.target.value)} /></div>
            <button className="btn btn-blue btn-sm" onClick={giveAdvance}>تسجيل السلفة</button>
          </div>
          <table className="tbl" style={{ marginBottom: 16 }}>
            <thead><tr><th>التاريخ</th><th>المبلغ</th><th>السبب</th></tr></thead>
            <tbody>
              {advances.length === 0 && <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد سلف</td></tr>}
              {advances.map(a => <tr key={a.id}><td>{a.advance_date}</td><td className="neg">{SAR(a.amount)}</td><td>{a.reason || '—'}</td></tr>)}
            </tbody>
          </table>

          <h4 className="ts-h4">سجل النشاط (آخر 15 عملية)</h4>
          <table className="tbl">
            <thead><tr><th>التاريخ</th><th>الإجراء</th><th>التفاصيل</th></tr></thead>
            <tbody>
              {activity.length === 0 && <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا يوجد نشاط مسجل</td></tr>}
              {activity.map(a => <tr key={a.id}><td>{a.created_at?.slice(0, 16).replace('T', ' ')}</td><td>{a.action} / {a.entity}</td><td>{a.new_data?.summary || '—'}</td></tr>)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
