export const SAR = (n) => (Number(n) || 0).toLocaleString('ar-SA', { maximumFractionDigits: 2 }) + ' ر.س'
export const num = (n) => Number(n) || 0
export const today = () => new Date().toISOString().slice(0, 10)

export const CATS = {
  apartment: 'شقة سكنية', chalet: 'شاليه',
  furnished_unit: 'وحدة مفروشة', hotel_room: 'غرفة فندقية'
}
export const STATUS = {
  available:  { label: 'متاح للإيجار', cls: 'u-av' },
  reserved:   { label: 'محجوز مسبقاً', cls: 'u-rs' },
  occupied:   { label: 'مسكون',        cls: 'u-oc' },
  cleaning:   { label: 'قيد التنظيف',  cls: 'u-cl' },
  maintenance:{ label: 'تحت الصيانة',  cls: 'u-cl' }
}

// قائمة الأثاث الافتراضية عند اختيار "وحدة مفروشة"
export const DEFAULT_FURNITURE = [
  'سرير مفرد','سرير مزدوج','مرتبة','مخدات','بطانيات','شراشف',
  'مكيف سبليت','مروحة سقف','ثلاجة','فريزر','غسالة','مايكرويف',
  'فرن كهربائي','موقد غاز','غلاية ماء','تلفاز','ريموت TV',
  'كنب','طاولة طعام','كراسي طعام','خزانة ملابس','كومودينو',
  'ستائر','سجاد','لمبات إنارة','سخان ماء','مكواة',
  'أدوات مطبخ (صحون/ملاعق)','أواني طبخ','مكنسة','دورة مياه — مرآة','دورة مياه — رشاش'
]

// توليد رابط مشاركة للوحدة
export const shareUrl = (slug) => `${window.location.origin}/u/${slug}`
export const waShareUrl = (slug, unitNumber) =>
  `https://wa.me/?text=${encodeURIComponent(`تفضّل بالاطلاع على مواصفات الوحدة رقم ${unitNumber}:\n${shareUrl(slug)}`)}`
export const PAY_METHODS = { cash: 'كاش', bank_transfer: 'تحويل بنكي', card: 'بطاقة بنكية' }
export const ROLES = { owner: 'المدير', manager: 'مدير فرعي', accountant: 'محاسب', employee: 'موظف' }

// توليد بيانات QR للفاتورة وفق ZATCA (TLV → Base64)
export function zatcaQR({ seller, vat, isoDate, total, vatAmount }) {
  const enc = new TextEncoder()
  const tlv = (tag, value) => {
    const v = enc.encode(String(value))
    return [tag, v.length, ...v]
  }
  const bytes = new Uint8Array([
    ...tlv(1, seller), ...tlv(2, vat), ...tlv(3, isoDate),
    ...tlv(4, Number(total).toFixed(2)), ...tlv(5, Number(vatAmount).toFixed(2))
  ])
  let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b))
  return btoa(bin)
}

// رفع ملف إلى Supabase Storage وإرجاع الرابط العام
export async function uploadFile(supabase, bucket, companyId, file) {
  if (!file) return null
  const path = `${companyId}/${Date.now()}_${file.name.replace(/[^\w.\-]/g, '_')}`
  const { error } = await supabase.storage.from(bucket).upload(path, file)
  if (error) throw error
  const { data } = supabase.storage.from(bucket).getPublicUrl(path)
  return data.publicUrl
}

// تسجيل إجراء في سجل النشاط (audit_logs) — يُستخدم لمراقبة نشاط الموظفين
// العمليات الحساسة تُعلَّم sensitive=true ليتم إبرازها في لوحة المراقبة
export async function logActivity(supabase, profile, { action, entity, entity_id = null, summary = '', sensitive = false } = {}) {
  if (!profile?.company_id) return
  try {
    await supabase.from('audit_logs').insert({
      company_id: profile.company_id,
      user_id: profile.id,
      action,
      entity,
      entity_id,
      new_data: { summary, sensitive, actor: profile.full_name, role: profile.role, at: new Date().toISOString() }
    })
  } catch (_) { /* التسجيل لا يجب أن يُعطّل العملية الأساسية */ }
}

export function exportCSV(filename, rows) {
  if (!rows?.length) return
  const heads = Object.keys(rows[0])
  const csv = '\uFEFF' + [heads.join(','), ...rows.map(r =>
    heads.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(','))].join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  a.download = filename; a.click()
}
