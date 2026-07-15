import React from 'react'
import { QRCodeSVG } from 'qrcode.react'

/* مستند مطبوع عام — ترويسة المنشأة + عنوان + QR للتحقق + زر طباعة.
   يُستخدم لتقارير الموظفين والعملاء والوحدات بتصميم موحّد فاخر.
   يُمرَّر المحتوى كـ children ويُعرض داخل صفحة احترافية. */
export default function PrintableDoc({ company, title, subtitle, qrValue, docNumber, onClose, children, width = 'min(920px,100%)' }) {
  const qr = qrValue || JSON.stringify({ doc: docNumber || title, company: company?.name })
  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ width }}>
        <div className="modal-h no-print"><h3>{title}</h3><button className="x" onClick={onClose}>✕</button></div>
        <div className="modal-b">
          <div className="contract-doc">
            <div className="contract-head">
              {company?.logo_url && <img src={company.logo_url} alt="logo" />}
              <div className="contract-head-info">
                <h2>{company?.name || 'المازن'}</h2>
                <div>الرقم الضريبي: {company?.vat_number || '—'} · السجل التجاري: {company?.cr_number || '—'} · {company?.address || ''}</div>
              </div>
              <div className="contract-qr">
                <QRCodeSVG value={qr} size={84} />
                {docNumber && <span>رقم المستند: {docNumber}</span>}
              </div>
            </div>
            <h3 className="contract-title">{title}</h3>
            {subtitle && <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, marginTop: -8, marginBottom: 16 }}>{subtitle}</p>}
            {children}
            <p className="contract-note" style={{ marginTop: 24 }}>
              مستند صادر آلياً من نظام {company?.name || 'المازن'} لإدارة الإيجارات بتاريخ الطباعة. رمز الـ QR أعلاه للتحقق من صحة البيانات.
            </p>
          </div>
        </div>
        <div className="modal-f no-print">
          <button className="btn btn-gold" onClick={() => window.print()}>🖨 طباعة</button>
        </div>
      </div>
    </div>
  )
}

/* شبكة حقول للتقارير (تسمية + قيمة) */
export function DocGrid({ items }) {
  return (
    <div className="contract-grid">
      {items.filter(Boolean).map(([label, value], i) => (
        <div key={i}><b>{label}</b><span>{value ?? '—'}</span></div>
      ))}
    </div>
  )
}
