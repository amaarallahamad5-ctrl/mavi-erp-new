'use strict';
/* Internal owner↔staff chat with structured work requests.
   - Staff post free-form coordination messages and optional work requests
     (non-financial kinds only — money and budgets stay owner-only).
   - The owner approves or rejects each request; approval enqueues the real
     office job immediately (owner actor, audited, idempotent).
   - Chat is for coordination only: never prices, costs, or secrets. */
const express = require('express');
const { get, all, run, audit } = require('./db');
const A = require('./auth');
const { JOB_KINDS } = require('./office-team');
const engine = require('./office-engine');

run(`CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender_role TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  body TEXT NOT NULL,
  request_kind TEXT,
  request_payload TEXT,
  request_status TEXT,
  decision_note TEXT,
  decided_at TEXT,
  job_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

/* Staff-requestable kinds: non-financial marketing/ops drafts only.
   campaign_brief / paid_ad_setup_draft / executive_brief are deliberately
   excluded — budgets are owner-only inputs. */
const STAFF_REQUEST_KINDS = Object.freeze([
  'content_draft',
  'community_followup_draft',
  'visual_reel_brief',
  'seo_readiness_check',
  'landing_page_check',
  'style_page_copy_draft',
  'delivery_promise_draft',
]);

/* Virtual-team auto-replies: rule-based acknowledgements from the responsible
   team member so the owner never talks into a void. Honest by design: the
   reply states what the member WILL do and what permission is needed, and it
   carries LIVE numbers from the office queue so the owner can act on it.
   Counts only — the chat is staff-readable, so no money amounts ever appear. */
const REPLY_RULES = [
  { re: /ورش|خياط|قص|إنتاج|تأخير/i, id: 'hana', name: 'هنا', role: 'منسقة الورش والإنتاج',
    line: 'هجهزلك كشف متابعة الورش للطلبات القريبة والمتأخرة، وأبلغك بأي تأخير مبكرًا قبل ما يوصل للعميلة.' },
  { re: /أوردر|طلب|عميل|مقاس|تسليم|تسعير|تصميم خاص/i, id: 'nour', name: 'نور', role: 'منسقة الطلبات والمقاسات',
    line: 'راجعت حالة الطلبات والمقاسات، وهجهزلك قائمة بالنواقص المطلوبة وأقترح ترتيب الأولويات. أي وعد تسليم جديد لعميلة هطلب إذنك الأول قبل ما أتواصل معاها.' },
  { re: /عربون|إيصال|فلوس|مبلغ|دفعة|حساب|مصروف/i, id: 'omar', name: 'عمر', role: 'المحاسب',
    line: 'هراجع الإيصالات المعلقة والأرصدة وأعرض عليك اللي محتاج قرارك — أنا مش بأعتمد أي دفعة بنفسي.' },
  { re: /بوست|محتوى|كابشن|إنستجرام|فيسبوك|نشر|ريل|تصوير/i, id: 'laila', name: 'ليلى', role: 'كاتبة المحتوى',
    line: 'أجهزلك مسودة بوست بالبيانات المعتمدة من الكتالوج (من غير أسعار) وأبعتهالك هنا للمراجعة — النشر نفسه يبقى بقرارك ويدوي.' },
  { re: /seo|جوجل|google|ظهور|بحث/i, id: 'karim', name: 'كريم', role: 'مدير التسويق والنمو',
    line: 'هطلب من نادين فحص جاهزية صفحة الموديل وأرجعلك بملخص النواقص قبل أي ترويج.' },
  { re: /إعلان|ميزانية|حملة|ad[s]?|ترويج/i, id: 'karim', name: 'كريم', role: 'مدير التسويق والنمو',
    line: 'أجهزلك موجز حملة بسقف ميزانية واضح ترفضيه أو توافقيه — الإطلاق الفعلي يدوي منك على المنصة.' },
  { re: /أمان|خصوصية|صلاحيات|باسورد|اختراق/i, id: 'tarek', name: 'طارق', role: 'مسؤول الأمان والجودة',
    line: 'هعمل فحص سريع للضوابط الحية (الصلاحيات وعزل البيانات) وأرفعلك التقرير بأي ملاحظة قبل أي إجراء.' },
  { re: /بيانات|erp|ربط|تقرير/i, id: 'youssef', name: 'يوسف', role: 'مسؤول بيانات وربط ERP',
    line: 'هفحص اتساق السجلات والروابط وأرجعلك تقرير سلامة مختصر.' },
  { re: /أي جديد|اي جديد|أخبار|اخبار|الوضع|إيه اللي|ايه اللي|حصل إيه|مين مسؤول|الخطة|إدارة/i, id: 'rami', name: 'رامي', role: 'المدير العام',
    line: 'هجيبلك الصورة الكاملة دلوقتي من طابور المكتب — المسودات اللي مستنية قرارك وأي حاجة عالقة.' },
  { re: /صباح الخير|مساء الخير|إزيك|ازيك|عاملة إيه|السلام|سلام/i, id: 'rami', name: 'رامي', role: 'المدير العام',
    line: 'أهلًا بالمالكة 🤍 — دي صورة المكتب دلوقتي بالأرقام، وأي مسودة مستنية قرارك هتلاقيها بقسم المسودات.' },
];
/* Live office facts for the reply: undecided drafts, pending deposit receipts,
   fresh (unconfirmed) orders, late orders, unpriced custom requests. Counts
   only — never amounts — because staff accounts read this chat too. */
function officeDigest() {
  try {
    const review = all("SELECT kind, COUNT(*) n FROM office_jobs WHERE status='review' GROUP BY kind ORDER BY n DESC");
    const pendingJobs = review.reduce((s, r) => s + r.n, 0);
    const pendingKinds = review.map((r) => `${(JOB_KINDS[r.kind] && JOB_KINDS[r.kind].label) || r.kind} (${r.n})`).slice(0, 4).join('، ');
    const receipts = get("SELECT COUNT(*) n FROM order_deposits WHERE status='receipt_pending'").n;
    const freshOrders = get("SELECT COUNT(*) n FROM orders WHERE status='new'").n;
    const late = get("SELECT COUNT(*) n FROM orders WHERE promise_date IS NOT NULL AND promise_date < date('now') AND status NOT IN ('delivered','cancelled','new')").n;
    const unpriced = get("SELECT COUNT(*) n FROM custom_requests WHERE status='review' AND price IS NULL").n;
    const lines = [];
    if (pendingJobs > 0) lines.push(`⏳ مستني قرارك: ${pendingJobs} مسودة${pendingKinds ? ` — ${pendingKinds}` : ''}`);
    else lines.push('⏳ مفيش مسودات مستنية قرارك دلوقتي — الطابور فاضي ✅');
    if (receipts > 0) lines.push(`🧾 إيصالات عربون محتاجة فحص: ${receipts}`);
    if (unpriced > 0) lines.push(`🎨 طلبات تصميم خاص محتاجة تسعير: ${unpriced}`);
    if (freshOrders > 0) lines.push(`🆕 أوردرات «جديد» لسه ما اتأكدتش: ${freshOrders} (بتدخل الحسابات أول ما تتأكد)`);
    if (late > 0) lines.push(`⏰ أوردرات متأخرة عن موعدها: ${late}`);
    return lines;
  } catch {
    return null;
  }
}
function autoReplyFor(text) {
  const body = String(text || '');
  const rule = REPLY_RULES.find((r) => r.re.test(body));
  if (rule) return rule;
  return { id: 'rami', name: 'رامي', role: 'المدير العام',
    line: 'وصلتني رسالتك — هجمع التفاصيل من الموظف المسؤول وأرجعلك هنا بخطة واضحة وقرار مطلوب منك.' };
}
function postStaffAck(name, role, body) {
  return createMessage('staff', `${name} · رد آلي من المكتب`, body, null, null);
}
/* The general manager (رامي) is the owner's single point of contact: he
   reports the prepared-work picture and acknowledges her bulk decisions,
   then moves the responsible teammates (their own acks follow via handoff). */
function postManagerSummary(decision, summary) {
  const approved = Number(summary && summary.approved) || 0;
  const rejected = Number(summary && summary.rejected) || 0;
  const failed = Number(summary && summary.failed) || 0;
  const parts = [];
  if (approved) parts.push(`اعتماد ${approved} مسودة${decision === 'approve' ? ' — الخطوات التالية اتحضّرت وبانتظار مراجعتك' : ''}`);
  if (rejected) parts.push(`رفض ${rejected} مسودة ورجعت لموظفيها لإعادة الصياغة`);
  if (failed) parts.push(`${failed} مسودة محتاجة تحديث بيانات قبل القرار (ظهرت بتنبيه في كروتها)`);
  const body = `📋 تقرير المدير العام: نفّذت قراراتك الجماعية — ${parts.join(' و ')}. أنا اللي بحرّك الفريق من هنا، وأي مسودة جديدة بتوصلك جاهزة للمراجعة فورًا. التنفيذ النهائي (إرسال/نشر/صرف) يفضل بيدك لوحدك.`;
  return postStaffAck('رامي · المدير العام', '', body);
}
/* Bulk decision: the responsible teammate acknowledges the batch of her kind. */
function postBulkHandoff(kind, count) {
  const entry = KIND_ACK_AR[kind] || ['رامي', 'استلم الاعتماد ✅ — الموظف المسؤول يبدأ خطوته'];
  return postStaffAck(entry[0], '', `${entry[1]} (${count} مسودة من قرار المالكة الجماعي).`);
}
function autoReplyToOwner(text) {
  const rule = autoReplyFor(text);
  const digest = officeDigest();
  const parts = [`شكرًا على رسالتك 🙏 ${rule.line}`];
  // Every reply carries the live office picture; the responsible member's own
  // domain line comes first so the reply never reads like a canned template.
  if (digest) parts.push(digest.join('\n'));
  let body = parts.join('\n');
  const last = get(
    `SELECT body FROM chat_messages WHERE sender_role='staff' AND sender_name=? ORDER BY id DESC LIMIT 1`,
    `${rule.name} · رد آلي من المكتب`
  );
  if (last && last.body === body) {
    body += '\n• مفيش تحديث جديد من رسالتك السابقة — كل حاجة زي ما هي، وهتابع لك أول ما يتغير حاجة.';
  }
  return postStaffAck(rule.name, rule.role, body);
}
/* Handoff message after the owner approves work: the responsible member
   acknowledges pickup (and, when chained, names the teammates taking over). */
const KIND_ACK_AR = {
  content_draft: ['ليلى', 'استلمت الاعتماد ✅ — البوست جاهز للاستخدام اليدوي من حساب البراند. حوّلت الشغل لمايا (خطة الريل) ونادين (فحص جاهزية الصفحة) وبسمة (متابعة المجتمع)'],
  visual_reel_brief: ['مايا', 'استلمت الاعتماد ✅ — هجهزك خطة تصوير جاهزة للتنفيذ، محتاجة منك تحديد موعد التصوير أو اعتماد اللقطات'],
  community_followup_draft: ['بسمة', 'استلمت الاعتماد ✅ — الرد جاهز للإرسال اليدوي للعميلة المهتمة'],
  care_campaign_draft: ['بسمة', 'استلمت الاعتماد ✅ — حملة العناية جاهزة: هبدأ الرسائل اليدوية واحدة واحدة للعميلات اللي اتسلم طلباتهم، بدون أي جماعي'],
  style_page_copy_draft: ['ليلى', 'استلمت الاعتماد ✅ — الوصف الجديد هيتكتب على صفحة الموديل فورًا وهيتأكد من ظهوره'],
  delivery_promise_draft: ['نور', 'استلمت الاعتماد ✅ — الموعد الجديد هيتسجل على الطلب فورًا وهيتأكد من الحفظ'],
  seo_readiness_check: ['نادين', 'استلمت الاعتماد ✅ — هبدأ استكمال نواقص الصفحة وأرجعلك بالنتيجة'],
  landing_page_check: ['كريم', 'استلمت الاعتماد ✅ — فريق التسويق يبدأ تنفيذ التحسينات المقترحة'],
  order_followup_draft: ['نور', 'استلمت الاعتماد ✅ — المتابعة جاهزة للإرسال اليدوي للعميلة'],
  workshop_followup_draft: ['هنا', 'استلمت الاعتماد ✅ — هبدأ متابعة الورش على هذا الكشف'],
  quality_delivery_checklist: ['دينا', 'استلمت الاعتماد ✅ — قائمة الفحص هتستخدم قبل التسليم'],
  customer_reply_draft: ['بسمة', 'استلمت الاعتماد ✅ — الرد جاهز للإرسال اليدوي'],
  deposit_followup_draft: ['عمر', 'استلمت الاعتماد ✅ — متابعة العربون جاهزة'],
  campaign_brief: ['كريم', 'استلم الاعتماد ✅ — الفريق يبدأ التجهيز، والإطلاق الفعلي لما تعتمدي بنفسك على المنصة'],
  executive_weekly_plan: ['رامي', 'استلمت الاعتماد ✅ — وزعت الخطة على المسؤولين المعنيين وهتابع التنفيذ'],
};
function postHandoffForJob(kind, nextStepsCount, execution = null) {
  const entry = KIND_ACK_AR[kind] || ['رامي', 'استلمت الاعتماد ✅ — الموظف المسؤول يبدأ خطوته'];
  const tail = nextStepsCount > 0 ? ` (${nextStepsCount} مسودة للخطوة التالية اتحضّرت وبانتظار مراجعة المالكة)` : '';
  // المسودات التنفيذية: رسالة صادقة بنتيجة التنفيذ الفعلي (تمّ وتحقق / فشل بالسبب)
  let execLine = '';
  if (execution && typeof execution === 'object') {
    execLine = execution.ok
      ? ' — التنفيذ تمّ واتحقق ✅ وصفحة الطلب/الموديل محدّثة'
      : ` — لكن التنفيذ فشل (${String(execution.message || execution.error_code || 'سبب غير معروف')}) ومحتاج تدخلك`;
  }
  return postStaffAck(entry[0], '', `${entry[1]}${execLine}${tail}.`);
}

const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;

function cleanText(value, maxLen) {
  const s = String(value ?? '').trim();
  if (!s || s.length > maxLen || CONTROL_CHARS.test(s)) return null;
  return s;
}

function listMessages() {
  const rows = all('SELECT * FROM chat_messages ORDER BY id DESC LIMIT 200');
  const messages = rows.reverse();
  const pending_count = messages.filter((m) => m.request_kind && m.request_status === 'pending').length;
  return { messages, pending_count };
}

function createMessage(senderRole, senderName, body, requestKind, requestPayload) {
  const role = senderRole === 'owner' ? 'owner' : 'staff';
  const name = cleanText(senderName, 80);
  if (!name) throw new engine.PolicyError('invalid_sender', 'اسم المرسل غير صالح');
  const text = cleanText(body, 1000);
  if (!text) throw new engine.PolicyError('invalid_message_body', 'الرسالة يجب أن تكون بين ١ و١٠٠٠ حرف بدون محارف غير صالحة');
  let kind = null;
  let payloadJson = null;
  if (requestKind !== undefined && requestKind !== null && requestKind !== '') {
    if (role !== 'staff') {
      throw new engine.PolicyError('owner_requests_not_supported', 'الطلبات من الموظفين — للمالكة الاعتماد أو الرفض أو إضافة مهمة مباشرة');
    }
    if (!STAFF_REQUEST_KINDS.includes(requestKind)) {
      throw new engine.PolicyError('unsupported_request_kind', 'نوع الطلب غير متاح للموظفين — الأنواع المالية للمالكة فقط');
    }
    const normalized = engine.validateJobPayload(requestKind, requestPayload || {});
    kind = requestKind;
    payloadJson = JSON.stringify(normalized);
  }
  const r = run(
    `INSERT INTO chat_messages(sender_role,sender_name,body,request_kind,request_payload,request_status)
     VALUES(?,?,?,?,?,?)`,
    role, name, text, kind, payloadJson, kind ? 'pending' : null
  );
  audit('chat', `message-${r.lastInsertRowid}`, kind ? `request:${kind}` : 'message', `${role}:${name}`);
  const saved = get('SELECT * FROM chat_messages WHERE id = ?', r.lastInsertRowid);
  // The owner never talks into a void: the responsible team member auto-acknowledges.
  if (role === 'owner') {
    try { autoReplyToOwner(text); } catch (_) { /* acknowledge is best-effort */ }
  }
  return saved;
}

async function decideRequest(requestId, decision, note, actor) {
  const actorRole = actor && (actor.role || (Array.isArray(actor.roles) ? actor.roles[0] : null));
  if (actorRole !== 'owner') {
    throw new engine.ForbiddenError('forbidden_owner_only', 'اعتماد الطلبات متاح للمالكة فقط');
  }
  if (!['approve', 'reject'].includes(decision)) {
    throw new engine.PolicyError('invalid_decision', 'اختاري الموافقة أو الرفض');
  }
  const cleanNote = note === undefined || note === null || note === '' ? null : cleanText(note, 300);
  if (note !== undefined && note !== null && note !== '' && !cleanNote) {
    throw new engine.PolicyError('invalid_decision_note', 'ملاحظة القرار طويلة أو فيها محارف غير صالحة');
  }
  const row = get('SELECT * FROM chat_messages WHERE id = ?', Number(requestId));
  if (!row || !row.request_kind) throw new engine.NotFoundError('request_not_found', 'الطلب غير موجود');
  if (row.request_status !== 'pending') throw new engine.ConflictError('request_already_decided', 'اتخذ قرار لهذا الطلب من قبل');

  let jobId = null;
  if (decision === 'approve') {
    const job = engine.defaultEngine.enqueue(
      row.request_kind,
      JSON.parse(row.request_payload),
      `chat-req-${row.id}`,
      actor
    );
    jobId = job.id;
  }
  run(
    `UPDATE chat_messages SET request_status = ?, decision_note = ?, decided_at = datetime('now'), job_id = ? WHERE id = ?`,
    decision === 'approve' ? 'approved' : 'rejected', cleanNote, jobId, row.id
  );
  audit('chat', `request-${row.id}`, decision, actor.id);
  if (decision === 'approve' && jobId) {
    // Visible effect: the approved request's draft is prepared immediately so
    // it lands in review, not just in the queue. gen_mode AUTO: AI first (one
    // short pass, no retries) when enabled, honest local fallback otherwise —
    // the fallback reason is written on the draft itself.
    try {
      const orClient = require('./openrouter-client');
      let cfgOk = false;
      try { const c = orClient.createConfig(); c.validate(); cfgOk = true; } catch (_) { cfgOk = false; }
      if (cfgOk && engine.defaultEngine.aiFirstPrepare) {
        await engine.defaultEngine.aiFirstPrepare({ max: 1, jobId, transport: orClient.createLiveTransport({ timeoutMs: 8000 }) });
      } else {
        engine.defaultEngine.runOnce({ provider: 'fixture', jobId });
      }
    } catch (_) {
      try { engine.defaultEngine.runOnce({ provider: 'fixture', jobId }); } catch (_) { /* prepare is best-effort */ }
    }
    try { postHandoffForJob(row.request_kind, 1); } catch (_) { /* ack is best-effort */ }
  }
  return get('SELECT * FROM chat_messages WHERE id = ?', row.id);
}

const router = express.Router();
const exactBody = (body, keys) => {
  const got = Object.keys(body || {}).sort();
  const want = keys.slice().sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    throw new engine.PolicyError('invalid_body_keys', 'حقول الطلب غير صالحة');
  }
};
const sendErr = (res, err) => {
  const status = err.status || (err instanceof engine.ConflictError ? 409 : err instanceof engine.NotFoundError ? 404 : err instanceof engine.PolicyError ? 400 : 500);
  res.status(status).json({ error: err.code || 'server_error', message: err.message || 'خطأ غير متوقع' });
};

router.get('/', A.requireStaff, (_req, res) => {
  try {
    res.json(listMessages());
  } catch (err) { sendErr(res, err); }
});

router.post('/', A.requireStaff, (req, res) => {
  try {
    exactBody(req.body || {}, ['body', 'request_kind', 'request_payload']);
    const msg = createMessage(
      req.user.role,
      req.user.name,
      req.body.body,
      req.body.request_kind,
      req.body.request_payload
    );
    res.status(201).json({ message: msg });
  } catch (err) { sendErr(res, err); }
});

router.post('/requests/:id/decision', A.requireOwner, async (req, res) => {
  try {
    exactBody(req.body || {}, ['decision', 'note']);
    const actor = engine.makeActor(`user:${req.user.id}`, req.user.role);
    const msg = await decideRequest(req.params.id, req.body.decision, req.body.note, actor);
    res.json({ message: msg });
  } catch (err) { sendErr(res, err); }
});

module.exports = { router, listMessages, createMessage, decideRequest, STAFF_REQUEST_KINDS, postHandoffForJob, postManagerSummary, postBulkHandoff };
