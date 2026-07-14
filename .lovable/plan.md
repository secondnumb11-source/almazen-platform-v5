
# خطة التنفيذ

## القسم الأول: شاشة معاينة عقد إيجار قبل الإرسال

### الواجهة (`src/pages/EjarPanel.jsx` + مكوّن جديد `EjarContractPreview.jsx`)
- زر «معاينة قبل الإرسال» يفتح Modal يعرض جدولاً منظّماً بالحقول الفعلية التي سترسل إلى إيجار:
  - **بيانات المؤجر:** اسم المنشأة، السجل التجاري، الرقم الضريبي (VAT)، رقم رخصة الوساطة.
  - **بيانات العقار:** رقم الصك، رقم الوحدة، التصنيف.
  - **بيانات المستأجر:** الاسم، نوع/رقم الهوية، الجوال.
  - **بيانات العقد الزمنية والمالية:** تاريخ البداية/النهاية، المدة بالأيام، القيمة الإجمالية، الدفعة المقدمة، التأمين.
- كل صف يحتوي أيقونة حالة: ✅ مطابق / ⚠️ ناقص / ❌ صيغة غير صحيحة، مع سبب الرفض.
- زر «إرسال إلى إيجار» **معطّل تلقائياً** ما لم تكن كل الحقول ✅.

### التحقق (`src/lib/ejarValidation.js` — ملف جديد)
دوال تحقق نقية تُستخدم في الواجهة والحافّة معاً:
- VAT: 15 رقم يبدأ بـ 3 وينتهي بـ 3.
- السجل التجاري: 10 أرقام.
- الهوية الوطنية/الإقامة: 10 أرقام (1/2 كبداية).
- الجوال: صيغة +9665XXXXXXXX.
- التواريخ: `check_out > check_in`، والمدة ≥ يوم.
- المبالغ: > 0 و `down_payment ≤ total_amount`.

### الحافّة (`supabase/functions/ejar-submit-contract/index.ts`)
- تُستدعى نفس دوال التحقق قبل بناء الـ payload — رفض 400 مع خريطة الحقول الفاشلة.
- تبقى نقطة `EJAR_API_BASE` كـ placeholder صريحة، وتوثيق واضح داخل الشيفرة أن الاتفاقية الرسمية مطلوبة لتفعيل عنوان الإنتاج، والباقي جاهز.

### متطلبات إيجار الرسمية (تُعرض في `EjarPanel` كقائمة تحقّق للمستخدم)
- سجل تجاري ساري + نشاط عقاري.
- رخصة فال / رخصة وساطة عقارية للمكاتب.
- توثيق الصكوك في «إحكام».
- توقيع اتفاقية «التكامل الرقمي بين شبكة إيجار ومنصات التسويق العقاري» للحصول على مفتاح API.
- بيئتان: sandbox وproduction — نخزّن `ejar_environment` في `companies`.

---

## القسم الثاني: نظام تجربة 7 أيام

### 1) تعديلات قاعدة البيانات (ستُعرض للنسخ في SQL Editor)
جدول migrations جديد + سكربت SQL جاهز `supabase/TRIAL_SYSTEM_READY_TO_PASTE.sql`:

```sql
-- إضافة أعمدة الاشتراك والتجربة على companies
alter table public.companies
  add column if not exists plan text not null default 'trial'
    check (plan in ('trial','active','expired','suspended')),
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_ends_at    timestamptz,
  add column if not exists subscription_ends_at timestamptz,
  add column if not exists activated_by_admin boolean not null default false,
  add column if not exists owner_phone text,
  add column if not exists owner_id_or_cr text;

-- جدول مدفوعات الاشتراك (لإيصالات التحويل + ميسر لاحقاً)
create table if not exists public.subscription_payments (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  amount numeric(12,2) not null,
  method text not null check (method in ('bank_transfer','moyasar','other')),
  reference text,
  receipt_url text,
  status text not null default 'pending'
    check (status in ('pending','approved','rejected')),
  notes text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id)
);
grant select, insert on public.subscription_payments to authenticated;
grant all on public.subscription_payments to service_role;
alter table public.subscription_payments enable row level security;
create policy sp_select on public.subscription_payments for select
  using (company_id = public.current_company_id());
create policy sp_insert on public.subscription_payments for insert
  with check (company_id = public.current_company_id());

-- Bucket لإيصالات الدفع
insert into storage.buckets (id, name, public)
  values ('subscription-receipts','subscription-receipts', false)
  on conflict (id) do nothing;

-- دالة حالة الاشتراك الحيّة
create or replace function public.company_access_state(_company uuid)
returns table(plan text, active boolean, seconds_left bigint)
language sql stable security definer set search_path=public as $$
  select
    c.plan,
    case
      when c.plan = 'active' and (c.subscription_ends_at is null or c.subscription_ends_at > now()) then true
      when c.plan = 'trial'  and c.trial_ends_at > now() then true
      when c.activated_by_admin then true
      else false
    end as active,
    greatest(0, extract(epoch from
      coalesce(c.subscription_ends_at, c.trial_ends_at, now()) - now())::bigint) as seconds_left
  from public.companies c where c.id = _company;
$$;
grant execute on function public.company_access_state(uuid) to authenticated;

-- تعديل bootstrap_owner لبدء التجربة 7 أيام تلقائياً
create or replace function public.bootstrap_owner(
  p_company_name text, p_full_name text, p_vat_number text default null,
  p_phone text default null, p_id_or_cr text default null
) returns uuid language plpgsql security definer set search_path=public as $$
declare v_uid uuid := auth.uid(); v_co uuid;
begin
  if v_uid is null then raise exception 'AUTH_REQUIRED' using errcode='28000'; end if;
  if exists (select 1 from public.profiles where id = v_uid) then
    raise exception 'PROFILE_EXISTS' using errcode='23505'; end if;
  insert into public.companies (name, vat_number, owner_phone, owner_id_or_cr,
    plan, trial_started_at, trial_ends_at)
  values (btrim(p_company_name), nullif(btrim(p_vat_number),''),
          nullif(btrim(p_phone),''), nullif(btrim(p_id_or_cr),''),
          'trial', now(), now() + interval '7 days')
  returning id into v_co;
  insert into public.profiles (id, company_id, role, full_name)
    values (v_uid, v_co, 'owner', btrim(p_full_name));
  return v_co;
end $$;

-- دوال إدارية للمالك (shadyabdelwahab99@gmail.com) لتفعيل/تمديد يدوي
create or replace function public.admin_extend_trial(_company uuid, _days int)
returns void language plpgsql security definer set search_path=public as $$
begin
  update public.companies set trial_ends_at = coalesce(trial_ends_at, now()) + make_interval(days => _days)
   where id = _company;
end $$;

create or replace function public.admin_activate_subscription(_company uuid, _months int default 12)
returns void language plpgsql security definer set search_path=public as $$
begin
  update public.companies
    set plan='active',
        subscription_ends_at = coalesce(subscription_ends_at, now()) + make_interval(months => _months)
   where id = _company;
end $$;
-- (تُنفَّذ فقط عن طريق service_role من داخل SQL Editor)
```

### 2) الواجهات الجديدة/المعدّلة

- **`src/pages/Landing.jsx`** — إعادة تصميم فاخر:
  - تعديل الزر: **«تسجيل الدخول أو التسجيل لتجربة المنصة 7 أيام مجاناً»**.
  - قسم مميّز «جرّب المنصة 7 أيام مجاناً» ببطاقة بارزة (glassmorphism + gradient + hover motion).
- **`src/pages/Login.jsx`** — إضافة Tabs في الأعلى:
  - «تسجيل دخول لعميل حالي» (النموذج الحالي كما هو).
  - «تسجيل جديد — تجربة 7 أيام مجاناً» (نموذج جديد).
  - تصميم فاخر: خلفية متدرّجة، بطاقة زجاجية، حركات دخول ناعمة (framer-motion لو متاح، وإلا CSS animations).
- **نموذج التسجيل الجديد** يجمع: الاسم، الشركة، السجل/الهوية، الجوال (+966)، الإيميل، كلمة السر.
  - يستدعي `supabase.auth.signUp` مع `emailRedirectTo` و`data` تحوي بقية الحقول.
  - بعد نجاح التسجيل → استدعاء Edge Function `notify-new-signup` لإرسال إيميل لصاحب النظام.
  - عرض رسالة «تحقّق من بريدك لتفعيل الحساب».
- **`src/pages/TrialExpired.jsx` (جديد)** — تصميم فاخر:
  - رسالة «انتهت فترة التجربة».
  - بطاقة اشتراك سنوي 2500 ريال.
  - زر ميسر (**معطّل** مع شارة «قريباً»).
  - نموذج تحويل بنكي + رفع إيصال (Supabase Storage) → يسجّل في `subscription_payments` ويرسل إيميل للأدمن.
  - زر واتساب `https://wa.me/966557500471` للاستفسار وطلب رقم الحساب.
  - رسالة «سيتم تأكيد السداد وتفعيل الاشتراك خلال 24 ساعة».
- **`src/components/TrialBanner.jsx` (جديد)** — شريط علوي رفيع داخل النظام (يظهر فقط لخطة `trial`):
  - عدّاد تنازلي حيّ (أيام:ساعات:دقائق).
  - زر «تفعيل الاشتراك» → يوجّه لصفحة الاشتراك (`TrialExpired` بوضع upgrade).
- **`src/AuthContext.jsx`** — بعد تحميل `company`:
  - استدعاء `company_access_state(company_id)`.
  - تخزين `{ plan, active, secondsLeft }` وتحديث كل دقيقة.
  - عرض `TrialExpired` بدل الـ Shell عندما `active === false`.

### 3) إيميلات التفعيل والإشعار

- **إيميل التفعيل**: عبر نظام Lovable Auth Email Templates المُدار (سنستدعي `scaffold_auth_email_templates` ثم `deploy_edge_functions`).
- **إيميل للأدمن عند تسجيل جديد**: Edge Function جديد `supabase/functions/notify-new-signup/index.ts` يستخدم `send-email` القائم (أو Lovable Emails transactional) لإرسال البيانات إلى `shadyabdelwahab99@gmail.com`.
- **إيميل عند رفع إيصال دفع**: نفس القناة، يُرفق رابط الإيصال في Storage (signed URL).

### 4) فرض التجربة على مستوى الوصول

- الواجهة: `AuthContext` يمنع الدخول للـ Shell إذا `active=false` ويعرض `TrialExpired`.
- الحماية الفعلية على DB: كل السياسات الحالية تعتمد على `company_id`؛ نضيف دالة `require_active_company()` تُستدعى داخل السياسات الحسّاسة (إنشاء حجز/فاتورة/دفعة) بحيث لا يمكن الكتابة إذا انتهت التجربة حتى بتجاوز الواجهة.

### 5) لوحة الأدمن اليدوية
تعليمات SQL جاهزة في ملف `TRIAL_SYSTEM_READY_TO_PASTE.sql` لصاحب النظام:
```sql
-- تمديد التجربة 15 يوم
select public.admin_extend_trial('<company_uuid>', 15);
-- تفعيل اشتراك سنوي
select public.admin_activate_subscription('<company_uuid>', 12);
-- إيقاف حساب
update public.companies set plan='suspended' where id='<company_uuid>';
```

---

## الملفات التي ستُنشأ/تُعدّل

**جديد:**
- `supabase/TRIAL_SYSTEM_READY_TO_PASTE.sql`
- `supabase/migrations/20260713100000_trial_system.sql`
- `supabase/functions/notify-new-signup/index.ts`
- `src/lib/ejarValidation.js`
- `src/components/EjarContractPreview.jsx`
- `src/components/TrialBanner.jsx`
- `src/pages/TrialExpired.jsx`
- `src/pages/SignupTrial.jsx` (أو مدمج في Login كتبويب)

**معدّل:**
- `src/pages/Landing.jsx` (تصميم فاخر + النص الجديد + قسم التجربة)
- `src/pages/Login.jsx` (Tabs + تصميم فاخر)
- `src/pages/EjarPanel.jsx` (زر المعاينة + قائمة المتطلبات)
- `src/AuthContext.jsx` (فحص حالة الاشتراك)
- `src/App.jsx` (توجيه TrialExpired + إظهار TrialBanner)
- `src/styles.css` (تأثيرات حركية جديدة)
- `supabase/functions/ejar-submit-contract/index.ts` (تحقق مزدوج)

## ملاحظات ضمان عدم كسر النظام
- كل تغييرات DB **Idempotent** (`if not exists`, `on conflict do nothing`).
- الشركات القديمة بدون `trial_ends_at` تُعامل كنشطة (backfill يضع `plan='active'` لكل الشركات الموجودة قبل التحديث).
- التحقق من إيجار لا يمنع الحفظ محلياً — فقط يمنع الإرسال.
- زر ميسر ظاهر لكنه معطّل (كما طلبت).

هل توافق على هذه الخطة لأبدأ التنفيذ الكامل؟
