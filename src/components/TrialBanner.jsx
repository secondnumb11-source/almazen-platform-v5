import React, { useEffect, useState } from 'react'

/*
  TrialBanner — شريط علوي رفيع يظهر داخل النظام أثناء فترة التجربة فقط
  ويحتوي على عدّاد تنازلي حيّ حتى انتهاء التجربة + زر تفعيل الاشتراك.
*/
export default function TrialBanner({ plan, secondsLeft, onUpgrade }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30 * 1000)
    return () => clearInterval(t)
  }, [])

  if (plan !== 'trial') return null
  if (secondsLeft == null || secondsLeft <= 0) return null

  const remain = Math.max(0, secondsLeft - Math.floor((Date.now() - now) / 1000) + Math.floor((Date.now() - now) / 1000))
  const days = Math.floor(remain / 86400)
  const hours = Math.floor((remain % 86400) / 3600)
  const mins = Math.floor((remain % 3600) / 60)

  const urgent = remain < 2 * 86400

  return (
    <div className={'trial-banner' + (urgent ? ' urgent' : '')}>
      <span className="tb-dot" />
      <span className="tb-txt">
        أنت الآن في <b>النسخة التجريبية المجانية</b> — الوقت المتبقّي:
        <b className="tb-count"> {days}ي : {String(hours).padStart(2,'0')}س : {String(mins).padStart(2,'0')}د </b>
      </span>
      <button className="tb-cta" onClick={onUpgrade}>تفعيل الاشتراك ✦</button>
    </div>
  )
}
