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
const { AI_SUPPORTED_KINDS } = require('./openrouter-client');

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
  execution TEXT NOT NULL DEFAULT '',
  execution_result TEXT,
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
CREATE INDEX IF NOT EXISTS idx_office_job_audit_job ON office_job_audit(job_id, id ASC);`;

function ensureOfficeSchema() {
  const existing = get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'office_jobs'");
  if (!existing) {
    db.exec(OFFICE_JOBS_SCHEMA_SQL);
    return;
  }
  const cols = db.pragma('table_info(office_jobs)').map(c => c.name);
  // Office action drafts (real execution + verification) — additive, idempotent
  if (!cols.includes('execution')) {
    db.exec("ALTER TABLE office_jobs ADD COLUMN execution TEXT NOT NULL DEFAULT ''");
  }
  if (!cols.includes('execution_result')) {
    db.exec('ALTER TABLE office_jobs ADD COLUMN execution_result TEXT');
  }
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
  execution TEXT NOT NULL DEFAULT '',
  execution_result TEXT,
            used_channel TEXT,
            used_by TEXT,
            used_at REAL,
            error_code TEXT,
            created_at REAL NOT NULL,
            updated_at REAL NOT NULL
          );
          INSERT INTO office_jobs_v2 (
            id, idempotency_key, request_hash, kind, employee_id, visibility,
            subject_type, subject_ref, subject_snapshot_hash, subject_fast_hash, subject_staff_hash, payload, status,
            revision, input_revision, attempts, lease_token, lease_until, result, result_hash,
            created_by, reviewed_by, used_channel, used_by, used_at, error_code, created_at, updated_at
          )
          SELECT
            id, idempotency_key, request_hash, kind, employee_id, visibility,
            subject_type, subject_ref, subject_snapshot_hash, subject_fast_hash, subject_staff_hash, payload, status,
            revision, input_revision, attempts, lease_token, lease_until, result, result_hash,
            created_by, reviewed_by, used_channel, used_by, used_at, error_code, created_at, updated_at
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

  if (kind === 'style_page_copy_draft') {
    assertExactKeys(payload, ['style_id']);
    const sid = String(payload.style_id || '').trim();
    if (!/^[A-Z0-9_-]{1,30}$/.test(sid)) {
      throw new PolicyError('invalid_style_id', 'معرّف الموديل غير صالح');
    }
    return { style_id: sid };
  }

  if (kind === 'delivery_promise_draft') {
    assertExactKeys(payload, ['order_code']);
    const code = String(payload.order_code || '').trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code)) {
      throw new PolicyError('invalid_order_code', 'رقم الطلب غير صالح');
    }
    return { order_code: code };
  }

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
    kind === 'care_campaign_draft' ||
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

/* Weekly customer-care campaign facts: aggregate counts of DELIVERED orders
   only (the finished work) — never names, phones, or order codes. These
   aggregates are safe to show to the team and to size the offer, while the
   actual recipients are chosen manually by the owner/basma from the orders
   page at send time. */
function readCareCampaignFacts() {
  const deliveredTotal = get("SELECT COUNT(*) n FROM orders WHERE status = 'delivered'").n;
  const deliveredLast30 = get("SELECT COUNT(*) n FROM orders WHERE status = 'delivered' AND updated_at >= datetime('now', '-30 days')").n;
  const customersTotal = get("SELECT COUNT(DISTINCT contact_phone) n FROM orders WHERE status = 'delivered' AND contact_phone IS NOT NULL AND TRIM(contact_phone) <> ''").n;
  const repeatCustomers = get(
    "SELECT COUNT(*) n FROM (SELECT contact_phone FROM orders WHERE status = 'delivered' AND contact_phone IS NOT NULL AND TRIM(contact_phone) <> '' GROUP BY contact_phone HAVING COUNT(*) >= 2)"
  ).n;
  const deliveringNow = get("SELECT COUNT(*) n FROM orders WHERE status = 'delivering'").n;
  const facts = {
    delivered_total: deliveredTotal,
    delivered_last_30_days: deliveredLast30,
    customers_total: customersTotal,
    repeat_customers: repeatCustomers,
    delivering_now: deliveringNow,
  };
  const h = digest(facts);
  return {
    subject_type: 'ops_summary',
    subject_ref: 'care-campaign',
    approvable: true,
    hash: h,
    fastHash: h,
    staffFastHash: h,
    facts,
  };
}

/* Real style facts for the page-copy action draft — PUBLIC fields only
   (name, description, fabrics, colours, lead time). Never price, cost, or
   any customer data: this feeds both the local template and the AI prompt. */
function readStylePageFacts(styleId) {
  const style = get("SELECT id, name, note, lead_days, active FROM styles WHERE id = ? AND type = 'made'", String(styleId || ''));
  if (!style) throw new NotFoundError('product_not_found', 'الموديل غير موجود في الكتالوج');
  const d = require('./tailoring-catalogue').detailsBatch([style.id]).get(style.id) || { fabrics: [], colours: [], sizes: [], lengths: [] };
  const imageCount = get('SELECT COUNT(*) n FROM style_images WHERE style_id = ?', style.id).n;
  const facts = {
    id: style.id,
    name: style.name,
    note: style.note || '',
    lead_days: style.lead_days,
    active: !!style.active,
    fabrics: (d.fabrics || []).slice(0, 30).map((x) => (x && typeof x === 'object' ? x.name : x)).filter(Boolean),
    colours: (d.colours || []).slice(0, 30).map((x) => (x && typeof x === 'object' ? x.name : x)).filter(Boolean),
    image_count: imageCount,
  };
  const h = digest(facts);
  return {
    subject_type: 'catalogue',
    subject_ref: style.id,
    approvable: !!style.active,
    hash: h,
    fastHash: h,
    staffFastHash: h,
    facts,
  };
}

/* Proposed delivery date computed honestly from the REGISTERED lead days of
   the ordered styles (max lead, floor 5 days) — nothing invented. */
function computeProposedDeliveryDate(orderCode) {
  const o = D.orderByCode(orderCode);
  if (!o) throw new NotFoundError('order_not_found', 'الطلب غير موجود');
  const leads = all(`SELECT s.lead_days FROM order_items oi JOIN styles s ON s.id = oi.style_id WHERE oi.order_id = ?`, o.id)
    .map((r) => Number(r.lead_days) || 0);
  const maxLead = Math.max(5, ...leads, 1);
  const fmt = new Intl.DateTimeFormat('en', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Africa/Cairo' });
  const parts = {};
  for (const p of fmt.formatToParts(Date.now() + maxLead * 86400000)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}`;
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
    kind === 'customer_reply_draft' ||
    kind === 'delivery_promise_draft'
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
  if (kind === 'care_campaign_draft') {
    return readCareCampaignFacts();
  }
  if (kind === 'style_page_copy_draft') {
    return readStylePageFacts(payload.style_id);
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

/* Customer-facing stages and custom-request states are always shown in Arabic
   inside draft text and facts — raw English enum values leak implementation
   details into owner-facing copy. */
const ORDER_STATUS_AR = {
  new: 'جديد', confirmed: 'مؤكد', cut: 'قص القماش', sewing: 'في التفصيل',
  ready: 'جاهز', delivering: 'قيد التوصيل', delivered: 'تم التسليم', cancelled: 'ملغي',
};
const CUSTOM_STATUS_AR = {
  review: 'بانتظار مراجعة وتسعير', quoted: 'بانتظار دفع العربون',
  receipt_pending: 'إيصال عربون بانتظار الفحص', approved: 'معتمد',
  rejected: 'مرفوض', delivered: 'تم التسليم', cancelled: 'ملغي',
};
const statusAr = (v, map = ORDER_STATUS_AR) => map[v] || String(v ?? '');

function buildFixtureResult(jobRow, payload, snap) {
  const kind = jobRow.kind;
  const provenance = {
    mode: 'fixture',
    ai_generated: false,
    model: null,
    subject_type: snap.subject_type,
    subject_ref: snap.subject_ref,
    subject_snapshot_hash: snap.hash,
    job_input_revision: jobRow.input_revision,  };

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
        ? `مسودة متابعة موعد التسليم المسجل (${f.promise_date}) للطلب ${f.code} في مرحلة ${statusAr(f.status)}.`
        : `الطلب ${f.code} في مرحلة ${statusAr(f.status)} ويحتاج تحديد موعد تسليم معتمد قبل مراسلة العميلة.`;
    } else {
      text = `مسودة تحديث حالة الطلب ${f.code} (${itemSummary}) — المرحلة المسجلة حاليًا: ${statusAr(f.status)}.`;
    }
    return {
      title: `مسودة متابعة تشغيلية — ${f.code}`,
      text,
      facts_used: [
        { label: 'رقم الطلب', value: String(f.code) },
        { label: 'المرحلة المسجلة', value: statusAr(f.status) },
        { label: 'موعد التسليم المسجل', value: f.promise_date || 'غير محدد' },
        { label: 'القطع', value: itemSummary || '—' },
        { label: 'المقاسات الأساسية', value: missing.length ? `ناقص: ${missing.join('، ')}` : 'مكتملة' },
      ],
      review_checklist: [
        'التحقق من ملكية الطلب قبل أي تواصل يدوي',
        'عدم تقديم وعد بموعد تسليم جديد قبل اعتماد المالكة',
        'الإرسال للعميلة يدوي من المالكة بعد الاعتماد — لا يوجد أي إرسال تلقائي',
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
      title: `كشف متابعة ورشة — ${f.code}`,
      text: `الطلب ${f.code} في مرحلة ${statusAr(f.status)}، الموعد المسجل: ${f.promise_date || 'غير محدد'}. القطع: ${lines}.`,
      facts_used: [
        { label: 'رقم الطلب', value: String(f.code) },
        { label: 'المرحلة المسجلة', value: statusAr(f.status) },
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
      text = `متابعة طلب التصميم الخاص ${f.code} (${statusAr(f.status, CUSTOM_STATUS_AR)}) — السعر المسجل: ${f.price ?? 'غير مسعر'} ج.م، العربون المطلوب: ${f.deposit_amount ?? 0} ج.م.`;
    }
    return {
      title: `مسودة مراجعة تصميم خاص (للمالكة) — ${f.code}`,
      text,
      facts_used: [
        { label: 'رقم الطلب الخاص', value: f.code },
        { label: 'العميلة', value: f.customer_name },
        { label: 'الحالة الحالية', value: statusAr(f.status, CUSTOM_STATUS_AR) },
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
    const channelAr = payload.channel === 'instagram' ? 'إنستجرام' : 'فيسبوك';
    const colours = f.colours.length ? f.colours.join('، ') : '';
    const fabrics = f.fabrics.join('، ');
    const lead = f.lead_days ? `التنفيذ على مقاسك خلال ${f.lead_days} يوم` : 'التنفيذ على مقاسك حسب الجدول المعتمد';
    const post = [
      `✨ ${f.name} — من مجموعة MAVI للتفصيل على المقاس`,
      fabrics ? `خامة ${fabrics} مريحة على الجسم، وقصة بتدي إطلالتك حركة راقية.` : '',
      colours ? `الألوان المتاحة: ${colours}.` : '',
      `${lead}.`,
      `اطلبيها دلوقتي من الموقع — ذوقك هو البداية، والباقي علينا 💛`,
    ].filter(Boolean).join('\n');
    const imagesMissing = !f.synthetic && (f.image_count ?? 0) === 0;
    const decision = f.synthetic
      ? 'الموديل ده عنصر اختبار داخلي — أعتمدي النص كنموذج صياغة فقط من غير ربطه بمنتج حقيقي.'
      : !imagesMissing
        ? 'الموديل جاهز للنشر: صوره المعتمدة موجودة وبياناته مكتملة. أقترح النشر بداية الأسبوع مع ستوري قصيرة للإعلان عنه.'
        : 'النص جاهز، لكن محتاجين رفع صور معتمدة للموديل قبل النشر — بوست من غير صور بيوصل لعدد أقل بكتير من العميلات.';
    return {
      title: `مسودة بوست ${channelAr} — ${f.name}`,
      text: `✍️ نص البوست المقترح (${channelAr}):\n\n${post}\n\n🎯 قراري كمدير المحتوى: ${decision}\n\n🙋 الإذن المطلوب منك: ${f.synthetic ? 'اعتماد النص كنموذج صياغة.' : `موافقة نشر هذا البوست على ${channelAr}. النشر يتم يدويًا من حساب البراند بعد إذنك — مفيش نشر تلقائي من النظام.`}`,
      facts_used: [
        { label: 'كود الموديل', value: String(f.id) },
        { label: 'اسم الموديل', value: String(f.name) },
        { label: 'القناة', value: String(payload.channel) },
        { label: 'نوع العنصر', value: f.synthetic ? 'عنصر اختبار تجريبي' : 'موديل كتالوج معتمد' },
        { label: 'الخامات والألوان', value: [fabrics, colours].filter(Boolean).join(' · ') || '—' },
      ],
      review_checklist: [
        'مطابقة الوصف والصور مع الكتالوج المعتمد قبل النشر',
        'عدم إضافة خصومات أو مواعيد تسليم غير معتمدة',
        'لا يوجد نشر تلقائي على أي منصة — النشر يدوي بعد إذنك',
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
      ? `🔍 فحص جاهزية صفحة الموديل «${f.name}» قبل الترويج رصد ${gaps.length} نواقص:\n${gaps.map(g => `• ${g}`).join('\n')}\n\n🎯 قراري: نكمّل النواقص دي الأول — أي ترويج قبلها هيضيّع جزء من الزيارات وبيربك العميلة.\n\n🙋 الإذن المطلوب منك: موافقة استكمال النواقص في الكتالوج (تعديل يدوي بمعرفتك).`
      : `🔍 فحص صفحة الموديل «${f.name}»: كل بيانات العرض المحلية مكتملة (الصور، الوصف، الخامات، الألوان، ومدة التنفيذ ${f.lead_days || '—'} يوم).\n\n🎯 قراري: الصفحة جاهزة للترويج؛ الفهرسة الخارجية في Google Search Console بتتأكد خارج النظام.\n\n🙋 الإذن المطلوب منك: الانطلاق في الترويج بعد تأكدك من حالة Search Console.`;
    return {
      title: `فحص جاهزية صفحة الموديل — ${f.name}`,
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
    const channelAr = payload.channel === 'instagram' ? 'إنستجرام' : 'فيسبوك';
    const ready = !f.synthetic && (f.image_count ?? 0) > 0 && f.colours.length;
    return {
      title: `موجز حملة — ${f.name} (قرار مطلوب منك)`,
      text: `📊 موجز الحملة المقترح:\n\n• الموديل: «${f.name}» — ${ready ? 'صفحته جاهزة للتحويل (صور معتمدة وألوان مسجلة).' : 'كمل بيانات صفحته الأول (صور معتمدة وألوان) قبل أي إعلان.'}\n• القناة: ${channelAr} — أنسب جمهور لعروض التفصيل على المقاس.\n• السقف المطلوب إذنه: ${payload.daily_budget_egp} ج.م ليوم إطلاق واحد كحد أقصى للتجربة.\n\n🎯 قراري كمدير التسويق: نبدأ بيوم واحد بس للقياس، ونتوسع بعد ما نتأكد إن الحملة جابت طلب مؤكد بعربون — مش مجرد نقرات.\n\n⚠️ اعتمادك للموجز توثيق قرار داخلي: مفيش ربط بحساب إعلاني ولا أي صرف تلقائي، والإطلاق الفعلي يتم يدويًا منك على المنصة.`,
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
      text: `ملخص التنسيق الأسبوعي: يوجد ${f.active_orders} طلب نشط، و${totalOpenCases} حالة متابعة مفتوحة (${f.pending_receipts} إيصال بانتظار الفحص، ${f.unpriced_custom} تصميم خاص بانتظار التسعير). مقترح التسويق التجريبي محدد بسقف تخطيطي ${payload.holiday_budget_egp} ج.م ليوم إجازة واحد بعد إغلاق المتأخرات ومراجعة المالكة.\n\n🙋 الإذن المطلوب منك: اعتماد الخطة والأولويات — أي تنفيذ يبدأ بعد إذنك.`,
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

  if (kind === 'care_campaign_draft') {
    const f = snap.facts;
    const audienceLine = `العميلات اللي سلّمنا لهم طلبات: ${Number(f.customers_total)} عميلة إجمالًا، منهم ${Number(f.repeat_customers)} عميلة اشتروا أكتر من مرة، و${Number(f.delivered_last_30_days)} طلب اتسلّم آخر ٣٠ يوم.`;
    const text = `📣 حملة عناية أسبوعية للعميلات اللي خلصنا معاهم (تسليم فعلي) — بتوجيه من المدير العام للإدارتين: خدمة العملاء + التسويق.\n\n${audienceLine}\n\nالرسالة الجاهزة للإرسال اليدوي (واتساب — رسالة واحدة واحدة):\n\n«أهلًا [اسم العميلة] 🌸 معاكي مافي! حابين نشكرك على ثقتك — نتمنى طلبك يكون وصل بحالة ممتازة ومناسبك. عشان خاطر عملائنا الأعزاء، عندك خصم خاص على موديل جديد لفترة محدودة. لو حابة تفاصيل العرض ابعتيلنا كلمة "تفاصيل" وهنكون تحت أمرك. وأي ملاحظة على تجربتك معانا احنا سامعينها ❤️»\n\nطريقة التنفيذ يدويًا بالكامل:\n• اختاري العميلة من صفحة الطلبات بالفلتر «تم التسليم» وابدأي واحدة واحدة — ممنوع الرسائل الجماعية أو أي إرسال آلي.\n• اكتبي اسم العميلة مكان [اسم العميلة] وعدّلي العرض لو تحبي قبل الإرسال.\n• طلب تقييم أو صور بدون إذن مكتوب ممنوع — قاعدة الإذن المستقل بعد الاستلام بيظل شغال.\n${Number(f.delivering_now) ? `\nملحوظة: فيه ${Number(f.delivering_now)} طلب لسه في مرحلة التوصيل — دول مش بيدخلوا الحملة دي قبل ما يتسلموا فعلًا.` : ''}`;
    return {
      title: 'حملة عناية وعروض — عميلات تم تسليمهم',
      text,
      facts_used: [
        { label: 'عميلات تم تسليم طلباتهم (إجمالي)', value: String(Number(f.customers_total)) },
        { label: 'عميلات اشتروا أكثر من مرة', value: String(Number(f.repeat_customers)) },
        { label: 'تسليمات آخر ٣٠ يوم', value: String(Number(f.delivered_last_30_days)) },
        { label: 'طبيعة البيانات', value: 'أرقام إجمالية فقط — بدون أي أسماء أو أرقام هواتف' },
      ],
      review_checklist: [
        'ممنوع الإرسال الجماعي أو الآلي — رسالة يدوية واحدة واحدة بعد اعتمادك',
        'عدم إضافة وعد بخصم أو موعد خارج المعتمد في الكتالوج',
        'أي طلب تقييم أو صور يكون بإذن صريح مستقل بعد الاستلام',
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
      text: `ملخص المتابعة اليومية: يوجد ${f.active_orders} طلب قيد التنفيذ، منها ${f.ready_orders} جاهز للتسليم، و${f.missing_promise_orders} طلب يحتاج تسجيل موعد تسليم معتمد، مع ${totalStaffCases} حالة متابعة تشغيلية مفتوحة (${caseSummary}).\n\n🙋 الإذن المطلوب منك: اعتماد القائمة أو توجيه سلمى بالأولوية — أي موعد تسليم جديد لعميلة يحتاج إذنك الأول.`,
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
      return `• ${i.style_name} — عدد ${i.qty}${specs ? ` (${specs})` : ''}`;
    }).join('\n');
    const deliveryLine = f.delivery_requested
      ? `التسليم بالشحن إلى محافظة العميلة${f.governorate ? ` (${f.governorate})` : ''}`
      : 'التسليم: استلام العميلة من الأتيليه بنفسها';
    return {
      title: `قائمة فحص الجودة قبل التسليم — ${f.code}`,
      text: `قبل تسليم الطلب ${f.code} لازم نراجع القطع دي قطعة قطعة ونتأكد إن كل حاجة مطابقة.\n\nالقطع المطلوب فحصها:\n${itemLines || '• (لا توجد قطع مسجلة)'}\n\n${deliveryLine}.\nالمرحلة الحالية للطلب: ${statusAr(f.status)}.\n\nبعد الفحص: اعتمدي القائمة لو كله تمام — ده إذن تحويل الطلب لمرحلة التسليم. لو فيه أي ملاحظة سجلّيها الأول ورفضي القائمة لإعادة الفحص.`,
      facts_used: [
        { label: 'رقم الطلب', value: String(f.code) },
        { label: 'المرحلة المسجلة', value: statusAr(f.status) },
        { label: 'القطع والمواصفات', value: f.items.map(i => `${i.style_name} ×${i.qty}`).join(' · ') || '—' },
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

  if (kind === 'style_page_copy_draft') {
    const f = snap.facts;
    const oldNote = String(f.note || '');
    const proposed = [
      `${f.name} من موديلات مافي للتفصيل على المقاس.`,
      f.fabrics.length ? `مخامة عليكي بـ${f.fabrics.join(' أو ')}.` : '',
      f.colours.length ? `متاح بألوان ${f.colours.slice(0, 5).join('، ')}.` : '',
      `بنفصّله على مقاسك خلال ${f.lead_days} يوم تقريبًا من تأكيد الطلب.`,
      'اطلبيه من موقعنا وابعتي مقاساتك، وفريقنا بيراجع كل التفاصيل معاكي خطوة بخطوة.',
    ].filter(Boolean).join(' ').slice(0, 480);
    return {
      title: `وصف مقترح لصفحة الموديل — ${f.name}`,
      text: proposed,
      action: { type: 'style_note', style_id: f.id, old_note: oldNote },
      facts_used: [
        { label: 'الموديل', value: `${f.name} (${f.id})` },
        { label: 'الخامات المسجلة', value: f.fabrics.join('، ') || '—' },
        { label: 'الألوان المسجلة', value: f.colours.join('، ') || '—' },
        { label: 'الوصف الحالي على الموقع', value: oldNote || '(بدون وصف)' },
        { label: 'مدة التنفيذ المسجلة', value: `${f.lead_days} يوم` },
      ],
      review_checklist: [
        'الاعتماد هينفّذ فعلًا: الوصف الجديد هيتكتب على صفحة المنتج المنشورة ويظهر للعميلات',
        'النص بدون أي سعر أو وعد بموعد غير المسجل — راجعي الصياغة قبل الاعتماد',
        'الوصف السابق محفوظ ويمكن استرجاعه بضغطة بعد التنفيذ',
      ],
      provenance,
      external_actions: [],
    };
  }

  if (kind === 'delivery_promise_draft') {
    const f = snap.facts;
    const proposedDate = computeProposedDeliveryDate(f.code);
    const missingPieces = f.items.filter(i => i.status === 'custom_pending').map(i => i.style_name);
    const gaps = [
      f.promise_date ? `فيه موعد مسجل حاليًا: ${f.promise_date}` : 'مفيش موعد تسليم مسجل للطلب',
      f.measurements && Object.values(f.measurements).some(v => v === null || v === undefined)
        ? 'فيه مقاسات ناقصة في حساب العميلة — لازم تكمليها قبل تأكيد التنفيذ'
        : 'المقاسات المسجلة مكتملة',
      missingPieces.length ? `فيه ${missingPieces.length} قطعة تصميم خاص لسه محتاجة تسعير: ${missingPieces.join('، ')}` : 'كل القطع مسعّرة ومسجلة',
    ];
    return {
      title: `موعد تسليم مقترح — ${f.code}`,
      text: `اقتراح موعد تسليم للطلب ${f.code} (المرحلة الحالية: ${statusAr(f.status)}).\n\nجمعنا المطلوب:\n${gaps.map(g => `• ${g}`).join('\n')}\n\nالموعد المقترح: ${proposedDate} — محسوب من أطول مدة تنفيذ مسجلة لقطع الطلب (بدون أي اختراع).\n\nاعتمادك هيسجل الموعد ده على الطلب فعلًا ويحدّثه في صفحة الطلب. تقدري تعتمدي كما هو، أو تعدّلي النص عبر «تعديل النص» لو حابة موعدًا مختلفًا (اكتبي التاريخ الجديد بوضوح).`,
      action: { type: 'set_promise_date', order_code: f.code, proposed_date: proposedDate },
      facts_used: [
        { label: 'الطلب', value: String(f.code) },
        { label: 'المرحلة', value: statusAr(f.status) },
        { label: 'الموعد الحالي', value: f.promise_date || 'غير محدد' },
        { label: 'الموعد المقترح', value: proposedDate },
        { label: 'أساس الحساب', value: 'أطول مدة تنفيذ مسجلة لقطع الطلب' },
      ],
      review_checklist: [
        'الاعتماد هينفّذ فعلًا: الموعد هيتسجل على الطلب الحقيقي',
        'الاقتراح محسوب من مدد التنفيذ المسجلة — عدّليه لو تحبي تاريخًا مختلفًا',
        'التعديل لا يمس السعر أو المقاسات أو أي بيانات أخرى للطلب',
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
      title: `مسودة رد للعميلة — الطلب ${f.code}`,
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
    const palette = f.colours.length ? f.colours.join('، ') : '';
    const fabrics = f.fabrics.join('، ');
    const imageNote = f.synthetic
      ? '• مصدر المادة: عنصر اختبار — بدون تصوير حقيقي.'
      : (f.image_count ?? 0) > 0
        ? `• مصدر المادة: صور الأتيليه المصرح بها (${f.image_count} صورة) — ممنوع استخدام صور عميلات بدون إذن موثق.`
        : '• ⚠️ ملحوظة تنفيذية: مفيش صور معتمدة مرفوعة للموديل — محتاجين جلسة تصوير أو رفع صور الأتيليه قبل الإنتاج.';
    return {
      title: `خطة ريل — ${f.name}`,
      text: `🎬 خطة الريل المقترحة للموديل «${f.name}»:\n\n• الافتتاحية (٠–٣ ثواني): حركة القصة${fabrics ? ` وملمس الخامة (${fabrics})` : ''} في إضاءة طبيعية — أول ٣ ثواني هي اللي بتوقف التمرير.\n• المنتصف: ${palette ? `عرض الألوان المتاحة (${palette})` : 'عرض تفاصيل القص والتفصيل'} ولقطات قريبة على جودة التشطيب.\n• الختام: شعار MAVI + دعوة لطلب القطعة من الموقع.\n\n${imageNote}\n\n🎯 قراري كمدير المحتوى: الريل أنسب صيغة للموديل لأن حركة القصة بتظهر بالفيديو أكتر بكتير من الصور الثابتة.\n\n🙋 الإذن المطلوب منك: اعتماد الخطة وتحديد موعد التصوير — التنفيذ يدوي بالكامل خارج النظام.`,
      facts_used: [
        { label: 'كود الموديل', value: String(f.id) },
        { label: 'اسم الموديل', value: String(f.name) },
        { label: 'الصور المصرح بها محليًا', value: `${f.image_count ?? 0} صورة` },
        { label: 'الخامات والألوان', value: [fabrics, palette].filter(Boolean).join(' · ') || '—' },
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
      title: `إعداد حملة إعلانية مقترح (لمصر) — ${f.name}`,
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
      ? `📱 فحص صفحة الموديل «${f.name}» على الموبايل رصد ${checks.length} نقاط محتاجة استكمال قبل توجيه الزيارات:\n${checks.map(c => `• ${c}`).join('\n')}\n\n🎯 قراري: نصلح النقاط دي قبل أي حملة — عميلة بتحاول تطلب من موبايلها وبتقف عند عقبة هتسيب الصفحة.\n\n🙋 الإذن المطلوب منك: موافقة تنفيذ التعديلات دي على الصفحة.`
      : `📱 فحص صفحة الموديل «${f.name}» على الموبايل: مسار الطلب واضح ومكتمل (الصور، المقاسات/الأطوال، الألوان، ومدة التنفيذ ${f.lead_days} يوم).\n\n🎯 قراري: الصفحة مستعدة لاستقبال زيارات من حملة — بس يفضل تجربة طلب فعلي من موبايل قبل الإطلاق.\n\n🙋 الإذن المطلوب منك: اعتماد بدء توجيه الزيارات للصفحة.`;
    return {
      title: `فحص صفحة الموبايل قبل الترويج — ${f.name}`,
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
    const channelAr = payload.channel === 'instagram' ? 'إنستجرام' : 'فيسبوك';
    const colours = f.colours.length ? ` بالألوان: ${f.colours.join('، ')}` : '';
    return {
      title: `رد جاهز على استفسار — ${f.name}`,
      text: `💬 الرد المقترح للعميلة المهتمة (${channelAr}):\n\n«أهلًا بيكِ في MAVI 🌸 ${f.name} من موديلات التفصيل على المقاس${colours}. تقدري تشوفي كل التفاصيل وتطلبيه مباشرة من موقعنا، ولو محتاجة مساعدة في المقاسات إحنا معاكي خطوة بخطوة.»\n\n🎯 قراري كمدير المجتمع: نحوّل الاستفسار لطلب مسجل على الموقع — بيضمن دقة المقاسات ومتابعة منظمة. المتابعة بعد الاستلام تكون بموافقتها الصريحة فقط، وطلب التقييم أو الصور إذن مستقل بعد الاستلام.\n\n🙋 الإذن المطلوب منك: موافقة إرسال الرد يدويًا للعميلة — مفيش رسائل تلقائية من النظام ولا رسائل جماعية.`,
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
        execution: row.execution || '',
        execution_result: row.execution_result ? JSON.parse(row.execution_result) : null,
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
      execution: row.execution || '',
      execution_result: row.execution_result ? JSON.parse(row.execution_result) : null,
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

    const reviewed = db.transaction(() => {
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
    // Pipeline handoff: approving a draft automatically queues the next team's
    // work (still owner-generated and owner-approved — never auto-executed).
    if (decision === 'approve') this._enqueueNextSteps(String(id), actor);
    return reviewed;
  }

  /* Next-step map per approved draft kind. Payload adapters mirror each kind's
     validateJobPayload contract. Idempotency keys make replays harmless.
     Approving a draft = the owner hands the work to the next colleague: the
     next drafts are queued AND auto-prepared offline (fixture provider, zero
     network) so the handoff is visible immediately in the review queue. */
  static NEXT_STEPS() {
    return {
      content_draft: [
        { kind: 'visual_reel_brief', payloadOf: (p) => ({ product_id: p.product_id }) },
        { kind: 'seo_readiness_check', payloadOf: (p) => ({ product_id: p.product_id }) },
        { kind: 'community_followup_draft', payloadOf: (p) => ({ product_id: p.product_id, channel: p.channel }) },
      ],
      campaign_brief: [
        { kind: 'paid_ad_setup_draft', payloadOf: (p) => ({ product_id: p.product_id, channel: p.channel, daily_budget_egp: p.daily_budget_egp }) },
      ],
      seo_readiness_check: [
        { kind: 'landing_page_check', payloadOf: (p) => ({ product_id: p.product_id }) },
      ],
    };
  }

  _enqueueNextSteps(jobId, actor) {
    try {
      const row = get('SELECT kind, status, payload FROM office_jobs WHERE id = ?', jobId);
      if (!row || row.status !== 'approved') return;
      const spec = OfficeEngine.NEXT_STEPS()[row.kind];
      if (!spec) return;
      const payload = JSON.parse(row.payload);
      for (const step of spec) {
        try {
          const next = this.enqueue(step.kind, step.payloadOf(payload), `chain-${jobId}:${step.kind}`, actor);
          // Visible handoff: prepare the next draft immediately with the
          // offline deterministic provider (no network, never auto-executes).
          if (next && next.status === 'queued') {
            this.runOnce({ provider: 'fixture', jobId: next.id });
          }
        } catch (_) { /* best-effort: duplicate chain or invalid subject skipped */ }
      }
    } catch (_) { /* the approval itself must never fail because of chaining */ }
  }

  /* The background worker's standing job: prepare everything queued with the
     offline deterministic provider (zero network). Called lazily on owner
     /jobs visits so drafts are always ready for the manager's report; AI
     generation is NEVER automatic — it stays behind the owner's button. */
  autoPrepareQueued({ max = 8 } = {}) {
    const cap = Number.isInteger(max) && max > 0 && max <= 50 ? max : 8;
    const rows = all("SELECT id FROM office_jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC LIMIT ?", cap);
    let prepared = 0;
    for (const r of rows) {
      try {
        const res = this.runOnce({ provider: 'fixture', jobId: r.id });
        if (res && res.status === 'review') prepared++;
      } catch (_) { /* per-job failures are recorded on the job itself */ }
    }
    return { prepared, considered: rows.length };
  }

  /* One owner decision over the whole prepared batch (the general manager's
     report card). Each target is reviewed individually inside its own
     transaction: stale/conflicting items fail with their exact code and are
     reported honestly — never auto-refreshed, never auto-retried. Approvals
     still fire the same visible handoff + chaining as single decisions. */
  bulkReview(decision, targets, actor) {
    checkActorRoles(actor, ['owner'], 'القرارات الجماعية متاحة للمالكة فقط');
    if (!['approve', 'reject'].includes(decision)) {
      throw new PolicyError('invalid_review_decision', 'اختاري الاعتماد أو الرفض');
    }
    if (!Array.isArray(targets) || !targets.length || targets.length > 50) {
      throw new PolicyError('invalid_bulk_targets', 'قائمة المسودات المطلوب تحديد القرار عليها غير صالحة');
    }
    for (const t of targets) {
      if (!t || typeof t.id !== 'string' || !t.id.trim() || !Number.isInteger(t.expected_revision) || typeof t.expected_result_hash !== 'string') {
        throw new PolicyError('invalid_bulk_targets', 'قائمة المسودات المطلوب تحديد القرار عليها غير صالحة');
      }
    }
    const results = [];
    let approved = 0;
    let rejected = 0;
    for (const t of targets) {
      try {
        const job = this.review(t.id, t.expected_revision, t.expected_result_hash, decision, actor);
        if (decision === 'approve') approved++; else rejected++;
        results.push({ id: t.id, ok: true, status: job.status });
      } catch (err) {
        results.push({ id: t.id, ok: false, code: err && err.code ? err.code : 'review_failed' });
      }
    }
    maviAudit('office_jobs', 'bulk-review', `bulk_${decision}_by_owner`, actor.id, {
      requested: targets.length, approved, rejected,
      failed: results.filter((r) => !r.ok).length,
    });
    return {
      decision,
      approved,
      rejected,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
  }

  /* Lazy weekly care campaign: on the owner's office visit, make sure this
     week's customer-care draft exists (idempotent per ISO-ish week index),
     so the campaign shows up automatically without pressing the daily cycle. */
  lazyWeeklyCareEnqueue(actor) {
    try {
      const weekIndex = Math.floor(this.clock() / 604800);
      const key = `cycle:w${weekIndex}:care-campaign`.slice(0, 120);
      const existing = get('SELECT id FROM office_jobs WHERE idempotency_key = ?', key);
      if (existing) return null;
      const j = this.enqueue('care_campaign_draft', {}, key, actor);
      return j ? j.id : null;
    } catch (_) {
      return null; // campaign scheduling is best-effort and must never block listing
    }
  }

  /* Handoff result of approving `jobId`, recomputed from the chain idempotency
     keys so the review response can tell the owner exactly what her approval
     set in motion (queued next steps + how many are already awaiting review). */
  handoffSummary(jobId) {
    try {
      const rows = all('SELECT kind, status FROM office_jobs WHERE idempotency_key LIKE ?', `chain-${String(jobId)}:%`);
      return {
        next_queued: rows.length,
        next_prepared: rows.filter((r) => r.status === 'review').length,
        next_kinds: rows.map((r) => r.kind),
      };
    } catch {
      return { next_queued: 0, next_prepared: 0, next_kinds: [] };
    }
  }

  /* ---------- Real execution tools (office writes to MAVI) ----------
     An approved ACTION draft carries `result.action`. Executing applies the
     one narrow change via a dedicated tool, then RE-READS the record to
     verify, and stores the proof (old/new + link) on the draft itself. The
     previous value is preserved so the owner can restore it. Nothing here
     touches prices, stock, images, measurements, or any customer record. */
  static EXECUTABLE_KINDS() {
    return new Set(['style_page_copy_draft', 'delivery_promise_draft']);
  }

  executeDraft(id, actor) {
    checkActorRoles(actor, ['owner'], 'تنفيذ المسودة متاح للمالكة فقط');
    const row = get('SELECT * FROM office_jobs WHERE id = ?', String(id || ''));
    if (!row) throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
    if (!OfficeEngine.EXECUTABLE_KINDS().has(row.kind)) {
      throw new PolicyError('kind_has_no_execution_tool', 'هذا النوع لا يملك أداة تنفيذ — المسودات العادية للمراجعة فقط');
    }
    if (row.status !== 'approved') {
      throw new ConflictError('only_approved_drafts_can_execute', 'اعتمدي المسودة أولًا — التنفيذ يتم بعد الاعتماد فقط');
    }
    if (row.execution === 'verified') {
      throw new ConflictError('already_executed_and_verified', 'المسودة اتنفذت واتحققت بالفعل');
    }
    let result;
    try { result = JSON.parse(row.result); } catch { result = null; }
    const action = result && result.action;
    if (!action || typeof action !== 'object') {
      return this._recordExecutionFailure(row, 'draft_has_no_action', 'المسودة بدون بيانات تنفيذ');
    }

    try {
      if (action.type === 'style_note') {
        // The proposed copy lives in result.text (owner edits included).
        const note = String((result && result.text) || '').trim();
        const exec = this._execStyleNote({ ...action, new_note: note }, actor);
        return this._recordExecutionSuccess(row, exec);
      }
      if (action.type === 'set_promise_date') {
        const exec = this._execPromiseDate(action, actor);
        return this._recordExecutionSuccess(row, exec);
      }
      return this._recordExecutionFailure(row, 'unknown_action_type', 'نوع تنفيذ غير معروف');
    } catch (err) {
      const code = (err && err.code) || 'execution_failed';
      const message = (err && err.message) || 'فشل التنفيذ';
      return this._recordExecutionFailure(row, code, message);
    }
  }

  _execStyleNote(action, actor) {
    const style = get("SELECT id, name, note FROM styles WHERE id = ? AND type = 'made'", String(action.style_id || ''));
    if (!style) throw new ConflictError('subject_not_active', 'الموديل غير موجود أو غير متاح');
    const note = String(action.new_note === undefined ? '' : action.new_note).trim();
    // Same content rules as the catalogue edit form: <=500 chars, no dangerous chars.
    if (!note || note.length > 500 || /[<>&"'`\\]/.test(note)) {
      throw new PolicyError('invalid_proposed_note', 'النص المقترح غير صالح (طوله لازم أقل من ٥٠٠ حرف وبدون محارف خاصة)');
    }
    const oldNote = style.note || '';
    const { run: runQ } = require('./db');
    runQ('UPDATE styles SET note = ? WHERE id = ?', note, style.id);
    const after = get('SELECT note FROM styles WHERE id = ?', style.id);
    const verified = after && after.note === note;
    if (!verified) throw new ConflictError('execution_verification_failed', 'تعذر التحقق من كتابة الوصف؛ التعديل تراجع');
    require('./public-cache').invalidateCatalogue();
    maviAudit('style', style.id, 'note_executed_from_office', actor.id, { old_note: oldNote, new_note: note });
    return {
      tool: 'style_note_update',
      style_id: style.id,
      style_name: style.name,
      old_note: oldNote,
      new_note: note,
      verified: true,
      link: `/store/product/${encodeURIComponent(style.id)}`,
    };
  }

  _execPromiseDate(action, actor) {
    const { setPromiseDateOnly } = require('./order-lifecycle');
    const proposed = String(action.proposed_date || '').trim();
    const res = setPromiseDateOnly(String(action.order_code || ''), proposed, `office:${actor.id}`);
    return {
      tool: 'promise_date_update',
      order_code: res.code,
      changed: !!res.changed,
      old_date: res.old_date || null,
      new_date: res.new_date || null,
      verified: res.changed ? !!res.verified : true,
      link: null,
    };
  }

  _recordExecutionSuccess(row, exec) {
    const payload = {
      ok: true,
      executed_at: new Date().toISOString(),
      ...exec,
    };
    run("UPDATE office_jobs SET execution = 'verified', execution_result = ?, updated_at = ? WHERE id = ?",
      canonical(payload), this.clock(), row.id);
    this._recordAudit(row.id, `execution_verified_${row.kind}`, { id: 'owner', role: 'owner' });
    maviAudit('office_job', row.id, 'execution_verified', 'owner', { kind: row.kind, tool: exec.tool });
    return this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', row.id), { id: 'owner', role: 'owner' }, { useFastSnapshot: false });
  }

  _recordExecutionFailure(row, code, message) {
    const payload = {
      ok: false,
      error_code: code,
      message,
      executed_at: new Date().toISOString(),
    };
    run("UPDATE office_jobs SET execution = 'failed', execution_result = ?, updated_at = ? WHERE id = ?",
      canonical(payload), this.clock(), row.id);
    this._recordAudit(row.id, `execution_failed_${row.kind}`, { id: 'owner', role: 'owner' });
    maviAudit('office_job', row.id, 'execution_failed', 'owner', { kind: row.kind, error: code });
    return this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', row.id), { id: 'owner', role: 'owner' }, { useFastSnapshot: false });
  }

  /* Restore the previous value after a verified execution (style note only —
     the promise date is a date field; restoring is a new approved draft). */
  restoreExecution(id, actor) {
    checkActorRoles(actor, ['owner'], 'الاسترجاع متاح للمالكة فقط');
    const row = get('SELECT * FROM office_jobs WHERE id = ?', String(id || ''));
    if (!row || row.kind !== 'style_page_copy_draft') {
      throw new PolicyError('restore_not_supported', 'الاسترجاع متاح لمسودات وصف الموديل فقط');
    }
    if (row.execution !== 'verified') {
      throw new ConflictError('nothing_to_restore', 'مفيش تنفيذ متحقق ليترجع');
    }
    let exec;
    try { exec = JSON.parse(row.execution_result); } catch { exec = null; }
    if (!exec || typeof exec.old_note !== 'string') {
      throw new ConflictError('missing_previous_value', 'القيمة السابقة غير محفوظة');
    }
    const style = get("SELECT id, note FROM styles WHERE id = ? AND type = 'made'", String(exec.style_id || ''));
    if (!style) throw new ConflictError('subject_not_active', 'الموديل غير موجود');
    if (style.note === exec.old_note) {
      throw new ConflictError('already_restored', 'الوصف السابق مطبّق بالفعل');
    }
    const { run: runQ } = require('./db');
    runQ('UPDATE styles SET note = ? WHERE id = ?', exec.old_note, style.id);
    const after = get('SELECT note FROM styles WHERE id = ?', style.id);
    if (!after || after.note !== exec.old_note) {
      throw new ConflictError('execution_verification_failed', 'تعذر التحقق من الاسترجاع؛ جرّبي مرة أخرى');
    }
    require('./public-cache').invalidateCatalogue();
    const payload = {
      ok: true,
      restored: true,
      restored_at: new Date().toISOString(),
      tool: 'style_note_update',
      style_id: style.id,
      style_name: exec.style_name || style.id,
      old_note: style.note,
      new_note: exec.old_note,
      verified: true,
      link: `/store/product/${encodeURIComponent(style.id)}`,
    };
    run("UPDATE office_jobs SET execution = 'restored', execution_result = ?, updated_at = ? WHERE id = ?",
      canonical(payload), this.clock(), row.id);
    this._recordAudit(row.id, 'execution_restored_style_page_copy_draft', actor);
    maviAudit('style', style.id, 'note_restored_from_office', actor.id, { restored_note: exec.old_note });
    return this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', row.id), actor, { useFastSnapshot: false });
  }

  /* Owner-only cleanup of decided drafts. Rows are deleted from office_jobs;
     the audit trail (office_job_audit + events) is always preserved. */
  purgeDecidedJobs(actor, opts = {}) {
    checkActorRoles(actor, ['owner'], 'تفريغ المسودات المحسومة متاح للمالكة فقط');
    const { purged } = this._purgeDecidedRows(opts);
    const row = get("SELECT COUNT(*) AS n FROM office_jobs WHERE status IN ('approved','rejected','failed')");
    return { purged, archive_remaining: Number((row && row.n) || 0) };
  }

  _purgeDecidedRows({ olderThanDays = 0 } = {}) {
    const useCutoff = Number.isInteger(olderThanDays) && olderThanDays > 0;
    // engine clock() is epoch seconds (Date.now()/1000 by default)
    const cutoff = useCutoff ? this.clock() - olderThanDays * 86400 : null;
    const info = useCutoff
      ? run("DELETE FROM office_jobs WHERE status IN ('approved','rejected','failed') AND updated_at <= ?", cutoff)
      : run("DELETE FROM office_jobs WHERE status IN ('approved','rejected','failed')");
    const purged = Number((info && info.changes) || 0);
    if (purged > 0) {
      maviAudit('office_jobs', 'purge-decided', useCutoff ? 'office_jobs_auto_purged' : 'office_jobs_purged', 'system', {
        purged,
        older_than_days: useCutoff ? olderThanDays : 0,
      });
    }
    return { purged };
  }

  deleteDecidedJob(id, actor) {
    checkActorRoles(actor, ['owner'], 'حذف المسودة المحسومة متاح للمالكة فقط');
    return db.transaction(() => {
      const row = get('SELECT * FROM office_jobs WHERE id = ?', String(id || ''));
      if (!row) throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
      if (!['approved', 'rejected', 'failed'].includes(row.status)) {
        throw new PolicyError('only_decided_jobs_can_be_deleted', 'لا يمكن حذف مسودة لسه في الشغل — اعتمديها أو ارفضيها الأول');
      }
      // Audit trail is recorded BEFORE the row is removed (and outlives it).
      this._recordAudit(row.id, `draft_deleted_by_owner_${row.status}`, actor);
      maviAudit('office_job', row.id, 'draft_deleted_by_owner', actor.id, { kind: row.kind, status: row.status });
      run('DELETE FROM office_jobs WHERE id = ?', row.id);
      return { ok: true, deleted_id: row.id };
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

  /* Gated OpenRouter AI step (owner-triggered via /worker/step only):
     - validate() first (throws BEFORE claiming when disabled/staging/no-key/bad-model — zero network, zero claim)
     - claims the next queued job; ONLY content_draft / campaign_brief are supported
     - sends PUBLIC catalogue fields only (id/name/note) — never price, cost, or customer data
     - one-shot request, free models only, 0-cost enforced, no automatic retries
     - success -> job lands in 'review' with ai_generated provenance awaiting human approval */
  async _runOpenRouterStep(actor, options = {}) {
    const or = require('./openrouter-client'); // lazy require: avoids module cycle at load time
    const cfg = or.createConfig();
    try {
      cfg.validate();
    } catch (err) {
      // Configuration problems (disabled/staging/invalid key/model) abort before claiming any job.
      // PolicyError keeps the long-standing runOnce contract for the gated provider.
      throw new PolicyError(err.code || 'openrouter_disabled', 'مزوّد الذكاء الاصطناعي غير مفعّل — فعّليه من إعدادات الذكاء الاصطناعي (المالكة)');
    }

    const claimed = this.claim(actor, options.jobId !== undefined ? options.jobId : null);
    if (!claimed) {
      const targetJobId = options.jobId !== undefined ? options.jobId : null;
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

    const jobId = claimed.job.id;
    const token = claimed.token;
    const row = get('SELECT kind, payload FROM office_jobs WHERE id = ?', jobId);
    const kind = row ? row.kind : '';

    if (!AI_SUPPORTED_KINDS.includes(kind)) {
      this.fail(jobId, token, 'ai_provider_kind_not_supported', actor);
      return { status: 'failed', job_id: jobId, error_code: 'ai_provider_kind_not_supported', network_calls: 0 };
    }

    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch (_) {
      this.fail(jobId, token, 'fixture_worker_failed', actor);
      return { status: 'failed', job_id: jobId, error_code: 'fixture_worker_failed', network_calls: 0 };
    }

    let productFacts = null;
    try {
      let snap;
      if (kind === 'style_page_copy_draft') {
        snap = readStylePageFacts(String(payload.style_id || ''));
      } else {
        snap = readCatalogueFacts(String(payload.product_id || ''), false);
      }
      const f = (snap && snap.facts) || {};
      const note = typeof f.note === 'string' ? f.note : '';
      productFacts = {
        id: String(kind === 'style_page_copy_draft' ? payload.style_id : payload.product_id),
        name: String(f.name || '').slice(0, 200),
        note: note.slice(0, 500),
      };
      if (Array.isArray(f.fabrics)) productFacts.fabrics = f.fabrics.slice(0, 30).map((x) => String(x).slice(0, 80)).filter(Boolean);
      if (Array.isArray(f.colours)) productFacts.colours = f.colours.slice(0, 30).map((x) => String(x).slice(0, 80)).filter(Boolean);
      if (!productFacts.name.trim()) throw new or.ProviderError('product_not_found');
    } catch (err) {
      this.fail(jobId, token, 'product_not_found', actor);
      return { status: 'failed', job_id: jobId, error_code: 'product_not_found', network_calls: 0 };
    }

    const useLive = typeof options.transport !== 'function';
    const transport = useLive ? or.createLiveTransport({ timeoutMs: 20000 }) : options.transport;
    if (useLive) {
      const { recordOutboundTelemetry } = require('./staging-guard');
      recordOutboundTelemetry('openrouter_ai', 'network_attempt');
    }

    try {
      const generated = await or.generateMarketingDraft(cfg, {
        kind,
        payload,
        productFacts,
        transport,
      });
      const completed = this.completeWithAiOutput(jobId, token, actor, generated);
      return {
        status: completed.status,
        job_id: completed.id,
        mode: 'openrouter',
        ai_generated: true,
        model_reported: generated.model_reported,
        network_calls: 1,
      };
    } catch (err) {
      const code = err instanceof or.ProviderError ? err.code : 'provider_connection_failed_no_automatic_retry';
      this.fail(jobId, token, code, actor);
      return {
        status: 'failed',
        job_id: jobId,
        error_code: code,
        network_calls: 1,
      };
    }
  }

  completeWithAiOutput(id, token, actor = WORKER_ACTOR, generated) {
    checkActorRoles(actor, ['worker']);
    if (!generated || !generated.draft || typeof generated.draft.title !== 'string') {
      throw new PolicyError('invalid_or_incomplete_draft_response', 'رد غير مكتمل من مزود الذكاء الاصطناعي');
    }
    const draft = generated.draft;
    const row = get('SELECT kind, payload FROM office_jobs WHERE id = ?', String(id || ''));
    if (!row) throw new NotFoundError('job_not_found', 'المهمة غير موجودة');
    let payload;
    try {
      payload = JSON.parse(row.payload);
    } catch (_) {
      payload = {};
    }
    const aiChecks = Array.isArray(draft.review_checklist) ? draft.review_checklist.slice(0, 7) : [];
    const reviewChecklist = [
      'مراجعة بشرية إلزامية قبل أي استخدام — هذه مسودة AI ولا تُنشر أو تُرسل تلقائيًا',
      'التحقق أن النص لا يذكر سعرًا أو توافرًا أو موعد تسليم غير مسجل في الكتالوج',
      ...aiChecks,
    ].slice(0, 8);

    const factsUsed = [];
    let actionField;
    if (payload && payload.style_id) {
      const style = get("SELECT id, name, note FROM styles WHERE id = ? AND type = 'made'", String(payload.style_id));
      actionField = { type: 'style_note', style_id: payload.style_id, old_note: (style && style.note) || '' };
      factsUsed.push({ label: 'الموديل', value: `${generated.productFacts ? generated.productFacts.name : payload.style_id} (${payload.style_id})` });
      factsUsed.push({ label: 'الوصف الحالي على الموقع', value: (style && style.note) || '(بدون وصف)' });
    } else if (payload && payload.product_id) {
      factsUsed.push({ label: 'الموديل', value: `${generated.productFacts ? generated.productFacts.name : payload.product_id} (${payload.product_id})` });
      if (payload.channel) factsUsed.push({ label: 'القناة', value: String(payload.channel) });
    }
    if (row.kind === 'campaign_brief' && Number.isInteger(payload.daily_budget_egp)) {
      factsUsed.push({ label: 'السقف التخطيطي', value: `${payload.daily_budget_egp} (تخطيطي فقط — بلا أي صرف)` });
    }
    factsUsed.push({ label: 'مصدر الصياغة', value: `مسودة AI مجانية عبر OpenRouter (${generated.model_reported})` });

    const result = {
      title: draft.title,
      text: draft.text,
      ...(actionField ? { action: actionField } : {}),
      facts_used: factsUsed,
      review_checklist: reviewChecklist,
      provenance: {
        source: 'openrouter_ai_draft',
        model: String(generated.model_reported || '').slice(0, 120),
        free_model_only: true,
        ai_generated: true,
        requires_human_review: true,
      },
      external_actions: [],
    };
    const resultJson = canonical(result);
    const resultHash = digest(result);
    return db.transaction(() => {
      const leased = this._requireActiveLease(id, token);
      const snap = computeSubjectSnapshot(leased.kind, JSON.parse(leased.payload), { includeBlobDigests: true });
      if (!snap.approvable) {
        throw new ConflictError('subject_not_active', 'تغيّرت حالة الطلب أو الموديل وأصبح غير متاح للمتابعة');
      }
      const now = this.clock();
      run(
        `UPDATE office_jobs
         SET status = 'review', subject_snapshot_hash = ?, subject_fast_hash = ?, subject_staff_hash = ?, result = ?, result_hash = ?,
             lease_token = NULL, lease_until = NULL, revision = revision + 1, updated_at = ?
         WHERE id = ?`,
        snap.hash, snap.fastHash, snap.staffFastHash || '', resultJson, resultHash, now, leased.id
      );
      this._recordAudit(leased.id, 'ai_draft_ready_for_review', actor);
      return this._publicRow(get('SELECT * FROM office_jobs WHERE id = ?', leased.id), actor, { useFastSnapshot: true });
    }).immediate();
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
    if (provider !== 'fixture' && provider !== 'openrouter') {
      throw new PolicyError('provider_not_implemented_no_network_call_made', 'المزوّد غير مفعّل ولا يتم إجراء أي اتصال خارجي');
    }
    if (provider === 'openrouter') {
      return this._runOpenRouterStep(actor, options);
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
    if (provider === 'openrouter') {
      // AI generation is deliberately one owner-pressed step at a time — never bulk-drained in a loop.
      throw new PolicyError('openrouter_drain_not_permitted_one_step_at_a_time', 'توليد الذكاء الاصطناعي يتم خطوة واحدة في كل ضغطة بموافقة المالكة — لا يوجد تصريف تلقائي');
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

    // 4. Weekly customer-care campaign for DELIVERED customers (service + marketing).
    //    Delivered work gets no per-order follow-ups — the care touch is periodic,
    //    aggregate-only, and always manually sent after the owner's approval.
    const weekIndex = Math.floor(this.clock() / 604800);
    if (enqueuedIds.length < maxNewJobs && !hasActiveJob('care_campaign_draft', 'care-campaign')) {
      const cc = this.enqueue('care_campaign_draft', {}, `cycle:w${weekIndex}:care-campaign`.slice(0, 120), actor);
      enqueuedIds.push(cc.id);
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

/* Legacy fixture drafts were generated with raw English stage values (e.g.
   «في مرحلة sewing») and a misleading «مسودة اختبار محلية» checklist line.
   This refresh re-renders their content from the CURRENT subject facts with
   the current builder so every card the owner sees — old or new — speaks the
   same correct language. Rules:
   - only undecided (review) and approved-but-never-used drafts are touched;
   - owner-edited texts (human_edited) are authoritative and never replaced;
   - the decision state itself is preserved (review stays review, approved
     stays approved) and every refresh is audited. Idempotent: refreshed
     content no longer matches the legacy markers. */
function isLegacyFixtureResult(result) {
  if (!result || typeof result !== 'object') return false;
  if (!result.provenance || result.provenance.mode !== 'fixture') return false;
  if (result.human_edited) return false;
  const blob = JSON.stringify(result);
  if (blob.includes('مسودة اختبار محلية') || blob.includes('تجريبي')) return true;
  // A raw English stage right after the Arabic «مرحلة» phrasing never happens
  // with the current builder, which always writes the Arabic label.
  return /(?:في مرحلة |المرحلة المسجلة(?: حاليًا)?: |الحالة الحالية: ) ?(new|confirmed|cut|sewing|ready|delivering|delivered|cancelled|quoted|receipt_pending|review)(["»،.\s]|$)/.test(blob);
}

function refreshLegacyFixtureContent() {
  const rows = all(`SELECT * FROM office_jobs
                    WHERE status IN ('review','approved') AND used_at IS NULL AND result IS NOT NULL`);
  let refreshed = 0, skipped = 0;
  for (const row of rows) {
    try {
      let result = null;
      try { result = JSON.parse(row.result); } catch { continue; }
      if (!isLegacyFixtureResult(result)) continue;
      const spec = JOB_KINDS[row.kind];
      if (!spec || spec.financial) continue;
      let snap;
      try {
        snap = computeSubjectSnapshot(row.kind, JSON.parse(row.payload), { includeBlobDigests: true });
      } catch { skipped++; continue; } // subject deleted: leave the record untouched
      if (!snap.approvable) { skipped++; continue; }
      const fresh = buildFixtureResult(
        { kind: row.kind, input_revision: row.input_revision },
        JSON.parse(row.payload), snap
      );
      const resultJson = canonical(fresh);
      const resultHash = digest(fresh);
      const now = defaultEngine.clock();
      db.transaction(() => {
        run(
          `UPDATE office_jobs
           SET result = ?, result_hash = ?, subject_snapshot_hash = ?, subject_fast_hash = ?, subject_staff_hash = ?,
               revision = revision + 1, updated_at = ?
           WHERE id = ? AND status IN ('review','approved') AND used_at IS NULL AND result IS NOT NULL`,
          resultJson, resultHash, snap.hash, snap.fastHash, snap.staffFastHash || '', now, row.id
        );
        run(`INSERT INTO office_job_audit(job_id, event, actor_id, created_at) VALUES(?,?,?,?)`,
          row.id, 'legacy_fixture_content_refreshed', 'system:legacy-refresh', now);
      })();
      maviAudit('office_job', row.id, 'legacy_fixture_content_refreshed', 'system', { kind: row.kind });
      refreshed++;
    } catch (err) {
      skipped++;
      try { maviAudit('office_job', row.id, 'legacy_refresh_failed', 'system', { error: String(err.message || err).slice(0, 200) }); } catch {}
    }
  }
  return { scanned: rows.length, refreshed, skipped };
}

// Runs once when the module loads (i.e., on every server boot) so the owner's
// queue self-heals after an upgrade; also re-callable via the owner route.
try {
  const boot = refreshLegacyFixtureContent();
  if (boot.refreshed > 0) console.log(`[office] refreshed ${boot.refreshed} legacy fixture draft(s)`);
} catch (err) {
  console.error('[office] legacy fixture refresh:', err.message);
}

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
  validateJobPayload,
  OfficeEngine,
  defaultEngine,
  refreshLegacyFixtureContent,
};
