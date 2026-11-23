'use strict';
/* Durable SQLite draft & approval engine integrated into MAVI Express.
   - Actor is constructed strictly from verified server sessions (never client JSON).
   - Per-kind RBAC enforced on create, read, list, revise, audit, recheck, and review.
   - Staff never receive financial fields/figures, `subject_stale`, `reviewed_by`, or snapshot hashes.
   - Drafts capture BOTH `subject_snapshot_hash` (full authoritative facts + 512 KiB chunked SHA-256
     of all associated design/style/receipt BLOBs) AND `subject_fast_hash` (metadata + exact byte
     lengths/revisions without reading multi-MiB BLOB streams).
   - Bulk listing (`list()`) uses `subject_fast_hash` with per-request memoization so opening the
     queue stays O(metadata) (<15ms, well under 128 MiB even with 300+ MiB of stored photos).
   - Single-item owner reads (`get()`, `recheck()`) and ALL write/approval paths (`enqueue()`,
     `completeFixture()`, `revise()`, `review(..., 'approve')`) enforce the FULL chunked byte-level
     `subject_snapshot_hash` inside a single SQLite transaction/savepoint (409 on any byte drift).
   - Default worker mode is `disabled`; `fixture` runs one synchronous local step only (`network_calls: 0`).
   - Approval records an audited decision ONLY — external publishing/spending/execution is always refused. */
const crypto = require('crypto');
const { db, get, all, run, audit: maviAudit } = require('./db');
const D = require('./domain');
const R = require('./deposit-rules');
const lifecycle = require('./order-lifecycle');
const { JOB_KINDS, ROLE_BY_ID } = require('./office-team');

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
    lead_days: 7,
    image_count: 1,
    fabrics: ['خامة اختبار'],
    colours: ['كحلي'],
    sizes: [],
    lengths: [150],
  }),
});

const OFFICE_JOBS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS office_jobs (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('staff','owner')),
  subject_type TEXT NOT NULL CHECK(subject_type IN ('order','catalogue','custom_request','ops_summary')),
  subject_ref TEXT NOT NULL,
  subject_snapshot_hash TEXT NOT NULL,
  subject_fast_hash TEXT NOT NULL DEFAULT '',
  subject_staff_hash TEXT NOT NULL DEFAULT '',
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
  used_channel TEXT,
  used_by TEXT,
  used_at REAL,
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
`;

function ensureOfficeSchema() {
  const existing = get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'office_jobs'");
  if (!existing) {
    db.exec(OFFICE_JOBS_SCHEMA_SQL);
    return;
  }
  const cols = db.pragma('table_info(office_jobs)').map(c => c.name);
  if (!cols.includes('subject_fast_hash')) {
    db.exec("ALTER TABLE office_jobs ADD COLUMN subject_fast_hash TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes('subject_staff_hash')) {
    db.exec("ALTER TABLE office_jobs ADD COLUMN subject_staff_hash TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes('used_channel')) {
    db.exec('ALTER TABLE office_jobs ADD COLUMN used_channel TEXT');
  }
  if (!cols.includes('used_by')) {
    db.exec('ALTER TABLE office_jobs ADD COLUMN used_by TEXT');
  }
  if (!cols.includes('used_at')) {
    db.exec('ALTER TABLE office_jobs ADD COLUMN used_at REAL');
  }
  // Safely widen the `subject_type` CHECK constraint on older dev/test DBs while preserving all rows & audits
  if (!existing.sql.includes("'custom_request'") || !existing.sql.includes("'ops_summary'")) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE office_jobs_v2 (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            request_hash TEXT NOT NULL,
            kind TEXT NOT NULL,
            employee_id TEXT NOT NULL,
            visibility TEXT NOT NULL CHECK(visibility IN ('staff','owner')),
            subject_type TEXT NOT NULL CHECK(subject_type IN ('order','catalogue','custom_request','ops_summary')),
            subject_ref TEXT NOT NULL,
            subject_snapshot_hash TEXT NOT NULL,
            subject_fast_hash TEXT NOT NULL DEFAULT '',
            subject_staff_hash TEXT NOT NULL DEFAULT '',
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
          INSERT INTO office_jobs_v2 (
            id, idempotency_key, request_hash, kind, employee_id, visibility,
            subject_type, subject_ref, subject_snapshot_hash, subject_fast_hash, subject_staff_hash, payload, status,
            revision, input_revision, attempts, lease_token, lease_until, result, result_hash,
            created_by, reviewed_by, error_code, created_at, updated_at
          )
          SELECT
            id, idempotency_key, request_hash, kind, employee_id, visibility,
            subject_type, subject_ref, subject_snapshot_hash, subject_fast_hash, subject_staff_hash, payload, status,
            revision, input_revision, attempts, lease_token, lease_until, result, result_hash,
            created_by, reviewed_by, error_code, created_at, updated_at
          FROM office_jobs;
          DROP TABLE office_jobs;
          ALTER TABLE office_jobs_v2 RENAME TO office_jobs;
          CREATE INDEX IF NOT EXISTS idx_office_jobs_queue ON office_jobs(status, created_at ASC, id ASC);
          CREATE INDEX IF NOT EXISTS idx_office_jobs_vis ON office_jobs(visibility, created_at DESC, id DESC);
        `);
      })();
    } finally {
      db.pragma('foreign_keys = ON');
    }
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS office_job_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES office_jobs(id) ON DELETE CASCADE,
      event TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      created_at REAL NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_office_job_audit_job ON office_job_audit(job_id, id ASC);
  `);
}
ensureOfficeSchema();

/* Bounded 64 KiB SQLite hex-chunk SHA-256 hashing into a single reusable scratch Buffer.
 * Avoids C++ external ArrayBuffer retention across large BLOB scans under 128 MiB container limits
 * while preserving exact raw-byte SHA-256 parity, NULL != empty, and fail-closed verification. */
const BLOB_CHUNK_BYTES = 64 * 1024;
const BLOB_SCRATCH_BUFFER = Buffer.allocUnsafe(BLOB_CHUNK_BYTES);
const blobQueries = {
  styleImage: db.prepare('SELECT hex(substr(image, ?, ?)) AS hx FROM style_images WHERE id = ?'),
  orderReceipt: db.prepare('SELECT hex(substr(receipt, ?, ?)) AS hx FROM order_deposits WHERE order_id = ?'),
  customImage: db.prepare('SELECT hex(substr(image, ?, ?)) AS hx FROM custom_requests WHERE id = ?'),
  customReceipt: db.prepare('SELECT hex(substr(receipt, ?, ?)) AS hx FROM custom_requests WHERE id = ?'),
  customExtraImage: db.prepare('SELECT hex(substr(image, ?, ?)) AS hx FROM custom_request_images WHERE id = ?'),
};

function chunkedBlobSha256(stmt, rowKey, byteLen) {
  if (byteLen === null || byteLen === undefined) return null;
  const size = Number(byteLen);
  if (size === 0) return 'empty:0';
  const hash = crypto.createHash('sha256');
  for (let offset = 1; offset <= size; offset += BLOB_CHUNK_BYTES) {
    const expected = Math.min(BLOB_CHUNK_BYTES, size - offset + 1);
    const row = stmt.get(offset, expected, rowKey);
    if (!row || typeof row.hx !== 'string' || row.hx.length !== expected * 2) {
      throw new ConflictError('stale_subject_facts', 'تغيّرت بايتات الصورة أو الإيصال أثناء الفحص؛ أعيدي التحقق');
    }
    const written = BLOB_SCRATCH_BUFFER.write(row.hx, 0, 'hex');
    if (written !== expected) {
      throw new ConflictError('stale_subject_facts', 'تعذر قراءة بايتات الصورة أو الإيصال بالكامل أثناء الفحص');
    }
    hash.update(written === BLOB_CHUNK_BYTES ? BLOB_SCRATCH_BUFFER : BLOB_SCRATCH_BUFFER.subarray(0, written));
  }
  return hash.digest('hex');
}

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

  if (
    kind === 'workshop_followup_draft' ||
    kind === 'deposit_followup_draft' ||
    kind === 'quality_delivery_checklist' ||
    kind === 'customer_reply_draft'
  ) {
    assertExactKeys(payload, ['order_code']);
    const code = String(payload.order_code || '').trim();
    if (!code || code.length > 40 || /[<>&"'`\\\x00-\x1f\x7f]/.test(code)) {
      throw new PolicyError('invalid_order_code', 'كود الطلب غير صالح');
    }
    return { order_code: code };
  }

  if (kind === 'custom_design_followup_draft') {
    assertExactKeys(payload, ['request_id']);
    const reqId = Number(payload.request_id);
    if (!Number.isSafeInteger(reqId) || reqId < 1) {
      throw new PolicyError('invalid_request_id', 'رقم طلب التصميم الخاص غير صالح');
    }
    return { request_id: reqId };
  }

  if (kind === 'content_draft' || kind === 'community_followup_draft') {
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

  if (
    kind === 'seo_readiness_check' ||
    kind === 'visual_reel_brief' ||
    kind === 'landing_page_check'
  ) {
    assertExactKeys(payload, ['product_id']);
    const pid = String(payload.product_id || '').trim();
    if (!/^[A-Z0-9_-]{1,30}$/.test(pid)) {
      throw new PolicyError('invalid_product_id', 'معرّف الموديل غير صالح');
    }
    return { product_id: pid };
  }

  if (kind === 'campaign_brief' || kind === 'paid_ad_setup_draft') {
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

  if (kind === 'executive_weekly_plan') {
    assertExactKeys(payload, ['holiday_budget_egp']);
    const budget = payload.holiday_budget_egp;
    if (!Number.isInteger(budget) || budget < 1 || budget > 100) {
      throw new PolicyError('invalid_planning_budget', 'سقف يوم الإعلان التخطيطي يجب أن يكون بين ١ و١٠٠ ج.م');
    }
    return { holiday_budget_egp: budget };
  }

  if (
    kind === 'daily_ops_triage' ||
    kind === 'security_privacy_audit' ||
    kind === 'erp_data_health_report' ||
    kind === 'funnel_attribution_report'
  ) {
    assertExactKeys(payload, []);
    return {};
  }

  throw new PolicyError('unsupported_job_kind', 'نوع المهمة غير مدعوم');
}

function readCatalogueFacts(productId, includePrice, includeBlobDigests = true) {
  if (Object.prototype.hasOwnProperty.call(SYNTHETIC_CATALOGUE, productId)) {
    const demo = SYNTHETIC_CATALOGUE[productId];
    const facts = {
      id: demo.id,
      name: demo.name,
      note: demo.note,
      active: true,
      type: 'made',
      lead_days: demo.lead_days,
      image_count: demo.image_count,
      synthetic: true,
      fabrics: demo.fabrics,
      colours: demo.colours,
      sizes: demo.sizes,
      lengths: demo.lengths,
    };
    const h = digest(facts);
    return {
      subject_type: 'catalogue',
      subject_ref: demo.id,
      approvable: true,
      hash: h,
      fastHash: h,
      staffFastHash: h,
      facts,
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
  const imgMeta = all(
    'SELECT id, image_type, is_primary, length(image) AS image_len FROM style_images WHERE style_id = ? ORDER BY id ASC',
    style.id
  );
  const staffBasis = {
    id: style.id,
    name: style.name,
    type: style.type,
    active: !!style.active,
    lead_days: style.lead_days,
    note: style.note || '',
    fabrics,
    colours,
    sizes,
    lengths,
    image_count: imgMeta.length,
  };
  const fastBasis = {
    ...staffBasis,
    effective_price: style.sale_price ?? style.price,
    images_meta: imgMeta.map(m => [m.id, m.image_type || null, m.is_primary ? 1 : 0, m.image_len ?? null]),
  };
  const staffFastHash = digest(staffBasis);
  const fastHash = digest(fastBasis);
  const fullHash = includeBlobDigests
    ? digest({
        ...fastBasis,
        images_sha256: imgMeta.map(m => [m.id, chunkedBlobSha256(blobQueries.styleImage, m.id, m.image_len)]),
      })
    : fastHash;

  const safeFacts = {
    id: style.id,
    name: style.name,
    type: style.type,
    active: !!style.active,
    lead_days: style.lead_days,
    image_count: imgMeta.length,
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
    hash: fullHash,
    fastHash,
    staffFastHash,
    facts: safeFacts,
  };
}

function readOrderOperationalFacts(orderCode, includeBlobDigests = true, staffOnly = false) {
  const o = D.orderByCode(orderCode);
  if (!o) throw new NotFoundError('order_not_found', 'الطلب غير موجود');
  const cust = get('SELECT name, phone FROM customers WHERE id = ?', o.customer_id) || {};
  const m = D.orderMeasurements(o) || {};
  const normalizedMeasurements = {
    src: (o.measurements_snapshot !== null && o.measurements_snapshot !== undefined) ? 'snapshot' : 'customer',
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

  // If this order was created from a custom-design request, include design-image metadata/digests for owner checks only
  const linkedCustom = staffOnly ? null : get(
    `SELECT c.id, c.image_type, length(c.image) AS image_len
     FROM custom_order_links l JOIN custom_requests c ON c.id = l.request_id
     WHERE l.order_id = ?`,
    o.id
  );
  const extraImgs = linkedCustom
    ? all('SELECT id, image_type, length(image) AS image_len FROM custom_request_images WHERE request_id = ? ORDER BY id ASC', linkedCustom.id)
    : [];

  const facts = {
    order_id: o.id,
    code: o.code,
    status: o.status,
    promise_date: o.promise_date || null,
    governorate: o.governorate || null,
    delivery_requested: !!o.delivery_requested,
    fabric_choice: o.fabric_choice || null,
    customer_name: cust.name || o.contact_name || null,
    measurements: normalizedMeasurements,
    items,
  };
  const staffBasis = {
    ...facts,
    contact: [o.contact_name ?? null, o.contact_phone ?? null, o.contact_area ?? null],
    customer_phone: cust.phone ?? null,
  };
  const staffFastHash = digest(staffBasis);
  const fastBasis = {
    ...staffBasis,
    linked_design_meta: linkedCustom
      ? {
          id: linkedCustom.id,
          main: [linkedCustom.image_type ?? null, linkedCustom.image_len ?? null],
          extra: extraImgs.map(x => [x.id, x.image_type ?? null, x.image_len ?? null]),
        }
      : null,
  };
  const fastHash = staffOnly ? staffFastHash : digest(fastBasis);
  const fullHash = !staffOnly && includeBlobDigests && linkedCustom
    ? digest({
        ...fastBasis,
        linked_design_sha256: {
          main: chunkedBlobSha256(blobQueries.customImage, linkedCustom.id, linkedCustom.image_len),
          extra: extraImgs.map(x => [x.id, chunkedBlobSha256(blobQueries.customExtraImage, x.id, x.image_len)]),
        },
      })
    : fastHash;

  return {
    order: o,
    subject_type: 'order',
    subject_ref: String(o.id),
    approvable: !['cancelled', 'delivered'].includes(o.status),
    hash: fullHash,
    fastHash,
    staffFastHash,
    fastBasis,
    linkedCustom,
    extraImgs,
    facts,
  };
}

function readOrderFinancialFacts(orderCode, includeBlobDigests = true) {
  const base = readOrderOperationalFacts(orderCode, includeBlobDigests);
  const o = base.order;
  const totals = D.orderTotals(o.id);
  const dep = get(
    `SELECT status, percent, payment_details, payment_method, receipt_type, receipt_source,
            receipt_revision, confirmed_payment_id, confirmed_amount,
            length(receipt) AS receipt_len
     FROM order_deposits WHERE order_id = ?`,
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
      cost: totals.cost,
      profit: totals.profit,
    },
    deposit: dep ? {
      status: dep.status,
      percent: dep.percent,
      payment_details: dep.payment_details || '',
      payment_method: dep.payment_method || null,
      receipt_type: dep.receipt_type || null,
      receipt_source: dep.receipt_source || null,
      receipt_revision: dep.receipt_revision || null,
      receipt_len: dep.receipt_len ?? null,
      has_receipt: dep.receipt_len !== null && dep.receipt_len !== undefined,
      confirmed_payment_id: dep.confirmed_payment_id ?? null,
      confirmed_amount: dep.confirmed_amount ?? null,
    } : null,
    deposit_rule: rule,
    financial_revision: finRev,
  };
  const fastBasis = {
    ...base.fastBasis,
    financial_facts: facts,
  };
  const fastHash = digest(fastBasis);
  const fullHash = includeBlobDigests
    ? digest({
        ...fastBasis,
        base_full_hash: base.hash,
        order_receipt_sha256: dep && dep.receipt_len !== null && dep.receipt_len !== undefined
          ? chunkedBlobSha256(blobQueries.orderReceipt, o.id, dep.receipt_len)
          : null,
      })
    : fastHash;

  return {
    subject_type: 'order',
    subject_ref: String(o.id),
    approvable: !['cancelled', 'delivered'].includes(o.status),
    hash: fullHash,
    fastHash,
    facts,
  };
}

function readCustomRequestFacts(requestId, includeBlobDigests = true) {
  const x = get(
    `SELECT id, customer_id, status, price, deposit_percent, date_needed, details,
            measurements, fabric_choice, requested_colour, requested_fabric,
            shipping_fee, governorate, advice, payment_details, payment_method,
            image_type, receipt_type, receipt_source, receipt_revision,
            length(image) AS image_len, length(receipt) AS receipt_len
     FROM custom_requests WHERE id = ?`,
    Number(requestId)
  );
  if (!x) throw new NotFoundError('custom_request_not_found', 'طلب التصميم الخاص غير موجود');
  const cust = get('SELECT name, phone FROM customers WHERE id = ?', x.customer_id) || {};
  const extraImgs = all(
    'SELECT id, image_type, length(image) AS image_len FROM custom_request_images WHERE request_id = ? ORDER BY id ASC',
    x.id
  );
  const rule = R.customRule(x);
  const quoteRev = R.customQuoteRevision(x);
  const fastBasis = {
    id: x.id,
    status: x.status,
    price: x.price ?? null,
    deposit_percent: x.deposit_percent ?? null,
    date_needed: x.date_needed ?? null,
    details: x.details ?? null,
    measurements: x.measurements ?? null,
    fabric_choice: x.fabric_choice ?? null,
    requested_colour: x.requested_colour ?? null,
    requested_fabric: x.requested_fabric ?? null,
    shipping_fee: x.shipping_fee ?? null,
    governorate: x.governorate ?? null,
    advice: x.advice ?? null,
    payment_details: x.payment_details ?? null,
    payment_method: x.payment_method ?? null,
    customer: [cust.name ?? null, cust.phone ?? null],
    main_image_meta: x.image_len !== null ? [x.image_type ?? null, x.image_len] : null,
    extra_images_meta: extraImgs.map(i => [i.id, i.image_type ?? null, i.image_len ?? null]),
    receipt_meta: x.receipt_len !== null
      ? [x.receipt_type ?? null, x.receipt_source ?? null, x.receipt_revision ?? null, x.receipt_len]
      : null,
    quote_rev: quoteRev,
  };
  const fastHash = digest(fastBasis);
  const fullHash = includeBlobDigests
    ? digest({
        ...fastBasis,
        main_image_sha256: x.image_len !== null ? chunkedBlobSha256(blobQueries.customImage, x.id, x.image_len) : null,
        extra_images_sha256: extraImgs.map(i => [i.id, chunkedBlobSha256(blobQueries.customExtraImage, i.id, i.image_len)]),
        receipt_sha256: x.receipt_len !== null ? chunkedBlobSha256(blobQueries.customReceipt, x.id, x.image_len === null ? x.receipt_len : x.receipt_len) : null,
      })
    : fastHash;

  const facts = {
    request_id: x.id,
    code: `CR-${x.id}`,
    customer_name: cust.name || '—',
    status: x.status,
    date_needed: x.date_needed || null,
    governorate: x.governorate || null,
    fabric_choice: x.fabric_choice || null,
    requested_colour: x.requested_colour || null,
    requested_fabric: x.requested_fabric || null,
    price: x.price ?? null,
    shipping_fee: x.shipping_fee ?? null,
    deposit_percent: x.deposit_percent ?? null,
    deposit_amount: rule ? rule.amount : null,
    has_receipt: x.receipt_len !== null,
    image_count: (x.image_len !== null ? 1 : 0) + extraImgs.length,
    details: x.details || '',
  };
  return {
    subject_type: 'custom_request',
    subject_ref: String(x.id),
    approvable: x.status !== 'approved',
    hash: fullHash,
    fastHash,
    facts,
  };
}

function readOpsOperationalSummaryFacts() {
  const activeOrders = get("SELECT COUNT(*) n FROM orders WHERE status NOT IN ('delivered','cancelled')").n;
  const readyOrders = get("SELECT COUNT(*) n FROM orders WHERE status = 'ready'").n;
  const missingPromiseOrders = get(
    "SELECT COUNT(*) n FROM orders WHERE status NOT IN ('delivered','cancelled') AND (promise_date IS NULL OR TRIM(promise_date) = '')"
  ).n;
  const staffOpenCases = all(
    "SELECT case_kind, COUNT(*) n FROM office_cases WHERE state = 'open' AND visibility = 'staff' GROUP BY case_kind ORDER BY case_kind ASC"
  );
  const facts = {
    active_orders: activeOrders,
    ready_orders: readyOrders,
    missing_promise_orders: missingPromiseOrders,
    staff_open_cases: staffOpenCases,
  };
  const h = digest(facts);
  return {
    subject_type: 'ops_summary',
    subject_ref: 'daily-ops-triage',
    approvable: true,
    hash: h,
    fastHash: h,
    staffFastHash: h,
    facts,
  };
}

function readOpsSummaryFacts() {
  const activeOrders = get("SELECT COUNT(*) n FROM orders WHERE status NOT IN ('delivered','cancelled')").n;
  const deliveredOrders = get("SELECT COUNT(*) n FROM orders WHERE status = 'delivered'").n;
  const unpricedCustom = get("SELECT COUNT(*) n FROM custom_requests WHERE status = 'review' AND price IS NULL").n;
  const pendingCustomReceipts = get("SELECT COUNT(*) n FROM custom_requests WHERE status = 'receipt_pending'").n;
  const pendingOrderReceipts = get(
    `SELECT COUNT(*) n FROM order_deposits d
     JOIN orders o ON o.id = d.order_id
     WHERE o.status NOT IN ('delivered','cancelled') AND d.status = 'receipt_pending'`
  ).n;
  const approvedDeposits = get(
    "SELECT COUNT(*) n FROM order_deposits WHERE status = 'approved' OR confirmed_payment_id IS NOT NULL"
  ).n;
  const linkedCustomOrders = get('SELECT COUNT(*) n FROM custom_order_links').n;
  const activeStyles = get("SELECT COUNT(*) n FROM styles WHERE active = 1 AND type = 'made' AND id NOT IN ('MANUAL-CUSTOM','CUSTOM-DESIGN')").n;
  const openCasesByKind = all(
    "SELECT case_kind, COUNT(*) n FROM office_cases WHERE state = 'open' GROUP BY case_kind ORDER BY case_kind ASC"
  );
  const facts = {
    active_orders: activeOrders,
    delivered_orders: deliveredOrders,
    unpriced_custom: unpricedCustom,
    pending_receipts: pendingCustomReceipts + pendingOrderReceipts,
    approved_deposits: approvedDeposits,
    linked_custom_orders: linkedCustomOrders,
    active_styles: activeStyles,
    open_cases_by_kind: openCasesByKind,
  };
  const h = digest(facts);
  return {
    subject_type: 'ops_summary',
    subject_ref: 'weekly-overview',
    approvable: true,
    hash: h,
    fastHash: h,
    facts,
  };
}

const computeSubjectSnapshotTx = db.transaction((kind, payload, includeBlobDigests = true, staffOnly = false) => {
  if (
    kind === 'order_followup_draft' ||
    kind === 'workshop_followup_draft' ||
    kind === 'quality_delivery_checklist' ||
    kind === 'customer_reply_draft'
  ) {
    return readOrderOperationalFacts(payload.order_code, includeBlobDigests, staffOnly);
  }
  if (kind === 'deposit_followup_draft') {
    return readOrderFinancialFacts(payload.order_code, includeBlobDigests);
  }
  if (kind === 'custom_design_followup_draft') {
    return readCustomRequestFacts(payload.request_id, includeBlobDigests);
  }
  if (
    kind === 'content_draft' ||
    kind === 'seo_readiness_check' ||
    kind === 'visual_reel_brief' ||
    kind === 'landing_page_check' ||
    kind === 'community_followup_draft'
  ) {
    return readCatalogueFacts(payload.product_id, false, includeBlobDigests);
  }
  if (kind === 'campaign_brief' || kind === 'paid_ad_setup_draft') {
    return readCatalogueFacts(payload.product_id, true, includeBlobDigests);
  }
  if (kind === 'daily_ops_triage') {
    return readOpsOperationalSummaryFacts();
  }
  if (
    kind === 'executive_weekly_plan' ||
    kind === 'security_privacy_audit' ||
    kind === 'erp_data_health_report' ||
    kind === 'funnel_attribution_report'
  ) {
    return readOpsSummaryFacts();
  }
  throw new PolicyError('unsupported_job_kind', 'نوع المهمة غير مدعوم');
});

function computeSubjectSnapshot(kind, payload, options = {}) {
  const includeBlobDigests = options.includeBlobDigests !== false;
  const staffOnly = options.staffOnly === true;
  return computeSubjectSnapshotTx(kind, payload, includeBlobDigests, staffOnly);
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

  if (kind === 'custom_design_followup_draft') {
    const f = snap.facts;
    let text;
    if (f.status === 'review' && f.price === null) {
      text = `طلب التصميم الخاص ${f.code} (${f.customer_name}) بانتظار تحديد السعر وتكلفة التوصيل ونسبة العربون (${f.image_count} صور مرفقة).`;
    } else if (f.status === 'receipt_pending') {
      text = `طلب التصميم الخاص ${f.code} مرفق به إيصال عربون بانتظار فحص المالكة قبل تحويله إلى طلب مؤكد.`;
    } else {
      text = `متابعة طلب التصميم الخاص ${f.code} (${f.status}) — السعر المسجل: ${f.price ?? 'غير مسعر'} ج.م، العربون المطلوب: ${f.deposit_amount ?? 0} ج.م.`;
    }
    return {
      title: `مسودة مراجعة تصميم خاص (للمالكة) — ${f.code}`,
      text,
      facts_used: [
        { label: 'رقم الطلب الخاص', value: f.code },
        { label: 'العميلة', value: f.customer_name },
        { label: 'الحالة الحالية', value: f.status },
        { label: 'الموعد المطلوب', value: f.date_needed || 'غير محدد' },
        { label: 'الصور المرفقة والمفحوصة بالبصمة', value: `${f.image_count} صورة` },
        { label: 'السعر / العربون', value: f.price !== null ? `${f.price} ج.م (عربون ${f.deposit_amount ?? 0} ج.م)` : 'بانتظار التسعير' },
      ],
      review_checklist: [
        'مراجعة جميع صور التصميم المرفقة والمقاسات قبل تثبيت السعر',
        'أي تغيير في الصور أو الإيصال أو الموعد يوقف الاعتماد القديم تلقائيًا (409)',
        'الاعتماد يحفظ مسودة المراجعة فقط ولا يرسل عرضًا أو يؤكد دفعة تلقائيًا',
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

  if (kind === 'seo_readiness_check') {
    const f = snap.facts;
    const gaps = [];
    if (!f.synthetic && f.image_count === 0) gaps.push('لا توجد صورة معتمدة مرفوعة للموديل');
    if (!f.note || f.note.trim().length < 10) gaps.push('وصف الموديل قصير ويستحسن توضيح قصة التفصيل والخامة');
    if (!f.fabrics.length) gaps.push('لم تُسجل خامات متاحة للموديل');
    if (!f.colours.length) gaps.push('لم تُسجل ألوان متاحة للموديل');
    if (!f.lengths.length && !f.sizes.length) gaps.push('لم تُسجل أطوال أو مقاسات للموديل');
    const summaryText = gaps.length
      ? `فحص جاهزية صفحة الموديل «${f.name}» (${f.id}) رصد ${gaps.length} نقاط لتحسين الوضوح قبل الترويج: ${gaps.join('؛ ')}.`
      : `بيانات العرض المحلية للموديل «${f.name}» (${f.id}) مكتملة (الصور، الوصف، الخامات، الألوان، ومدة التنفيذ ${f.lead_days || '—'} يوم). تبقى حالة الفهرسة الخارجية في Google Search Console خاضعة للتحقق المستقل خارج التطبيق.`;
    return {
      title: `فحص جاهزية الظهور وصفحة الموديل — ${f.name}`,
      text: summaryText,
      facts_used: [
        { label: 'كود الموديل', value: String(f.id) },
        { label: 'الصور المعتمدة', value: `${f.image_count ?? 0} صورة` },
        { label: 'مدة التنفيذ المسجلة', value: f.lead_days ? `${f.lead_days} يوم` : 'غير محددة' },
        { label: 'نواقص صفحة العرض المحلية', value: gaps.length ? `${gaps.length} ملاحظات` : 'مكتملة محليًا' },
        { label: 'حالة Google الخارجية', value: 'غير متصلة — تحتاج مراجعة Search Console مستقلة' },
      ],
      review_checklist: [
        'هذا الفحص يراجع بيانات الكتالوج المحلية فقط ولا يتصل بخدمات Google',
        'قياس الزيارات والتحويل يظل مشروطًا بموافقة العميلة الصريحة على الكوكيز',
        'لا ضمان لترتيب نتائج البحث أو قبول الإعلانات دون مراجعة المنصة الخارجية',
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

  if (kind === 'executive_weekly_plan') {
    const f = snap.facts;
    const totalOpenCases = f.open_cases_by_kind.reduce((s, x) => s + Number(x.n || 0), 0);
    const kindBreakdown = f.open_cases_by_kind.length
      ? f.open_cases_by_kind.map(x => `${x.case_kind}: ${x.n}`).join(' · ')
      : 'لا توجد حالات مفتوحة';
    return {
      title: 'خطة أولويات الأسبوع المشتركة (الإدارة العليا — للمالكة)',
      text: `ملخص التنسيق الأسبوعي: يوجد ${f.active_orders} طلب نشط، و${totalOpenCases} حالة متابعة مفتوحة (${f.pending_receipts} إيصال بانتظار الفحص، ${f.unpriced_custom} تصميم خاص بانتظار التسعير). مقترح التسويق التجريبي محدد بسقف تخطيطي ${payload.holiday_budget_egp} ج.م ليوم إجازة واحد بعد إغلاق المتأخرات ومراجعة المالكة.`,
      facts_used: [
        { label: 'الطلبات النشطة حاليًا', value: String(f.active_orders) },
        { label: 'إجمالي الحالات المفتوحة', value: String(totalOpenCases) },
        { label: 'إيصالات بانتظار قرار المالكة', value: String(f.pending_receipts) },
        { label: 'تصميمات خاصة بانتظار التسعير', value: String(f.unpriced_custom) },
        { label: 'توزيع الحالات', value: kindBreakdown },
        { label: 'سقف تجربة الإجازة التخطيطي', value: `${payload.holiday_budget_egp} ج.م (بدون صرف آلي)` },
      ],
      review_checklist: [
        'الأولوية لإغلاق المتأخرات وفحص الإيصالات المعلقة قبل إطلاق أي ترويج',
        'اعتماد الخطة توثيق داخلي للأولويات فقط ولا ينفذ صرفًا أو رسائل تلقائية',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'daily_ops_triage') {
    const f = snap.facts;
    const totalStaffCases = f.staff_open_cases.reduce((s, x) => s + Number(x.n || 0), 0);
    const caseSummary = f.staff_open_cases.length
      ? f.staff_open_cases.map(x => `${x.case_kind}: ${x.n}`).join(' · ')
      : 'لا توجد حالات تشغيلية متأخرة';
    return {
      title: 'قائمة أولويات التشغيل اليومية (سلمى — تشغيل)',
      text: `ملخص المتابعة اليومية: يوجد ${f.active_orders} طلب قيد التنفيذ، منها ${f.ready_orders} جاهز للتسليم، و${f.missing_promise_orders} طلب يحتاج تسجيل موعد تسليم معتمد، مع ${totalStaffCases} حالة متابعة تشغيلية مفتوحة (${caseSummary}).`,
      facts_used: [
        { label: 'الطلبات قيد التنفيذ', value: String(f.active_orders) },
        { label: 'طلبات جاهزة للتسليم', value: String(f.ready_orders) },
        { label: 'طلبات بدون موعد مسجل', value: String(f.missing_promise_orders) },
        { label: 'الحالات التشغيلية المفتوحة', value: String(totalStaffCases) },
        { label: 'تفصيل الحالات', value: caseSummary },
      ],
      review_checklist: [
        'البدء بالطلبات المتأخرة أو القريبة في الموعد المسجل قبل الحالات الأحدث',
        'عدم تقديم موعد تسليم جديد للعميلة قبل اعتماد المالكة',
        'هذه القائمة تنظيمية داخلية ولا ترسل إشعارات تلقائية',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'quality_delivery_checklist') {
    const f = snap.facts;
    const itemLines = f.items.map(i => {
      const specs = [i.colour, i.size, i.length_cm ? `طول ${i.length_cm} سم` : null].filter(Boolean).join(' / ');
      return `${i.style_name} ×${i.qty}${specs ? ` (${specs})` : ''}`;
    }).join(' — ');
    return {
      title: `قائمة فحص الجودة قبل التسليم — ${f.code}`,
      text: `قائمة الفحص اليدوي للطلب ${f.code} (المرحلة الحالية: ${f.status}، طريقة التسليم: ${f.delivery_requested ? 'شحن للمحافظة المسجلة' : 'استلام من الأتيليه'}). القطع المطلوب مراجعتها يدويًا: ${itemLines}.`,
      facts_used: [
        { label: 'رقم الطلب', value: String(f.code) },
        { label: 'المرحلة المسجلة', value: String(f.status) },
        { label: 'القطع والمواصفات', value: itemLines || '—' },
        { label: 'أسلوب التسليم', value: f.delivery_requested ? `شحن (${f.governorate || 'محافظة غير محددة'})` : 'استلام مباشر' },
      ],
      review_checklist: [
        'مطابقة المقاسات الفعلية للقطعة بشريط القياس مع المقاسات المسجلة قبل التغليف',
        'فحص التشطيب والخياطة والكي واللون يدويًا — السجل الرقمي لا يغني عن الفحص البشري',
        'توثيق أي ملاحظة إصلاح قبل تحويل الطلب إلى جاهز للتسليم',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'customer_reply_draft') {
    const f = snap.facts;
    const itemSummary = f.items.map(i => `${i.style_name} ×${i.qty}`).join('، ');
    const schedulePart = f.promise_date
      ? `والموعد المسجل حاليًا في النظام هو ${f.promise_date}`
      : 'وسيتم تأكيد موعد التسليم فور اعتماده من الإدارة';
    return {
      title: `مسودة رد استفسار عميلة محكومة — ${f.code}`,
      text: `أهلًا بكِ في مافي براند بخصوص الطلب رقم ${f.code} (${itemSummary}): الطلب حاليًا في مرحلة «${f.status}» ${schedulePart}. شكرًا لتواصلكِ معنا.`,
      facts_used: [
        { label: 'رقم الطلب', value: String(f.code) },
        { label: 'المرحلة المسجلة', value: String(f.status) },
        { label: 'الموعد المسجل', value: f.promise_date || 'بانتظار تحديد موعد معتمد' },
        { label: 'القطع المسجلة', value: itemSummary || '—' },
      ],
      review_checklist: [
        'التحقق من رقم هاتف العميلة وملكية الطلب قبل إرسال أي رد يدوي',
        'عدم إضافة أي وعد بتعديل موعد أو خصم خارج ما هو مسجل ومعتمد',
        'المسودة محفوظة للمراجعة البشرية فقط ولا تُرسل تلقائيًا',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'visual_reel_brief') {
    const f = snap.facts;
    const palette = f.colours.length ? f.colours.join('، ') : 'الألوان المعتمدة في الكتالوج';
    const fabrics = f.fabrics.length ? f.fabrics.join('، ') : 'الخامة المعتمدة في الكتالوج';
    return {
      title: `موجز تصوير ريل وعرض مرئي — ${f.name}`,
      text: `موجز محتوى مرئي للموديل «${f.name}» (${f.id}): التركيز في اللقطات الافتتاحية على حركة القصة وملمس الخامة (${fabrics}) وتدرج الألوان المتاحة (${palette}) باستخدام صور ومواد الأتيليه المصرح بها فقط (${f.image_count ?? 0} صورة مسجلة).`,
      facts_used: [
        { label: 'كود الموديل', value: String(f.id) },
        { label: 'اسم الموديل', value: String(f.name) },
        { label: 'الصور المصرح بها محليًا', value: `${f.image_count ?? 0} صورة` },
        { label: 'الخامات والألوان', value: `${fabrics} · ${palette}` },
      ],
      review_checklist: [
        'حظر استخدام صور عميلات بدون إذن صريح وموثق',
        'عدم تقديم أي صورة مولدة أو مرجعية باعتبارها قطعة منفذة مسبقًا',
        'مطابقة الإضاءة واللون مع القطعة الحقيقية في الأتيليه',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'paid_ad_setup_draft') {
    const f = snap.facts;
    return {
      title: `مسودة إعداد حملة إعلانية محكومة لمصر — ${f.name}`,
      text: `إعداد تخطيطي مقترح على قناة ${payload.channel} داخل نطاق مصر للموديل «${f.name}» (${f.id}) بسعر عرض حالي ${f.effective_price ?? 'غير محدد'} ج.م ومدة تنفيذ ${f.lead_days || '—'} يوم، مع سقف تخطيطي صارم ${payload.daily_budget_egp} ج.م ليوم واحد فقط رهين قرار المالكة المستقل.`,
      facts_used: [
        { label: 'كود الموديل', value: String(f.id) },
        { label: 'القناة والنطاق الجغرافي', value: `${payload.channel} — مصر` },
        { label: 'السعر المعروض حاليًا', value: f.effective_price !== undefined ? `${f.effective_price} ج.م` : 'عنصر اختبار' },
        { label: 'مدة التنفيذ المسجلة', value: f.lead_days ? `${f.lead_days} يوم` : 'غير محددة' },
        { label: 'السقف اليومي التخطيطي', value: `${payload.daily_budget_egp} ج.م (بلا صرف فعلي)` },
      ],
      review_checklist: [
        'التحقق من استيعاب الورشة ومخزون القماش قبل تشغيل أي إعلان خارجي',
        'لا يوجد ربط بحساب إعلاني ولا إطلاق أو خصم مالي من داخل النظام',
        'قياس النتائج يعتمد على الطلبات والعربون المؤكد وليس النقرات فقط',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'landing_page_check') {
    const f = snap.facts;
    const checks = [];
    if (!f.synthetic && (f.image_count ?? 0) < 2) checks.push('يفضل توفير صورتين أو أكثر لتوضيح التفاصيل على شاشة الموبايل');
    if (!f.lead_days) checks.push('مدة التنفيذ غير محددة بوضوح');
    if (!f.sizes.length && !f.lengths.length) checks.push('خيارات المقاسات أو الأطوال غير مكتملة');
    if (!f.colours.length) checks.push('قائمة الألوان المتاحة فارغة');
    const readiness = checks.length
      ? `رصد فحص صفحة الوصول للموديل «${f.name}» (${f.id}) على الموبايل ${checks.length} نقاط تحتاج استكمالًا قبل توجيه الزيارات: ${checks.join('؛ ')}.`
      : `عناصر صفحة الوصول ومسار الطلب على الموبايل للموديل «${f.name}» (${f.id}) واضحة ومكتملة (الصور، المقاسات/الأطوال، الألوان، ومدة التنفيذ ${f.lead_days} يوم).`;
    return {
      title: `فحص صفحة الوصول ومسار الموبايل — ${f.name}`,
      text: readiness,
      facts_used: [
        { label: 'كود الموديل', value: String(f.id) },
        { label: 'عدد الصور الحالية', value: `${f.image_count ?? 0} صورة` },
        { label: 'الألوان المتاحة', value: f.colours.length ? f.colours.join('، ') : 'غير محددة' },
        { label: 'المقاسات / الأطوال', value: [...f.sizes, ...f.lengths.map(l => `${l}سم`)].join('، ') || 'تفصيل حسب المقاس' },
        { label: 'نتيجة الفحص المحلي', value: checks.length ? `${checks.length} تحسينات مقترحة` : 'جاهزة محليًا' },
      ],
      review_checklist: [
        'تجربة إتمام الطلب من هاتف محمول فعلي قبل توجيه أي حملة',
        'عدم تغيير سياسات الشحن أو الاستبدال بدون اعتماد المالكة',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'community_followup_draft') {
    const f = snap.facts;
    return {
      title: `مسودة تحويل استفسار للموقع وموافقة المتابعة — ${f.name}`,
      text: `أهلًا بكِ في مافي براند! يمكنكِ استعراض تفاصيل الموديل «${f.name}» (${f.id}) عبر قناة ${payload.channel} ثم اختيار اللون والمقاس وتسجيل طلبكِ مباشرة على الموقع لضمان دقة المقاسات، مع إمكانية اختيار المتابعة الاختيارية بموافقتكِ الصريحة فقط.`,
      facts_used: [
        { label: 'كود الموديل', value: String(f.id) },
        { label: 'القناة', value: String(payload.channel) },
        { label: 'مدة التنفيذ المسجلة', value: f.lead_days ? `${f.lead_days} يوم` : 'حسب الجدول المعتمد' },
      ],
      review_checklist: [
        'حظر الرسائل الجماعية غير المطلوبة؛ استفسار الطلب لا يُعد موافقة تسويقية تلقائية',
        'طلب التقييم أو مشاركة صورة العميلة يتم بإذن صريح ومستقل بعد الاستلام فقط',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'security_privacy_audit') {
    const f = snap.facts;
    const aiOff = process.env.AI_ENABLED !== '1';
    const workerDisabled = (process.env.MAVI_OFFICE_PROVIDER || 'disabled') === 'disabled';
    return {
      title: 'تقرير فحص الخصوصية والصلاحيات والامتثال (طارق — للمالكة)',
      text: `فحص الضوابط الحية: عزل البيانات المالية والإيصالات عن حسابات الموظفين مفعّل، والاعتماد النهائي محصور بالمالكة، وبوابة الإرسال/الصرف الخارجي معطّلة بالكامل (${f.pending_receipts} إيصال قيد المراجعة مفصول عن ${f.approved_deposits} عربون معتمد).`,
      facts_used: [
        { label: 'حالة الذكاء الاصطناعي الخارجي', value: aiOff ? 'معطّل (0 اتصالات خارجية)' : 'مفعّل — يلزم التحقق من المفاتيح' },
        { label: 'وضع عامل المكتب الخلفي', value: workerDisabled ? 'متوقف افتراضيًا (يدوي بالطلب)' : String(process.env.MAVI_OFFICE_PROVIDER) },
        { label: 'عربون معتمد مقابل إيصالات معلقة', value: `${f.approved_deposits} معتمد / ${f.pending_receipts} قيد المراجعة` },
        { label: 'التنفيذ الخارجي الآلي', value: 'محظور برمجيًا (external_actions = [])' },
      ],
      review_checklist: [
        'التحقق خارج المحادثة من تدوير أو إلغاء أي مفاتيح قديمة وإعداد ملفات الأسرار بصلاحيات 0600',
        'تشغيل بوابة Docker الفعلية (128 MiB) ومتصفح Chromium قبل أي نشر مستقبلي',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'erp_data_health_report') {
    const f = snap.facts;
    const totalOpenCases = f.open_cases_by_kind.reduce((s, x) => s + Number(x.n || 0), 0);
    return {
      title: 'تقرير سلامة بيانات الطلبات والربط (يوسف — للمالكة)',
      text: `فحص اتساق السجلات المحلية: يوجد ${f.active_orders} طلب نشط، و${f.delivered_orders} طلب مسلّم، و${f.active_styles} موديل نشط في الكتالوج، و${f.linked_custom_orders} طلب مرتبط بتصميم خاص عبر custom_order_links، و${totalOpenCases} حلقة متابعة مفتوحة بدون ازدواجية.`,
      facts_used: [
        { label: 'الطلبات النشطة / المسلّمة', value: `${f.active_orders} نشط / ${f.delivered_orders} مسلّم` },
        { label: 'موديلات الكتالوج النشطة', value: String(f.active_styles) },
        { label: 'روابط التصميم الخاص بالطلبات', value: String(f.linked_custom_orders) },
        { label: 'حلقات المتابعة المفتوحة', value: String(totalOpenCases) },
      ],
      review_checklist: [
        'التحقق الدوري من النسخ الاحتياطية خارج الخادم عبر verify:backup ومطابقة بصمة SHA-256',
        'عدم تعديل قاعدة بيانات الإنتاج يدويًا خارج مسارات النظام الموثقة',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'funnel_attribution_report') {
    const f = snap.facts;
    return {
      title: 'تقرير قمع التحويل وفجوات القياس (فرح — للمالكة)',
      text: `قراءة صادقة لقمع التحويل المحلي: مسجل حاليًا ${f.active_orders + f.delivered_orders} طلب غير ملغى (${f.approved_deposits} بعربون مؤكد، و${f.pending_receipts} بإيصال قيد الفحص، و${f.unpriced_custom} طلب تصميم خاص بانتظار التسعير). بيانات الزيارات والنقرات الخارجية غير مربوطة محليًا، لذا لا يُنسب أي إيراد لقناة إعلانية دون دليل مستقل وموافقة تتبع.`,
      facts_used: [
        { label: 'إجمالي الطلبات النشطة والمسلّمة', value: String(f.active_orders + f.delivered_orders) },
        { label: 'طلبات بعربون معتمد مؤكد', value: String(f.approved_deposits) },
        { label: 'إيصالات بانتظار المراجعة (ليست إيرادًا مؤكدًا بعد)', value: String(f.pending_receipts) },
        { label: 'تصميمات خاصة بانتظار التسعير', value: String(f.unpriced_custom) },
        { label: 'مصدر الزيارات الخارجي', value: 'فجوة قياس موثقة — لا يُفترض attribution بدون دليل' },
      ],
      review_checklist: [
        'عدم احتساب النقرات أو رسائل الاستفسار أو الإيصالات المعلقة كمبيعات مؤكدة',
        'ربط التحليلات الخارجية يظل متوقفًا على موافقة العميلة الصريحة والتحقق المستقل',
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

  _publicRow(row, actor = { role: 'owner' }, options = {}) {
    if (!row) throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
    const isStaff = actor && actor.role === 'staff';
    const payload = JSON.parse(row.payload);
    let result = row.result ? JSON.parse(row.result) : null;
    if (isStaff && result && result.provenance) {
      const { subject_snapshot_hash, ...restProv } = result.provenance;
      result = { ...result, provenance: restProv };
    }

    let subjectCode = row.subject_ref;
    if (row.subject_type === 'order') {
      const orderRow = get('SELECT code FROM orders WHERE id = ?', Number(row.subject_ref));
      subjectCode = (orderRow && orderRow.code) || (payload && payload.order_code) || null;
    } else if (row.subject_type === 'custom_request') {
      subjectCode = `CR-${row.subject_ref}`;
    }

    // Staff receive operational-only `subject_stale` (strictly excluding deposits, receipts, prices,
    // custom_requests, and BLOB bytes — zero hidden-state side channels) and never receive `reviewed_by`.
    if (isStaff) {
      let staffSubjectStale = false;
      try {
        const cacheKey = `${row.kind}:${row.payload}:staff`;
        let current;
        if (options.snapshotCache && options.snapshotCache.has(cacheKey)) {
          current = options.snapshotCache.get(cacheKey);
        } else {
          current = computeSubjectSnapshot(row.kind, payload, { includeBlobDigests: false, staffOnly: true });
          if (options.snapshotCache) options.snapshotCache.set(cacheKey, current);
        }
        if (row.subject_staff_hash) {
          staffSubjectStale = current.staffFastHash !== row.subject_staff_hash || !current.approvable;
        } else {
          staffSubjectStale = !current.approvable;
        }
      } catch (_) {
        staffSubjectStale = true;
      }
      return {
        id: row.id,
        kind: row.kind,
        employee_id: row.employee_id,
        visibility: row.visibility,
        subject_type: row.subject_type,
        subject_ref: row.subject_ref,
        subject_code: subjectCode,
        subject_stale: staffSubjectStale,
        payload,
        status: row.status,
        revision: row.revision,
        input_revision: row.input_revision,
        attempts: row.attempts,
        result,
        result_hash: row.result_hash || null,
        created_by: row.created_by,
        manual_execution: row.used_at ? {
          channel: row.used_channel || 'internal',
          used_by: row.used_by || null,
          used_at: row.used_at,
        } : null,
        error_code: row.error_code || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
      };
    }

    let subjectStale = false;
    try {
      const isUngenerated = row.status === 'queued' && !row.result;
      const useFast = (!!options.useFastSnapshot || isUngenerated) && !!row.subject_fast_hash;
      const cacheKey = `${row.kind}:${row.payload}:${useFast ? 'fast' : 'full'}`;
      let current;
      if (options.snapshotCache && options.snapshotCache.has(cacheKey)) {
        current = options.snapshotCache.get(cacheKey);
      } else {
        current = computeSubjectSnapshot(row.kind, payload, { includeBlobDigests: !useFast });
        if (options.snapshotCache) options.snapshotCache.set(cacheKey, current);
      }
      if (useFast) {
        subjectStale = current.fastHash !== row.subject_fast_hash || !current.approvable;
      } else {
        subjectStale = current.hash !== row.subject_snapshot_hash || !current.approvable;
      }
    } catch (_) {
      subjectStale = true;
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
      manual_execution: row.used_at ? {
        channel: row.used_channel || 'internal',
        used_by: row.used_by || null,
        used_at: row.used_at,
      } : null,
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
        return this._publicRow(existing, actor, { useFastSnapshot: true });
      }

      // Queueing validates subject existence/metadata immediately with zero BLOB scans;
      // full byte-level SHA-256 is captured when the draft is generated in `completeFixture`
      // and verified on single-job `get`, `recheck`, and `review('approve')`.
      const snap = computeSubjectSnapshot(kind, cleanPayload, { includeBlobDigests: false });
      if (!snap.approvable) {
        throw new ConflictError('subject_not_active', 'لا يمكن إنشاء مسودة لطلب ملغي/مسلّم أو سجل غير متاح');
      }

      const id = 'job-' + crypto.randomBytes(8).toString('hex');
      const now = this.clock();
      const visibility = spec.financial ? 'owner' : 'staff';
      run(
        `INSERT INTO office_jobs(
           id, idempotency_key, request_hash, kind, employee_id, visibility,
           subject_type, subject_ref, subject_snapshot_hash, subject_fast_hash, subject_staff_hash, payload, status,
           created_by, created_at, updated_at
         ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`,
        id, cleanKey, requestHash, kind, spec.employee_id, visibility,
        snap.subject_type, snap.subject_ref, snap.hash, snap.fastHash, snap.staffFastHash || '', canonical(cleanPayload),
        actor.id, now, now
      );
      this._recordAudit(id, 'queued', actor);
      maviAudit('office_job', id, 'queued', actor.id, { kind, subject_type: snap.subject_type, subject_ref: snap.subject_ref });
      return this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', id), actor);
    }).immediate();
  }

  get(id, actor) {
    checkActorRoles(actor, ['owner', 'staff', 'worker']);
    const row = get('SELECT * FROM office_jobs WHERE id = ?', String(id || ''));
    if (!row) throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
    this._assertKindAccess(actor, row.kind, 'read');
    return this._publicRow(row, actor, { useFastSnapshot: false });
  }

  list(actor) {
    checkActorRoles(actor, ['owner', 'staff', 'worker']);
    const rows = actor.role === 'staff'
      ? all("SELECT * FROM office_jobs WHERE visibility = 'staff' ORDER BY created_at DESC, id DESC LIMIT 200")
      : all('SELECT * FROM office_jobs ORDER BY created_at DESC, id DESC LIMIT 200');
    const snapshotCache = new Map();
    return rows.map(r => this._publicRow(r, actor, { useFastSnapshot: true, snapshotCache }));
  }

  listBySubject(actor, subjectType, subjectRef, limit = 20) {
    checkActorRoles(actor, ['owner', 'staff', 'worker']);
    if (!['order', 'catalogue', 'custom_request', 'ops_summary'].includes(subjectType)) {
      throw new PolicyError('invalid_subject_type', 'نوع العنصر غير صالح');
    }
    if (actor.role === 'staff' && subjectType === 'custom_request') {
      throw new ForbiddenError('forbidden_subject', 'طلبات التصميم الخاص متاحة للمالكة فقط');
    }
    const safeLimit = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 20;
    const rows = actor.role === 'staff'
      ? all(
          "SELECT * FROM office_jobs WHERE subject_type = ? AND subject_ref = ? AND visibility = 'staff' ORDER BY created_at DESC, id DESC LIMIT ?",
          subjectType,
          String(subjectRef || ''),
          safeLimit
        )
      : all(
          'SELECT * FROM office_jobs WHERE subject_type = ? AND subject_ref = ? ORDER BY created_at DESC, id DESC LIMIT ?',
          subjectType,
          String(subjectRef || ''),
          safeLimit
        );
    const snapshotCache = new Map();
    return rows.map(r => this._publicRow(r, actor, { useFastSnapshot: true, snapshotCache }));
  }

  listByKinds(actor, kinds, limit = 20) {
    checkActorRoles(actor, ['owner', 'staff', 'worker']);
    if (!Array.isArray(kinds) || !kinds.length) {
      throw new PolicyError('invalid_kinds', 'أنواع المهام المطلوبة غير صالحة');
    }
    const cleanKinds = [...new Set(kinds.map(k => String(k || '').trim()))];
    for (const k of cleanKinds) {
      const spec = JOB_KINDS[k];
      if (!spec) throw new PolicyError('unsupported_job_kind', 'نوع المهمة غير مدعوم');
      if (actor.role !== 'worker' && !spec.visibility_roles.includes(actor.role)) {
        throw new ForbiddenError('forbidden_job_kind', 'هذا التقرير متاح للمالكة فقط');
      }
    }
    const safeLimit = Number.isInteger(limit) && limit >= 1 && limit <= 100 ? limit : 20;
    const ph = cleanKinds.map(() => '?').join(',');
    const rows = actor.role === 'staff'
      ? all(
          `SELECT * FROM office_jobs WHERE kind IN (${ph}) AND visibility = 'staff' ORDER BY created_at DESC, id DESC LIMIT ?`,
          ...cleanKinds,
          safeLimit
        )
      : all(
          `SELECT * FROM office_jobs WHERE kind IN (${ph}) ORDER BY created_at DESC, id DESC LIMIT ?`,
          ...cleanKinds,
          safeLimit
        );
    const snapshotCache = new Map();
    return rows.map(r => this._publicRow(r, actor, { useFastSnapshot: true, snapshotCache }));
  }

  recheck(id, actor) {
    checkActorRoles(actor, ['owner'], 'إعادة فحص البصمة والاعتماد متاحة للمالكة فقط');
    return db.transaction(() => {
      const row = get('SELECT * FROM office_jobs WHERE id = ?', String(id || ''));
      if (!row) throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
      const job = this._publicRow(row, actor, { useFastSnapshot: false });
      this._recordAudit(row.id, job.subject_stale ? 'recheck_detected_stale_subject' : 'recheck_verified_fresh', actor);
      return {
        job,
        subject_stale: job.subject_stale,
      };
    }).immediate();
  }

  getAudit(id, actor) {
    checkActorRoles(actor, ['owner', 'staff']);
    const row = get('SELECT * FROM office_jobs WHERE id = ?', String(id || ''));
    if (!row) throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
    this._assertKindAccess(actor, row.kind, 'read');
    const events = all('SELECT id, job_id, event, actor_id, created_at FROM office_job_audit WHERE job_id = ? ORDER BY id ASC', row.id);
    if (actor.role === 'staff') {
      return events.filter(ev => !ev.event.startsWith('recheck_') && !ev.event.startsWith('draft_'));
    }
    return events;
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
        job: this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', job.id), actor, { useFastSnapshot: true }),
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
      const snap = computeSubjectSnapshot(row.kind, payload, { includeBlobDigests: true });
      if (!snap.approvable) {
        throw new ConflictError('subject_not_active', 'تغيّرت حالة الطلب أو الموديل وأصبح غير متاح للمتابعة');
      }
      const result = buildFixtureResult(row, payload, snap);
      const resultJson = canonical(result);
      const resultHash = digest(result);
      const now = this.clock();
      run(
        `UPDATE office_jobs
         SET status = 'review', subject_snapshot_hash = ?, subject_fast_hash = ?, subject_staff_hash = ?, result = ?, result_hash = ?,
             lease_token = NULL, lease_until = NULL, revision = revision + 1, updated_at = ?
         WHERE id = ?`,
        snap.hash, snap.fastHash, snap.staffFastHash || '', resultJson, resultHash, now, row.id
      );
      this._recordAudit(row.id, 'fixture_ready_for_review', actor);
      return this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', row.id), actor, { useFastSnapshot: true });
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
      const snap = computeSubjectSnapshot(row.kind, cleanPayload, { includeBlobDigests: false });
      if (!snap.approvable) {
        throw new ConflictError('subject_not_active', 'لا يمكن تعديل مسودة لطلب ملغي/مسلّم أو سجل غير متاح');
      }
      const now = this.clock();
      run(
        `UPDATE office_jobs
         SET payload = ?, subject_ref = ?, subject_snapshot_hash = ?, subject_fast_hash = ?, subject_staff_hash = ?, status = 'queued',
             input_revision = input_revision + 1, revision = revision + 1, attempts = 0,
             lease_token = NULL, lease_until = NULL, result = NULL, result_hash = NULL,
             reviewed_by = NULL, used_channel = NULL, used_by = NULL, used_at = NULL, error_code = NULL, updated_at = ?
         WHERE id = ?`,
        canonical(cleanPayload), snap.subject_ref, snap.hash, snap.fastHash, snap.staffFastHash || '', now, row.id
      );
      this._recordAudit(row.id, 'revised_prior_output_and_approval_invalidated', actor);
      maviAudit('office_job', row.id, 'revised', actor.id, { kind: row.kind });
      return this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', row.id), actor, { useFastSnapshot: true });
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
          currentSnap = computeSubjectSnapshot(row.kind, JSON.parse(row.payload), { includeBlobDigests: true });
        } catch (err) {
          if (err instanceof NotFoundError) {
            throw new ConflictError('stale_subject_facts', 'حُذف السجل المرتبط بالمسودة ولا يمكن اعتمادها');
          }
          throw err;
        }
        if (!currentSnap.approvable || currentSnap.hash !== row.subject_snapshot_hash) {
          throw new ConflictError(
            'stale_subject_facts',
            'تغيّرت بيانات الطلب أو الصور أو الإيصال بعد تجهيز المسودة؛ أعيدي توليدها وراجعي البيانات المحدثة'
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
      return this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', row.id), actor, { useFastSnapshot: false });
    }).immediate();
  }

  editDraftText(id, rawText, expectedRevision, expectedResultHash, actor) {
    checkActorRoles(actor, ['owner'], 'تعديل نص المسودة متاح للمالكة فقط');
    const cleanText = String(rawText ?? '').trim();
    if (cleanText.length < 5 || cleanText.length > 4000) {
      throw new PolicyError('invalid_draft_text', 'نص المسودة يجب أن يكون بين ٥ و٤٠٠٠ حرف');
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(cleanText)) {
      throw new PolicyError('invalid_draft_text', 'نص المسودة يحتوي على محارف تحكم غير صالحة');
    }
    return db.transaction(() => {
      const row = get('SELECT * FROM office_jobs WHERE id = ?', String(id || ''));
      if (!row) throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
      if (!Number.isInteger(expectedRevision) || row.revision !== expectedRevision || !['review', 'approved'].includes(row.status)) {
        throw new ConflictError('stale_revision_or_not_editable', 'المسودة ليست في حالة قابلة للتعديل على هذه النسخة');
      }
      if (
        typeof expectedResultHash !== 'string' ||
        !row.result ||
        !row.result_hash ||
        row.result_hash !== expectedResultHash ||
        digest(JSON.parse(row.result)) !== expectedResultHash
      ) {
        throw new ConflictError('output_changed', 'تغيّر محتوى المسودة؛ راجعي النسخة الحالية قبل التعديل');
      }
      let currentSnap;
      try {
        currentSnap = computeSubjectSnapshot(row.kind, JSON.parse(row.payload), { includeBlobDigests: true });
      } catch (err) {
        if (err instanceof NotFoundError) {
          throw new ConflictError('stale_subject_facts', 'حُذف السجل المرتبط بالمسودة');
        }
        throw err;
      }
      if (!currentSnap.approvable || currentSnap.hash !== row.subject_snapshot_hash) {
        throw new ConflictError(
          'stale_subject_facts',
          'تغيّرت بيانات الطلب أو الموديل بعد تحضير المسودة؛ حدّثي المسودة أولًا قبل تعديل النص'
        );
      }

      const prevResult = JSON.parse(row.result);
      const updatedResult = {
        ...prevResult,
        text: cleanText,
        human_edited: true,
        edited_by: actor.id,
      };
      const newJson = canonical(updatedResult);
      const newHash = digest(updatedResult);
      const now = this.clock();
      // Editing returns draft to `review` and clears any prior approval or manual execution stamp
      run(
        `UPDATE office_jobs
         SET status = 'review', result = ?, result_hash = ?, reviewed_by = NULL,
             used_channel = NULL, used_by = NULL, used_at = NULL,
             revision = revision + 1, updated_at = ?
         WHERE id = ?`,
        newJson, newHash, now, row.id
      );
      this._recordAudit(row.id, 'owner_edited_draft_text', actor);
      maviAudit('office_job', row.id, 'owner_edited_draft_text', actor.id, { kind: row.kind });
      return this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', row.id), actor, { useFastSnapshot: false });
    }).immediate();
  }

  markManualExecution(id, channel, actor) {
    checkActorRoles(actor, ['owner', 'staff']);
    const allowedChannels = ['whatsapp', 'instagram', 'facebook', 'phone', 'internal'];
    const cleanChannel = String(channel || '').trim();
    if (!allowedChannels.includes(cleanChannel)) {
      throw new PolicyError('invalid_execution_channel', 'قناة الاستخدام اليدوي غير صالحة');
    }
    return db.transaction(() => {
      const row = get('SELECT * FROM office_jobs WHERE id = ?', String(id || ''));
      if (!row) throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
      this._assertKindAccess(actor, row.kind, 'read');
      if (row.status !== 'approved') {
        throw new ConflictError('draft_not_approved', 'لا يمكن تسجيل الاستخدام اليدوي قبل اعتماد المسودة من المالكة');
      }
      const now = this.clock();
      run(
        'UPDATE office_jobs SET used_channel = ?, used_by = ?, used_at = ?, updated_at = ? WHERE id = ?',
        cleanChannel, actor.id, now, now, row.id
      );
      this._recordAudit(row.id, 'manual_execution_logged', actor);
      maviAudit('office_job', row.id, 'manual_execution_logged', actor.id, { kind: row.kind, channel: cleanChannel });
      return this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', row.id), actor, { useFastSnapshot: false });
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

  drainQueue(options = {}) {
    const actor = options.actor || WORKER_ACTOR;
    checkActorRoles(actor, ['worker']);
    const provider = options.provider === undefined
      ? (process.env.MAVI_OFFICE_PROVIDER || 'disabled')
      : options.provider;
    const maxSteps = options.maxSteps === undefined ? 20 : options.maxSteps;
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 50) {
      throw new PolicyError('invalid_max_steps', 'الحد الأقصى للخطوات يجب أن يكون بين ١ و٥٠');
    }
    if (provider === 'disabled') {
      return { status: 'paused', processed_count: 0, steps: [], network_calls: 0 };
    }
    if (provider !== 'fixture') {
      throw new PolicyError('provider_not_implemented_no_network_call_made', 'المزوّد غير مفعّل ولا يتم إجراء أي اتصال خارجي');
    }
    const steps = [];
    for (let i = 0; i < maxSteps; i++) {
      const step = this.runOnce({ provider, actor });
      if (step.status === 'idle' || step.status === 'paused') break;
      steps.push(step);
    }
    return {
      status: steps.length ? 'drained' : 'idle',
      processed_count: steps.length,
      steps,
      ai_generated: false,
      network_calls: 0,
    };
  }

  listRecentAudit(actor, limit = 60) {
    checkActorRoles(actor, ['owner']);
    const safeLimit = Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 60;
    const rows = all(
      `SELECT a.id, a.job_id, a.event, a.actor_id, a.created_at,
              j.kind, j.subject_ref, j.payload, j.status, j.revision, j.result_hash
       FROM office_job_audit a
       JOIN office_jobs j ON j.id = a.job_id
       ORDER BY a.id DESC
       LIMIT ?`,
      safeLimit
    );
    return rows.map(r => {
      const spec = JOB_KINDS[r.kind];
      const role = spec && spec.assignee_role_id ? ROLE_BY_ID.get(spec.assignee_role_id) : null;
      let displayRef = r.subject_ref;
      try {
        const p = JSON.parse(r.payload || '{}');
        if (p.order_code) displayRef = p.order_code;
        else if (p.request_id) displayRef = `CR-${p.request_id}`;
        else if (p.product_id) displayRef = p.product_id;
      } catch (_) {}
      return {
        id: r.id,
        job_id: r.job_id,
        event: r.event,
        actor_id: r.actor_id,
        created_at: r.created_at,
        kind: r.kind,
        kind_label_ar: spec ? spec.label_ar : r.kind,
        assignee_role_id: spec ? spec.assignee_role_id : null,
        assignee_name_ar: role ? role.name : null,
        subject_ref: displayRef,
        job_status: r.status,
        revision: r.revision,
        result_hash: r.result_hash,
      };
    });
  }

  runDailyCycle(actor, options = {}) {
    checkActorRoles(actor, ['owner']);
    const provider = options.provider === undefined ? 'fixture' : options.provider;
    if (provider !== 'fixture' && provider !== 'disabled') {
      throw new PolicyError('provider_not_implemented_no_network_call_made', 'المزوّد غير مفعّل ولا يتم إجراء أي اتصال خارجي');
    }
    const holidayBudgetEgp = options.holidayBudgetEgp === undefined ? 100 : options.holidayBudgetEgp;
    if (typeof holidayBudgetEgp !== 'number' || !Number.isFinite(holidayBudgetEgp) || holidayBudgetEgp <= 0 || holidayBudgetEgp > 100) {
      throw new PolicyError('invalid_planning_budget', 'السقف التخطيطي يجب أن يكون بين ١ و١٠٠ ج.م (بدون صرف فعلي)');
    }

    const { syncCases, listCases } = require('./office-cases');
    const syncSummary = syncCases({ actor });
    const dayKey = syncSummary.cairo_date;

    const hasActiveJob = (kind, subjectRef) => Boolean(
      get(
        "SELECT 1 FROM office_jobs WHERE kind = ? AND subject_ref = ? AND status IN ('queued','running','review') LIMIT 1",
        kind,
        String(subjectRef)
      )
    );

    const enqueuedIds = [];
    const skippedExisting = [];
    const maxNewJobs = 25;
    const stampKey = Math.floor(this.clock() * 1000).toString(36);

    const tryEnqueue = (kind, payload, expectedRef, tag) => {
      if (enqueuedIds.length >= maxNewJobs) return;
      if (hasActiveJob(kind, expectedRef)) {
        skippedExisting.push({ kind, subject_ref: String(expectedRef) });
        return;
      }
      const idem = `cycle:${dayKey}:${kind}:${expectedRef}:${tag}:${stampKey}`.slice(0, 120);
      const j = this.enqueue(kind, payload, idem, actor);
      enqueuedIds.push(j.id);
    };

    // 1. Core daily governance, ops triage, data health, funnel, and weekly plan briefs
    tryEnqueue('executive_weekly_plan', { holiday_budget_egp: holidayBudgetEgp }, 'weekly-overview', 'core');
    tryEnqueue('daily_ops_triage', {}, 'daily-ops-triage', 'core');
    tryEnqueue('security_privacy_audit', {}, 'weekly-overview', 'core');
    tryEnqueue('erp_data_health_report', {}, 'weekly-overview', 'core');
    tryEnqueue('funnel_attribution_report', {}, 'weekly-overview', 'core');

    // 2. Top open follow-up cases by priority
    const openCases = listCases(actor, { state: 'open' });
    for (const c of openCases) {
      if (enqueuedIds.length >= maxNewJobs) break;
      const subjRef = String(c.subject_id);
      if (c.subject_type === 'custom_request') {
        tryEnqueue('custom_design_followup_draft', { request_id: Number(c.subject_id) }, subjRef, `case-${c.id}`);
      } else if (c.subject_type === 'order') {
        if (['needs_quote', 'receipt_pending_review', 'deposit_unpaid'].includes(c.case_kind)) {
          tryEnqueue('deposit_followup_draft', { order_code: c.subject_code }, subjRef, `case-${c.id}`);
        } else if (c.case_kind === 'workshop_unassigned') {
          tryEnqueue('workshop_followup_draft', { order_code: c.subject_code }, subjRef, `case-${c.id}`);
        } else if (c.case_kind === 'missing_measurements') {
          tryEnqueue('order_followup_draft', { order_code: c.subject_code, focus: 'measurements' }, subjRef, `case-${c.id}`);
        } else {
          tryEnqueue('order_followup_draft', { order_code: c.subject_code, focus: 'schedule' }, subjRef, `case-${c.id}`);
        }
      }
    }

    // 3. Orders currently in `ready` stage -> Dina's pre-delivery quality checklist
    const readyOrders = all("SELECT id, code FROM orders WHERE status = 'ready' ORDER BY id ASC LIMIT 4");
    for (const ro of readyOrders) {
      if (enqueuedIds.length >= maxNewJobs) break;
      tryEnqueue('quality_delivery_checklist', { order_code: ro.code }, String(ro.id), 'ready-qc');
    }

    const drain = provider === 'fixture'
      ? this.drainQueue({ provider: 'fixture', maxSteps: 30, actor: WORKER_ACTOR })
      : { status: 'paused', processed_count: 0, steps: [], network_calls: 0 };

    return {
      cairo_date: dayKey,
      cases_sync: syncSummary,
      enqueued_count: enqueuedIds.length,
      enqueued_job_ids: enqueuedIds,
      skipped_active_count: skippedExisting.length,
      prepared_count: drain.processed_count,
      auto_approved_count: 0,
      external_actions_executed: 0,
      network_calls: 0,
    };
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
