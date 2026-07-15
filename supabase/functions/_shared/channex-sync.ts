// supabase/functions/_shared/channex-sync.ts
//
// منطق مشترك لتحويل حجز قادم من Channex (JSON:API booking object) إلى
// سجل في جدول bookings، يُستخدم من channex-webhook (استقبال فوري) ومن
// channex-process-queue (مهمة "اكتشاف الحجوزات المفقودة" — pull_reservations)
// لتفادي تكرار نفس منطق المطابقة والإنشاء في مكانين.
//
// أسماء الحقول هنا مطابقة لعيّنات التوثيق الرسمي الفعلي لـ Channex التي
// زوّدنا بها المستخدم مباشرة (وليست تخميناً): ota_reservation_code هو
// المعرّف المضمون الحضور في كل حمولة (وليس booking.id الذي لا يصل ضمن
// الـ webhook الخام أصلاً — يظهر فقط عبر استعلام /booking_revisions).

const OTA_NAME_MAP: Record<string, string> = {
  booking: 'booking_com', 'booking.com': 'booking_com', bookingcom: 'booking_com',
  airbnb: 'airbnb',
  expedia: 'expedia',
  agoda: 'agoda',
  hotels: 'hotels_com', 'hotels.com': 'hotels_com',
  tripcom: 'trip_com', 'trip.com': 'trip_com', tripadvisor: 'trip_com',
  homeaway: 'vrbo', vrbo: 'vrbo',
  offline: 'other', // حجز أُدخل يدوياً داخل Channex نفسه (ليس عبر Al-Mazen ولا عبر OTA)
}

export function mapOtaName(raw?: string) {
  if (!raw) return 'other'
  return OTA_NAME_MAP[raw.toLowerCase().trim()] || raw.toLowerCase().trim()
}

// تحديد نوع الحدث اعتماداً على booking.status نفسه بدل الاعتماد فقط على
// غلاف "event" خارجي — لأن عيّنات Channex الرسمية لا تُظهر دائماً غلافاً
// موحّداً، بينما status داخل الحجز ثابت الحضور ('cancelled' / 'modified' / غائب لحجز جديد)
export function resolveEventType(payload: any): 'booking_new' | 'booking_modification' | 'booking_cancellation' {
  const explicit = payload?.event
  if (explicit === 'booking_new' || explicit === 'booking_modification' || explicit === 'booking_cancellation') return explicit
  const status = payload?.booking?.status
  if (status === 'cancelled') return 'booking_cancellation'
  if (status === 'modified') return 'booking_modification'
  return 'booking_new'
}

export async function handleCancellation(db: any, companyId: string, booking: any) {
  const reservationCode = String(booking?.ota_reservation_code ?? booking?.unique_id ?? '')
  const source = mapOtaName(booking?.ota_name)
  if (!reservationCode) return
  // service_role: مسموح له الآن بتغيير status إلى cancelled بعد تعديل
  // enforce_owner_only_cancel (migration 20260718000001) لأن هذا إلغاء
  // حقيقي وصل من العميل على المنصة الخارجية، وليس طلباً من متصفح.
  await db.from('bookings')
    .update({ status: 'cancelled', cancel_reason: 'ألغاه العميل على المنصة الخارجية (Channex/' + source + ')' })
    .eq('company_id', companyId)
    .eq('booking_source', source)
    .eq('ota_reservation_id', reservationCode)
}

export async function handleUpsert(db: any, companyId: string, booking: any) {
  const reservationCode = String(booking?.ota_reservation_code ?? booking?.unique_id ?? '')
  if (!reservationCode) throw new Error('حمولة الحجز لا تحتوي ota_reservation_code لضمان عدم التكرار')

  const room = (booking?.rooms && booking.rooms[0]) || {}
  const roomTypeId = String(room?.room_type_id ?? booking?.room_type_id ?? '')
  if (!roomTypeId) throw new Error('حمولة الحجز لا تحتوي room_type_id لمطابقة الوحدة')

  const { data: unit } = await db
    .from('units').select('id, company_id, daily_price')
    .eq('company_id', companyId).eq('channex_room_type_id', roomTypeId).maybeSingle()
  if (!unit) throw new Error(`لا توجد وحدة مربوطة بـ room_type_id = ${roomTypeId}. اربط الوحدة أولاً من تبويب "ربط الوحدات".`)

  const source = mapOtaName(booking?.ota_name)
  const customer = booking?.customer || {}
  const guestName = [customer?.name, customer?.surname].filter(Boolean).join(' ').trim() || ('ضيف من ' + source)
  const guestPhone = customer?.phone || null
  const guestEmail = customer?.mail || null

  // إيجاد عميل موجود مسبقاً بنفس الجوال (نزيل تكرار ملفات الضيوف العائدين)،
  // وإلا إنشاء ملف جديد. رقم الإثبات الرسمي غير متوفر من أي OTA عند الحجز —
  // يُستكمل فعلياً عند تسليم الوحدة تماماً كأي حجز مباشر (لا شيء يُختلق هنا).
  let customerId: string | null = null
  if (guestPhone) {
    const { data: existing } = await db.from('customers')
      .select('id').eq('company_id', companyId).eq('phone', guestPhone).maybeSingle()
    customerId = existing?.id || null
  }
  if (!customerId) {
    const { data: created, error: custErr } = await db.from('customers').insert({
      company_id: companyId,
      full_name: guestName,
      id_type: 'passport',
      id_number: `OTA-PENDING-${source}-${reservationCode}`,
      phone: guestPhone || '—',
      email: guestEmail,
      notes: `⚠️ ضيف قادم عبر ${source} — بيانات إثبات الهوية بانتظار التحقق الفعلي عند تسليم الوحدة.`,
    }).select('id').maybeSingle()
    if (custErr) throw new Error('تعذّر إنشاء ملف العميل: ' + custErr.message)
    customerId = created?.id
  }

  // تواريخ الغرفة أدق من تواريخ الحجز الإجمالية عند تعدد الغرف — نُفضّلها إن وُجدت
  const checkIn = room?.checkin_date || booking?.arrival_date
  const checkOut = room?.checkout_date || booking?.departure_date
  if (!checkIn || !checkOut) throw new Error('حمولة الحجز لا تحتوي تواريخ وصول/مغادرة صحيحة')

  const amount = Number(booking?.amount ?? room?.amount ?? 0) || 0
  const commission = booking?.ota_commission != null ? Number(booking.ota_commission) : null

  const bookingRow = {
    company_id: companyId,
    unit_id: unit.id,
    customer_id: customerId,
    status: 'confirmed',
    rent_period: 'daily',
    check_in_date: checkIn,
    check_out_date: checkOut,
    base_price: amount,
    total_amount: amount,
    booking_source: source,
    ota_reservation_id: reservationCode,
    ota_channel_booking_id: booking?.id ? String(booking.id) : null,
    ota_commission: commission,
    ota_raw_payload: booking,
    contract_number: booking?.unique_id || reservationCode,
    notes: amount === 0 ? '⚠️ لم تصل قيمة الحجز ضمن بيانات القناة — راجعها يدوياً من لوحة Channex.' : null,
  }

  const { error: upsertErr } = await db.from('bookings')
    .upsert(bookingRow, { onConflict: 'company_id,booking_source,ota_reservation_id' })

  if (upsertErr) {
    // 23P01 = exclusion_violation (تعارض تواريخ عبر قيد منع الحجز المزدوج)
    if (upsertErr.code === '23P01') {
      throw new Error('⚠️ تعارض حجز حقيقي: هذه التواريخ محجوزة بالفعل داخل المازن لنفس الوحدة. يتطلب مراجعة يدوية فورية لحل التعارض مع Channex.')
    }
    throw new Error('تعذّر حفظ الحجز: ' + upsertErr.message)
  }
}
