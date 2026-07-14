import React, { useState, useRef, useEffect } from 'react'
import ReactMarkdown from 'react-markdown'
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport } from 'ai'
import { supabase } from '../lib/supabase'
import { useAuth } from '../AuthContext'

/*
  المساعد الذكي — يعمل عبر Edge Function ai-assistant التي تستدعي Lovable AI Gateway
  مع tool-calling للاستعلام غير المحدود عن كل بيانات المنشأة.
*/
export default function Assistant() {
  const { profile, canFinance } = useAuth()
  const [input, setInput] = useState('')
  const box = useRef(null)

  const supaUrl = import.meta.env.VITE_SUPABASE_URL || 'https://drowmezlcrvowuhqmfef.supabase.co'
  const supaKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY

  const [transport] = useState(() => new DefaultChatTransport({
    api: `${supaUrl}/functions/v1/ai-assistant`,
    headers: async () => {
      const { data: { session } } = await supabase.auth.getSession()
      return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session?.access_token || supaKey}`,
        'apikey': supaKey || '',
      }
    },
    prepareSendMessagesRequest: ({ messages }) => ({
      body: { messages, company_id: profile?.company_id }
    }),
  }))

  const { messages, sendMessage, status, error } = useChat({ transport })

  useEffect(() => { box.current?.scrollTo(0, 1e9) }, [messages, status])

  const isLoading = status === 'submitted' || status === 'streaming'

  const ask = (text) => {
    const t = (text ?? input).trim()
    if (!t || isLoading) return
    setInput('')
    sendMessage({ text: t })
  }

  const suggestions = canFinance
    ? [
        'أصدر لي تقرير الإيرادات الشهرية مع رسم للأعلى ٥ وحدات ربحاً',
        'من المستأجرون المتأخرون عن السداد أكثر من ١٥ يوماً؟',
        'كم ضريبة القيمة المضافة المستحقة عن الربع الحالي؟',
        'قارن أداء هذا الشهر بالشهر الماضي بالتفصيل',
        'اعرض الوحدات المتاحة تحت ٤٠٠ ريال يومياً',
        'استخرج جدول المصروفات لهذا الشهر مصنفاً بالفئة',
      ]
    : ['أريد وحدة لـ ٣ أيام أقل من ٤٠٠ ريال', 'اعرض المستأجرين المتأخرين', 'كم نسبة الإشغال؟']

  const renderPart = (p, i) => {
    if (p.type === 'text') return <ReactMarkdown key={i}>{p.text}</ReactMarkdown>
    if (p.type?.startsWith('tool-')) {
      const name = p.type.slice(5)
      return (
        <div key={i} className="ai-tool">
          <b>⚙ أداة: {name}</b>
          {p.state === 'output-available' && (
            <div className="ai-tool-out">✓ تم — {p.output?.count != null ? `${p.output.count} سجل` : 'نُفّذ'}</div>
          )}
        </div>
      )
    }
    return null
  }

  return (
    <div>
      <div className="pg-title">
        <h2>🤖 المساعد الذكي غير المحدود</h2>
        <span className="chip">مدعوم بـ Lovable AI — يفهم أي طلب ويستخرج أي تقرير</span>
      </div>
      <div className="panel ai-box">
        <div className="ai-msgs" ref={box}>
          {messages.length === 0 && (
            <div className="msg a">
              <ReactMarkdown>
                {canFinance
                  ? 'مرحبًا! أنا مساعدك الذكي غير المحدود. اطلب مني **أي تقرير أو تحليل أو استخراج بيانات** بلغة طبيعية وسأنفذه من بياناتك الحقيقية مباشرة.'
                  : 'مرحبًا! اسألني عن الوحدات المتاحة أو المتأخرات أو أي بيانات تحتاجها.'}
              </ReactMarkdown>
            </div>
          )}
          {messages.map(m => (
            <div key={m.id} className={'msg ' + (m.role === 'assistant' ? 'a' : 'u')}>
              {m.parts?.map(renderPart) || m.content}
            </div>
          ))}
          {status === 'submitted' && <div className="msg a"><i>⏳ جارٍ التفكير…</i></div>}
          {error && <div className="msg a" style={{ color: '#c00' }}>خطأ: {error.message}</div>}
        </div>
        <div className="suggest">{suggestions.map(s =>
          <button key={s} onClick={() => ask(s)} disabled={isLoading}>{s}</button>)}</div>
        <div className="ai-in">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="اطلب أي تقرير أو تحليل بلغة طبيعية…"
            onKeyDown={e => e.key === 'Enter' && ask()}
            disabled={isLoading}
            autoFocus
          />
          <button className="btn btn-gold btn-sm" onClick={() => ask()} disabled={isLoading}>
            {isLoading ? '…' : 'إرسال'}
          </button>
        </div>
      </div>
    </div>
  )
}
