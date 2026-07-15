import { supabase } from './supabase'

/*
  يُستدعى فور أي حجز/تسليم/إخلاء/إلغاء مباشر داخل المازن لوحدة مرتبطة
  بمنصات الحجز، حتى تنعكس الإتاحة على Channex (ومنه على Booking.com/Airbnb..)
  فوراً بدل انتظار ضغط المالك لزر "مزامنة الآن" يدوياً. غير معطِّل للواجهة:
  يعمل في الخلفية ويُهمَل أي خطأ (المهمة تبقى في الطابور لإعادة محاولتها لاحقاً).
*/
export function triggerChannexSync(companyId) {
  if (!companyId) return
  supabase.functions.invoke('channex-process-queue', { body: { company_id: companyId } }).catch(() => {})
}
