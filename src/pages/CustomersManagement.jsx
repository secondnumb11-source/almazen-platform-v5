import React, { useEffect, useState, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../AuthContext'
import { SAR, num, today, uploadFile, PAY_METHODS } from '../lib/helpers'
import RentalContract from '../components/RentalContract'
import PrintableDoc, { DocGrid } from '../components/PrintableDoc'

const ID_TYPES = { national_id: 'هوية وطنية', iqama: 'إقامة', passport: 'جواز سفر' }
const PAY_TYPE_LABEL = { rent: 'إيجار', down_payment: 'عربون', insurance: 'تأمين', penalty: 'غرامة', other: 'أخرى' }

/* إدارة العملاء والمستأجرين — CRM موحّد مع نظام الولاء وبيانات بوابة المستأجر */
export default function CustomersManagement() {
  const { profile, toast } = useAuth()
  const [customers, setCustomers] = useState([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [adding, setAdding] = useState(false)

  const load = async () => {
    setLoading(true)
    const { data } = await supabase.from('customers')
      .select(`*, bookings(
        id, total_amount, base_price, discount_percent, discount_amount, contract_number,
        check_in_date, check_out_date, status, rent_period, down_payment, insurance_amount, unit_id,
        units(unit_number, category, description),
        payments(amount, payment_type, method, payment_date, reference_number, document_url),
        profiles!bookings_employee_id_fkey(full_name)
      )`)
      .eq('company_id', profile.company_id).order('full_name')
    setCustomers(data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [profile])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return customers
    return customers.filter(c => c.full_name?.toLowerCase().includes(q) || c.id_number?.includes(q) || c.phone?.includes(q))
  }, [customers, search])

  return (
    <div>
      <div className="pg-title"><h2>👥 إدارة العملاء والمستأجرين</h2>
        <button className="btn btn-gold btn-sm" onClick={() => setAdding(true)}>+ عميل جديد</button>
      </div>

      <div className="panel" style={{ marginBottom: 16 }}>
        <input placeholder="ابحث بالاسم أو رقم الهوية أو الجوال…" value={search} onChange={e => setSearch(e.target.value)} style={{ marginBottom: 12 }} />
        <table className="tbl">
          <thead><tr><th>الاسم</th><th>نوع الإثبات</th><th>رقم الإثبات</th><th>الجوال</th><th>عدد الإقامات</th><th>نقاط الولاء</th><th></th></tr></thead>
          <tbody>
            {loading && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)' }}>جارٍ التحميل…</td></tr>}
            {!loading && filtered.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد نتائج</td></tr>}
            {filtered.map(c => (
              <tr key={c.id}>
                <td>{c.full_name} {c.is_vip && <span className="chip chip-gold">VIP</span>}</td>
                <td>{ID_TYPES[c.id_type]}</td>
                <td dir="ltr">{c.id_number}</td>
                <td dir="ltr">{c.phone}</td>
                <td>{(c.bookings || []).length}</td>
                <td><span className="chip chip-ok">{c.loyalty_points} نقطة</span></td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => setSelected(c)}>عرض الملف</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && <AddCustomerModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); load() }} />}
      {selected && <CustomerDetail customer={selected} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  )
}

function AddCustomerModal({ onClose, onSaved }) {
  const { profile, toast } = useAuth()
  const [f, setF] = useState({ full_name: '', id_type: 'national_id', id_number: '', birth_date: '', phone: '', email: '', notes: '' })
  const [idFile, setIdFile] = useState(null)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!f.full_name || !f.id_number || !f.phone) return toast('أكمل الاسم ورقم الإثبات والجوال', true)
    setSaving(true)
    const id_document_url = idFile ? await uploadFile(supabase, 'documents', profile.company_id, idFile) : null
    const { error } = await supabase.from('customers').insert({
      ...f, birth_date: f.birth_date || null, id_document_url,
      company_id: profile.company_id, created_by: profile.id
    })
    setSaving(false)
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ أُضيف العميل بنجاح')
    onSaved()
  }

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(560px,100%)' }}>
        <div className="modal-h"><h3>عميل جديد</h3><button className="x" onClick={onClose}>✕</button></div>
        <div className="modal-b">
          <div className="grid2">
            <div className="fld"><label>الاسم الكامل *</label><input value={f.full_name} onChange={e => setF({ ...f, full_name: e.target.value })} /></div>
            <div className="fld"><label>نوع الإثبات</label>
              <select value={f.id_type} onChange={e => setF({ ...f, id_type: e.target.value })}>
                {Object.entries(ID_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></div>
            <div className="fld"><label>رقم الإثبات *</label><input dir="ltr" value={f.id_number} onChange={e => setF({ ...f, id_number: e.target.value })} /></div>
            <div className="fld"><label>تاريخ الميلاد</label><input type="date" value={f.birth_date} onChange={e => setF({ ...f, birth_date: e.target.value })} /></div>
            <div className="fld"><label>الجوال *</label><input dir="ltr" value={f.phone} onChange={e => setF({ ...f, phone: e.target.value })} /></div>
            <div className="fld"><label>البريد الإلكتروني</label><input dir="ltr" value={f.email} onChange={e => setF({ ...f, email: e.target.value })} /></div>
            <div className="fld"><label>مستند الهوية/الإقامة</label><input type="file" accept="image/*,.pdf" onChange={e => setIdFile(e.target.files?.[0] || null)} /></div>
            <div className="fld" style={{ gridColumn: '1 / -1' }}><label>ملاحظات</label><input value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} /></div>
          </div>
          <button className="btn btn-gold" style={{ width: '100%', marginTop: 12 }} disabled={saving} onClick={save}>{saving ? '…جارٍ الحفظ' : 'حفظ العميل'}</button>
        </div>
      </div>
    </div>
  )
}

function CustomerDetail({ customer, onClose, onChanged }) {
  const { profile, company, toast, isOwner } = useAuth()
  const canEdit = isOwner || profile.role === 'accountant'      // تعديل بيانات العميل
  const canEditPortal = true                                     // كل الأدوار تعدّل بيانات دخول البوابة
  const [loyalty, setLoyalty] = useState([])
  const [templates, setTemplates] = useState([])
  const [portalAccts, setPortalAccts] = useState({})
  const [editingCreds, setEditingCreds] = useState(null)
  const [msgPreview, setMsgPreview] = useState('')
  const [editingInfo, setEditingInfo] = useState(false)
  const [infoForm, setInfoForm] = useState({
    full_name: customer.full_name || '', id_type: customer.id_type || 'national_id',
    id_number: customer.id_number || '', birth_date: customer.birth_date || '',
    phone: customer.phone || '', email: customer.email || '', notes: customer.notes || ''
  })
  const [idFile, setIdFile] = useState(null)
  const [savingInfo, setSavingInfo] = useState(false)
  const [redeemPoints, setRedeemPoints] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [contractFor, setContractFor] = useState(null)
  const [showReport, setShowReport] = useState(false)

  const saveInfo = async () => {
    if (!infoForm.full_name || !infoForm.id_number || !infoForm.phone) return toast('أكمل الاسم ورقم الإثبات والجوال', true)
    setSavingInfo(true)
    const patch = { ...infoForm, birth_date: infoForm.birth_date || null }
    if (idFile) patch.id_document_url = await uploadFile(supabase, 'documents', profile.company_id, idFile)
    const { error } = await supabase.from('customers').update(patch).eq('id', customer.id)
    setSavingInfo(false)
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ حُدّثت بيانات العميل')
    setEditingInfo(false)
    onChanged()
  }

  const doRedeem = async () => {
    const pts = num(redeemPoints)
    if (!pts || pts <= 0) return toast('أدخل عدد نقاط صحيحاً', true)
    setRedeeming(true)
    const { data, error } = await supabase.rpc('redeem_loyalty_points', { p_customer_id: customer.id, p_points: pts })
    setRedeeming(false)
    if (error) return toast('خطأ: ' + error.message, true)
    toast(`✓ استُبدلت ${pts} نقطة = ${SAR(data)}`)
    setRedeemPoints('')
    onChanged()
  }

  useEffect(() => {
    supabase.from('loyalty_transactions').select('*').eq('customer_id', customer.id).order('created_at', { ascending: false })
      .then(({ data }) => setLoyalty(data || []))
    supabase.from('message_templates').select('*').eq('company_id', profile.company_id)
      .then(({ data }) => setTemplates(data || []))
    const bookingIds = (customer.bookings || []).map(b => b.id)
    if (bookingIds.length) {
      supabase.from('tenant_portal_accounts').select('booking_id, username, access_token, is_active').in('booking_id', bookingIds)
        .then(({ data }) => {
          const m = {}; (data || []).forEach(a => { m[a.booking_id] = a }); setPortalAccts(m)
        })
    }
  }, [customer, profile])

  const saveUsername = async (bookingId, username) => {
    const { error } = await supabase.from('tenant_portal_accounts').update({ username }).eq('booking_id', bookingId)
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ حُدّث اسم المستخدم')
    setEditingCreds(null)
    setPortalAccts(m => ({ ...m, [bookingId]: { ...m[bookingId], username } }))
  }

  const regenToken = async (bookingId) => {
    const { data, error } = await supabase.rpc('portal_regenerate_token', { p_booking_id: bookingId })
    if (error) return toast('تعذّر توليد رمز جديد: ' + error.message, true)
    toast('✓ تم توليد رمز دخول جديد')
    setPortalAccts(m => ({ ...m, [bookingId]: { ...m[bookingId], access_token: data } }))
  }

  const togglePortal = async (bookingId, active) => {
    const { error } = await supabase.from('tenant_portal_accounts').update({ is_active: active }).eq('booking_id', bookingId)
    if (error) return toast('خطأ: ' + error.message, true)
    toast(active ? '✓ فُعّل حساب البوابة' : '✓ عُطّل حساب البوابة')
    setPortalAccts(m => ({ ...m, [bookingId]: { ...m[bookingId], is_active: active } }))
  }

  // إجماليات مالية للعميل عبر كل حجوزاته
  const allPayments = (customer.bookings || []).flatMap(b => (b.payments || []).map(p => ({ ...p, unit: b.units?.unit_number })))
  const totalContracted = (customer.bookings || []).reduce((s, b) => s + num(b.total_amount), 0)
  const totalPaid = allPayments.reduce((s, p) => s + num(p.amount), 0)
  const totalInsurance = allPayments.filter(p => p.payment_type === 'insurance').reduce((s, p) => s + num(p.amount), 0)
  const totalDeposit = allPayments.filter(p => p.payment_type === 'down_payment').reduce((s, p) => s + num(p.amount), 0)
  const lastRedeem = loyalty.find(l => l.points < 0)

  const activeBooking = (customer.bookings || []).find(b => b.status === 'checked_in') || customer.bookings?.[0]

  const applyTemplate = (t) => {
    const unit = activeBooking?.units?.unit_number || '—'
    const checkout = activeBooking?.check_out_date || '—'
    const checkin = activeBooking?.check_in_date || '—'
    const body = t.body
      .replace('{name}', customer.full_name)
      .replace('{company}', company?.name || 'المازن')
      .replace('{unit}', unit)
      .replace('{checkin}', checkin)
      .replace('{checkout}', checkout)
      .replace('{amount}', '—')
    setMsgPreview(body)
  }

  const sendWhatsApp = () => {
    const phone = (customer.phone || '').replace(/\D/g, '').replace(/^0/, '966')
    window.open(`https://wa.me/${phone}?text=${encodeURIComponent(msgPreview)}`, '_blank')
  }

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(820px,100%)' }}>
        <div className="modal-h"><h3>ملف العميل — {customer.full_name}</h3><button className="x" onClick={onClose}>✕</button></div>
        <div className="modal-b">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
            <button className="btn btn-blue btn-sm" onClick={() => setShowReport(true)}>🖨 طباعة تقرير العميل الشامل</button>
            {customer.id_document_url && <a className="btn btn-ghost btn-sm" href={customer.id_document_url} target="_blank" rel="noreferrer">🪪 عرض مستند الهوية</a>}
          </div>

          {!editingInfo ? (
            <div className="ts-grid" style={{ marginBottom: 16 }}>
              <div><b>الاسم الكامل</b><span>{customer.full_name}</span></div>
              <div><b>نوع الإثبات</b><span>{ID_TYPES[customer.id_type]}</span></div>
              <div><b>رقم الإثبات</b><span dir="ltr">{customer.id_number}</span></div>
              <div><b>تاريخ الميلاد</b><span dir="ltr">{customer.birth_date || '—'}</span></div>
              <div><b>الجوال</b><span dir="ltr">{customer.phone}</span></div>
              <div><b>البريد</b><span>{customer.email || '—'}</span></div>
              <div><b>نقاط الولاء</b><span className="money">{customer.loyalty_points} نقطة</span></div>
              <div><b>آخر استبدال</b><span>{lastRedeem ? lastRedeem.created_at?.slice(0, 10) : '—'}</span></div>
              <div><b>VIP</b><span>{customer.is_vip ? 'نعم' : 'لا'}</span></div>
              {canEdit && <div style={{ gridColumn: '1 / -1' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditingInfo(true)}>✎ تعديل بيانات العميل</button>
              </div>}
            </div>
          ) : (
            <div className="grid2" style={{ marginBottom: 16, background: 'var(--soft)', padding: 12, borderRadius: 8 }}>
              <div className="fld"><label>الاسم الكامل</label><input value={infoForm.full_name} onChange={e => setInfoForm({ ...infoForm, full_name: e.target.value })} /></div>
              <div className="fld"><label>نوع الإثبات</label>
                <select value={infoForm.id_type} onChange={e => setInfoForm({ ...infoForm, id_type: e.target.value })}>
                  {Object.entries(ID_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select></div>
              <div className="fld"><label>رقم الإثبات</label><input dir="ltr" value={infoForm.id_number} onChange={e => setInfoForm({ ...infoForm, id_number: e.target.value })} /></div>
              <div className="fld"><label>تاريخ الميلاد</label><input type="date" value={infoForm.birth_date} onChange={e => setInfoForm({ ...infoForm, birth_date: e.target.value })} /></div>
              <div className="fld"><label>الجوال</label><input dir="ltr" value={infoForm.phone} onChange={e => setInfoForm({ ...infoForm, phone: e.target.value })} /></div>
              <div className="fld"><label>البريد الإلكتروني</label><input dir="ltr" value={infoForm.email} onChange={e => setInfoForm({ ...infoForm, email: e.target.value })} /></div>
              <div className="fld"><label>تحديث مستند الهوية/الإقامة</label><input type="file" accept="image/*,.pdf" onChange={e => setIdFile(e.target.files?.[0] || null)} /></div>
              <div className="fld"><label>ملاحظات</label><input value={infoForm.notes} onChange={e => setInfoForm({ ...infoForm, notes: e.target.value })} /></div>
              <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8 }}>
                <button className="btn btn-gold btn-sm" disabled={savingInfo} onClick={saveInfo}>{savingInfo ? '…' : 'حفظ'}</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditingInfo(false)}>إلغاء</button>
              </div>
            </div>
          )}

          {canEdit && (
            <div className="panel" style={{ marginBottom: 16, background: 'var(--soft)' }}>
              <b>استبدال نقاط الولاء</b>
              <div style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 8px' }}>10 نقاط = 1 ر.س — الرصيد الحالي: {customer.loyalty_points} نقطة</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input type="number" style={{ maxWidth: 140 }} placeholder="عدد النقاط" value={redeemPoints} onChange={e => setRedeemPoints(e.target.value)} />
                <button className="btn btn-blue btn-sm" disabled={redeeming} onClick={doRedeem}>{redeeming ? '…' : 'استبدال'}</button>
              </div>
            </div>
          )}

          <h4 className="ts-h4">الملخص المالي للعميل</h4>
          <div className="kpis" style={{ marginBottom: 16 }}>
            <div className="kpi"><div className="v">{SAR(totalContracted)}</div><div className="l">إجمالي التعاقدات</div></div>
            <div className="kpi"><div className="v">{SAR(totalPaid)}</div><div className="l">إجمالي المدفوع</div></div>
            <div className="kpi"><div className="v">{SAR(totalDeposit)}</div><div className="l">العربون المدفوع</div></div>
            <div className="kpi"><div className="v">{SAR(totalInsurance)}</div><div className="l">التأمين المدفوع</div></div>
          </div>

          <h4 className="ts-h4">سجل الإيجارات الكامل ({(customer.bookings || []).length})</h4>
          <div style={{ overflowX: 'auto' }}>
          <table className="tbl" style={{ marginBottom: 16, minWidth: 720 }}>
            <thead><tr><th>الوحدة</th><th>من</th><th>إلى</th><th>النوع</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th><th>العربون</th><th>التأمين</th><th>العقد</th></tr></thead>
            <tbody>
              {(customer.bookings || []).length === 0 && <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد حجوزات</td></tr>}
              {(customer.bookings || []).map(b => {
                const paid = (b.payments || []).reduce((s, p) => s + num(p.amount), 0)
                return (
                  <tr key={b.id}>
                    <td>{b.units?.unit_number}</td><td dir="ltr">{b.check_in_date}</td><td dir="ltr">{b.check_out_date}</td>
                    <td>{{ daily: 'يومي', monthly: 'شهري', yearly: 'سنوي' }[b.rent_period] || b.rent_period}</td>
                    <td className="money">{SAR(b.total_amount)}</td>
                    <td className="money">{SAR(paid)}</td>
                    <td className={num(b.total_amount) - paid > 0 ? 'neg' : 'money'}>{SAR(num(b.total_amount) - paid)}</td>
                    <td>{SAR(b.down_payment)}</td><td>{SAR(b.insurance_amount)}</td>
                    <td><button className="btn btn-ghost btn-sm" onClick={() => setContractFor(b)}>🖨</button></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          </div>

          <h4 className="ts-h4">تفاصيل الدفعات</h4>
          <table className="tbl" style={{ marginBottom: 16 }}>
            <thead><tr><th>التاريخ</th><th>الوحدة</th><th>النوع</th><th>المبلغ</th><th>طريقة الدفع</th><th>المستند</th></tr></thead>
            <tbody>
              {allPayments.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد دفعات</td></tr>}
              {allPayments.sort((a, b) => (b.payment_date || '').localeCompare(a.payment_date || '')).map((p, i) => (
                <tr key={i}>
                  <td dir="ltr">{p.payment_date}</td><td>{p.unit || '—'}</td>
                  <td>{PAY_TYPE_LABEL[p.payment_type] || p.payment_type}</td>
                  <td className="money">{SAR(p.amount)}</td><td>{PAY_METHODS[p.method] || p.method}</td>
                  <td>{p.document_url ? <a className="btn btn-ghost btn-sm" href={p.document_url} target="_blank" rel="noreferrer">🔍 عرض</a> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h4 className="ts-h4">بيانات دخول بوابة المستأجر</h4>
          <table className="tbl" style={{ marginBottom: 16 }}>
            <thead><tr><th>الوحدة</th><th>اسم المستخدم</th><th>الحالة</th><th>إجراءات</th></tr></thead>
            <tbody>
              {(customer.bookings || []).filter(b => portalAccts[b.id]).length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد حسابات بوابة</td></tr>}
              {(customer.bookings || []).map(b => {
                const acct = portalAccts[b.id]
                if (!acct) return null
                return (
                  <tr key={b.id}>
                    <td>{b.units?.unit_number}</td>
                    <td>
                      {canEditPortal && editingCreds === b.id ? (
                        <div style={{ display: 'flex', gap: 4 }}>
                          <input dir="ltr" defaultValue={acct.username} style={{ width: 110 }} id={`u-${b.id}`}
                            onKeyDown={e => e.key === 'Enter' && saveUsername(b.id, e.target.value)} />
                          <button className="btn btn-green btn-sm" onClick={() => saveUsername(b.id, document.getElementById(`u-${b.id}`).value)}>حفظ</button>
                        </div>
                      ) : <span dir="ltr">{acct.username}</span>}
                    </td>
                    <td><span className={'chip ' + (acct.is_active === false ? 'chip-danger' : 'chip-ok')}>{acct.is_active === false ? 'معطّل' : 'نشط'}</span></td>
                    <td>
                      {canEditPortal && <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditingCreds(b.id)}>✎ اسم المستخدم</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => regenToken(b.id)}>🔄 رابط جديد</button>
                        {acct.is_active === false
                          ? <button className="btn btn-ghost btn-sm" onClick={() => togglePortal(b.id, true)}>تفعيل</button>
                          : <button className="btn btn-ghost btn-sm" onClick={() => togglePortal(b.id, false)}>تعطيل</button>}
                      </div>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          <h4 className="ts-h4">سجل نقاط الولاء</h4>
          <table className="tbl" style={{ marginBottom: 16 }}>
            <thead><tr><th>التاريخ</th><th>النقاط</th><th>السبب</th></tr></thead>
            <tbody>
              {loyalty.length === 0 && <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد حركات ولاء بعد</td></tr>}
              {loyalty.map(l => (
                <tr key={l.id}><td>{l.created_at?.slice(0, 10)}</td>
                  <td className={l.points < 0 ? 'neg' : 'money'}>{l.points > 0 ? '+' : ''}{l.points}</td>
                  <td>{l.reason || '—'}</td></tr>
              ))}
            </tbody>
          </table>

          <h4 className="ts-h4">إرسال رسالة جاهزة</h4>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {templates.map(t => <button key={t.id} className="btn btn-ghost btn-sm" onClick={() => applyTemplate(t)}>{t.name}</button>)}
          </div>
          {msgPreview && (
            <>
              <textarea className="drawer-notes-area" style={{ minHeight: 90 }} value={msgPreview} onChange={e => setMsgPreview(e.target.value)} dir="auto" />
              <button className="btn btn-green btn-sm" style={{ marginTop: 8 }} onClick={sendWhatsApp}>💬 إرسال عبر واتساب</button>
            </>
          )}
        </div>
      </div>
      {contractFor && (
        <RentalContract
          onClose={() => setContractFor(null)}
          company={company}
          employeeName={contractFor.profiles?.full_name}
          customer={customer}
          unit={contractFor.units}
          booking={contractFor}
        />
      )}
      {showReport && (
        <PrintableDoc
          company={company} title={`تقرير العميل — ${customer.full_name}`}
          docNumber={'CUS-' + (customer.id?.slice(0, 8) || '')}
          qrValue={JSON.stringify({ customer: customer.full_name, id: customer.id_number, phone: customer.phone })}
          onClose={() => setShowReport(false)}
        >
          <h4 className="contract-h4">البيانات الشخصية</h4>
          <DocGrid items={[
            ['الاسم الكامل', customer.full_name],
            ['نوع الإثبات', ID_TYPES[customer.id_type]],
            ['رقم الإثبات', customer.id_number],
            ['تاريخ الميلاد', customer.birth_date || '—'],
            ['الجوال', customer.phone],
            ['البريد', customer.email || '—'],
            ['نقاط الولاء', customer.loyalty_points + ' نقطة'],
            ['آخر استبدال نقاط', lastRedeem ? lastRedeem.created_at?.slice(0, 10) : '—'],
          ]} />
          <h4 className="contract-h4">الملخص المالي</h4>
          <DocGrid items={[
            ['إجمالي التعاقدات', SAR(totalContracted)],
            ['إجمالي المدفوع', SAR(totalPaid)],
            ['المتبقي', SAR(totalContracted - totalPaid)],
            ['العربون المدفوع', SAR(totalDeposit)],
            ['التأمين المدفوع', SAR(totalInsurance)],
            ['عدد الإيجارات', (customer.bookings || []).length],
          ]} />
          <h4 className="contract-h4">سجل الإيجارات</h4>
          <table className="tbl" style={{ marginBottom: 8 }}>
            <thead><tr><th>الوحدة</th><th>من</th><th>إلى</th><th>الإجمالي</th><th>المدفوع</th><th>المتبقي</th></tr></thead>
            <tbody>
              {(customer.bookings || []).length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد</td></tr>}
              {(customer.bookings || []).map(b => {
                const paid = (b.payments || []).reduce((s, p) => s + num(p.amount), 0)
                return <tr key={b.id}>
                  <td>{b.units?.unit_number}</td><td dir="ltr">{b.check_in_date}</td><td dir="ltr">{b.check_out_date}</td>
                  <td className="money">{SAR(b.total_amount)}</td><td className="money">{SAR(paid)}</td>
                  <td>{SAR(num(b.total_amount) - paid)}</td>
                </tr>
              })}
            </tbody>
          </table>
        </PrintableDoc>
      )}
    </div>
  )
}
