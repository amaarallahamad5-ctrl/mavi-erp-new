'use strict';
/* فهمي بتاع التسويق — the owner's daily marketing/ops idea, one per Cairo day.
   Owner decision (26.11): «الذكاء الصناعي يبقى هو مسئول التسويق يدي أفكار يومية
   بمعدل فكرة كل يوم… مش شرط يبقى فكرة بوست، ممكن تكون فكرة تحسين حاجة في الموقع
   للوصول للعميل… كزرار خاص بالاشعارات وفيه كل التفاصيل».
   How it works (honest, zero fake content):
   - one idea per Africa/Cairo day, idempotent (INSERT OR IGNORE on the day key)
   - the idea is built ONLY from real system data (orders, measurements,
     custom requests, style pages) — numbers, codes and names come from the DB
   - plain, understandable Arabic — no provider jargon, no AI-speak
   - the daily topic rotates among the data-backed topics so she gets variety
   - ideas are stored so previous days stay readable in the same modal */

const { db, get, all, run } = require('./db');
const { cairoDate } = require('./business-date');
const D = require('./domain');

const FAHMY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fahmy_ideas (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL DEFAULT '',
  title_ar TEXT NOT NULL,
  body_ar TEXT NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '[]',
  steps_json TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'real-data',
  ai_model TEXT NOT NULL DEFAULT '',
  is_new INTEGER NOT NULL DEFAULT 1,
  created_at REAL NOT NULL,
  read_at REAL
);
CREATE INDEX IF NOT EXISTS idx_fahmy_ideas_day ON fahmy_ideas(day DESC);`;

function ensureFahmySchema() {
  const existing = get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'fahmy_ideas'");
  if (!existing) {
    db.exec(FAHMY_SCHEMA_SQL);
    return;
  }
  const cols = db.pragma('table_info(fahmy_ideas)').map(c => c.name);
  if (!cols.includes('ai_model')) {
    db.exec("ALTER TABLE fahmy_ideas ADD COLUMN ai_model TEXT NOT NULL DEFAULT ''");
  }
}
ensureFahmySchema();

/* ---------- real-data brief (only counts and public-safe names) ---------- */
const MISSING_M_KEYS = ['bust', 'waist', 'hip', 'length'];
function hasCompleteMeasurements(m) {
  if (!m || typeof m !== 'object') return false;
  return MISSING_M_KEYS.every(k => {
    const v = Number(m[k]);
    return Number.isFinite(v) && v >= 20 && v <= 250;
  });
}

const STATUS_AR = {
  new: 'مسجّل', confirmed: 'مؤكد', cut: 'القص', sewing: 'الخياطة',
  ready: 'جاهزة للتسليم', delivering: 'في التوصيل', delivered: 'اتسلمت', cancelled: 'ملغي',
};
const CHANNEL_AR = { whatsapp: 'واتساب', facebook: 'فيسبوك', instagram: 'إنستجرام', online: 'الموقع', walkin: 'زيارة الفرع' };

function arDate(value) {
  const d = cairoDate(value);
  if (!d) return '';
  const [y, mo, da] = d.split('-');
  return `${da}/${mo}/${y}`;
}

function collectBrief() {
  const today = cairoDate(new Date().toISOString());
  const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const twoWeeksAgo = new Date(Date.now() - 14 * 864e5).toISOString().slice(0, 10);
  const brief = { today };

  // 1) late delivery promises (active orders whose promise_date passed)
  brief.late = all(
    `SELECT o.code, o.promise_date, o.status, COALESCE(NULLIF(o.contact_name,''), c.name) AS cname
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status NOT IN ('delivered','cancelled') AND o.promise_date IS NOT NULL AND o.promise_date < ?
     ORDER BY o.promise_date ASC LIMIT 5`, today
  ).map(o => ({ code: o.code, name: o.cname, stage: STATUS_AR[o.status] || o.status, date: o.promise_date,
    days: Math.max(0, Math.round((new Date(today) - new Date(o.promise_date)) / 864e5)) }));
  brief.lateCount = get(
    `SELECT COUNT(*) n FROM orders WHERE status NOT IN ('delivered','cancelled') AND promise_date IS NOT NULL AND promise_date < ?`, today
  ).n;

  // 2) active made orders missing core measurements (cutting is blocked).
  // Orders with custom_pending items are skipped — their sizing follows the
  // custom-request flow, not the measurements table.
  const measCandidates = all(
    `SELECT o.id, o.code, o.status, COALESCE(NULLIF(o.contact_name,''), c.name) AS cname, o.measurements_snapshot, o.customer_id
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status IN ('confirmed','cut')
       AND NOT EXISTS (
         SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.status = 'custom_pending'
       )
     ORDER BY o.created_at ASC LIMIT 120`, []
  );
  const missingList = [];
  for (const o of measCandidates) {
    let m = null;
    if (o.measurements_snapshot !== null && o.measurements_snapshot !== undefined) {
      try { m = JSON.parse(o.measurements_snapshot); } catch (_) {}
    }
    if (!m || typeof m !== 'object') m = get('SELECT * FROM measurements WHERE customer_id = ?', o.customer_id);
    if (!hasCompleteMeasurements(m)) missingList.push(o);
  }
  brief.measureMissing = missingList.slice(0, 5).map(o => ({ code: o.code, name: o.cname, stage: STATUS_AR[o.status] || o.status }));
  brief.measureMissingCount = missingList.length;

  // 3) pieces ready but not delivered yet
  brief.ready = all(
    `SELECT o.code, COALESCE(NULLIF(o.contact_name,''), c.name) AS cname
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status IN ('ready','delivering') ORDER BY o.updated_at ASC LIMIT 5`, []
  ).map(o => ({ code: o.code, name: o.cname }));
  brief.readyCount = get(`SELECT COUNT(*) n FROM orders WHERE status IN ('ready','delivering')`, []).n;

  // 4) custom requests waiting for pricing
  brief.pendingQuotes = all(
    `SELECT id, created_at FROM custom_requests WHERE status = 'review' ORDER BY created_at ASC LIMIT 5`, []
  ).map(r => {
    const days = Math.max(0, Math.round((Date.now() - new Date(r.created_at.replace(' ', 'T') + 'Z').getTime()) / 864e5));
    return { id: r.id, days };
  });
  brief.pendingQuotesCount = get(`SELECT COUNT(*) n FROM custom_requests WHERE status = 'review'`, []).n;

  // 5) public made-style pages missing their description (bad for reach/SEO)
  brief.stylesNoNote = all(
    `SELECT id, name FROM styles WHERE type = 'made' AND active = 1 AND (note IS NULL OR TRIM(note) = '') ORDER BY created_at DESC LIMIT 5`, []
  ).map(s => ({ id: s.id, name: s.name }));
  brief.stylesNoNoteCount = get(
    `SELECT COUNT(*) n FROM styles WHERE type = 'made' AND active = 1 AND (note IS NULL OR TRIM(note) = '')`, []
  ).n;
  brief.stylesTotal = get(`SELECT COUNT(*) n FROM styles WHERE type = 'made' AND active = 1`, []).n;

  // 6) active orders with zero recorded payments
  brief.noDeposit = all(
    `SELECT o.code, COALESCE(NULLIF(o.contact_name,''), c.name) AS cname, o.status
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.status NOT IN ('delivered','cancelled')
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)
     ORDER BY o.created_at ASC LIMIT 5`, []
  ).map(o => ({ code: o.code, name: o.cname, stage: STATUS_AR[o.status] || o.status }));
  brief.noDepositCount = get(
    `SELECT COUNT(*) n FROM orders o
       WHERE o.status NOT IN ('delivered','cancelled')
       AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)`, []
  ).n;

  // 7) delivered in the last two weeks (care + reviews + photos)
  brief.deliveredRecent = get(
    `SELECT COUNT(*) n FROM orders WHERE status = 'delivered' AND updated_at >= ?`, twoWeeksAgo
  ).n;

  // 8) this week's orders by channel (marketing anchor)
  brief.weekOrders = get(`SELECT COUNT(*) n FROM orders WHERE created_at >= ?`, weekAgo).n;
  brief.topChannel = get(
    `SELECT channel, COUNT(*) n FROM orders WHERE created_at >= ? GROUP BY channel ORDER BY n DESC LIMIT 1`, weekAgo
  ) || null;

  return brief;
}

/* ---------- topic builders: every sentence is written from the brief ---------- */
function topicsFromBrief(b) {
  const T = [];
  const list = (arr, fmt) => arr.slice(0, 3).map(fmt).join('، ');

  if (b.lateCount > 0) {
    T.push({
      topic: 'late_promises',
      title: `مواعيد التسليم المتأخرة — ${b.lateCount} طلب محتاج اتصال النهاردة`,
      body:
        `صباح/مساء الخير 🌸 أنا فهمي، قريت بيانات النظام كلها وطلعتلك أهم حاجة محتاجة لمك اليوم.\n\n` +
        `عندنا ${b.lateCount} طلب موعد تسليمه عدّى وهو لسه في التشغيل. دي أول حاجة بتضايق العميلة وبتقلل التقييمات، وترتيبها بسيط: اتصال واحد بيحل الموضوع.\n\n` +
        `الطلبات بالترتيب (الأقدم أولًا):\n` +
        b.late.map(o => `• طلب ${o.code} — ${o.name} — الميعاد كان ${arDate(o.date)} (${o.days} يوم تأخير) — القطعة في مرحلة ${o.stage}.`).join('\n') +
        `\n\nاتصلي على كل عميلة بالترتيب، اتفقي معاها على ميعاد جديد يناسبها، وسجّليه على الطلب من كارت الطلب نفسه. لو تحبي، افتحي تاب «المسودات» — رسالة متابعة جاهزة لكل طلب من دول تقدري تنسخيها وتبعتيها على واتساب بإيدك.` +
        (b.lateCount > b.late.length ? `\n\nودي أول ${b.late.length} طلبات بس — باقي ${b.lateCount - b.late.length} طلبات شوفهم من صفحة «شغل النهاردة».` : ''),
      facts: [
        { label: 'طلبات متأخرة', value: String(b.lateCount) },
        { label: 'أقدم تأخير', value: `${b.late[0] ? b.late[0].days : 0} يوم` },
        { label: 'أقدم طلب', value: b.late[0] ? b.late[0].code : '—' },
      ],
      steps: [
        'اتصلي على كل عميلة بالترتيب (الأقدم أولًا) واتmegaفي معاها ميعاد جديد واضح.',
        'سجّلي الميعاد الجديد على الطلب من كارت الطلب.',
        'انسخي رسالة المتابعة الجاهزة من تاب المسودات وابعتيها على واتساب بإيدك.',
      ],
    });
  }

  if (b.measureMissing.length > 0) {
    T.push({
      topic: 'missing_measurements',
      title: `مقاسات ناقصة بتوقف القص — ${b.measureMissing.length} طلب محتاج استكمال`,
      body:
        `أنا فهمي، بصيت على طلبات التشغيل النهاردة ودي أقرب حاجة تسرّع الشغل.\n\n` +
        `في ${b.measureMissing.length} طلب مؤكد/في القص، مقاساته الأساسية (الصدر أو الوسط أو الأرداف أو الطول) مش مكتملة. من غير المقاسات دي القص بيوقف، وكل يوم تأخير بيتحول لطلب متأخر بعدين.\n\n` +
        `الطلبات:\n` +
        b.measureMissing.map(o => `• طلب ${o.code} — ${o.name} — المرحلة: ${o.stage}.`).join('\n') +
        `\n\nالمطلوب بسيط: كلمي كل عميلة تستكمل مقاساتها، وسجّلي المقاسات من كارت الطلب. أول ما المقاسات تكتمل، القص يكمل على طول.` +
        `\n\nنصيحة مني: رسالة «استكمال المقاسات» الجاهزة موجودة في كارت كل طلب من دول داخل صفحة الطلب — اضغطي زر المسودة وانسخيها.`,
      facts: [
        { label: 'طلبات ناقصة المقاسات', value: String(b.measureMissing.length) },
        { label: 'أول طلب', value: b.measureMissing[0] ? b.measureMissing[0].code : '—' },
      ],
      steps: [
        'كلمي كل عميلة على القائمة واطلبي منها المقاسات الناقصة (الصدر/الوسط/الأرداف/الطول).',
        'سجّلي المقاسات فورًا في كارت الطلب.',
        'لو العميلة مش متجاوبة، حدّدي ميعاد تذكير تاني بكرة.',
      ],
    });
  }

  if (b.readyCount > 0) {
    T.push({
      topic: 'ready_to_deliver',
      title: `قطع جاهزة لسه متسلّمتش — ${b.readyCount} طلب جاهز للتسليم`,
      body:
        `أنا فهمي، ودي فكرة بتشيل حاجة من دماغك وتفرّح العميلات في نفس الوقت.\n\n` +
        `عندنا ${b.readyCount} قطعة جاهزة (أو في التوصيل) لسه وصلتش للعميلات. القطعة اللي جاهزة وواقفة هي أسرع فاتورة بتتحول لفلوس، وأحسن انطباع عند العميلة.\n\n` +
        `الطلبات الجاهزة:\n` +
        b.ready.map(o => `• طلب ${o.code} — ${o.name}.`).join('\n') +
        `\n\nاتفقيلي على ترتيب التسليم النهاردة أو بكره: اتصلي على كل عميلة تحديد ميعاد التسليم أو التوصيل، وسجّلي الاتفاق على الطلب. لو حابة تزودي الانطباع، ضيفي مع التسليم رسالة شكر قصيرة وطلب تقييم بعد الاستلام.`,
      facts: [
        { label: 'قطع جاهزة للتسليم', value: String(b.readyCount) },
        { label: 'أول طلب', value: b.ready[0] ? b.ready[0].code : '—' },
      ],
      steps: [
        'اتصلي على العميلات الجاهزين وثبّتي ميعاد التسليم/التوصيل.',
        'سجّلي الاتفاق على الطلب عشان التشغيل يعرف.',
        'بعد الاستلام، ابعتيلها رسالة شكر واطلبي تقييم للموديل.',
      ],
    });
  }

  if (b.pendingQuotesCount > 0) {
    T.push({
      topic: 'pending_quotes',
      title: `طلبات تصميم خاص محتاجة تسعير — ${b.pendingQuotesCount} طلب مستني ردك`,
      body:
        `أنا فهمي، ودي حاجة بتفوت فلوس لو سابت.\n\n` +
        `في ${b.pendingQuotesCount} طلب تصميم خاص دخول من العميلات ولسه في مرحلة «بانتظار التسعير». الطلب اللي بيستنى التسعير أكتر من يومين بيروح يشتري من مكان تاني — السرعة هنا بتكسب الطلب.\n\n` +
        `الطلبات:\n` +
        b.pendingQuotes.map(r => `• طلب تصميم CR-${r.id} — مستني ${r.days} ${r.days === 1 ? 'يوم' : 'أيام'}.`).join('\n') +
        `\n\nافتحي كل طلب من صفحة التصاميم الخاصة، شوفي الصور والمقاسات، حدّدي السعر والعربون، وابعتي التسعير للعميلة. مفيش حاجة تقنية — بس نظرتك وقرارك.`,
      facts: [
        { label: 'طلبات محتاجة تسعير', value: String(b.pendingQuotesCount) },
        { label: 'أقدم طلب مستني', value: b.pendingQuotes[0] ? `${b.pendingQuotes[0].days} يوم` : '—' },
      ],
      steps: [
        'افتحي صفحة التصاميم الخاصة وشوفي الطلبات المفتوحة.',
        'حدّدي السعر والعربون لكل طلب وابعتيه للعميلة.',
        'أول ما العميلة توافق، سجّلي الطلب كأوردر عادي.',
      ],
    });
  }

  if (b.stylesNoNoteCount > 0) {
    T.push({
      topic: 'styles_no_description',
      title: `فكرة للوصول للعميلات: أكمل أوصاف ${b.stylesNoNoteCount} موديل على الموقع`,
      body:
        `أنا فهمي بتاع التسويق، ودي فكرة بتزوّد ظهورك على جوجل وبتقلل أسئلة «ده إيه؟» في الرسايل.\n\n` +
        `الموقع فيه ${b.stylesTotal} موديل نشط، منهم ${b.stylesNoNoteCount} موديل صفحته من غير وصف. صفحة الموديل اللي فيها وصف كويس بتظهر في البحث وبتقنع العميلة تشتري من غير ما تسأل.\n\n` +
        `الموديلات الناقصة:\n` +
        b.stylesNoNote.map(s => `• ${s.name} (${s.id}).`).join('\n') +
        `\n\nمن صفحة كل موديل في الإدارة، افتحي «مسودات الفريق» واختاري «كابشن إنستجرام» أو «وصف صفحة الموديل» — المسودة بتنزل بتفاصيل الموديل الحقيقية، تراجعيها، واعتمديها فيتكتب الوصف على الصفحة فورًا (والاسترجاع متاح).`,
      facts: [
        { label: 'موديلات من غير وصف', value: String(b.stylesNoNoteCount) },
        { label: 'إجمالي الموديلات', value: String(b.stylesTotal) },
        { label: 'أول موديل', value: b.stylesNoNote[0] ? b.stylesNoNote[0].name : '—' },
      ],
      steps: [
        'افتحي صفحة كل موديل ناقص من القايمة فوق.',
        'اطلبي مسودة وصف من أزرار المسودات جوة صفحة الموديل.',
        'راجعي النص واعتمديه — الوصف يتكتب على الموقع فورًا.',
      ],
    });
  }

  if (b.noDepositCount > 0) {
    T.push({
      topic: 'no_deposit',
      title: `طلبات بدون عربون — ${b.noDepositCount} طلب تنفيذه واقف`,
      body:
        `أنا فهمي، ودي أهم حاجة في ترتيب النهاردة بعد المتأخرات.\n\n` +
        `في ${b.noDepositCount} طلب مسجّل من غير أي عربون أو دفعة. القاعدة عندنا إن التنفيذ يبدأ بالعربون — فالطلبات دي واقفة في مكانها ومحتاجة مكالمة واحدة بتحسمها.\n\n` +
        `الطلبات:\n` +
        b.noDeposit.map(o => `• طلب ${o.code} — ${o.name} — المرحلة: ${o.stage}.`).join('\n') +
        `\n\nكلمي كل عميلة بأسلوب لطيف: «الطلب اتسجل ومستنى العربون عشان نبدأ التنفيذ فورًا». أول ما الدفعة تتم، سجّليها من صفحة الطلب والشغل يبدأ على طول.`,
      facts: [
        { label: 'طلبات بدون عربون', value: String(b.noDepositCount) },
        { label: 'أول طلب', value: b.noDeposit[0] ? b.noDeposit[0].code : '—' },
      ],
      steps: [
        'اتصلي على كل عميلة وأكدي معاها الطلب.',
        'سجّلي العربون من صفحة الطلب أول ما يتحول.',
        'اللي مش حاسمة معاها، اعملي ليها تذكير بعد يومين.',
      ],
    });
  }

  if (b.deliveredRecent > 0) {
    T.push({
      topic: 'care_reviews',
      title: `فكرة تسويق مجانية: ${b.deliveredRecent} عميلة استلمت آخر أسبوعين — اطلبي منهم تقييم وصور`,
      body:
        `أنا فهمي بتاع التسويق، ودي أرخص وأقوى فكرة إعلانية عندك.\n\n` +
        `آخر أسبوعين ${b.deliveredRecent} عميلة استلموا طلباتهم. العميلة اللي لسه مبسوطة من التسليم بترد بسرعة، وتقييمها وصورتها على الموديل بتسوّق لك من غير ما تدفعي جنيه.\n\n` +
        `الفكرة بالخطوات: ابعتيلهم رسالة شكر قصيرة، اطلبي منهم تقييم للموديل على الموقع، ولو بعتت صورة للقطعة عليها اطلبي موافقتها تنزليها كصورة للعميلة على صفحة الموديل. بعد أسبوع هتلاقي صفحات الموديل أقوى والثقة أعلى.\n\n` +
        `ولو عايزة أثر أسرع: انزلي الصور والتقييمات دي كمحتوى ستوري/بوست بالاسم بتاع الموديل.`,
      facts: [
        { label: 'عميلات استلموا آخر أسبوعين', value: String(b.deliveredRecent) },
      ],
      steps: [
        'ابعتيلي كل عميلة استلمت رسالة شكر + طلب تقييم.',
        'خزّني صور العميلات الجديدة على صفحة الموديل.',
        'اعملي بوست/ستوري يجمع التقييمات والصور.',
      ],
    });
  }

  if (b.weekOrders > 0 && b.topChannel) {
    T.push({
      topic: 'weekly_channel',
      title: `فكرة أسبوعية: ${b.weekOrders} طلب جديد الأسبوع ده — الأغلبية جهنا من ${CHANNEL_AR[b.topChannel.channel] || b.topChannel.channel}`,
      body:
        `أنا فهمي، ودي قراءة سريعة لأرقام الأسبوع.\n\n` +
        `الأسبوع ده دخل ${b.weekOrders} طلب جديد، وأكتر قناة جابت طلبات هي ${CHANNEL_AR[b.topChannel.channel] || b.topChannel.channel} (${b.topChannel.n} طلب). لما قناة بتشتغل كده، المنطقي إنك تزودي حضورك فيها.\n\n` +
        `اقتراحي العملي: افتحي صفحات أحدث موديلاتك، اطلبي لكل واحد بوست/ريل جاهز من أزرار المسودات، وعدّلي النص بصوتك وانزليه على ${CHANNEL_AR[b.topChannel.channel] || b.topChannel.channel} المده ده. كرّريها كل أسبوع بنفس الموعد عشان الجمهور يتعود.`,
      facts: [
        { label: 'طلبات الأسبوع', value: String(b.weekOrders) },
        { label: 'أقوى قناة', value: CHANNEL_AR[b.topChannel.channel] || b.topChannel.channel },
        { label: 'طلبات القناة دي', value: String(b.topChannel.n) },
      ],
      steps: [
        'اطلبي مسودة بوست/ريل لكل موديل جديد من صفحته.',
        'راجعي النص وانزليه على القناة الأقوى.',
        'كرري الجدولة أسبوعيًا بنفس الموعد.',
      ],
    });
  }

  // evergreen fallback: still real data (latest active styles), never invented
  const newest = all(`SELECT id, name FROM styles WHERE type = 'made' AND active = 1 ORDER BY created_at DESC, id DESC LIMIT 3`, [])
    .map(s => ({ id: s.id, name: s.name }));
  T.push({
    topic: 'weekly_focus',
    title: `فكرة النهاردة: ركّزي التسويق على أحدث موديلاتك (${newest.map(s => s.name).join('، ')})`,
    body:
      `أنا فهمي بتاع التسويق. النهاردة البيانات هادية — مفيش متأخرات ولا نواقص عالقة — فأحسن استغلال لوقتك هو التسويق.\n\n` +
      `أحدث موديلات عندك دلوقتي: ${newest.map(s => `«${s.name}»`).join('، ')}. الموديل الجديد محتاج حضور: بوست يوضح تفاصيله وخامته ومقاساته، وريل قصير بيوريك حركة القماش.\n\n` +
      `من صفحة كل موديل اطلبي مسودة البوست أو خطة الريل، تراجعيها وعدّليها بصوتك، وانزليها. ولو صفحة الموديل نفسها ناقصها وصف، كمّلي الوصف الأول — هو اللي بيجيب الزيارات من جوجل.`,
    facts: [
      { label: 'أحدث موديلات', value: newest.map(s => s.name).join('، ') || '—' },
      { label: 'إجمالي الموديلات النشطة', value: String(b.stylesTotal) },
    ],
    steps: [
      'افتحي صفحة كل موديل من الأحدث.',
      'اطلبي مسودة بوست/ريل وراجعيها وانزليها.',
      'لو الوصف ناقص، اعتمدي مسودة الوصف الأول.',
    ],
  });
  return T;
}

function buildIdeaForDay(day) {
  const brief = collectBrief();
  const topics = topicsFromBrief(brief);
  // rotate deterministically so consecutive days differ when several topics qualify
  const dayNum = Math.floor(new Date(day + 'T00:00:00Z').getTime() / 864e5);
  const pick = topics[dayNum % topics.length];
  return pick;
}

function todayKey() {
  return cairoDate(new Date().toISOString());
}

function rowToIdea(row) {
  if (!row) return null;
  let facts = [], steps = [];
  try { facts = JSON.parse(row.facts_json || '[]'); } catch (_) {}
  try { steps = JSON.parse(row.steps_json || '[]'); } catch (_) {}
  return {
    id: row.id,
    day: row.day,
    topic: row.topic,
    title_ar: row.title_ar,
    body_ar: row.body_ar,
    facts,
    steps,
    source: row.source,
    ai_model: row.ai_model || '',
    is_new: !!row.is_new,
    created_at: row.created_at,
    read_at: row.read_at || null,
  };
}

/* ---------- AI-first engine (owner decision 26.11: «المشغل الأساسي بتاع
   فهمي يكون الذكاء الاصطناعي ويطلع نتايج قوية بعد بحث») ----------
   - first visit of a Cairo day: research the real-data brief with the gated
     AI provider (one call, no retries, free models only)
   - any failure (disabled, no key, congested free model, bad reply) falls
     back to the honest local real-data idea — nothing is ever faked
   - a local (fallback) idea is silently upgraded to the researched one later
     the same day when the provider becomes reachable (throttled 10 minutes
     after each failure so steady-state requests stay instant)
   - the brief sent to the provider carries NO customer names / phones /
     measurements / money — aggregates, codes, dates, stages, style names */
const UPGRADE_THROTTLE_MS = 10 * 60 * 1000;
let FAHMY_AI_LAST_FAIL = 0;
let fahmyAiInflight = null;

/* PRIVACY CONTRACT (locked by tests): NOTHING that leaves the ERP carries
   order/custom-request codes, customer names, phones, measurements, or money.
   Orders become ordinal labels; the specific codes are shown to the owner
   locally in the idea's facts grid (briefFacts below) and nowhere else. */
function sanitizeBriefForAi(b) {
  return {
    today: b.today,
    late_promises: {
      count: b.lateCount,
      oldest_days_late: b.late[0] ? b.late[0].days : 0,
      oldest_first: b.late.map((o, i) => ({ order: `متأخر #${i + 1}`, stage: o.stage, promised_date: o.date, days_late: o.days })),
    },
    missing_measurements: {
      count: b.measureMissingCount,
      orders: b.measureMissing.map((o, i) => ({ order: `ناقص مقاسات #${i + 1}`, stage: o.stage })),
    },
    ready_to_deliver: { count: b.readyCount },
    pending_custom_quotes: {
      count: b.pendingQuotesCount,
      oldest_waiting_days: b.pendingQuotes[0] ? b.pendingQuotes[0].days : 0,
    },
    catalogue: {
      styles_total: b.stylesTotal,
      styles_missing_description: { count: b.stylesNoNoteCount, names: b.stylesNoNote.map(st => st.name) },
    },
    orders_without_deposit: {
      count: b.noDepositCount,
      stages: b.noDeposit.map(o => o.stage),
    },
    delivered_last_two_weeks: b.deliveredRecent,
    week_orders: b.weekOrders,
    top_channel: b.topChannel ? { channel: CHANNEL_AR[b.topChannel.channel] || b.topChannel.channel, orders: b.topChannel.n } : null,
  };
}

function briefFacts(b) {
  const f = [];
  if (b.lateCount > 0) {
    f.push({ label: 'طلبات متأخرة عن موعد التسليم', value: String(b.lateCount) });
    if (b.late[0]) f.push({ label: 'أقدم طلب متأخر — ابدأي بيه', value: `${b.late[0].code} (${b.late[0].days} يوم)` });
  }
  if (b.measureMissingCount > 0 && b.measureMissing[0]) {
    f.push({ label: 'أول طلب ناقص المقاسات', value: b.measureMissing[0].code });
  }
  if (b.pendingQuotesCount > 0 && b.pendingQuotes[0]) {
    f.push({ label: 'أقدم تصميم خاص مستني تسعير', value: `CR-${b.pendingQuotes[0].id} (${b.pendingQuotes[0].days} يوم)` });
  }
  if (b.noDepositCount > 0 && b.noDeposit[0]) {
    f.push({ label: 'أول طلب بدون عربون', value: b.noDeposit[0].code });
  }
  if (b.measureMissingCount > 0) f.push({ label: 'طلبات ناقصة المقاسات', value: String(b.measureMissingCount) });
  if (b.readyCount > 0) f.push({ label: 'قطع جاهزة للتسليم', value: String(b.readyCount) });
  if (b.pendingQuotesCount > 0) f.push({ label: 'تصاميم خاصة محتاجة تسعير', value: String(b.pendingQuotesCount) });
  if (b.stylesNoNoteCount > 0) f.push({ label: 'موديلات بدون وصف', value: `${b.stylesNoNoteCount} من ${b.stylesTotal}` });
  if (b.deliveredRecent > 0) f.push({ label: 'تسليمات آخر أسبوعين', value: String(b.deliveredRecent) });
  if (b.weekOrders > 0) f.push({ label: 'طلبات الأسبوع', value: String(b.weekOrders) });
  if (b.topChannel) f.push({ label: 'أقوى قناة الأسبوع', value: CHANNEL_AR[b.topChannel.channel] || b.topChannel.channel });
  return f;
}

/* AI-first chain (owner decision 26.11): (1) the gated OpenRouter config —
   env or the key the owner saved from inside the فهمي modal; (2) the keyless
   free agent (وكيل مجاني) — no setup at all; (3) null -> the honest local
   real-data builder. Every hop is one-shot, no retries, never faked. */
async function tryAiIdea(brief, options = {}) {
  const sanitized = sanitizeBriefForAi(brief);
  // hop 1: gated provider with the stored/env key
  try {
    const or = require('./openrouter-client');
    const cfg = or.createConfig();
    let ready = false;
    try { cfg.validate(); ready = true; } catch (_) { ready = false; }
    if (ready) {
      const transport = options.transport || or.createLiveTransport({ timeoutMs: 18000 });
      const out = await or.generateFahmyIdea(cfg, { brief: sanitized, transport });
      if (out && out.title && out.body) {
        return {
          topic: 'ai_research',
          title: String(out.title),
          body: String(out.body),
          steps: Array.isArray(out.steps) ? out.steps : [],
          facts: briefFacts(brief),
          model: String(out.model_reported || ''),
        };
      }
    }
  } catch (_) { /* fall through to the free agent */ }
  // hop 2: keyless free agent (وكيل مجاني) — works with zero setup
  try {
    const fa = require('./free-agent-client');
    if (fa.freeAgentEnabled()) {
      const out = await fa.generateFahmyIdeaFree(sanitized, { transport: options.freeTransport, timeoutMs: 22000 });
      if (out && out.title && out.body) {
        return {
          topic: 'ai_research',
          title: String(out.title),
          body: String(out.body),
          steps: Array.isArray(out.steps) ? out.steps : [],
          facts: briefFacts(brief),
          model: String(out.model_reported || 'pollinations:openai'),
        };
      }
    }
  } catch (_) { /* fall through to the honest local idea */ }
  return null;
}

function localIdeaForDay(day) {
  const pick = buildIdeaForDay(day);
  run(
    `INSERT OR IGNORE INTO fahmy_ideas(id, day, topic, title_ar, body_ar, facts_json, steps_json, source, is_new, created_at)
     VALUES(?,?,?,?,?,?,?,?,1,?)`,
    `fahmy-${day}`, day, pick.topic, pick.title, pick.body,
    JSON.stringify(pick.facts || []), JSON.stringify(pick.steps || []), 'real-data', Date.now()
  );
  return get('SELECT * FROM fahmy_ideas WHERE day = ?', day);
}

async function ensureTodayIdea(options = {}) {
  const day = todayKey();
  const existing = get('SELECT * FROM fahmy_ideas WHERE day = ?', day);
  const aiWanted = !existing || (existing.source !== 'ai' && Date.now() - FAHMY_AI_LAST_FAIL > UPGRADE_THROTTLE_MS);
  if (aiWanted) {
    if (!fahmyAiInflight) {
      fahmyAiInflight = (async () => {
        try {
          const brief = collectBrief();
          const ai = await tryAiIdea(brief, options);
          if (ai) {
            run(
              `INSERT INTO fahmy_ideas(id, day, topic, title_ar, body_ar, facts_json, steps_json, source, is_new, created_at, ai_model)
               VALUES(?,?,?,?,?,?,?,'ai',1,?,?)
               ON CONFLICT(day) DO UPDATE SET
                 topic = excluded.topic,
                 title_ar = excluded.title_ar,
                 body_ar = excluded.body_ar,
                 facts_json = excluded.facts_json,
                 steps_json = excluded.steps_json,
                 source = 'ai',
                 ai_model = excluded.ai_model,
                 is_new = 1`,
              `fahmy-${day}`, day, ai.topic, ai.title, ai.body,
              JSON.stringify(ai.facts || []), JSON.stringify(ai.steps || []),
              Date.now(), ai.model || ''
            );
          } else {
            FAHMY_AI_LAST_FAIL = Date.now();
          }
        } catch (_) {
          FAHMY_AI_LAST_FAIL = Date.now();
        } finally {
          fahmyAiInflight = null;
        }
      })();
    }
    await fahmyAiInflight.catch(() => {});
  }
  const row = get('SELECT * FROM fahmy_ideas WHERE day = ?', day) || localIdeaForDay(day);
  return rowToIdea(row);
}

function listRecent(limit = 8) {
  const rows = all('SELECT * FROM fahmy_ideas ORDER BY day DESC LIMIT ?', Math.max(1, Math.min(30, Number(limit) || 8)));
  return rows.map(rowToIdea);
}

function markRead(day) {
  const d = day && /^\d{4}-\d{2}-\d{2}$/.test(String(day)) ? String(day) : todayKey();
  run('UPDATE fahmy_ideas SET is_new = 0, read_at = ? WHERE day = ? AND is_new = 1', Date.now(), d);
  return rowToIdea(get('SELECT * FROM fahmy_ideas WHERE day = ?', d));
}

module.exports = { ensureTodayIdea, listRecent, markRead, todayKey, collectBrief, buildIdeaForDay, sanitizeBriefForAi, briefFacts, tryAiIdea,
  /* reset the upgrade throttle: called right after the owner saves a research
     key so today's local idea upgrades immediately; also used by tests */
  resetAiThrottle() { FAHMY_AI_LAST_FAIL = 0; fahmyAiInflight = null; },
  _testResetAiThrottle() { FAHMY_AI_LAST_FAIL = 0; fahmyAiInflight = null; } };
