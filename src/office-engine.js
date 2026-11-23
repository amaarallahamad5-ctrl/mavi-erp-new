'use strict';
/* Durable SQLite draft & approval engine integrated into MAVI Express.
   - Actor is constructed strictly from verified server sessions (never client JSON).
   - Per-kind RBAC enforced on create, read, list, revise, audit, and review.
   - Staff never receive financial fields/figures in jobs, payloads, outputs, audit, or errors.
   - Drafts capture `subject_snapshot_hash` of authoritative MAVI order/catalogue facts and
     re-verify that exact hash inside the SAME `BEGIN IMMEDIATE` transaction on approval (409 on drift).
   - Default worker mode is `disabled`; `fixture` runs one synchronous local step only (`network_calls: 0`).
   - Approval records an audited decision ONLY — external publishing/spending/execution is always refused. */
const crypto = require('crypto');
const { db, get, all, run, audit: maviAudit } = require('./db');
const D = require('./domain');
const R = require('./deposit-rules');
const lifecycle = require('./order-lifecycle');
const { JOB_KINDS } = require('./office-team');

class PolicyError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
    this.status = 400;
  }
}

class ForbiddenError extends PolicyError {
  constructor(code, message) {
    super(code, message);
    this.status = 403;
  }
}

class NotFoundError extends PolicyError {
  constructor(code, message) {
    super(code, message);
    this.status = 404;
  }
}

class ConflictError extends PolicyError {
  constructor(code, message) {
    super(code, message);
    this.status = 409;
  }
}

const SYNTHETIC_CATALOGUE = Object.freeze({
  'DEMO-PUBLIC-01': Object.freeze({
    id: 'DEMO-PUBLIC-01',
    name: 'قطعة توضيحية لاختبار النظام',
    note: 'بيانات مصطنعة للاختبار فقط وليست عرض بيع حقيقيًا من MAVI.',
    active: true,
    type: 'made',
    synthetic: true,
    fabrics: ['خامة اختبار'],
    colours: ['كحلي'],
    sizes: [],
    lengths: [150],
  }),
});

db.exec(`
CREATE TABLE IF NOT EXISTS office_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('staff','owner')),
  subject_type TEXT NOT NULL CHECK(subject_type IN ('order','catalogue')),
  subject_ref TEXT NOT NULL,
  subject_snapshot_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','running','review','approved','rejected','failed')),
  revision INTEGER NOT NULL DEFAULT 1,
  input_revision INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until REAL,
  result TEXT,
  result_hash TEXT,
  created_by TEXT NOT NULL,
  reviewed_by TEXT,
  error_code TEXT,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_office_jobs_queue ON office_jobs(status, created_at ASC, id ASC);
CREATE INDEX IF NOT EXISTS idx_office_jobs_vis ON office_jobs(visibility, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS office_job_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES office_jobs(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_office_job_audit_job ON office_job_audit(job_id, id ASC);
`);

function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new PolicyError('non_finite_number', 'قيمة رقمية غير صالحة');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function digest(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function makeActor(id, role) {
  if (typeof id !== 'string' || !id.trim() || id.length > 80 || !['owner', 'staff', 'worker'].includes(role)) {
    throw new ForbiddenError('caller_not_permitted', 'صلاحية المتصل غير صالحة');
  }
  return Object.freeze({ id: id.trim(), role });
}

function actorFromRequest(req) {
  if (!req || !req.session || req.session.realm !== 'admin' || !req.user || !['owner', 'staff'].includes(req.user.role)) {
    throw new ForbiddenError('caller_not_permitted', 'يلزم تسجيل دخول الإدارة');
  }
  return makeActor(`user:${req.user.id}`, req.user.role);
}

const WORKER_ACTOR = makeActor('system:office-worker', 'worker');

function checkActorRoles(actor, allowedRoles, message) {
  if (!actor || typeof actor.id !== 'string' || !actor.id.trim() || !allowedRoles.includes(actor.role)) {
    throw new ForbiddenError('caller_not_permitted', message || 'غير مصرح بتنفيذ هذا الإجراء');
  }
}

function assertExactKeys(obj, expectedKeys) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new PolicyError('invalid_payload', 'بيانات المهمة غير صالحة');
  }
  const actual = Object.keys(obj).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((k, idx) => k !== expected[idx])) {
    throw new PolicyError('only_allowlisted_fields_supported', 'الحقول المرسلة غير مسموحة لهذا النوع من المهام');
  }
}

function validateIdempotencyKey(key) {
  if (typeof key !== 'string' || key.length < 1 || key.length > 100 || !/^[A-Za-z0-9_:-]+$/.test(key)) {
    throw new PolicyError('invalid_idempotency_key', 'مفتاح منع التكرار غير صالح');
  }
  return key;
}

function validateJobPayload(kind, payload) {
  const spec = JOB_KINDS[kind];
  if (!spec) throw new PolicyError('unsupported_job_kind', 'نوع المهمة غير مدعوم');

  if (kind === 'order_followup_draft') {
    assertExactKeys(payload, ['order_code', 'focus']);
    const code = String(payload.order_code || '').trim();
    if (!code || code.length > 40 || /[<>&"'`\\\x00-\x1f\x7f]/.test(code)) {
      throw new PolicyError('invalid_order_code', 'كود الطلب غير صالح');
    }
    if (!['measurements', 'schedule', 'status_update'].includes(payload.focus)) {
      throw new PolicyError('invalid_focus', 'حددي سبب المتابعة التشغيلية');
    }
    return { order_code: code, focus: payload.focus };
  }

  if (kind === 'workshop_followup_draft') {
    assertExactKeys(payload, ['order_code']);
    const code = String(payload.order_code || '').trim();
    if (!code || code.length > 40 || /[<>&"'`\\\x00-\x1f\x7f]/.test(code)) {
      throw new PolicyError('invalid_order_code', 'كود الطلب غير صالح');
    }
    return { order_code: code };
  }

  if (kind === 'deposit_followup_draft') {
    assertExactKeys(payload, ['order_code']);
    const code = String(payload.order_code || '').trim();
    if (!code || code.length > 40 || /[<>&"'`\\\x00-\x1f\x7f]/.test(code)) {
      throw new PolicyError('invalid_order_code', 'كود الطلب غير صالح');
    }
    return { order_code: code };
  }

  if (kind === 'content_draft') {
    assertExactKeys(payload, ['product_id', 'channel']);
    const pid = String(payload.product_id || '').trim();
    if (!/^[A-Z0-9_-]{1,30}$/.test(pid)) {
      throw new PolicyError('invalid_product_id', 'معرّف الموديل غير صالح');
    }
    if (!['instagram', 'facebook'].includes(payload.channel)) {
      throw new PolicyError('unsupported_channel', 'القناة غير مدعومة');
    }
    return { product_id: pid, channel: payload.channel };
  }

  if (kind === 'campaign_brief') {
    assertExactKeys(payload, ['product_id', 'channel', 'daily_budget_egp']);
    const pid = String(payload.product_id || '').trim();
    if (!/^[A-Z0-9_-]{1,30}$/.test(pid)) {
      throw new PolicyError('invalid_product_id', 'معرّف الموديل غير صالح');
    }
    if (!['instagram', 'facebook'].includes(payload.channel)) {
      throw new PolicyError('unsupported_channel', 'القناة غير مدعومة');
    }
    const budget = payload.daily_budget_egp;
    if (!Number.isInteger(budget) || budget < 1 || budget > 100) {
      throw new PolicyError('invalid_planning_budget', 'سقف يوم الإعلان التخطيطي يجب أن يكون عددًا صحيحًا ضمن الحد المسموح');
    }
    return { product_id: pid, channel: payload.channel, daily_budget_egp: budget };
  }

  throw new PolicyError('unsupported_job_kind', 'نوع المهمة غير مدعوم');
}

function readCatalogueFacts(productId, includePrice) {
  if (Object.prototype.hasOwnProperty.call(SYNTHETIC_CATALOGUE, productId)) {
    const demo = SYNTHETIC_CATALOGUE[productId];
    return {
      subject_type: 'catalogue',
      subject_ref: demo.id,
      approvable: true,
      facts: {
        id: demo.id,
        name: demo.name,
        note: demo.note,
        active: true,
        type: 'made',
        synthetic: true,
        fabrics: demo.fabrics,
        colours: demo.colours,
        sizes: demo.sizes,
        lengths: demo.lengths,
      },
    };
  }
  const style = get("SELECT id, name, type, price, sale_price, lead_days, note, active FROM styles WHERE id = ? AND id <> 'MANUAL-CUSTOM' AND id <> 'CUSTOM-DESIGN'", productId);
  if (!style) {
    throw new NotFoundError('product_not_found', 'الموديل غير موجود في الكتالوج');
  }
  const d = require('./tailoring-catalogue').detailsBatch([style.id]).get(style.id) || { fabrics: [], colours: [], sizes: [], lengths: [] };
  const fabrics = d.fabrics.slice();
  const colours = d.colours.map(r => r.name);
  const sizes = d.sizes.slice();
  const lengths = d.lengths.slice();
  const hashBasis = {
    id: style.id,
    name: style.name,
    type: style.type,
    active: !!style.active,
    lead_days: style.lead_days,
    note: style.note || '',
    effective_price: style.sale_price ?? style.price,
    fabrics,
    colours,
    sizes,
    lengths,
  };
  const safeFacts = {
    id: style.id,
    name: style.name,
    type: style.type,
    active: !!style.active,
    lead_days: style.lead_days,
    note: style.note || '',
    synthetic: false,
    fabrics,
    colours,
    sizes,
    lengths,
    ...(includePrice ? { effective_price: style.sale_price ?? style.price } : {}),
  };
  return {
    subject_type: 'catalogue',
    subject_ref: style.id,
    approvable: !!style.active && style.type === 'made',
    hash: digest(hashBasis),
    facts: safeFacts,
  };
}

function readOrderOperationalFacts(orderCode) {
  const o = D.orderByCode(orderCode);
  if (!o) throw new NotFoundError('order_not_found', 'الطلب غير موجود');
  const m = D.orderMeasurements(o) || {};
  const normalizedMeasurements = {
    bust: m.bust ?? null,
    waist: m.waist ?? null,
    hip: m.hip ?? null,
    shoulder: m.shoulder ?? null,
    length: m.length ?? null,
    sleeve: m.sleeve ?? null,
    arm: m.arm ?? null,
  };
  const assignedWorkshops = all('SELECT order_item_id, tailor_name FROM order_workshop_costs WHERE order_id = ? ORDER BY id ASC', o.id);
  const items = all(`
    SELECT oi.id, oi.style_id, oi.qty, oi.colour, oi.size, oi.length_cm,
           oi.fabric_choice, oi.item_note, oi.status, oi.tailor_id,
           t.name AS legacy_tailor_name,
           COALESCE(NULLIF(oi.description,''), s.name) AS style_name
    FROM order_items oi
    JOIN styles s ON s.id = oi.style_id
    LEFT JOIN tailors t ON t.id = oi.tailor_id
    WHERE oi.order_id = ? ORDER BY oi.id ASC
  `, o.id).map(i => ({
    id: i.id,
    style_id: i.style_id,
    style_name: i.style_name,
    qty: i.qty,
    colour: i.colour || null,
    size: i.size || null,
    length_cm: i.length_cm ?? null,
    fabric_choice: i.fabric_choice || null,
    item_note: i.item_note || null,
    status: i.status || 'normal',
    workshops: [...new Set([
      i.legacy_tailor_name,
      ...assignedWorkshops.filter(w => w.order_item_id === i.id).map(w => w.tailor_name),
    ].filter(Boolean))],
  }));
  const facts = {
    order_id: o.id,
    code: o.code,
    status: o.status,
    promise_date: o.promise_date || null,
    governorate: o.governorate || null,
    delivery_requested: !!o.delivery_requested,
    fabric_choice: o.fabric_choice || null,
    measurements: normalizedMeasurements,
    items,
  };
  return {
    order: o,
    subject_type: 'order',
    subject_ref: String(o.id),
    approvable: !['cancelled', 'delivered'].includes(o.status),
    hash: digest(facts),
    facts,
  };
}

function readOrderFinancialFacts(orderCode) {
  const base = readOrderOperationalFacts(orderCode);
  const o = base.order;
  const totals = D.orderTotals(o.id);
  const dep = get(
    'SELECT status, percent, payment_details, payment_method, receipt_revision, confirmed_payment_id, confirmed_amount, (receipt IS NOT NULL) AS has_receipt FROM order_deposits WHERE order_id = ?',
    o.id
  ) || null;
  const rule = R.orderRule(o.id, totals.total, dep);
  const finRev = lifecycle.financialRevision(o.id);
  const facts = {
    ...base.facts,
    shipping_quoted: !!o.shipping_quoted,
    delivery_fee: o.delivery_fee,
    discount: o.discount,
    totals: {
      subtotal: totals.subtotal,
      total: totals.total,
      paid: totals.paid,
      refunded: totals.refunded,
      due: totals.due,
    },
    deposit: dep ? {
      status: dep.status,
      percent: dep.percent,
      payment_details: dep.payment_details || '',
      receipt_revision: dep.receipt_revision || null,
      has_receipt: !!dep.has_receipt,
      confirmed_payment_id: dep.confirmed_payment_id ?? null,
      confirmed_amount: dep.confirmed_amount ?? null,
    } : null,
    deposit_rule: rule,
    financial_revision: finRev,
  };
  return {
    subject_type: 'order',
    subject_ref: String(o.id),
    approvable: !['cancelled', 'delivered'].includes(o.status),
    hash: digest(facts),
    facts,
  };
}

function computeSubjectSnapshot(kind, payload) {
  if (kind === 'order_followup_draft' || kind === 'workshop_followup_draft') {
    return readOrderOperationalFacts(payload.order_code);
  }
  if (kind === 'deposit_followup_draft') {
    return readOrderFinancialFacts(payload.order_code);
  }
  if (kind === 'content_draft') {
    const cat = readCatalogueFacts(payload.product_id, false);
    return { ...cat, hash: cat.hash || digest(cat.facts) };
  }
  if (kind === 'campaign_brief') {
    const cat = readCatalogueFacts(payload.product_id, true);
    return { ...cat, hash: cat.hash || digest(cat.facts) };
  }
  throw new PolicyError('unsupported_job_kind', 'نوع المهمة غير مدعوم');
}

function buildFixtureResult(jobRow, payload, snap) {
  const kind = jobRow.kind;
  const provenance = {
    mode: 'fixture',
    ai_generated: false,
    model: null,
    subject_type: snap.subject_type,
    subject_ref: snap.subject_ref,
    subject_snapshot_hash: snap.hash,
    job_input_revision: jobRow.input_revision,
  };

  if (kind === 'order_followup_draft') {
    const f = snap.facts;
    const missing = ['bust', 'waist', 'hip', 'length'].filter(k => {
      const v = Number(f.measurements[k]);
      return !Number.isFinite(v) || v < 20 || v > 250;
    });
    const itemSummary = f.items.map(i => `${i.style_name} (×${i.qty})`).join('، ');
    let text;
    if (payload.focus === 'measurements') {
      text = missing.length
        ? `مسودة متابعة استكمال مقاسات للطلب ${f.code} (${itemSummary}). الحقول الناقصة: ${missing.join('، ')}.`
        : `مقاسات التفصيل الأساسية مكتملة للطلب ${f.code} (${itemSummary})؛ يمكن تأكيد الجاهزية للقص.`;
    } else if (payload.focus === 'schedule') {
      text = f.promise_date
        ? `مسودة متابعة موعد التسليم المسجل (${f.promise_date}) للطلب ${f.code} في مرحلة ${f.status}.`
        : `الطلب ${f.code} في مرحلة ${f.status} ويحتاج تحديد موعد تسليم معتمد قبل مراسلة العميلة.`;
    } else {
      text = `مسودة تحديث حالة الطلب ${f.code} (${itemSummary}) — المرحلة المسجلة حاليًا: ${f.status}.`;
    }
    return {
      title: `مسودة متابعة تشغيلية — ${f.code}`,
      text,
      facts_used: [
        { label: 'رقم الطلب', value: String(f.code) },
        { label: 'المرحلة المسجلة', value: String(f.status) },
        { label: 'موعد التسليم المسجل', value: f.promise_date || 'غير محدد' },
        { label: 'القطع', value: itemSummary || '—' },
        { label: 'المقاسات الأساسية', value: missing.length ? `ناقص: ${missing.join('، ')}` : 'مكتملة' },
      ],
      review_checklist: [
        'التحقق من ملكية الطلب قبل أي تواصل يدوي',
        'عدم تقديم وعد بموعد تسليم جديد قبل اعتماد المالكة',
        'هذه مسودة اختبار محلية — لا يتم إرسال أي رسالة تلقائيًا',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'workshop_followup_draft') {
    const f = snap.facts;
    const lines = f.items.map(i => {
      const ws = i.workshops.length ? i.workshops.join(' / ') : 'غير مسندة بعد';
      return `${i.style_name} ×${i.qty} (الورشة: ${ws})`;
    }).join(' — ');
    return {
      title: `كشف متابعة ورشة تجريبي — ${f.code}`,
      text: `الطلب ${f.code} في مرحلة ${f.status}، الموعد المسجل: ${f.promise_date || 'غير محدد'}. القطع: ${lines}.`,
      facts_used: [
        { label: 'رقم الطلب', value: String(f.code) },
        { label: 'المرحلة المسجلة', value: String(f.status) },
        { label: 'موعد التسليم المسجل', value: f.promise_date || 'غير محدد' },
        { label: 'إسناد الورش', value: lines || '—' },
      ],
      review_checklist: [
        'تأكيد استلام الورشة للقطعة والمقاسات المسجلة',
        'الفحص الفعلي للجودة بشري قبل تحويل الحالة إلى جاهز',
        'لا يتضمن الكشف أي أجور أو تكاليف مالية',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'deposit_followup_draft') {
    const f = snap.facts;
    const depStatus = f.deposit?.status || 'none';
    const hasCustomPending = f.items.some(i => i.status === 'custom_pending');
    const reqAmt = f.deposit_rule?.amount ?? 0;
    let text;
    if (hasCustomPending || (f.delivery_requested && !f.shipping_quoted) || depStatus === 'needs_quote') {
      text = `الطلب ${f.code} يحتاج استكمال التسعير وعرض العربون أولًا قبل مطالبة العميلة بأي تحويل.`;
    } else if (depStatus === 'receipt_pending') {
      text = `يوجد إيصال عربون مرفوع للطلب ${f.code} بانتظار المراجعة؛ لا تطالبي العميلة بالدفع مجددًا قبل فحص الإيصال.`;
    } else {
      text = `متابعة مالية للطلب ${f.code}: الإجمالي ${f.totals.total} ج.م، العربون المطلوب ${reqAmt} ج.م، المدفوع المعتمد ${f.totals.paid} ج.م، المتبقي ${f.totals.due} ج.م.`;
    }
    return {
      title: `مسودة متابعة مالية (للمالكة) — ${f.code}`,
      text,
      facts_used: [
        { label: 'رقم الطلب', value: String(f.code) },
        { label: 'حالة العربون', value: String(depStatus) },
        { label: 'إجمالي الطلب', value: `${f.totals.total} ج.م` },
        { label: 'العربون المطلوب', value: `${reqAmt} ج.م` },
        { label: 'المدفوع المعتمد', value: `${f.totals.paid} ج.م` },
        { label: 'المتبقي', value: `${f.totals.due} ج.م` },
      ],
      review_checklist: [
        'مراجعة سجل الدفعات والمرتجعات قبل مراسلة العميلة',
        'صورة الإيصال لا تُعد دفعة معتمدة إلا بعد التأكيد من قسم العربون',
        'الاعتماد هنا يحفظ المسودة فقط ولا يسجل دفعة أو يرسل رسالة',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'content_draft') {
    const f = snap.facts;
    const fabricsText = f.fabrics.length ? `الخامات المسجلة: ${f.fabrics.join('، ')}.` : '';
    const coloursText = f.colours.length ? `الألوان المسجلة: ${f.colours.join('، ')}.` : '';
    return {
      title: `مسودة محتوى اختبار — ${f.name}`,
      text: `مسودة عرض على ${payload.channel} للموديل «${f.name}» (${f.id}). ${fabricsText} ${coloursText} للاختبار والمراجعة البشرية فقط دون نشر آلي.`.replace(/\s+/g, ' ').trim(),
      facts_used: [
        { label: 'كود الموديل', value: String(f.id) },
        { label: 'اسم الموديل', value: String(f.name) },
        { label: 'القناة', value: String(payload.channel) },
        { label: 'نوع العنصر', value: f.synthetic ? 'عنصر اختبار تجريبي' : 'موديل كتالوج معتمد' },
        { label: 'الخامات والألوان', value: [f.fabrics.join('، '), f.colours.join('، ')].filter(Boolean).join(' · ') || '—' },
      ],
      review_checklist: [
        'مطابقة الوصف والصور مع الكتالوج المعتمد',
        'عدم إضافة خصومات أو مواعيد تسليم غير معتمدة',
        'لا يوجد نشر تلقائي على أي منصة',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'campaign_brief') {
    const f = snap.facts;
    return {
      title: `موجز حملة تجريبي — ${f.name}`,
      text: `قناة التخطيط: ${payload.channel} للموديل «${f.name}» (${f.id}). سقف تخطيطي ${payload.daily_budget_egp} ج.م ليوم إعلان واحد في الإجازة؛ عدد الأيام والإطلاق يحتاجان قرارًا مستقلًا من المالكة.`,
      facts_used: [
        { label: 'كود الموديل', value: String(f.id) },
        { label: 'اسم الموديل', value: String(f.name) },
        { label: 'القناة', value: String(payload.channel) },
        { label: 'سقف الميزانية التخطيطي', value: `${payload.daily_budget_egp} ج.م / يوم` },
      ],
      review_checklist: [
        'التحقق من جاهزية التشغيل وصفحة الوصول قبل أي إعلان',
        'التأكد من تفعيل قياس التحويل بموافقة العميلة',
        'اعتماد المسودة لا يربط حساب إعلانات ولا يصرف أي مبلغ',
      ],
      provenance,
      external_actions: [],
    };
  }

  throw new PolicyError('unsupported_job_kind', 'نوع المهمة غير مدعوم');
}

class OfficeEngine {
  constructor(options = {}) {
    this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now() / 1000;
    this.leaseSeconds = Number.isInteger(options.leaseSeconds) && options.leaseSeconds >= 1 ? options.leaseSeconds : 60;
    this.maxAttempts = Number.isInteger(options.maxAttempts) && options.maxAttempts >= 1 ? options.maxAttempts : 3;
  }

  _assertKindAccess(actor, kind, mode) {
    const spec = JOB_KINDS[kind];
    if (!spec) throw new PolicyError('unsupported_job_kind', 'نوع المهمة غير مدعوم');
    if (actor.role === 'worker') return spec;
    const allowed = mode === 'create' ? spec.allowed_create_roles : spec.visibility_roles;
    if (!allowed.includes(actor.role)) {
      throw new ForbiddenError('forbidden_job_kind', 'هذه المهمة متاحة للمالكة فقط');
    }
    return spec;
  }

  _recordAudit(jobId, event, actor) {
    run(
      'INSERT INTO office_job_audit(job_id, event, actor_id, created_at) VALUES(?,?,?,?)',
      jobId, event, actor.id, this.clock()
    );
  }

  _publicRow(row) {
    if (!row) throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
    const payload = JSON.parse(row.payload);
    const result = row.result ? JSON.parse(row.result) : null;
    let subjectStale = false;
    try {
      const current = computeSubjectSnapshot(row.kind, payload);
      subjectStale = current.hash !== row.subject_snapshot_hash || !current.approvable;
    } catch (_) {
      subjectStale = true;
    }
    let subjectCode = row.subject_ref;
    if (row.subject_type === 'order') {
      const orderRow = get('SELECT code FROM orders WHERE id = ?', Number(row.subject_ref));
      subjectCode = (orderRow && orderRow.code) || (payload && payload.order_code) || null;
    }
    return {
      id: row.id,
      kind: row.kind,
      employee_id: row.employee_id,
      visibility: row.visibility,
      subject_type: row.subject_type,
      subject_ref: row.subject_ref,
      subject_code: subjectCode,
      subject_stale: subjectStale,
      payload,
      status: row.status,
      revision: row.revision,
      input_revision: row.input_revision,
      attempts: row.attempts,
      result,
      result_hash: row.result_hash || null,
      created_by: row.created_by,
      reviewed_by: row.reviewed_by || null,
      error_code: row.error_code || null,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  enqueue(kind, rawPayload, idempotencyKey, actor) {
    checkActorRoles(actor, ['owner', 'staff']);
    const spec = this._assertKindAccess(actor, kind, 'create');
    const cleanPayload = validateJobPayload(kind, rawPayload);
    const cleanKey = validateIdempotencyKey(idempotencyKey);
    const requestHash = digest({ kind, payload: cleanPayload });

    return db.transaction(() => {
      const existing = get('SELECT * FROM office_jobs WHERE idempotency_key = ?', cleanKey);
      if (existing) {
        this._assertKindAccess(actor, existing.kind, 'read');
        if (existing.request_hash !== requestHash) {
          throw new ConflictError('idempotency_key_reused_with_different_request', 'مفتاح العملية مستخدم سابقًا بمدخلات مختلفة');
        }
        return this._publicRow(existing);
      }

      const snap = computeSubjectSnapshot(kind, cleanPayload);
      if (!snap.approvable) {
        throw new ConflictError('subject_not_active', 'لا يمكن إنشاء مسودة لطلب ملغي/مسلّم أو موديل غير متاح');
      }

      const id = 'job-' + crypto.randomBytes(8).toString('hex');
      const now = this.clock();
      const visibility = spec.financial ? 'owner' : 'staff';
      run(
        `INSERT INTO office_jobs(
           id, idempotency_key, request_hash, kind, employee_id, visibility,
           subject_type, subject_ref, subject_snapshot_hash, payload, status,
           created_by, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`,
        id, cleanKey, requestHash, kind, spec.employee_id, visibility,
        snap.subject_type, snap.subject_ref, snap.hash, canonical(cleanPayload),
        actor.id, now, now
      );
      this._recordAudit(id, 'queued', actor);
      maviAudit('office_job', id, 'queued', actor.id, { kind, subject_type: snap.subject_type, subject_ref: snap.subject_ref });
      return this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', id));
    }).immediate();
  }

  get(id, actor) {
    checkActorRoles(actor, ['owner', 'staff', 'worker']);
    const row = get('SELECT * FROM office_jobs WHERE id = ?', String(id || ''));
    if (!row) throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
    this._assertKindAccess(actor, row.kind, 'read');
    return this._publicRow(row);
  }

  list(actor) {
    checkActorRoles(actor, ['owner', 'staff', 'worker']);
    const rows = actor.role === 'staff'
      ? all("SELECT * FROM office_jobs WHERE visibility = 'staff' ORDER BY created_at DESC, id DESC LIMIT 200")
      : all('SELECT * FROM office_jobs ORDER BY created_at DESC, id DESC LIMIT 200');
    return rows.map(r => this._publicRow(r));
  }

  getAudit(id, actor) {
    checkActorRoles(actor, ['owner', 'staff']);
    const row = get('SELECT * FROM office_jobs WHERE id = ?', String(id || ''));
    if (!row) throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
    this._assertKindAccess(actor, row.kind, 'read');
    return all('SELECT id, job_id, event, actor_id, created_at FROM office_job_audit WHERE job_id = ? ORDER BY id ASC', row.id);
  }

  claim(actor = WORKER_ACTOR, targetJobId = null) {
    checkActorRoles(actor, ['worker']);
    let cleanTargetId = null;
    if (targetJobId !== null && targetJobId !== undefined) {
      if (typeof targetJobId !== 'string' || !targetJobId.trim() || targetJobId.length > 80 || !/^[A-Za-z0-9_-]+$/.test(targetJobId.trim())) {
        throw new PolicyError('invalid_job_id', 'معرّف المهمة غير صالح');
      }
      cleanTargetId = targetJobId.trim();
    }
    return db.transaction(() => {
      const now = this.clock();
      const expired = all("SELECT * FROM office_jobs WHERE status = 'running' AND lease_until <= ?", now);
      for (const exp of expired) {
        const nextStatus = exp.attempts >= this.maxAttempts ? 'failed' : 'queued';
        run(
          `UPDATE office_jobs
           SET status = ?, lease_token = NULL, lease_until = NULL,
               error_code = 'lease_expired', revision = revision + 1, updated_at = ?
           WHERE id = ?`,
          nextStatus, now, exp.id
        );
        this._recordAudit(exp.id, 'expired_' + nextStatus, actor);
      }

      let job;
      if (cleanTargetId) {
        const existingTarget = get('SELECT * FROM office_jobs WHERE id = ?', cleanTargetId);
        if (!existingTarget) {
          throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
        }
        job = existingTarget.status === 'queued' ? existingTarget : null;
      } else {
        job = get("SELECT * FROM office_jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1");
      }
      if (!job) return null;

      const token = crypto.randomBytes(24).toString('hex');
      run(
        `UPDATE office_jobs
         SET status = 'running', attempts = attempts + 1, lease_token = ?, lease_until = ?,
             revision = revision + 1, error_code = NULL, updated_at = ?
         WHERE id = ?`,
        token, now + this.leaseSeconds, now, job.id
      );
      this._recordAudit(job.id, 'claimed', actor);
      return {
        job: this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', job.id)),
        token,
      };
    }).immediate();
  }

  _requireActiveLease(id, token) {
    const row = get('SELECT * FROM office_jobs WHERE id = ?', String(id || ''));
    if (!row || row.status !== 'running' || !token || row.lease_token !== token || row.lease_until <= this.clock()) {
      throw new ConflictError('stale_or_expired_worker_lease', 'انتهت صلاحية حجز العامل للمهمة');
    }
    return row;
  }

  completeFixture(id, token, actor = WORKER_ACTOR) {
    checkActorRoles(actor, ['worker']);
    return db.transaction(() => {
      const row = this._requireActiveLease(id, token);
      const payload = JSON.parse(row.payload);
      const snap = computeSubjectSnapshot(row.kind, payload);
      if (!snap.approvable) {
        throw new ConflictError('subject_not_active', 'تغيّرت حالة الطلب أو الموديل وأصبح غير متاح للمتابعة');
      }
      const result = buildFixtureResult(row, payload, snap);
      const resultJson = canonical(result);
      const resultHash = digest(result);
      const now = this.clock();
      run(
        `UPDATE office_jobs
         SET status = 'review', subject_snapshot_hash = ?, result = ?, result_hash = ?,
             lease_token = NULL, lease_until = NULL, revision = revision + 1, updated_at = ?
         WHERE id = ?`,
        snap.hash, resultJson, resultHash, now, row.id
      );
      this._recordAudit(row.id, 'fixture_ready_for_review', actor);
      return this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', row.id));
    }).immediate();
  }

  fail(id, token, errorCode = 'fixture_worker_failed', actor = WORKER_ACTOR) {
    checkActorRoles(actor, ['worker']);
    const safeCode = /^[a-z0-9_]{3,60}$/.test(String(errorCode || '')) ? errorCode : 'fixture_worker_failed';
    db.transaction(() => {
      this._requireActiveLease(id, token);
      run(
        `UPDATE office_jobs
         SET status = 'failed', error_code = ?, lease_token = NULL, lease_until = NULL,
             revision = revision + 1, updated_at = ?
         WHERE id = ?`,
        safeCode, this.clock(), id
      );
      this._recordAudit(id, 'failed', actor);
    }).immediate();
  }

  revise(id, rawPayload, expectedRevision, actor) {
    checkActorRoles(actor, ['owner', 'staff']);
    return db.transaction(() => {
      const row = get('SELECT * FROM office_jobs WHERE id = ?', String(id || ''));
      if (!row) throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
      this._assertKindAccess(actor, row.kind, 'create');
      if (!Number.isInteger(expectedRevision) || row.revision !== expectedRevision) {
        throw new ConflictError('stale_revision', 'تغيّرت نسخة المهمة؛ حدّثي الصفحة وراجعيها');
      }
      const cleanPayload = validateJobPayload(row.kind, rawPayload);
      const snap = computeSubjectSnapshot(row.kind, cleanPayload);
      if (!snap.approvable) {
        throw new ConflictError('subject_not_active', 'لا يمكن تعديل مسودة لطلب ملغي/مسلّم أو موديل غير متاح');
      }
      const now = this.clock();
      run(
        `UPDATE office_jobs
         SET payload = ?, subject_ref = ?, subject_snapshot_hash = ?, status = 'queued',
             input_revision = input_revision + 1, revision = revision + 1, attempts = 0,
             lease_token = NULL, lease_until = NULL, result = NULL, result_hash = NULL,
             reviewed_by = NULL, error_code = NULL, updated_at = ?
         WHERE id = ?`,
        canonical(cleanPayload), snap.subject_ref, snap.hash, now, row.id
      );
      this._recordAudit(row.id, 'revised_prior_output_and_approval_invalidated', actor);
      maviAudit('office_job', row.id, 'revised', actor.id, { kind: row.kind });
      return this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', row.id));
    }).immediate();
  }

  review(id, expectedRevision, expectedResultHash, decision, actor) {
    checkActorRoles(actor, ['owner'], 'اعتماد المسودات متاح للمالكة فقط');
    if (!['approve', 'reject'].includes(decision)) {
      throw new PolicyError('invalid_review_decision', 'اختاري الاعتماد أو الرفض');
    }

    return db.transaction(() => {
      const row = get('SELECT * FROM office_jobs WHERE id = ?', String(id || ''));
      if (!row) throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
      if (!Number.isInteger(expectedRevision) || row.revision !== expectedRevision || row.status !== 'review') {
        throw new ConflictError('stale_revision_or_not_awaiting_review', 'المهمة ليست بانتظار المراجعة على هذه النسخة');
      }
      if (
        typeof expectedResultHash !== 'string' ||
        !row.result ||
        !row.result_hash ||
        row.result_hash !== expectedResultHash ||
        digest(JSON.parse(row.result)) !== expectedResultHash
      ) {
        throw new ConflictError('output_changed', 'تغيّر محتوى المسودة؛ راجعي النسخة الحالية قبل القرار');
      }

      if (decision === 'approve') {
        let currentSnap;
        try {
          currentSnap = computeSubjectSnapshot(row.kind, JSON.parse(row.payload));
        } catch (err) {
          if (err instanceof NotFoundError) {
            throw new ConflictError('stale_subject_facts', 'حُذف السجل المرتبط بالمسودة ولا يمكن اعتمادها');
          }
          throw err;
        }
        if (!currentSnap.approvable || currentSnap.hash !== row.subject_snapshot_hash) {
          throw new ConflictError(
            'stale_subject_facts',
            'تغيّرت بيانات الطلب أو الموديل المؤثرة بعد تجهيز المسودة؛ أعيدي توليدها وراجعي البيانات المحدثة'
          );
        }
      }

      const nextStatus = decision === 'approve' ? 'approved' : 'rejected';
      const now = this.clock();
      run(
        'UPDATE office_jobs SET status = ?, reviewed_by = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
        nextStatus, actor.id, now, row.id
      );
      this._recordAudit(row.id, `draft_${nextStatus}_no_execution`, actor);
      maviAudit('office_job', row.id, `draft_${nextStatus}_no_execution`, actor.id, { kind: row.kind });
      return this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', row.id));
    }).immediate();
  }

  executeExternal() {
    throw new PolicyError('external_execution_not_implemented_and_disabled', 'التنفيذ والنشر والصرف الخارجي معطّل بالكامل');
  }

  runOnce(options = {}) {
    const actor = options.actor || WORKER_ACTOR;
    checkActorRoles(actor, ['worker']);
    const provider = options.provider === undefined
      ? (process.env.MAVI_OFFICE_PROVIDER || 'disabled')
      : options.provider;

    if (provider === 'disabled') {
      return { status: 'paused', reason: 'no_provider_enabled', network_calls: 0 };
    }
    if (provider !== 'fixture') {
      throw new PolicyError('provider_not_implemented_no_network_call_made', 'المزوّد غير مفعّل ولا يتم إجراء أي اتصال خارجي');
    }

    const targetJobId = options.jobId !== undefined ? options.jobId : null;
    const claimed = this.claim(actor, targetJobId);
    if (!claimed) {
      if (targetJobId !== null && targetJobId !== undefined) {
        const current = get('SELECT id, status FROM office_jobs WHERE id = ?', String(targetJobId).trim());
        return {
          status: 'idle',
          job_id: current ? current.id : String(targetJobId).trim(),
          job_status: current ? current.status : null,
          network_calls: 0,
        };
      }
      return { status: 'idle', network_calls: 0 };
    }
    try {
      const completed = this.completeFixture(claimed.job.id, claimed.token, actor);
      return {
        status: completed.status,
        job_id: completed.id,
        mode: 'fixture',
        ai_generated: false,
        network_calls: 0,
      };
    } catch (err) {
      if (err instanceof ConflictError && err.code === 'stale_or_expired_worker_lease') {
        throw err;
      }
      const code = err instanceof ConflictError && err.code === 'subject_not_active'
        ? 'subject_not_active'
        : 'fixture_worker_failed';
      this.fail(claimed.job.id, claimed.token, code, actor);
      return {
        status: 'failed',
        job_id: claimed.job.id,
        error_code: code,
        network_calls: 0,
      };
    }
  }
}

const defaultEngine = new OfficeEngine();

module.exports = {
  PolicyError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  SYNTHETIC_CATALOGUE,
  WORKER_ACTOR,
  canonical,
  digest,
  makeActor,
  actorFromRequest,
  computeSubjectSnapshot,
  OfficeEngine,
  defaultEngine,
};
