import React, { useEffect, useState, useCallback } from 'react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../AuthContext'

/*
  لوحة "ربط منصات الحجز" (Channel Manager) — بوابة المالك/المدير/المحاسب.
  الوسيط المستخدم فعلياً هو Channex (channex.io) الذي يتولى بدوره توزيع
  الأسعار/الإتاحة/الحجوزات على Booking.com وAirbnb وExpedia وAgoda
  وHotels.com وTrip.com وVrbo — لأن هذه المنصات لا تمنح API مباشر لأنظمة
  PMS فردية، والوصول الرسمي إليها يمر حصرياً عبر شركاء معتمدين كـ Channex.
*/
export default function ChannelManagerPanel() {
  const { profile, company, canFinance, toast } = useAuth()
  const [tab, setTab] = useState('settings')
  if (!canFinance) return null

  return (
    <div className="panel">
      <h3>🌐 ربط منصات الحجز (Booking.com / Airbnb / Expedia / Agoda / Hotels.com / Trip.com / Vrbo)</h3>
      <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>
        الربط يتم عبر <b>Channex</b> كوسيط معتمد (Channel Manager) — منصات الحجز العالمية لا تمنح وصولاً
        برمجياً مباشراً لأنظمة الإدارة الفردية، والطريقة الرسمية الوحيدة هي عبر شريك معتمد مثله.
      </p>
      <div className="mtabs" style={{ marginBottom: 14 }}>
        <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>⚙️ إعدادات الاتصال</button>
        <button className={tab === 'mapping' ? 'on' : ''} onClick={() => setTab('mapping')}>🔗 ربط الوحدات</button>
        <button className={tab === 'log' ? 'on' : ''} onClick={() => setTab('log')}>🧾 سجل المزامنة</button>
      </div>
      {tab === 'settings' && <ChannexSettings profile={profile} company={company} toast={toast} />}
      {tab === 'mapping' && <ChannexMapping profile={profile} toast={toast} />}
      {tab === 'log' && <ChannexSyncLog profile={profile} toast={toast} />}
    </div>
  )
}

/* ================= إعدادات الاتصال ================= */
function ChannexSettings({ profile, company, toast }) {
  const [f, setF] = useState({ api_key: '', webhook_secret: '', enabled: false, environment: 'sandbox' })
  const [hasKey, setHasKey] = useState(false)
  const [hasSecret, setHasSecret] = useState(false)
  const [webhookId, setWebhookId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [testBusy, setTestBusy] = useState(false)
  const [testResult, setTestResult] = useState(null)
  const [webhookBusy, setWebhookBusy] = useState(false)

  const load = useCallback(async () => {
    const { data: settings } = await supabase
      .from('channel_manager_settings').select('*').eq('company_id', profile.company_id).maybeSingle()
    const { data: secret } = await supabase
      .from('company_secrets').select('channex_api_key, channex_webhook_secret').eq('company_id', profile.company_id).maybeSingle()
    setF(x => ({ ...x, enabled: settings?.enabled || false, environment: settings?.environment || 'sandbox' }))
    setHasKey(!!secret?.channex_api_key)
    setHasSecret(!!secret?.channex_webhook_secret)
    setWebhookId(settings?.channex_webhook_id || null)
  }, [profile])

  useEffect(() => { load() }, [load])

  const generateSecret = () => {
    const s = crypto.randomUUID().replace(/-/g, '')
    setF(x => ({ ...x, webhook_secret: s }))
  }

  const save = async () => {
    setBusy(true)
    const { error } = await supabase.rpc('update_channex_settings', {
      p_api_key: f.api_key || null,
      p_webhook_secret: f.webhook_secret || null,
      p_enabled: f.enabled,
      p_environment: f.environment,
    })
    setBusy(false)
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ حُفظت إعدادات ربط منصات الحجز')
    setF(x => ({ ...x, api_key: '', webhook_secret: '' }))
    load()
  }

  const testConnection = async () => {
    setTestBusy(true); setTestResult(null)
    const { data, error } = await supabase.functions.invoke('channex-test-connection', {
      body: { company_id: profile.company_id }
    })
    setTestBusy(false)
    if (error) { setTestResult({ ok: false, message: error.message }); return }
    setTestResult(data)
  }

  const registerWebhook = async () => {
    setWebhookBusy(true)
    const { data, error } = await supabase.functions.invoke('channex-register-webhook', {
      body: { company_id: profile.company_id, action: 'register' }
    })
    setWebhookBusy(false)
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ سُجِّل الـ webhook فعلياً على حساب Channex — سيصل كل حجز جديد تلقائياً')
    load()
  }

  const removeWebhookLink = async () => {
    setWebhookBusy(true)
    const { data, error } = await supabase.functions.invoke('channex-register-webhook', {
      body: { company_id: profile.company_id, action: 'remove' }
    })
    setWebhookBusy(false)
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ أُزيل ربط الـ webhook')
    load()
  }

  return (
    <div>
      <div className="grid2">
        <div className="fld">
          <label>مفتاح API من Channex (User API Key)</label>
          <input type="password" value={f.api_key} placeholder={hasKey ? '•••••••• (محفوظ — اكتب لاستبداله)' : 'من لوحة حسابك في Channex → Settings → API Keys'}
            onChange={e => setF({ ...f, api_key: e.target.value })} dir="ltr" />
        </div>
        <div className="fld">
          <label>البيئة</label>
          <select value={f.environment} onChange={e => setF({ ...f, environment: e.target.value })}>
            <option value="sandbox">تجريبية (Sandbox / staging.channex.io)</option>
            <option value="production">فعلية (Production / app.channex.io)</option>
          </select>
        </div>
        <div className="fld">
          <label>سر الـ Webhook (لتأكيد أن الإشعارات فعلاً من Channex)</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="password" value={f.webhook_secret} placeholder={hasSecret ? '•••••••• (محفوظ)' : 'اضغط "توليد" لإنشاء سر عشوائي آمن'}
              onChange={e => setF({ ...f, webhook_secret: e.target.value })} dir="ltr" style={{ flex: 1 }} />
            <button type="button" className="btn btn-ghost btn-sm" onClick={generateSecret}>توليد</button>
          </div>
        </div>
        <div className="fld" style={{ display: 'flex', alignItems: 'end' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 0 }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={f.enabled} onChange={e => setF({ ...f, enabled: e.target.checked })} />
            تفعيل استقبال ومزامنة الحجوزات
          </label>
        </div>
      </div>
      <button className="btn btn-gold btn-sm" disabled={busy} onClick={save}>حفظ إعدادات الاتصال</button>

      <div style={{ marginTop: 18, padding: 12, border: '1px dashed var(--border)', borderRadius: 8 }}>
        <b>ربط استقبال الحجوزات (Webhook)</b>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 8px' }}>
          يسجّل هذا الزر رابط الاستقبال فعلياً على حسابكم في Channex عبر واجهتهم البرمجية (POST /webhooks) —
          يغطي كل العقارات دفعة واحدة، ولا حاجة لأي نسخ أو لصق يدوي.
        </p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-gold btn-sm" disabled={webhookBusy || !hasKey || !hasSecret} onClick={registerWebhook}>
            {webhookBusy ? '...جارٍ التسجيل' : (webhookId ? '🔄 إعادة تسجيل الـ Webhook' : '🔗 تسجيل الـ Webhook تلقائياً')}
          </button>
          {webhookId && (
            <button className="btn btn-ghost btn-sm" disabled={webhookBusy} onClick={removeWebhookLink}>⛔ إزالة الربط</button>
          )}
          <span className={'chip ' + (webhookId ? 'chip-ok' : '')}>{webhookId ? 'مُسجَّل' : 'غير مُسجَّل بعد'}</span>
        </div>
        {(!hasKey || !hasSecret) && <div style={{ fontSize: 12, color: 'var(--st-oc)', marginTop: 6 }}>احفظ مفتاح API وسر الـ webhook أولاً قبل التسجيل.</div>}
      </div>

      <div style={{ marginTop: 18, padding: 12, border: '1px dashed var(--border)', borderRadius: 8 }}>
        <b>اختبار الاتصال بحساب Channex</b>
        <p style={{ fontSize: 12, color: 'var(--muted)', margin: '4px 0 8px' }}>
          يستدعي فعلياً GET /properties من Channex بمفتاحكم المحفوظ ويعرض عدد العقارات المسجّلة.
        </p>
        <button className="btn btn-sm" disabled={testBusy || !hasKey} onClick={testConnection}>
          {testBusy ? '...جارٍ الاختبار' : '🔌 اختبار الاتصال'}
        </button>
        {!hasKey && <div style={{ fontSize: 12, color: 'var(--st-oc)', marginTop: 6 }}>احفظ مفتاح API أولاً قبل الاختبار.</div>}
        {testResult && (
          <div style={{ marginTop: 10, fontSize: 12, background: 'var(--panel)', padding: 10, borderRadius: 6 }}>
            <div>الحالة: <b style={{ color: testResult.ok ? 'var(--st-ok)' : 'var(--st-oc)' }}>
              {testResult.ok ? '✓ متصل' : '✗ فشل الاتصال'}</b>
            </div>
            {testResult.message && <div style={{ marginTop: 4 }}>{testResult.message}</div>}
          </div>
        )}
      </div>

      <div className="ejar-note" style={{ marginTop: 18 }}>
        <b>كيف تحصل على بيانات اتصال Channex الحقيقية؟</b>
        <p>
          أنشئ حساباً في <a href="https://channex.io" target="_blank" rel="noopener noreferrer">channex.io</a>، فعّل الخصائص
          المطلوبة (Properties → Room Types → Rate Plans)، ثم من إعدادات حسابك أنشئ API Key وألصقه أعلاه.
          بعدها اربط قنوات البيع (Booking.com/Airbnb/...) من داخل لوحة Channex نفسها — هي من تتولى العلاقة الرسمية
          المباشرة مع كل منصة. نظام المازن يتزامن مع Channex فقط، وChannex يتزامن مع كل المنصات.
        </p>
      </div>
    </div>
  )
}

/* ================= ربط الوحدات بعقارات/غرف Channex ================= */
function ChannexMapping({ profile, toast }) {
  const [units, setUnits] = useState([])
  const [properties, setProperties] = useState([])
  const [roomTypesCache, setRoomTypesCache] = useState({})   // property_id -> [{id,title}]
  const [ratePlansCache, setRatePlansCache] = useState({})
  const [loading, setLoading] = useState(true)
  const [savingId, setSavingId] = useState(null)
  const [syncBusy, setSyncBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase.from('units')
      .select('id, unit_number, daily_price, channex_property_id, channex_room_type_id, channex_rate_plan_id, ota_sync_enabled')
      .eq('company_id', profile.company_id).order('unit_number')
    setUnits(data || [])

    const { data: props, error } = await supabase.functions.invoke('channex-list-properties', {
      body: { company_id: profile.company_id }
    })
    if (!error) setProperties(props?.properties || [])
    setLoading(false)
  }, [profile])

  useEffect(() => { load() }, [load])

  const loadRoomsAndRates = async (propertyId) => {
    if (!propertyId || roomTypesCache[propertyId]) return
    const { data, error } = await supabase.functions.invoke('channex-list-properties', {
      body: { company_id: profile.company_id, property_id: propertyId }
    })
    if (error) return toast('تعذّر جلب أنواع الغرف: ' + error.message, true)
    setRoomTypesCache(c => ({ ...c, [propertyId]: data?.room_types || [] }))
    setRatePlansCache(c => ({ ...c, [propertyId]: data?.rate_plans || [] }))
  }

  const updateUnitField = (id, patch) => setUnits(us => us.map(u => u.id === id ? { ...u, ...patch } : u))

  const saveMapping = async (u) => {
    setSavingId(u.id)
    const { error } = await supabase.rpc('set_unit_channex_mapping', {
      p_unit_id: u.id,
      p_property_id: u.channex_property_id || null,
      p_room_type_id: u.channex_room_type_id || null,
      p_rate_plan_id: u.channex_rate_plan_id || null,
      p_sync_enabled: !!u.ota_sync_enabled,
    })
    setSavingId(null)
    if (error) return toast('خطأ: ' + error.message, true)
    toast('✓ حُفظ ربط الوحدة')
  }

  const syncNow = async () => {
    setSyncBusy(true)
    const { data, error } = await supabase.functions.invoke('channex-process-queue', {
      body: { company_id: profile.company_id }
    })
    setSyncBusy(false)
    if (error) return toast('خطأ: ' + error.message, true)
    toast(`✓ اكتملت المزامنة — نجح: ${data?.done ?? 0} / فشل: ${data?.failed ?? 0}`)
  }

  if (loading) return <div style={{ textAlign: 'center', padding: 20, color: 'var(--muted)' }}>جارٍ التحميل…</div>

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <p style={{ fontSize: 12, color: 'var(--muted)' }}>
          اربط كل وحدة بعقارها ونوع الغرفة وخطة السعر المقابلة في Channex، وفعّل المزامنة. عند تغيير السعر أو إنشاء
          حجز مباشر لاحقاً سيُدرَج تلقائياً في طابور المزامنة (تبويب "سجل المزامنة").
        </p>
        <button className="btn btn-gold btn-sm" disabled={syncBusy} onClick={syncNow} style={{ whiteSpace: 'nowrap' }}>
          {syncBusy ? '...جارٍ المزامنة' : '🔄 مزامنة الآن'}
        </button>
      </div>
      {properties.length === 0 && (
        <div style={{ padding: 12, background: 'var(--soft)', borderRadius: 8, marginBottom: 12, fontSize: 13 }}>
          لا توجد عقارات — تأكد من حفظ مفتاح API صحيح من تبويب "إعدادات الاتصال" ومن وجود عقار واحد على الأقل في حساب Channex.
        </div>
      )}
      <table className="tbl">
        <thead><tr><th>الوحدة</th><th>عقار Channex</th><th>نوع الغرفة</th><th>خطة السعر</th><th>مفعّلة</th><th></th></tr></thead>
        <tbody>
          {units.map(u => (
            <tr key={u.id}>
              <td>{u.unit_number}</td>
              <td>
                <select value={u.channex_property_id || ''} onChange={e => { updateUnitField(u.id, { channex_property_id: e.target.value, channex_room_type_id: '', channex_rate_plan_id: '' }); loadRoomsAndRates(e.target.value) }}>
                  <option value="">— اختر —</option>
                  {properties.map(p => <option key={p.id} value={p.id}>{p.title || p.id}</option>)}
                </select>
              </td>
              <td>
                <select value={u.channex_room_type_id || ''} onChange={e => updateUnitField(u.id, { channex_room_type_id: e.target.value })} disabled={!u.channex_property_id}>
                  <option value="">— اختر —</option>
                  {(roomTypesCache[u.channex_property_id] || []).map(r => <option key={r.id} value={r.id}>{r.title || r.id}</option>)}
                </select>
              </td>
              <td>
                <select value={u.channex_rate_plan_id || ''} onChange={e => updateUnitField(u.id, { channex_rate_plan_id: e.target.value })} disabled={!u.channex_property_id}>
                  <option value="">— اختر —</option>
                  {(ratePlansCache[u.channex_property_id] || []).map(r => <option key={r.id} value={r.id}>{r.title || r.id}</option>)}
                </select>
              </td>
              <td>
                <input type="checkbox" checked={!!u.ota_sync_enabled} onChange={e => updateUnitField(u.id, { ota_sync_enabled: e.target.checked })} />
              </td>
              <td><button className="btn btn-ghost btn-sm" disabled={savingId === u.id} onClick={() => saveMapping(u)}>حفظ</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ================= سجل المزامنة (الطابور + الـ webhooks الواردة) ================= */
function ChannexSyncLog({ profile }) {
  const [queue, setQueue] = useState([])
  const [logs, setLogs] = useState([])
  const [view, setView] = useState('queue')

  const load = useCallback(async () => {
    const { data: q } = await supabase.from('ota_sync_queue')
      .select('*, units(unit_number)').eq('company_id', profile.company_id)
      .order('created_at', { ascending: false }).limit(50)
    setQueue(q || [])
    const { data: l } = await supabase.from('ota_webhook_logs')
      .select('*').eq('company_id', profile.company_id)
      .order('created_at', { ascending: false }).limit(50)
    setLogs(l || [])
  }, [profile])

  useEffect(() => { load() }, [load])

  const STATUS_LABEL = { pending: 'بانتظار', processing: 'جارٍ التنفيذ', done: 'تم بنجاح', failed: 'فشل' }
  const STATUS_CLS = { pending: 'chip', processing: 'chip chip-gold', done: 'chip chip-ok', failed: 'chip chip-danger' }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <button className={'chipf ' + (view === 'queue' ? 'on' : '')} onClick={() => setView('queue')}>طابور المزامنة الصادرة</button>
        <button className={'chipf ' + (view === 'webhooks' ? 'on' : '')} onClick={() => setView('webhooks')}>الإشعارات الواردة (Webhooks)</button>
      </div>

      {view === 'queue' && (
        <table className="tbl">
          <thead><tr><th>الوقت</th><th>الوحدة</th><th>النوع</th><th>الحالة</th><th>المحاولات</th><th>آخر خطأ</th></tr></thead>
          <tbody>
            {queue.length === 0 && <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد مهام مزامنة بعد</td></tr>}
            {queue.map(q => (
              <tr key={q.id}>
                <td dir="ltr" style={{ fontSize: 12 }}>{new Date(q.created_at).toLocaleString('ar-SA')}</td>
                <td>{q.units?.unit_number || '—'}</td>
                <td>{{ push_price: 'دفع سعر', push_availability: 'دفع إتاحة', push_restrictions: 'دفع قيود', pull_reservations: 'اكتشاف حجوزات' }[q.job_type] || q.job_type}</td>
                <td><span className={STATUS_CLS[q.status] || 'chip'}>{STATUS_LABEL[q.status] || q.status}</span></td>
                <td>{q.attempts}</td>
                <td style={{ fontSize: 12, color: 'var(--st-oc)' }}>{q.last_error || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {view === 'webhooks' && (
        <table className="tbl">
          <thead><tr><th>الوقت</th><th>الحدث</th><th>معرّف الحجز الخارجي</th><th>الحالة</th><th>خطأ</th></tr></thead>
          <tbody>
            {logs.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--muted)' }}>لم تصل أي إشعارات من Channex بعد</td></tr>}
            {logs.map(l => (
              <tr key={l.id}>
                <td dir="ltr" style={{ fontSize: 12 }}>{new Date(l.created_at).toLocaleString('ar-SA')}</td>
                <td>{l.event_type}</td>
                <td dir="ltr">{l.external_booking_id || '—'}</td>
                <td><span className={l.processed ? 'chip chip-ok' : 'chip chip-danger'}>{l.processed ? 'تمت المعالجة' : 'فشلت'}</span></td>
                <td style={{ fontSize: 12, color: 'var(--st-oc)' }}>{l.error || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
