import React from 'react'
import { QRCodeSVG } from 'qrcode.react'
import { SAR, PAY_METHODS } from '../lib/helpers'

const PERIOD_LABEL = { daily: 'يومي', monthly: 'شهري', yearly: 'سنوي' }
const PAY_TYPE_LABEL = { rent: 'إيجار', down_payment: 'عربون', insurance: 'تأمين', penalty: 'غرامة', other: 'أخرى' }

/* عقد الإيجار الإلكتروني المبدئي — مستند رسمي كامل بترويسة و QR للتحقق،
   قابل للطباعة في أي وقت (عند الحجز أو لاحقاً من ملف العميل/الوحدة) */
export default function RentalContract({ booking, customer, unit, company, employeeName, onClose }) {
  const paid = (booking.payments || []).reduce((s, p) => s + Number(p.amount || 0), 0)
  const total = Number(booking.total_amount || 0)
  const remaining = total - paid
  const qrValue = JSON.stringify({
    contract: booking.contract_number || booking.id?.slice(0, 8) || '—',
    tenant: customer?.full_name, unit: unit?.unit_number,
    from: booking.check_in_date, to: booking.check_out_date, total
  })

  return (
    <div className="overlay" onClick={e => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={{ width: 'min(900px,100%)' }}>
        <div className="modal-h no-print"><h3>عقد الإيجار الإلكتروني</h3><button className="x" onClick={onClose}>✕</button></div>
        <div className="modal-b">
          <div className="contract-doc">
            <div className="contract-head">
              {company?.logo_url && <img src={company.logo_url} alt="logo" />}
              <div className="contract-head-info">
                <h2>{company?.name || 'المازن'}</h2>
                <div>الرقم الضريبي: {company?.vat_number || '—'} · السجل التجاري: {company?.cr_number || '—'} · {company?.address || ''}</div>
              </div>
              <div className="contract-qr">
                <QRCodeSVG value={qrValue} size={84} />
                <span>رقم العقد: {booking.contract_number || booking.id?.slice(0, 8) || '—'}</span>
              </div>
            </div>

            <h3 className="contract-title">عقد إيجار وحدة سكنية — مبدئي إلكتروني</h3>

            <div className="contract-grid">
              <div><b>اسم المستأجر</b><span>{customer?.full_name || '—'}</span></div>
              <div><b>رقم الهوية/الإقامة</b><span dir="ltr">{customer?.id_number || '—'}</span></div>
              <div><b>جوال المستأجر</b><span dir="ltr">{customer?.phone || '—'}</span></div>
              <div><b>الموظف المسؤول عن العقد</b><span>{employeeName || '—'}</span></div>
            </div>

            <h4 className="contract-h4">بيانات الوحدة المؤجرة</h4>
            <div className="contract-grid">
              <div><b>رقم الوحدة</b><span>{unit?.unit_number || '—'}</span></div>
              <div><b>نوع الوحدة</b><span>{unit?.category || '—'}</span></div>
              <div><b>تفاصيل الوحدة</b><span>{unit?.description || '—'}</span></div>
              <div><b>نوع الإيجار</b><span>{PERIOD_LABEL[booking.rent_period] || booking.rent_period}</span></div>
            </div>

            <h4 className="contract-h4">مدة العقد والقيمة الإيجارية</h4>
            <div className="contract-grid">
              <div><b>تاريخ بدء الإيجار</b><span dir="ltr">{booking.check_in_date}</span></div>
              <div><b>تاريخ انتهاء الإيجار</b><span dir="ltr">{booking.check_out_date}</span></div>
              <div><b>السعر الأساسي</b><span className="money">{SAR(booking.base_price || total)}</span></div>
              <div><b>نسبة الخصم</b><span>{booking.discount_percent || 0}%</span></div>
              <div><b>قيمة الإيجار الإجمالية (بعد الخصم)</b><span className="money">{SAR(total)}</span></div>
              <div><b>مبلغ العربون</b><span>{SAR(booking.down_payment)}</span></div>
              <div><b>مبلغ التأمين</b><span>{SAR(booking.insurance_amount)}</span></div>
            </div>

            <h4 className="contract-h4">بيان السداد</h4>
            <table className="tbl" style={{ marginBottom: 14 }}>
              <thead><tr><th>التاريخ</th><th>النوع</th><th>طريقة الدفع</th><th>المبلغ</th></tr></thead>
              <tbody>
                {(booking.payments || []).length === 0 && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--muted)' }}>لا توجد دفعات مسجّلة بعد</td></tr>}
                {(booking.payments || []).map((p, i) => (
                  <tr key={i}>
                    <td>{p.payment_date}</td><td>{PAY_TYPE_LABEL[p.payment_type] || p.payment_type}</td>
                    <td>{PAY_METHODS[p.method] || p.method}</td><td className="money">{SAR(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="contract-grid" style={{ marginBottom: 16 }}>
              <div><b>إجمالي المدفوع</b><span className="money">{SAR(paid)}</span></div>
              <div><b>المتبقي من قيمة الإيجار</b><span className={remaining > 0 ? 'neg' : 'money'}>{SAR(remaining)}</span></div>
              <div><b>موعد استحقاق المتبقي</b><span dir="ltr">{remaining > 0 ? booking.check_out_date : '—'}</span></div>
            </div>

            <p className="contract-note">
              هذا عقد إيجار مبدئي إلكتروني صادر آلياً من نظام {company?.name || 'المازن'} لإدارة الإيجارات، ويوثّق شروط الإيجار الأساسية بين الطرفين
              حتى استكمال أي إجراءات توثيق رسمية إضافية (كمنصة إيجار الحكومية عند الحاجة). يمكن طباعة هذا العقد في أي وقت.
            </p>

            <div className="voucher-sign">
              <div><span>توقيع المستأجر</span><i /></div>
              <div><span>توقيع المنشأة ({employeeName || 'الموظف المسؤول'})</span><i /></div>
            </div>
          </div>
        </div>
        <div className="modal-f no-print">
          <button className="btn btn-gold" onClick={() => window.print()}>🖨 طباعة العقد</button>
        </div>
      </div>
    </div>
  )
}
