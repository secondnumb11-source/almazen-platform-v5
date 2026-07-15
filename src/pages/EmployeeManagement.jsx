import React, { useEffect, useState } from 'react'
import { supabase, adminSignupClient, staffEmail, normalizeStaffUsername } from '../lib/supabase'
import { useAuth } from '../AuthContext'
import { SAR, num, today, ROLES, uploadFile } from '../lib/helpers'

const REQ_TYPE = { leave: 'إجازة', advance: 'سلفة', other: 'أخرى' }
const REQ_STATUS = { new: 'جديد', approved: 'مقبول', rejected: 'مرفوض' }

function explain(err) {
  const code = err?.code || ''
  const msg = err?.message || 'خطأ غير متوقع'
  if (code === '42501' || /permission denied|row-level security|policy/i.test(msg))
    return 'صلاحيات قاعدة البيانات ناقصة — نفّذ ملف supabase/POST_SETUP_FIX.sql ثم أعد المحاولة.'
  return 'خطأ: ' + msg
}

/* إدارة الموظفين — الملف الكامل: الحسابات، الصلاحيات، الرواتب والسلف،
   الطلبات، سجل النشاط، والشكاوى — كل ما يخص الموظفين من مكان واحد */
export default function EmployeeManagement() {
  const { profile, toast, isOwner } = useAuth()
  const canEdit = isOwner || profile.role === 'accountant'
  const [staff, setStaff] = useState([])
  const [perms, setPerms] = useState({})
  const [selected, setSelected] = useState(null)
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [adding, setAdding] = useState(false)
  const [nu, setNu] = useState({
    full_name: '', username: '', password: '', role: 'employee',
    birth_date: '', nationality: '', id_number: '', hire_date: '', end_date: ''
  })
  const [busy, setBusy] = useState(false)

  const load = async () => {
    setLoading(true)
    const { data } = await supabase.from('profiles').select('*').eq('company_id', profile.company_id).order('full_name')
    setStaff(data || [])
    const ids = (data || []).map(s => s.id)
    if (ids.length) {
      const { data: pr } = await supabase.from('staff_permissions').select('*').in('staff_id', ids)
      const map = {}; (pr || []).forEach(p => { map[p.staff_id] = p }); setPerms(map)
    }
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

  const addStaff = async () => {
    if (!nu.full_name || !nu.username || nu.password.length < 6)
      return toast('أكمل البيانات (كلمة المرور 6 أحرف على الأقل)', true)
    setBusy(true)
    try {
      const username = normalizeStaffUsername(nu.username)
      const { data, error } = await adminSignupClient.auth.signUp({ email: staffEmail(username), password: nu.password })
      if (error) throw error
      const uid = data.user?.id
      if (!uid) throw new Error('لم يُنشأ المستخدم — تأكد من إيقاف "Confirm email" في إعدادات Supabase Auth')
      const { error: pe } = await supabase.from('profiles').insert({
        id: uid, company_id: profile.company_id, role: nu.role,
        full_name: nu.full_name, username, created_by: profile.id,
        birth_date: nu.birth_date || null, nationality: nu.nationality || null,
        id_number: nu.id_number || null, hire_date: nu.hire_date || null, end_date: nu.end_date || null,
      })
      if (pe) throw pe
      await supabase.from('staff_permissions').insert({
        staff_id: uid, user_id: uid, company_id: profile.company_id,
        can_discount: false, discount_max_percent: 10, can_cancel_booking: false,
        can_edit_data: true, can_upload_media: true, can_view_accountant: false, can_export_reports: false,
      })
      toast(`✓ أُنشئ حساب ${nu.full_name} — الدخول باسم المستخدم "${username}"`)
      setNu({ full_name: '', username: '', password: '', role: 'employee', birth_date: '', nationality: '', id_number: '', hire_date: '', end_date: '' })
      setAdding(false); load()
    } catch (e) { toast(explain(e), true) } finally { setBusy(false) }
  }

  return (
    <div>
      <div className="pg-title"><h2>🧑‍💼 إدارة الموظفين</h2>
        {canEdit && <button className="btn btn-gold btn-sm" onClick={() => setAdding(v => !v)}>{adding ? '✕ إلغاء' : '+ إنشاء حساب موظف'}</button>}
      </div>

      {adding && canEdit && (
        <div className="panel" style={{ marginBottom: 16 }}>
          <h3>حساب موظف جديد</h3>
          <div className="grid3">
            <div className="fld"><label>الاسم الكامل *</label><input value={nu.full_name} onChange={e => setNu({ ...nu, full_name: e.target.value })} /></div>
            <div className="fld"><label>اسم المستخدم *</label><input value={nu.username} onChange={e => setNu({ ...nu, username: e.target.value })} dir="ltr" placeholder="ahmad.s" /></div>
            <div className="fld"><label>كلمة المرور *</label><input type="password" value={nu.password} onChange={e => setNu({ ...nu, password: e.target.value })} /></div>
            <div className="fld"><label>الدور</label>
              <select value={nu.role} onChange={e => setNu({ ...nu, role: e.target.value })}>
                <option value="employee">موظف</option><option value="accountant">محاسب</option><option value="manager">مدير</option>
              </select></div>
            <div className="fld"><label>تاريخ الميلاد</label><input type="date" value={nu.birth_date} onChange={e => setNu({ ...nu, birth_date: e.target.value })} /></div>
            <div className="fld"><label>الجنسية</label><input value={nu.nationality} onChange={e => setNu({ ...nu, nationality: e.target.value })} placeholder="سعودي / مصري …" /></div>
            <div className="fld"><label>رقم الهوية / الإقامة</label><input value={nu.id_number} onChange={e => setNu({ ...nu, id_number: e.target.value })} dir="ltr" /></div>
            <div className="fld"><label>تاريخ بدء العمل</label><input type="date" value={nu.hire_date} onChange={e => setNu({ ...nu, hire_date: e.target.value })} /></div>
            <div className="fld"><label>تاريخ ترك العمل (إن وُجد)</label><input type="date" value={nu.end_date} onChange={e => setNu({ ...nu, end_date: e.target.value })} /></div>
          </div>
          <button className="btn btn-blue btn-sm" disabled={busy} onClick={addStaff}>+ إنشاء الحساب</button>
        </div>
      )}

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
                    {canEdit ? <>
                      <button className="btn btn-green btn-sm" onClick={() => decide(r, 'approved')}>✓ قبول</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => decide(r, 'rejected')}>✕ رفض</button>
                    </> : <span style={{ color: 'var(--muted)', fontSize: 12 }}>بانتظار الإدارة</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="panel">
        <table className="tbl">
          <thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الدور</th><th>المسمى الوظيفي</th><th>الجنسية</th><th>الراتب</th><th>تاريخ التعيين</th><th>انتهاء الإقامة</th><th></th></tr></thead>
          <tbody>
            {loading && <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--muted)' }}>جارٍ التحميل…</td></tr>}
            {staff.map(s => (
              <tr key={s.id}>
                <td>{s.full_name}</td><td dir="ltr">{s.username || '—'}</td><td>{ROLES[s.role]}</td><td>{s.job_title || '—'}</td>
                <td>{s.nationality || '—'}</td>
                <td className="money">{SAR(s.salary)}</td><td dir="ltr">{s.hire_date || '—'}</td>
                <td dir="ltr" className={s.iqama_expiry && new Date(s.iqama_expiry) < new Date() ? 'neg' : ''}>{s.iqama_expiry || '—'}</td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => setSelected(s)}>عرض الملف</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && (
        <EmployeeProfile
          employee={selected} perms={perms[selected.id]} canEdit={canEdit}
          onClose={() => setSelected(null)} onChanged={load}
        />
      )}
    </div>
  )
}

const PERM_FIELDS = {
  can_discount: 'السماح بالخصم', discount_max_percent: 'حد الخصم الأقصى %',
  can_cancel_booking: 'إلغاء الحجوزات', can_edit_data: 'تعديل البيانات',
  can_upload_media: 'رفع صور/فيديو', can_view_accountant: 'الاطلاع على قسم الحسابات',
  can_export_reports: 'إصدار التقارير',
}

function EmployeeProfile({ employee, perms, canEdit, onClose, onChanged }) {
  const { profile, toast } = useAuth()
  const [f, setF] = useState({
    job_title: employee.job_title || '', address: employee.address || '', salary: employee.salary || 0,
    manager_id: employee.manager_id || '', iqama_expiry: employee.iqama_expiry || '', hr_notes: employee.hr_notes || '',
    birth_date: employee.birth_date || '', nationality: employee.nationality || '', id_number: employee.id_number || '',
    hire_date: employee.hire_date || '', end_date: employee.end_date || '', role: employee.role,
  })
  const [p, setP] = useState(perms || {
    staff_id: employee.id, user_id: employee.id, company_id: profile.company_id,
    can_discount: false, discount_max_percent: 10, can_cancel_booking: false,
    can_edit_data: true, can_upload_media: true, can_view_accountant: false, can_export_reports: false,
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
      birth_date: f.birth_date || null, nationality: f.nationality || null, id_number: f.id_number || null,
      hire_date: f.hire_date || null, end_date: f.end_date || null, role: f.role,
      id_photo_url, contract_url
    }).eq('id', employee.id)
    if (error) { setSaving(false); return toast('خطأ: ' + error.message, true) }
    const { error: pe } = await supabase.from('staff_permissions')
      .upsert({ ...p, user_id: employee.id, staff_id: employee.id, updated_at: new Date().toISOString() }, { onConflict: 'staff_id' })
    setSaving(false)
    if (pe) return toast('حُفظت بيانات الموظف، لكن فشلت الصلاحيات: ' + pe.message, true)
    toast('✓ حُفظ ملف الموظف والصلاحيات')
    onChanged(); onClose()
  }

  const deactivate = async () => {
    if (!confirm('تعطيل الحساب بتحديد تاريخ ترك العمل اليوم؟')) return
    const { error } = await supabase.from('profiles').update({ end_date: today() }).eq('id', employee.id)
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ عُطِّل الحساب'); onChanged(); onClose()
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

  const isEmp = f.role === 'employee'
  const ro = !canEdit // للعرض فقط عندما لا تتوفر صلاحية التعديل

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(920px,100%)' }}>
        <div className="modal-h"><h3>ملف الموظف — {employee.full_name}</h3><button className="x" onClick={onClose}>✕</button></div>
        <div className="modal-b">
          <h4 className="ts-h4">البيانات الشخصية والوظيفية</h4>
          <div className="grid3" style={{ marginBottom: 16 }}>
            <div className="fld"><label>الدور</label>
              <select disabled={ro} value={f.role} onChange={e => setF({ ...f, role: e.target.value })}>
                <option value="employee">موظف</option><option value="accountant">محاسب</option><option value="manager">مدير</option>
              </select></div>
            <div className="fld"><label>المسمى الوظيفي</label><input disabled={ro} value={f.job_title} onChange={e => setF({ ...f, job_title: e.target.value })} /></div>
            <div className="fld"><label>الراتب الشهري (ر.س)</label><input disabled={ro} type="number" value={f.salary} onChange={e => setF({ ...f, salary: e.target.value })} /></div>
            <div className="fld"><label>تاريخ الميلاد</label><input disabled={ro} type="date" value={f.birth_date} onChange={e => setF({ ...f, birth_date: e.target.value })} /></div>
            <div className="fld"><label>الجنسية</label><input disabled={ro} value={f.nationality} onChange={e => setF({ ...f, nationality: e.target.value })} /></div>
            <div className="fld"><label>رقم الهوية/الإقامة</label><input disabled={ro} dir="ltr" value={f.id_number} onChange={e => setF({ ...f, id_number: e.target.value })} /></div>
            <div className="fld"><label>العنوان</label><input disabled={ro} value={f.address} onChange={e => setF({ ...f, address: e.target.value })} /></div>
            <div className="fld"><label>المدير المباشر</label>
              <select disabled={ro} value={f.manager_id} onChange={e => setF({ ...f, manager_id: e.target.value })}>
                <option value="">— بدون —</option>
                {managers.map(m => <option key={m.id} value={m.id}>{m.full_name}</option>)}
              </select></div>
            <div className="fld"><label>تاريخ بدء العمل</label><input disabled={ro} type="date" value={f.hire_date} onChange={e => setF({ ...f, hire_date: e.target.value })} /></div>
            <div className="fld"><label>تاريخ ترك العمل</label><input disabled={ro} type="date" value={f.end_date} onChange={e => setF({ ...f, end_date: e.target.value })} /></div>
            <div className="fld"><label>تاريخ انتهاء الإقامة</label><input disabled={ro} type="date" value={f.iqama_expiry} onChange={e => setF({ ...f, iqama_expiry: e.target.value })} /></div>
            {canEdit && <div className="fld"><label>صورة الهوية/الإقامة</label><input type="file" accept="image/*,.pdf" onChange={e => setIdFile(e.target.files?.[0] || null)} /></div>}
            {canEdit && <div className="fld"><label>عقد العمل</label><input type="file" accept="image/*,.pdf" onChange={e => setContractFile(e.target.files?.[0] || null)} /></div>}
            <div className="fld" style={{ gridColumn: '1 / -1' }}><label>ملاحظات</label><input disabled={ro} value={f.hr_notes} onChange={e => setF({ ...f, hr_notes: e.target.value })} /></div>
          </div>

          {isEmp && (
            <div className="panel" style={{ marginBottom: 16, background: 'var(--soft)' }}>
              <b>الصلاحيات التفصيلية</b>
              <div className="grid2" style={{ marginTop: 8 }}>
                {Object.entries(PERM_FIELDS).map(([k, lbl]) => k === 'discount_max_percent' ? (
                  <div className="fld" key={k}><label>{lbl}</label>
                    <input disabled={ro} type="number" min="0" max="100" value={p.discount_max_percent ?? 10}
                      onChange={e => setP({ ...p, discount_max_percent: Number(e.target.value) })} /></div>
                ) : (
                  <label key={k}><input disabled={ro} type="checkbox" checked={!!p[k]} onChange={e => setP({ ...p, [k]: e.target.checked })} /> {lbl}</label>
                ))}
              </div>
            </div>
          )}

          {canEdit && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              <button className="btn btn-gold btn-sm" disabled={saving} onClick={save}>{saving ? '…' : 'حفظ البيانات والصلاحيات'}</button>
              <button className="btn btn-ghost btn-sm" onClick={deactivate}>تعطيل الحساب</button>
            </div>
          )}

          <h4 className="ts-h4">مؤشرات الأداء</h4>
          <div className="kpis" style={{ marginBottom: 16 }}>
            <div className="kpi"><div className="v">{complaints}</div><div className="l">شكاوى المستأجرين</div></div>
            <div className="kpi"><div className="v">{advances.length}</div><div className="l">عدد السلف</div></div>
            <div className="kpi"><div className="v">{SAR(advances.reduce((s, a) => s + num(a.amount), 0))}</div><div className="l">إجمالي السلف</div></div>
          </div>

          {canEdit && <>
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
          </>}
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
