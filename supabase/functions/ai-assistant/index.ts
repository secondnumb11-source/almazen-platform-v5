// مساعد ذكي غير محدود — يستخدم Lovable AI Gateway مع tool-calling للاستعلام عن البيانات
// يستقبل: { messages: [{role,content}], company_id }
// يُعيد: streaming SSE من AI SDK
import { streamText, tool, stepCountIs, convertToModelMessages } from "npm:ai@5";
import { createGoogleGenerativeAI } from "npm:@ai-sdk/google@2";
import { createClient } from "npm:@supabase/supabase-js@2";
import { z } from "npm:zod@3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "GEMINI_API_KEY not configured in Supabase secrets" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const { messages } = await req.json();

    // Derive company_id from the verified JWT — never trust a client-supplied value.
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      return new Response(JSON.stringify({ error: "AUTH_REQUIRED" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    const supaUrl = Deno.env.get("SUPABASE_URL")!;
    const supaKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supaUrl, supaKey);

    const caller = createClient(supaUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await caller.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "AUTH_REQUIRED" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
    const { data: profile } = await admin.from("profiles")
      .select("company_id").eq("id", userData.user.id).maybeSingle();
    const company_id = profile?.company_id;
    if (!company_id) {
      return new Response(JSON.stringify({ error: "PROFILE_NOT_FOUND" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // كل استعلام مقيد تلقائيًا على company_id لضمان العزل الأمني
    // (يجب استدعاء select() قبل أي عامل تصفية مثل eq في supabase-js)
    const scoped = (table: string, select: string) => admin.from(table).select(select).eq("company_id", company_id);

    const google = createGoogleGenerativeAI({ apiKey });

    const tools = {
      query_units: tool({
        description: "استعلام عن الوحدات: available/reserved/occupied/maintenance. يعيد الأرقام والأسعار والحالة.",
        inputSchema: z.object({
          status: z.string().nullable().optional().describe("available|reserved|occupied|maintenance"),
          max_price: z.number().nullable().optional().describe("سعر يومي أقصى"),
          category: z.string().nullable().optional(),
        }),
        execute: async ({ status, max_price, category }) => {
          let q = scoped("units", "unit_number,category,status,daily_price,monthly_price,description");
          if (status) q = q.eq("status", status);
          if (category) q = q.eq("category", category);
          if (max_price) q = q.lte("daily_price", max_price);
          const { data, error } = await q.limit(100);
          return error ? { error: error.message } : { rows: data, count: data?.length || 0 };
        },
      }),
      query_bookings: tool({
        description: "الحجوزات مع بيانات المستأجر والوحدة. يقبل فلترة بالتاريخ والحالة ورقم الوحدة.",
        inputSchema: z.object({
          from: z.string().nullable().optional().describe("YYYY-MM-DD"),
          to: z.string().nullable().optional(),
          status: z.string().nullable().optional().describe("confirmed|checked_in|checked_out|cancelled"),
          unit_number: z.string().nullable().optional(),
        }),
        execute: async ({ from, to, status, unit_number }) => {
          let q = scoped("bookings", "id,check_in_date,check_out_date,total_amount,discount_percent,status,down_payment,insurance_amount,customers(full_name,phone,id_number),units!inner(unit_number,category)");
          if (from) q = q.gte("check_in_date", from);
          if (to) q = q.lte("check_out_date", to);
          if (status) q = q.eq("status", status);
          if (unit_number) q = q.eq("units.unit_number", unit_number);
          const { data, error } = await q.order("check_in_date", { ascending: false }).limit(200);
          return error ? { error: error.message } : { rows: data, count: data?.length || 0 };
        },
      }),
      query_payments: tool({
        description: "الدفعات المسجلة مع نوعها والمبلغ والطريقة. فلترة بالتاريخ ونوع الدفعة والوحدة.",
        inputSchema: z.object({
          from: z.string().nullable().optional(),
          to: z.string().nullable().optional(),
          type: z.string().nullable().optional().describe("rent|down_payment|insurance|refund"),
          unit_number: z.string().nullable().optional(),
        }),
        execute: async ({ from, to, type, unit_number }) => {
          let q = scoped("payments", "payment_date,amount,method,payment_type,reference_number,bookings(units!inner(unit_number),customers(full_name))");
          if (from) q = q.gte("payment_date", from);
          if (to) q = q.lte("payment_date", to);
          if (type) q = q.eq("payment_type", type);
          const { data, error } = await q.order("payment_date", { ascending: false }).limit(500);
          if (error) return { error: error.message };
          const rows = unit_number ? data?.filter((r: any) => r.bookings?.units?.unit_number === unit_number) : data;
          const total = (rows || []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
          return { rows, count: rows?.length || 0, total };
        },
      }),
      query_expenses: tool({
        description: "المصروفات مع الفئة والوحدة المرتبطة.",
        inputSchema: z.object({
          from: z.string().nullable().optional(),
          to: z.string().nullable().optional(),
          category: z.string().nullable().optional(),
        }),
        execute: async ({ from, to, category }) => {
          let q = scoped("expenses", "expense_date,amount,category,description,unit_id,units(unit_number)");
          if (from) q = q.gte("expense_date", from);
          if (to) q = q.lte("expense_date", to);
          if (category) q = q.eq("category", category);
          const { data, error } = await q.order("expense_date", { ascending: false }).limit(500);
          if (error) return { error: error.message };
          const total = (data || []).reduce((s: number, r: any) => s + Number(r.amount || 0), 0);
          return { rows: data, count: data?.length || 0, total };
        },
      }),
      query_customers: tool({
        description: "بيانات المستأجرين المسجلين (الاسم، الجوال، الهوية، النقاط).",
        inputSchema: z.object({ search: z.string().nullable().optional() }),
        execute: async ({ search }) => {
          let q = scoped("customers", "full_name,phone,id_number,customer_type,vat_number,loyalty_points");
          if (search) q = q.or(`full_name.ilike.%${search}%,phone.ilike.%${search}%,id_number.ilike.%${search}%`);
          const { data, error } = await q.limit(200);
          return error ? { error: error.message } : { rows: data, count: data?.length || 0 };
        },
      }),
      query_maintenance: tool({
        description: "طلبات الصيانة والحالة.",
        inputSchema: z.object({ status: z.string().nullable().optional() }),
        execute: async ({ status }) => {
          let q = scoped("maintenance_requests", "*,units(unit_number)");
          if (status) q = q.eq("status", status);
          const { data, error } = await q.order("created_at", { ascending: false }).limit(200);
          return error ? { error: error.message } : { rows: data, count: data?.length || 0 };
        },
      }),
      compute_kpis: tool({
        description: "احسب مؤشرات الأداء الأساسية للمدة: إيرادات، مصروفات، صافي، عدد الحجوزات، الإشغال.",
        inputSchema: z.object({ from: z.string(), to: z.string() }),
        execute: async ({ from, to }) => {
          const [pays, exps, bks] = await Promise.all([
            scoped("payments", "amount").gte("payment_date", from).lte("payment_date", to),
            scoped("expenses", "amount").gte("expense_date", from).lte("expense_date", to),
            scoped("bookings", "id").gte("check_in_date", from).lte("check_in_date", to),
          ]);
          const rev = (pays.data || []).reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
          const exp = (exps.data || []).reduce((s: number, p: any) => s + Number(p.amount || 0), 0);
          const { data: occ } = await admin.rpc("occupancy_rate", { p_company: company_id, p_from: from, p_to: to });
          return { revenue: rev, expenses: exp, net: rev - exp, bookings: bks.data?.length || 0, occupancy_pct: occ ?? 0 };
        },
      }),
    };

    const system = `أنت مساعد ذكي فائق الذكاء وغير محدود لمنصة "المازن" لإدارة الوحدات السكنية والشاليهات في السعودية.
- اللغة الافتراضية: العربية الفصحى.
- كل جواب يجب أن يعتمد على البيانات الحقيقية عبر الأدوات المتاحة.
- استخدم الأدوات دائمًا قبل الإجابة على أي سؤال يتعلق بأرقام أو تقارير أو بيانات المنشأة.
- يمكنك دمج نتائج عدة أدوات لبناء تقرير شامل.
- عند طلب تقرير أو ملف: نفّذ الاستعلامات ثم قدّم النتائج مُنسّقة (جدول ماركداون + إجماليات + رؤى تحليلية).
- الأرقام المالية بالريال السعودي (ر.س). التواريخ بصيغة YYYY-MM-DD.
- لا يوجد أي قيد على نوع البيانات — تصفّح الحجوزات، الدفعات، المصروفات، الصيانة، الوحدات، المستأجرين بحرية.
- إذا طلب المستخدم "أصدر لي" أو "استخرج ملف" — اجمع البيانات وقدّمها كجدول جاهز للنسخ.
- عند اكتشاف مشاكل (متأخرات، خسائر) قدّم توصيات عملية.
company_id الحالي: ${company_id}. لا تكشف أي بيانات لشركة أخرى.`;

    const result = streamText({
      model: google("gemini-2.5-flash"),
      system,
      messages: convertToModelMessages(messages),
      tools,
      stopWhen: stepCountIs(50),
    });

    return result.toUIMessageStreamResponse({ headers: corsHeaders });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  }
});
