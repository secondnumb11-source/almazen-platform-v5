import React, { useEffect, useMemo, useState } from 'react'
import { supabase, adminSignupClient, staffEmail, normalizeStaffUsername } from '../lib/supabase'
import { useAuth } from '../AuthContext'
import { uploadFile, ROLES } from '../lib/helpers'
import UnitActivityPanel from '../components/UnitActivityPanel'

/* إعدادات الإيميلات والتكامل تُحفظ محلياً في هذا المتصفح لكل منشأة،
   وتُطبَّق فوراً على واجهة التطبيق (مثل رابط بوابة المستأجر ورقم الواتساب المُرسل).
   المفاتيح السرّية الفعلية تبقى في متغيرات البيئة (.env) أو أسرار الخادم. */
const LSK = (companyId, ns) => `almazen:${companyId}:${ns}`
const loadLS = (k, fallback) => {
  try { const v = localStorage.getItem(k); return v ? { ...fallback, ...JSON.parse(v) } : fallback }
  catch { return fallback }
}
const saveLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

const DEFAULT_EMAIL = {
  senderName: '',
  senderEmail: '',
  confirmEmail: true,
  welcomeSubject: 'أهلاً بك في {company}',
  welcomeBody: 'شكراً لانضمامك إلينا. رابط بوابتك: {portal}',
}
const DEFAULT_INTEG = {
  whatsappNumber: '',
  ejarBaseUrl: '',
  publicBaseUrl: '',
  webhookUrl: '',
}

export default function Settings() {
  const { profile, company, toast, refreshCompany } = useAuth()
  const [tab, setTab] = useState('company')
  const [c, setC] = useState(company || {})
  const [staff, setStaff] = useState([])
  const [zatcaKey, setZatcaKey] = useState('')
  const [nu, setNu] = useState({
    full_name: '', username: '', password: '', role: 'employee',
    birth_date: '', nationality: '', id_number: '', hire_date: '', end_date: ''
  })
  const [perms, setPerms] = useState({}) // staff_id -> permissions object
  const [busy, setBusy] = useState(false)
  const [editStaff, setEditStaff] = useState(null)     // النسخة المعدّلة (المسودة)
  const [editOriginal, setEditOriginal] = useState(null) // النسخة الأصلية للمقارنة
  const [editPerms, setEditPerms] = useState(null)       // مسودة الصلاحيات
  const [editPermsOriginal, setEditPermsOriginal] = useState(null)

  const openEdit = (s) => {
    setEditStaff({ ...s })
    setEditOriginal({ ...s })
    const p = perms[s.id] || {
      staff_id: s.id, company_id: profile.company_id,
      can_discount: false, discount_max_percent: 10,
      can_cancel_booking: false, can_edit_data: true,
      can_upload_media: true, can_view_accountant: false,
      can_export_reports: false,
    }
    setEditPerms({ ...p })
    setEditPermsOriginal({ ...p })
  }
  const closeEdit = () => {
    setEditStaff(null); setEditOriginal(null)
    setEditPerms(null); setEditPermsOriginal(null)
  }

  const saveEditStaff = async () => {
    if (!editStaff) return
    const { id, full_name, role, birth_date, nationality, id_number, hire_date, end_date } = editStaff
    const { error } = await supabase.from('profiles').update({
      full_name, role,
      birth_date: birth_date || null, nationality: nationality || null,
      id_number: id_number || null, hire_date: hire_date || null,
      end_date: end_date || null,
    }).eq('id', id)
    if (error) return toast('خطأ في الحفظ: ' + error.message, true)
    // حفظ الصلاحيات إن تغيّرت
    if (editPerms && JSON.stringify(editPerms) !== JSON.stringify(editPermsOriginal)) {
      const { error: pe } = await supabase.from('staff_permissions')
        .upsert({ ...editPerms, updated_at: new Date().toISOString() }, { onConflict: 'staff_id' })
      if (pe) return toast('حُفظت البيانات، لكن فشلت الصلاحيات: ' + pe.message, true)
    }
    toast('✓ حُفظت بيانات الموظف والصلاحيات'); closeEdit(); loadStaff()
  }
  const deactivateStaff = async (id) => {
    if (!confirm('تعطيل الحساب بتحديد تاريخ ترك العمل اليوم؟')) return
    const today = new Date().toISOString().slice(0, 10)
    const { error } = await supabase.from('profiles').update({ end_date: today }).eq('id', id)
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ عُطِّل الحساب'); closeEdit(); loadStaff()
  }
  useEffect(() => setC(company || {}), [company])
  // مفتاح ZATCA يُخزَّن في جدول company_secrets المقيّد بالدور (لا على صف الشركة)
  useEffect(() => {
    if (!profile) return
    supabase.from('company_secrets').select('zatca_api_key').eq('company_id', profile.company_id).maybeSingle()
      .then(({ data }) => setZatcaKey(data?.zatca_api_key || ''))
  }, [profile])

  const emailKey = useMemo(() => LSK(profile?.company_id, 'email'), [profile])
  const integKey = useMemo(() => LSK(profile?.company_id, 'integration'), [profile])
  const [email, setEmail] = useState(DEFAULT_EMAIL)
  const [integ, setInteg] = useState(DEFAULT_INTEG)

  useEffect(() => {
    if (!profile) return
    setEmail(loadLS(emailKey, DEFAULT_EMAIL))
    setInteg(loadLS(integKey, { ...DEFAULT_INTEG, publicBaseUrl: company?.public_base_url || '' }))
  }, [profile, emailKey, integKey, company])

  const loadStaff = async () => {
    const { data } = await supabase.from('profiles').select('*').eq('company_id', profile.company_id)
    setStaff(data || [])
    // تحميل الصلاحيات من جدول staff_permissions
    const ids = (data || []).map(s => s.id)
    if (ids.length) {
      const { data: pr } = await supabase.from('staff_permissions').select('*').in('staff_id', ids)
      const map = {}
      ;(pr || []).forEach(p => { map[p.staff_id] = p })
      setPerms(map)
    }
  }
  useEffect(() => { loadStaff() /* eslint-disable-next-line */ }, [profile])

  const saveCompany = async () => {
    const { error } = await supabase.from('companies').update({
      name: c.name, vat_number: c.vat_number, cr_number: c.cr_number,
      address: c.address, city: c.city, phone: c.phone, email: c.email,
      invoice_footer: c.invoice_footer, default_vat_rate: c.default_vat_rate || 15,
      public_base_url: c.public_base_url || null,
    }).eq('id', profile.company_id)
    if (error) return toast(explain(error), true)
    toast('✓ حُفظت بيانات الترويسة والهوية'); refreshCompany()
  }

  const uploadLogo = async (file) => {
    try {
      const url = await uploadFile(supabase, 'unit-media', profile.company_id, file)
      await supabase.from('companies').update({ logo_url: url }).eq('id', profile.company_id)
      toast('✓ استُبدل شعار النظام بشعار منشأتك فوراً'); refreshCompany()
    } catch (e) { toast('فشل الرفع: ' + e.message, true) }
  }

  const saveZatca = async () => {
    const { error } = await supabase.from('company_secrets')
      .upsert({ company_id: profile.company_id, zatca_api_key: zatcaKey || null, updated_at: new Date().toISOString() },
        { onConflict: 'company_id' })
    if (error) return toast(explain(error), true)
    toast('✓ حُفظ مفتاح ZATCA')
  }

  const saveEmail = () => {
    saveLS(emailKey, email)
    toast('✓ حُفظت إعدادات الإيميلات وطُبّقت فوراً')
  }
  const saveInteg = async () => {
    saveLS(integKey, integ)
    if (integ.publicBaseUrl && integ.publicBaseUrl !== company?.public_base_url) {
      await supabase.from('companies')
        .update({ public_base_url: integ.publicBaseUrl }).eq('id', profile.company_id)
      refreshCompany()
    }
    toast('✓ حُفظت إعدادات التكامل وطُبّقت فوراً')
  }

  const addStaff = async () => {
    if (!nu.full_name || !nu.username || nu.password.length < 6)
      return toast('أكمل البيانات (كلمة المرور 6 أحرف على الأقل)', true)
    setBusy(true)
    try {
      const username = normalizeStaffUsername(nu.username)
      const { data, error } = await adminSignupClient.auth.signUp({
        email: staffEmail(username), password: nu.password,
      })
      if (error) throw error
      const uid = data.user?.id
      if (!uid) throw new Error('لم يُنشأ المستخدم — تأكد من إيقاف "Confirm email" في إعدادات Supabase Auth')
      const { error: pe } = await supabase.from('profiles').insert({
        id: uid, company_id: profile.company_id, role: nu.role,
        full_name: nu.full_name, username, created_by: profile.id,
        birth_date: nu.birth_date || null, nationality: nu.nationality || null,
        id_number: nu.id_number || null, hire_date: nu.hire_date || null,
        end_date: nu.end_date || null,
      })
      if (pe) throw pe
      // إنشاء صف افتراضي في staff_permissions
      await supabase.from('staff_permissions').insert({
        staff_id: uid, company_id: profile.company_id,
        can_discount: false, discount_max_percent: 10,
        can_cancel_booking: false, can_edit_data: true,
        can_upload_media: true, can_view_accountant: false,
        can_export_reports: false,
      })
      toast(`✓ أُنشئ حساب ${nu.full_name} — الدخول باسم المستخدم "${username}"`)
      setNu({ full_name: '', username: '', password: '', role: 'employee',
        birth_date: '', nationality: '', id_number: '', hire_date: '', end_date: '' })
      loadStaff()
    } catch (e) { toast(explain(e), true) } finally { setBusy(false) }
  }

  const updatePerm = async (staffId, patch) => {
    const current = perms[staffId] || { staff_id: staffId, company_id: profile.company_id }
    const next = { ...current, ...patch }
    setPerms(p => ({ ...p, [staffId]: next }))
    const { error } = await supabase.from('staff_permissions')
      .upsert({ ...next, updated_at: new Date().toISOString() }, { onConflict: 'staff_id' })
    if (error) toast('خطأ في حفظ الصلاحية: ' + error.message, true)
    else toast('✓ حُفظت الصلاحية')
  }

  const TABS = [
    { k: 'company', label: 'المنشأة', icon: '🏛️' },
    { k: 'email',   label: 'الإيميلات', icon: '✉️' },
    { k: 'integ',   label: 'التكامل', icon: '🔌' },
    { k: 'staff',   label: 'الحسابات', icon: '👥' },
    { k: 'activity', label: 'نشاط وحدة', icon: '📋' },
  ]

  return (
    <div>
      <div className="pg-title"><h2>الإعدادات — الهوية والفوترة والتكامل (صلاحية المدير)</h2></div>

      <div className="settings-tabs">
        {TABS.map(t => (
          <button key={t.k} className={tab === t.k ? 'on' : ''} onClick={() => setTab(t.k)}>
            <span>{t.icon}</span><span>{t.label}</span>
          </button>
        ))}
      </div>

      {tab === 'company' && (
        <div className="grid2">
          <div className="panel"><h3>الشعار والترويسة (تظهر على الفاتورة)</h3>
            <div className="fld"><label>شعار المنشأة — يستبدل شعار النظام فوراً</label>
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                {company?.logo_url && <img src={company.logo_url} alt="logo" style={{ width: 52, height: 52, borderRadius: 12, objectFit: 'cover' }} />}
                <input type="file" accept="image/*" onChange={e => e.target.files[0] && uploadLogo(e.target.files[0])} />
              </div></div>
            <div className="grid2">
              <div className="fld"><label>اسم المنشأة</label><input value={c.name || ''} onChange={e => setC({ ...c, name: e.target.value })} /></div>
              <div className="fld"><label>الرقم الضريبي VAT</label><input value={c.vat_number || ''} onChange={e => setC({ ...c, vat_number: e.target.value })} dir="ltr" /></div>
              <div className="fld"><label>السجل التجاري</label><input value={c.cr_number || ''} onChange={e => setC({ ...c, cr_number: e.target.value })} dir="ltr" /></div>
              <div className="fld"><label>نسبة الضريبة %</label><input type="number" value={c.default_vat_rate || 15} onChange={e => setC({ ...c, default_vat_rate: e.target.value })} /></div>
              <div className="fld"><label>الجوال</label><input value={c.phone || ''} onChange={e => setC({ ...c, phone: e.target.value })} dir="ltr" /></div>
              <div className="fld"><label>المدينة</label><input value={c.city || ''} onChange={e => setC({ ...c, city: e.target.value })} /></div>
            </div>
            <div className="fld"><label>العنوان</label><input value={c.address || ''} onChange={e => setC({ ...c, address: e.target.value })} /></div>
            <div className="fld"><label>رابط الموقع المنشور (لبناء رابط بوابة المستأجر في رسائل واتساب التلقائية)</label>
              <input value={c.public_base_url || ''} onChange={e => setC({ ...c, public_base_url: e.target.value })} dir="ltr" placeholder="https://your-domain.com" /></div>
            <div className="fld"><label>نص أسفل الفاتورة</label><input value={c.invoice_footer || ''} onChange={e => setC({ ...c, invoice_footer: e.target.value })} /></div>
            <button className="btn btn-gold btn-sm" onClick={saveCompany}>حفظ البيانات</button>
          </div>

          <div className="panel"><h3>الربط مع ZATCA</h3>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>البوابة جاهزة لاستقبال مفتاح الربط — يُفعّل الإرسال الفعلي لاحقاً.</p>
            <div className="fld"><label>مفتاح ZATCA API</label>
              <input type="password" value={zatcaKey} onChange={e => setZatcaKey(e.target.value)} dir="ltr" /></div>
            <button className="btn btn-green btn-sm" onClick={saveZatca}>حفظ المفتاح</button>
          </div>
        </div>
      )}

      {tab === 'email' && (
        <div className="panel">
          <h3>تكوين إيميلات المنشأة</h3>
          <div className="settings-hint">
            <b>ملاحظة:</b> هذه الإعدادات تُطبَّق فوراً على قوالب الرسائل التلقائية داخل التطبيق. أما إعدادات SMTP وتأكيد البريد لحسابات Supabase Auth فتُدار من لوحة Supabase → Authentication → Email.
          </div>
          <div className="grid2">
            <div className="fld"><label>اسم المرسل</label>
              <input value={email.senderName} onChange={e => setEmail({ ...email, senderName: e.target.value })} placeholder="مؤسسة المازن" /></div>
            <div className="fld"><label>بريد المرسل</label>
              <input type="email" dir="ltr" value={email.senderEmail} onChange={e => setEmail({ ...email, senderEmail: e.target.value })} placeholder="no-reply@your-domain.com" /></div>
          </div>
          <div className="fld"><label>عنوان رسالة الترحيب (يدعم {'{company}'} و{'{portal}'})</label>
            <input value={email.welcomeSubject} onChange={e => setEmail({ ...email, welcomeSubject: e.target.value })} /></div>
          <div className="fld"><label>نص رسالة الترحيب</label>
            <textarea rows="4" value={email.welcomeBody} onChange={e => setEmail({ ...email, welcomeBody: e.target.value })} /></div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 14px', cursor: 'pointer' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={email.confirmEmail} onChange={e => setEmail({ ...email, confirmEmail: e.target.checked })} />
            <span>تفعيل تأكيد البريد الإلكتروني لحسابات المدير الجدد (يتطلب أيضاً تفعيله في Supabase Auth)</span>
          </label>
          <button className="btn btn-gold btn-sm" onClick={saveEmail}>حفظ وتطبيق</button>
        </div>
      )}

      {tab === 'integ' && (
        <div className="panel">
          <h3>تهيئة التكامل والقنوات</h3>
          <div className="settings-hint">
            القيم أدناه عامة (غير سرّية) وتُحفظ محلياً في هذا المتصفح لكل منشأة. المفاتيح والأسرار الحقيقية تبقى في متغيرات البيئة على الخادم.
          </div>
          <div className="grid2">
            <div className="fld"><label>رقم واتساب المنشأة (للرسائل التلقائية)</label>
              <input dir="ltr" value={integ.whatsappNumber} onChange={e => setInteg({ ...integ, whatsappNumber: e.target.value })} placeholder="+9665XXXXXXXX" /></div>
            <div className="fld"><label>رابط منصة إيجار (Ejar)</label>
              <input dir="ltr" value={integ.ejarBaseUrl} onChange={e => setInteg({ ...integ, ejarBaseUrl: e.target.value })} placeholder="https://www.ejar.sa" /></div>
            <div className="fld"><label>رابط الموقع المنشور — لبوابة المستأجر</label>
              <input dir="ltr" value={integ.publicBaseUrl} onChange={e => setInteg({ ...integ, publicBaseUrl: e.target.value })} placeholder="https://your-domain.com" /></div>
            <div className="fld"><label>Webhook للإشعارات الخارجية (اختياري)</label>
              <input dir="ltr" value={integ.webhookUrl} onChange={e => setInteg({ ...integ, webhookUrl: e.target.value })} placeholder="https://hooks.example.com/almazen" /></div>
          </div>
          <button className="btn btn-gold btn-sm" onClick={saveInteg}>حفظ وتطبيق</button>
        </div>
      )}

      {tab === 'staff' && (
        <>
          <div className="panel"><h3>حسابات الموظفين — البيانات الكاملة (ينشئها المدير)</h3>
            <table className="tbl" style={{ marginBottom: 12 }}>
              <thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الدور</th><th>الجنسية</th><th>الهوية</th><th>بدء العمل</th><th>ترك العمل</th><th></th></tr></thead>
              <tbody>{staff.map(s =>
                <tr key={s.id}>
                  <td>{s.full_name}</td>
                  <td dir="ltr">{s.username || '—'}</td>
                  <td>{ROLES[s.role]}</td>
                  <td>{s.nationality || '—'}</td>
                  <td dir="ltr">{s.id_number || '—'}</td>
                  <td dir="ltr">{s.hire_date || '—'}</td>
                  <td dir="ltr">{s.end_date || '—'}</td>
                  <td><button className="btn btn-sm" onClick={() => openEdit(s)}>تعديل</button></td>
                </tr>)}
              </tbody>
            </table>
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
            <button className="btn btn-blue btn-sm" disabled={busy} onClick={addStaff}>+ إنشاء حساب موظف</button>
          </div>

          <div className="panel" style={{ marginTop: 14 }}><h3>الصلاحيات التفصيلية للموظفين</h3>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 10 }}>يُحدَّد لكل موظف ما يستطيع فعله. المدير والمحاسب لديهما صلاحيات كاملة تلقائياً — الجدول أدناه للموظفين فقط.</p>
            <table className="tbl">
              <thead><tr>
                <th>الموظف</th><th>خصم</th><th>حد الخصم %</th><th>إلغاء حجز</th><th>تعديل بيانات</th><th>رفع صور/فيديو</th><th>بوابة المحاسب</th><th>إصدار تقارير</th>
              </tr></thead>
              <tbody>
                {staff.filter(s => s.role === 'employee').length === 0 && (
                  <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا يوجد موظفون بدور "موظف" بعد</td></tr>
                )}
                {staff.filter(s => s.role === 'employee').map(s => {
                  const p = perms[s.id] || {}
                  return (
                    <tr key={s.id}>
                      <td><b>{s.full_name}</b><br/><small dir="ltr">{s.username}</small></td>
                      <td><input type="checkbox" checked={!!p.can_discount} onChange={e => updatePerm(s.id, { can_discount: e.target.checked })} /></td>
                      <td><input type="number" min="0" max="100" style={{ width: 70 }} value={p.discount_max_percent ?? 10}
                        onChange={e => updatePerm(s.id, { discount_max_percent: Number(e.target.value) })} /></td>
                      <td><input type="checkbox" checked={!!p.can_cancel_booking} onChange={e => updatePerm(s.id, { can_cancel_booking: e.target.checked })} /></td>
                      <td><input type="checkbox" checked={!!p.can_edit_data} onChange={e => updatePerm(s.id, { can_edit_data: e.target.checked })} /></td>
                      <td><input type="checkbox" checked={!!p.can_upload_media} onChange={e => updatePerm(s.id, { can_upload_media: e.target.checked })} /></td>
                      <td><input type="checkbox" checked={!!p.can_view_accountant} onChange={e => updatePerm(s.id, { can_view_accountant: e.target.checked })} /></td>
                      <td><input type="checkbox" checked={!!p.can_export_reports} onChange={e => updatePerm(s.id, { can_export_reports: e.target.checked })} /></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'activity' && <UnitActivityPanel />}

      {editStaff && (() => {
        const changed = []
        const fields = { full_name: 'الاسم', role: 'الدور', birth_date: 'الميلاد',
          nationality: 'الجنسية', id_number: 'رقم الهوية', hire_date: 'بدء العمل', end_date: 'ترك العمل' }
        Object.entries(fields).forEach(([k, lbl]) => {
          const a = editOriginal?.[k] || '—', b = editStaff?.[k] || '—'
          if (String(a) !== String(b)) changed.push({ lbl, from: a, to: b })
        })
        const permLabels = {
          can_discount: 'خصم', discount_max_percent: 'حد الخصم %',
          can_cancel_booking: 'إلغاء حجز', can_edit_data: 'تعديل بيانات',
          can_upload_media: 'رفع وسائط', can_view_accountant: 'بوابة المحاسب',
          can_export_reports: 'إصدار تقارير',
        }
        const permChanged = []
        Object.entries(permLabels).forEach(([k, lbl]) => {
          const a = editPermsOriginal?.[k], b = editPerms?.[k]
          if (JSON.stringify(a) !== JSON.stringify(b)) permChanged.push({ lbl, from: fmtVal(a), to: fmtVal(b) })
        })
        const hasChanges = changed.length + permChanged.length > 0
        const isEmp = editStaff.role === 'employee'
        return (
          <div className="modal-back" onClick={closeEdit}>
            <div className="modal" style={{ maxWidth: 780 }} onClick={e => e.stopPropagation()}>
              <h3>تعديل الموظف — {editStaff.full_name}</h3>
              <div className="grid2">
                <div className="fld"><label>الاسم الكامل</label>
                  <input value={editStaff.full_name || ''} onChange={e => setEditStaff({ ...editStaff, full_name: e.target.value })} /></div>
                <div className="fld"><label>الدور</label>
                  <select value={editStaff.role} onChange={e => setEditStaff({ ...editStaff, role: e.target.value })}>
                    <option value="employee">موظف</option>
                    <option value="accountant">محاسب</option>
                    <option value="manager">مدير</option>
                  </select></div>
                <div className="fld"><label>تاريخ الميلاد</label>
                  <input type="date" value={editStaff.birth_date || ''} onChange={e => setEditStaff({ ...editStaff, birth_date: e.target.value })} /></div>
                <div className="fld"><label>الجنسية</label>
                  <input value={editStaff.nationality || ''} onChange={e => setEditStaff({ ...editStaff, nationality: e.target.value })} /></div>
                <div className="fld"><label>رقم الهوية/الإقامة</label>
                  <input dir="ltr" value={editStaff.id_number || ''} onChange={e => setEditStaff({ ...editStaff, id_number: e.target.value })} /></div>
                <div className="fld"><label>تاريخ بدء العمل</label>
                  <input type="date" value={editStaff.hire_date || ''} onChange={e => setEditStaff({ ...editStaff, hire_date: e.target.value })} /></div>
                <div className="fld"><label>تاريخ ترك العمل</label>
                  <input type="date" value={editStaff.end_date || ''} onChange={e => setEditStaff({ ...editStaff, end_date: e.target.value })} /></div>
              </div>

              {isEmp && editPerms && (
                <div className="panel" style={{ marginTop: 10, padding: 10 }}>
                  <b>الصلاحيات التفصيلية</b>
                  <div className="grid2" style={{ marginTop: 8 }}>
                    <label><input type="checkbox" checked={!!editPerms.can_discount} onChange={e => setEditPerms({ ...editPerms, can_discount: e.target.checked })} /> السماح بالخصم</label>
                    <div className="fld"><label>حد الخصم الأقصى %</label>
                      <input type="number" min="0" max="100" value={editPerms.discount_max_percent ?? 10}
                        onChange={e => setEditPerms({ ...editPerms, discount_max_percent: Number(e.target.value) })} /></div>
                    <label><input type="checkbox" checked={!!editPerms.can_cancel_booking} onChange={e => setEditPerms({ ...editPerms, can_cancel_booking: e.target.checked })} /> إلغاء الحجوزات</label>
                    <label><input type="checkbox" checked={!!editPerms.can_edit_data} onChange={e => setEditPerms({ ...editPerms, can_edit_data: e.target.checked })} /> تعديل البيانات</label>
                    <label><input type="checkbox" checked={!!editPerms.can_upload_media} onChange={e => setEditPerms({ ...editPerms, can_upload_media: e.target.checked })} /> رفع صور/فيديو</label>
                    <label><input type="checkbox" checked={!!editPerms.can_view_accountant} onChange={e => setEditPerms({ ...editPerms, can_view_accountant: e.target.checked })} /> بوابة المحاسب</label>
                    <label><input type="checkbox" checked={!!editPerms.can_export_reports} onChange={e => setEditPerms({ ...editPerms, can_export_reports: e.target.checked })} /> إصدار التقارير</label>
                  </div>
                </div>
              )}

              <div className="panel" style={{ marginTop: 10, padding: 10, background: hasChanges ? 'rgba(212,175,55,.08)' : 'transparent' }}>
                <b>معاينة التغييرات قبل الحفظ</b>
                {!hasChanges && <div style={{ color: 'var(--muted)', fontSize: 13, marginTop: 6 }}>لا توجد تغييرات بعد.</div>}
                {hasChanges && (
                  <table className="tbl" style={{ marginTop: 6 }}>
                    <thead><tr><th>الحقل</th><th>القيمة السابقة</th><th>القيمة الجديدة</th></tr></thead>
                    <tbody>
                      {changed.map((c, i) => <tr key={'f' + i}><td>{c.lbl}</td><td dir="ltr">{c.from}</td><td dir="ltr"><b>{c.to}</b></td></tr>)}
                      {permChanged.map((c, i) => <tr key={'p' + i}><td>صلاحية: {c.lbl}</td><td>{c.from}</td><td><b>{c.to}</b></td></tr>)}
                    </tbody>
                  </table>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
                <button className="btn btn-sm" onClick={closeEdit}>إلغاء دون حفظ</button>
                <button className="btn btn-sm btn-red" onClick={() => deactivateStaff(editStaff.id)}>تعطيل الحساب</button>
                <button className="btn btn-sm btn-gold" disabled={!hasChanges} onClick={saveEditStaff}>حفظ التعديلات</button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

function explain(err) {
  const code = err?.code || ''
  const msg = err?.message || 'خطأ غير متوقع'
  if (code === '42501' || /permission denied|row-level security|policy/i.test(msg))
    return 'صلاحيات قاعدة البيانات ناقصة — نفّذ ملف supabase/POST_SETUP_FIX.sql ثم أعد المحاولة.'
  return 'خطأ: ' + msg
}

function fmtVal(v) {
  if (v === true) return '✓ مفعّل'
  if (v === false) return '✗ غير مفعّل'
  if (v == null || v === '') return '—'
  return String(v)
}
