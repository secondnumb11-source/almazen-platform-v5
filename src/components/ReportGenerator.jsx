import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { SAR, num, today } from '../lib/helpers'

export function ReportGenerator({ companyId }) {
  const [reportType, setReportType] = useState('customer_movement')
  const [dateFrom, setDateFrom] = useState(today().slice(0, 8) + '01')
  const [dateTo, setDateTo] = useState(today())
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)

  const generateReport = async () => {
    setLoading(true)
    try {
      if (reportType === 'customer_movement') {
        const { data: customers } = await supabase.from('customers')
          .select('id, full_name, created_at, bookings(id, check_in_date, status)')
          .eq('company_id', companyId)
          .gte('created_at', dateFrom)
          .lte('created_at', dateTo)
        setData({ type: 'customer_movement', rows: customers || [] })
      } else if (reportType === 'services') {
        const { data: services } = await supabase.from('bookings')
          .select('id, customers(full_name), units(unit_number), base_price, check_in_date, status')
          .eq('company_id', companyId)
          .gte('check_in_date', dateFrom)
          .lte('check_in_date', dateTo)
        setData({ type: 'services', rows: services || [] })
      } else if (reportType === 'maintenance') {
        const { data: expenses } = await supabase.from('expenses')
          .select('id, description, vendor_name, amount, expense_date, category')
          .eq('company_id', companyId)
          .eq('category', 'maintenance')
          .gte('expense_date', dateFrom)
          .lte('expense_date', dateTo)
        const { data: payments } = await supabase.from('payments')
          .select('id, amount, payment_date, bookings(units(unit_number))')
          .eq('company_id', companyId)
          .eq('payment_type', 'maintenance')
          .gte('payment_date', dateFrom)
          .lte('payment_date', dateTo)
        setData({ type: 'maintenance', expenses: expenses || [], payments: payments || [] })
      } else if (reportType === 'occupancy') {
        const { data: units } = await supabase.from('units').select('id, unit_number').eq('company_id', companyId)
        const { data: bookings } = await supabase.from('bookings')
          .select('unit_id, check_in_date, check_out_date, status')
          .eq('company_id', companyId)
          .lte('check_in_date', dateTo)
          .gte('check_out_date', dateFrom)
        setData({ type: 'occupancy', units: units || [], bookings: bookings || [] })
      } else if (reportType === 'available_units') {
        const { data: bookings } = await supabase.from('bookings')
          .select('unit_id, check_out_date, units(unit_number)')
          .eq('company_id', companyId)
          .eq('status', 'confirmed')
          .gte('check_out_date', dateFrom)
          .lte('check_out_date', dateTo)
        setData({ type: 'available_units', rows: bookings || [] })
      } else if (reportType === 'occupied_units') {
        const { data: bookings } = await supabase.from('bookings')
          .select('unit_id, check_in_date, check_out_date, customers(full_name), units(unit_number)')
          .eq('company_id', companyId)
          .in('status', ['checked_in', 'confirmed'])
          .lte('check_in_date', dateTo)
          .gte('check_out_date', dateFrom)
        setData({ type: 'occupied_units', rows: bookings || [] })
      } else if (reportType === 'revenue_summary') {
        const { data: payments } = await supabase.from('payments')
          .select('amount, payment_type, payment_date, bookings(customers(full_name), units(unit_number))')
          .eq('company_id', companyId)
          .gte('payment_date', dateFrom)
          .lte('payment_date', dateTo)
        const { data: expenses } = await supabase.from('expenses')
          .select('amount, category, expense_date')
          .eq('company_id', companyId)
          .gte('expense_date', dateFrom)
          .lte('expense_date', dateTo)
        setData({ type: 'revenue_summary', payments: payments || [], expenses: expenses || [] })
      }
    } catch (err) {
      console.error('Report error:', err)
    }
    setLoading(false)
  }

  return (
    <div className="panel">
      <h3>📊 منشئ التقارير المحاسبية</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginBottom: 16 }}>
        <select value={reportType} onChange={e => setReportType(e.target.value)}>
          <option value="customer_movement">تقرير حركة العملاء</option>
          <option value="services">تقرير الخدمات</option>
          <option value="maintenance">تقرير الصيانة والمدفوعات</option>
          <option value="occupancy">تقرير الإشغال والتوفر</option>
          <option value="available_units">الوحدات المتاحة</option>
          <option value="occupied_units">الوحدات المسكونة</option>
          <option value="revenue_summary">ملخص الإيرادات والمصروفات</option>
        </select>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
        <button className="btn btn-blue btn-sm" disabled={loading} onClick={generateReport}>{loading ? '...' : 'إنشاء التقرير'}</button>
      </div>

      {data && (
        <div>
          <table className="tbl" style={{ width: '100%', fontSize: 13 }}>
            <thead>
              {data.type === 'customer_movement' && <tr><th>العميل</th><th>تاريخ الإضافة</th><th>عدد الحجوزات</th></tr>}
              {data.type === 'services' && <tr><th>العميل</th><th>الوحدة</th><th>المبلغ</th><th>تاريخ الدخول</th></tr>}
              {data.type === 'maintenance' && <tr><th>الوصف</th><th>المورد</th><th>المبلغ</th><th>التاريخ</th></tr>}
              {data.type === 'available_units' && <tr><th>الوحدة</th><th>تاريخ التوفر</th></tr>}
              {data.type === 'occupied_units' && <tr><th>الوحدة</th><th>المستأجر</th><th>من</th><th>إلى</th></tr>}
              {data.type === 'revenue_summary' && <tr><th>النوع</th><th>المبلغ</th><th>التاريخ</th></tr>}
            </thead>
            <tbody>
              {data.type === 'customer_movement' && data.rows.map((c, i) => (
                <tr key={i}>
                  <td>{c.full_name}</td>
                  <td>{c.created_at?.slice(0, 10)}</td>
                  <td>{(c.bookings || []).length}</td>
                </tr>
              ))}
              {data.type === 'services' && data.rows.map((s, i) => (
                <tr key={i}>
                  <td>{s.customers?.full_name}</td>
                  <td>{s.units?.unit_number}</td>
                  <td>{SAR(s.base_price)}</td>
                  <td>{s.check_in_date}</td>
                </tr>
              ))}
              {data.type === 'maintenance' && <>
                {data.expenses.map((e, i) => (
                  <tr key={`e${i}`}>
                    <td>{e.description}</td>
                    <td>{e.vendor_name}</td>
                    <td>{SAR(e.amount)}</td>
                    <td>{e.expense_date}</td>
                  </tr>
                ))}
                {data.payments.map((p, i) => (
                  <tr key={`p${i}`}>
                    <td>دفع صيانة</td>
                    <td>—</td>
                    <td>{SAR(p.amount)}</td>
                    <td>{p.payment_date}</td>
                  </tr>
                ))}
              </>}
              {data.type === 'available_units' && data.rows.map((u, i) => (
                <tr key={i}>
                  <td>{u.units?.unit_number}</td>
                  <td>{u.check_out_date}</td>
                </tr>
              ))}
              {data.type === 'occupied_units' && data.rows.map((u, i) => (
                <tr key={i}>
                  <td>{u.units?.unit_number}</td>
                  <td>{u.customers?.full_name}</td>
                  <td>{u.check_in_date}</td>
                  <td>{u.check_out_date}</td>
                </tr>
              ))}
              {data.type === 'revenue_summary' && (
                <>
                  {data.payments.map((p, i) => (
                    <tr key={`p${i}`}>
                      <td>إيراد - {p.payment_type}</td>
                      <td>{SAR(p.amount)}</td>
                      <td>{p.payment_date}</td>
                    </tr>
                  ))}
                  {data.expenses.map((e, i) => (
                    <tr key={`e${i}`}>
                      <td>مصروف - {e.category}</td>
                      <td>{SAR(e.amount)}</td>
                      <td>{e.expense_date}</td>
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
