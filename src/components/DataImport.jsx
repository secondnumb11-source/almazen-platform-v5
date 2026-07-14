import React, { useState } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '../lib/supabase'
import { useAuth } from '../AuthContext'
import { num } from '../lib/helpers'

/* استيراد بيانات من نظام آخر — يقرأ CSV/Excel، يقترح ربطاً ذكياً للأعمدة
   بحقول النظام، يعرض معاينة، ثم يُدخل البيانات فعلياً بعد تأكيد المستخدم */

const TARGETS = {
  customers: {
    label: 'العملاء والمستأجرون',
    fields: {
      full_name: ['name', 'الاسم', 'اسم العميل', 'اسم المستأجر', 'full_name', 'customer_name'],
      id_number: ['id', 'رقم الهوية', 'الهوية', 'id_number', 'national_id', 'iqama'],
      phone: ['phone', 'الجوال', 'رقم الجوال', 'mobile', 'هاتف'],
      email: ['email', 'البريد', 'البريد الإلكتروني'],
    },
    required: ['full_name', 'id_number', 'phone']
  },
  expenses: {
    label: 'المصروفات',
    fields: {
      amount: ['amount', 'المبلغ', 'القيمة', 'value'],
      description: ['description', 'الوصف', 'البيان', 'notes', 'ملاحظات'],
      expense_date: ['date', 'التاريخ', 'expense_date'],
      vendor_name: ['vendor', 'البائع', 'المورد', 'vendor_name'],
    },
    required: ['amount']
  },
}
// ملاحظة: الدفعات غير مدرجة هنا لأنها ترتبط إلزامياً بحجز قائم (booking_id) —
// لا يمكن استيرادها كسجلات مستقلة بأمان؛ تُدخل من داخل شاشة الحجز نفسها.

function normalize(s) { return String(s || '').trim().toLowerCase() }

function autoMapColumns(headers, targetKey) {
  const target = TARGETS[targetKey]
  const mapping = {}
  for (const [field, synonyms] of Object.entries(target.fields)) {
    const normSyns = synonyms.map(normalize)
    const match = headers.find(h => normSyns.includes(normalize(h)))
      || headers.find(h => normSyns.some(s => normalize(h).includes(s)))
    if (match) mapping[field] = match
  }
  return mapping
}

export default function DataImport() {
  const { profile, toast } = useAuth()
  const [targetKey, setTargetKey] = useState('customers')
  const [headers, setHeaders] = useState([])
  const [rows, setRows] = useState([])
  const [mapping, setMapping] = useState({})
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState(null)

  const target = TARGETS[targetKey]

  const onFile = async (file) => {
    if (!file) return
    setResult(null)
    // ملفات CSV تُقرأ كنص عبر File.text() لضمان فك ترميز UTF-8 الصحيح للعربية —
    // القراءة كـ arrayBuffer تجعل XLSX يخمّن الترميز وقد يُنتج حروفاً مشوّهة.
    const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv'
    const wb = isCsv
      ? XLSX.read(await file.text(), { type: 'string' })
      : XLSX.read(await file.arrayBuffer(), { type: 'array' })
    const ws = wb.Sheets[wb.SheetNames[0]]
    const json = XLSX.utils.sheet_to_json(ws, { defval: '' })
    if (!json.length) return toast('الملف فارغ أو لا يمكن قراءته', true)
    const hdrs = Object.keys(json[0])
    setHeaders(hdrs)
    setRows(json)
    setMapping(autoMapColumns(hdrs, targetKey))
    toast(`✓ قُرئ الملف — ${json.length} صف، ${hdrs.length} عمود. راجع الربط أدناه ثم أكّد الاستيراد.`)
  }

  const changeTarget = (k) => {
    setTargetKey(k)
    if (headers.length) setMapping(autoMapColumns(headers, k))
  }

  const buildRow = (row) => {
    const out = {}
    for (const field of Object.keys(target.fields)) {
      const col = mapping[field]
      if (col && row[col] !== undefined && row[col] !== '') out[field] = row[col]
    }
    return out
  }

  const missingRequired = target.required.filter(f => !mapping[f])

  const runImport = async () => {
    if (missingRequired.length) return toast('أكمل ربط الحقول الإلزامية: ' + missingRequired.join('، '), true)
    setImporting(true)
    let ok = 0, failed = 0
    const errors = []
    for (const row of rows) {
      const mapped = buildRow(row)
      if (!mapped[target.required[0]]) { failed++; continue }
      let payload = { company_id: profile.company_id }
      if (targetKey === 'customers') {
        payload = {
          ...payload, full_name: String(mapped.full_name), id_number: String(mapped.id_number || ''),
          phone: String(mapped.phone || ''), email: mapped.email ? String(mapped.email) : null,
          id_type: 'national_id'
        }
      } else if (targetKey === 'expenses') {
        payload = {
          ...payload, amount: num(mapped.amount), description: mapped.description ? String(mapped.description) : null,
          expense_date: mapped.expense_date ? String(mapped.expense_date).slice(0, 10) : new Date().toISOString().slice(0, 10),
          vendor_name: mapped.vendor_name ? String(mapped.vendor_name) : null, category: 'other'
        }
      }
      const { error } = await supabase.from(targetKey).insert(payload)
      if (error) { failed++; errors.push(error.message) } else ok++
    }
    setImporting(false)
    setResult({ ok, failed, errors: [...new Set(errors)].slice(0, 5) })
    toast(`✓ اكتمل الاستيراد — نجح ${ok}، فشل ${failed}`)
  }

  return (
    <div className="panel">
      <h3>📥 استيراد بيانات من نظام آخر</h3>
      <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
        ارفع ملف Excel أو CSV مُصدَّراً من نظامك السابق. سيُقترح ربط الأعمدة تلقائياً بحقول النظام — راجعها وعدّلها ثم أكّد الاستيراد.
        البيانات المستوردة تُصنَّف وتُربط مباشرة في نفس جداول النظام (العملاء، المصروفات) لتظهر فوراً في كل التقارير والأقسام.
      </p>

      <div className="grid2" style={{ marginBottom: 12 }}>
        <div><label>نوع البيانات المستوردة</label>
          <select value={targetKey} onChange={e => changeTarget(e.target.value)}>
            {Object.entries(TARGETS).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
          </select></div>
        <div><label>الملف (Excel أو CSV)</label>
          <input type="file" accept=".xlsx,.xls,.csv" onChange={e => onFile(e.target.files?.[0])} /></div>
      </div>

      {headers.length > 0 && (
        <>
          <h4 className="ts-h4">ربط الأعمدة ({rows.length} صف)</h4>
          <div className="grid3" style={{ marginBottom: 14 }}>
            {Object.keys(target.fields).map(field => (
              <div key={field}>
                <label>{field} {target.required.includes(field) && <span className="neg">*</span>}</label>
                <select value={mapping[field] || ''} onChange={e => setMapping(m => ({ ...m, [field]: e.target.value || undefined }))}>
                  <option value="">— تجاهل —</option>
                  {headers.map(h => <option key={h} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>

          <h4 className="ts-h4">معاينة (أول 5 صفوف بعد الربط)</h4>
          <table className="tbl" style={{ marginBottom: 14 }}>
            <thead><tr>{Object.keys(target.fields).map(f => <th key={f}>{f}</th>)}</tr></thead>
            <tbody>
              {rows.slice(0, 5).map((r, i) => {
                const b = buildRow(r)
                return <tr key={i}>{Object.keys(target.fields).map(f => <td key={f}>{b[f] ?? '—'}</td>)}</tr>
              })}
            </tbody>
          </table>

          <button className="btn btn-gold" disabled={importing || missingRequired.length > 0} onClick={runImport}>
            {importing ? '…جارٍ الاستيراد' : `استيراد ${rows.length} صف الآن`}
          </button>
          {missingRequired.length > 0 && <span className="neg" style={{ marginRight: 10, fontSize: 12 }}>أكمل الحقول الإلزامية أولاً</span>}

          {result && (
            <div style={{ marginTop: 12, fontSize: 13 }}>
              <span className="chip chip-ok">نجح: {result.ok}</span>{' '}
              {result.failed > 0 && <span className="chip chip-danger">فشل: {result.failed}</span>}
              {result.errors.length > 0 && (
                <ul style={{ marginTop: 8, color: 'var(--st-oc)' }}>
                  {result.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
