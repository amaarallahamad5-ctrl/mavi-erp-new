'use strict';
/* Operational & owner follow-up cases derived from real MAVI records.
   - Partial unique index enforces at most ONE open episode per (subject_type, subject_id, case_kind).
   - Resolved episodes remain in `office_cases` with full lifecycle history in `office_case_events`.
   - Re-occurring conditions open a new incremented `episode` rather than overwriting closed history.
   - Changing the underlying dates/status while still open updates `trigger_hash` & records `context_updated`.
   - Staff never receive `owner`-visibility cases or any financial fields/amounts. */
const crypto = require('crypto');
const { db, get, all, run } = require('./db');
const D = require('./domain');
const R = require('./deposit-rules');
const { cairoDate, validDate } = require('./business-date');

db.exec(`
CREATE TABLE IF NOT EXISTS office_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT NOT NULL CHECK(subject_type IN ('order','custom_request')),
  subject_id INTEGER NOT NULL,
  subject_code TEXT NOT NULL,
  case_kind TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('staff','owner')),
  assignee_role_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','resolved')),
  episode INTEGER NOT NULL DEFAULT 1,
  trigger_hash TEXT NOT NULL,
  reason_ar TEXT NOT NULL,
  next_step_ar TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution_reason TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_office_cases_one_open
  ON office_cases(subject_type, subject_id, case_kind)
  WHERE state = 'open';
CREATE INDEX IF NOT EXISTS idx_office_cases_lookup
  ON office_cases(state, visibility, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_office_cases_subject
  ON office_cases(subject_type, subject_id, episode DESC);

CREATE TABLE IF NOT EXISTS office_case_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES office_cases(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL,
  subject_id INTEGER NOT NULL,
  case_kind TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK(visibility IN ('staff','owner')),
  episode INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('opened','context_updated','resolved','reopened')),
  trigger_hash TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_office_case_events_subject
  ON office_case_events(subject_type, subject_id, id ASC);
`);

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function digest(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

function addDaysIso(yyyyMmDd, days) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function nowStamp(nowOption) {
  if (typeof nowOption === 'string' && nowOption.trim()) {
    const d = new Date(nowOption);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (nowOption instanceof Date && !Number.isNaN(nowOption.getTime())) {
    return nowOption.toISOString();
  }
  return new Date().toISOString();
}

function hasCompleteMeasurements(m) {
  if (!m || typeof m !== 'object') return false;
  return ['bust', 'waist', 'hip', 'length'].every(k => {
    const v = Number(m[k]);
    return Number.isFinite(v) && v >= 20 && v <= 250;
  });
}

function missingMeasurementKeys(m) {
  if (!m || typeof m !== 'object') return ['bust', 'waist', 'hip', 'length'];
  return ['bust', 'waist', 'hip', 'length'].filter(k => {
    const v = Number(m[k]);
    return !Number.isFinite(v) || v < 20 || v > 250;
  });
}

function evaluateActiveConditions(todayCairo, dueSoonLimit) {
  const desired = new Map(); // key: `${subject_type}:${subject_id}:${case_kind}`
  const addCase = (spec) => {
    const key = `${spec.subject_type}:${spec.subject_id}:${spec.case_kind}`;
    desired.set(key, {
      ...spec,
      trigger_hash: digest(spec.trigger_facts),
    });
  };

  // 1. Open orders
  const openOrders = all("SELECT * FROM orders WHERE status NOT IN ('delivered','cancelled') ORDER BY id ASC");
  for (const o of openOrders) {
    const items = all(`
      SELECT oi.id, oi.style_id, oi.qty, oi.status, oi.tailor_id, s.type AS style_type,
             COALESCE(NULLIF(oi.description,''), s.name) AS style_name
      FROM order_items oi JOIN styles s ON s.id = oi.style_id
      WHERE oi.order_id = ? ORDER BY oi.id ASC
    `, o.id);
    const workshopItemIds = new Set(
      all('SELECT DISTINCT order_item_id FROM order_workshop_costs WHERE order_id = ? AND order_item_id IS NOT NULL', o.id)
        .map(r => r.order_item_id)
    );
    const hasMadeItems = items.some(i => i.style_type === 'made');
    const hasCustomPending = items.some(i => i.status === 'custom_pending');
    const m = D.orderMeasurements(o);

    // Staff-safe operational checks (ZERO money fields)
    if (hasMadeItems && !hasCompleteMeasurements(m)) {
      const missing = missingMeasurementKeys(m);
      addCase({
        subject_type: 'order',
        subject_id: o.id,
        subject_code: o.code,
        case_kind: 'missing_measurements',
        visibility: 'staff',
        assignee_role_id: 'nour',
        reason_ar: 'مقاسات التفصيل الأساسية غير مكتملة',
        next_step_ar: 'التواصل مع العميلة لاستكمال المقاسات المسجلة قبل القص',
        trigger_facts: { status: o.status, missing },
        summary: {
          order_code: o.code,
          order_status: o.status,
          missing_fields: missing,
        },
      });
    }

    const pDate = o.promise_date && validDate(String(o.promise_date).trim()) ? String(o.promise_date).trim() : null;
    if (!pDate && !hasCustomPending) {
      addCase({
        subject_type: 'order',
        subject_id: o.id,
        subject_code: o.code,
        case_kind: 'missing_promise_date',
        visibility: 'staff',
        assignee_role_id: 'nour',
        reason_ar: 'لم يُحدد موعد تسليم للطلب بعد',
        next_step_ar: 'مراجعة جدول التنفيذ وتحديد موعد تسليم معتمد',
        trigger_facts: { status: o.status, promise_date: null },
        summary: {
          order_code: o.code,
          order_status: o.status,
          promise_date: null,
        },
      });
    } else if (pDate && pDate < todayCairo) {
      addCase({
        subject_type: 'order',
        subject_id: o.id,
        subject_code: o.code,
        case_kind: 'late_delivery',
        visibility: 'staff',
        assignee_role_id: 'salma',
        reason_ar: 'تجاوز الطلب موعد التسليم المسجل بتوقيت القاهرة',
        next_step_ar: 'مراجعة مرحلة التنفيذ وتصعيد المتابعة للمالكة قبل أي وعد جديد',
        trigger_facts: { status: o.status, promise_date: pDate },
        summary: {
          order_code: o.code,
          order_status: o.status,
          promise_date: pDate,
          reference_cairo_date: todayCairo,
        },
      });
    } else if (pDate && pDate >= todayCairo && pDate <= dueSoonLimit && o.status !== 'ready') {
      addCase({
        subject_type: 'order',
        subject_id: o.id,
        subject_code: o.code,
        case_kind: 'due_soon',
        visibility: 'staff',
        assignee_role_id: 'salma',
        reason_ar: 'موعد تسليم الطلب خلال ٣ أيام ولم يصل لمرحلة الجاهزية',
        next_step_ar: 'متابعة استكمال الخياطة وفحص الجودة قبل الموعد',
        trigger_facts: { status: o.status, promise_date: pDate },
        summary: {
          order_code: o.code,
          order_status: o.status,
          promise_date: pDate,
          reference_cairo_date: todayCairo,
        },
      });
    }

    if (['cut', 'sewing'].includes(o.status)) {
      const unassigned = items.filter(i => i.style_type === 'made' && !i.tailor_id && !workshopItemIds.has(i.id));
      if (unassigned.length > 0) {
        addCase({
          subject_type: 'order',
          subject_id: o.id,
          subject_code: o.code,
          case_kind: 'workshop_unassigned',
          visibility: 'staff',
          assignee_role_id: 'hana',
          reason_ar: 'طلب في مرحلة القص/الخياطة بدون ورشة مسجلة لكل القطع',
          next_step_ar: 'تأكيد الورشة المسؤولة عن التنفيذ مع المالكة',
          trigger_facts: { status: o.status, item_ids: unassigned.map(x => x.id) },
          summary: {
            order_code: o.code,
            order_status: o.status,
            unassigned_items: unassigned.map(x => ({ item_id: x.id, style_name: x.style_name, qty: x.qty })),
          },
        });
      }
    }

    // Owner-only financial/quote checks
    const deposit = get(
      'SELECT status, percent, receipt_revision, (receipt IS NOT NULL) AS has_receipt FROM order_deposits WHERE order_id = ?',
      o.id
    );
    const totals = D.orderTotals(o.id);
    const rule = R.orderRule(o.id, totals.total, deposit);
    const shippingPending = !!o.delivery_requested && !o.shipping_quoted;
    const depositQuotePending = deposit && deposit.status === 'needs_quote';

    if (hasCustomPending || shippingPending || depositQuotePending) {
      addCase({
        subject_type: 'order',
        subject_id: o.id,
        subject_code: o.code,
        case_kind: 'needs_quote',
        visibility: 'owner',
        assignee_role_id: 'omar',
        reason_ar: hasCustomPending
          ? 'يوجد تصميم خاص داخل الطلب بانتظار التسعير'
          : 'الطلب يحتاج تحديد تكلفة الشحن وعرض العربون',
        next_step_ar: 'مراجعة التسعير وإرسال عرض العربون والشحن من المالكة',
        trigger_facts: {
          status: o.status,
          custom_pending: hasCustomPending,
          shipping_pending: shippingPending,
          deposit_status: deposit?.status || null,
        },
        summary: {
          order_code: o.code,
          order_status: o.status,
          custom_price_pending: hasCustomPending,
          shipping_pending: shippingPending,
          deposit_status: deposit?.status || null,
        },
      });
    } else if (deposit && deposit.status === 'receipt_pending' && deposit.has_receipt) {
      addCase({
        subject_type: 'order',
        subject_id: o.id,
        subject_code: o.code,
        case_kind: 'receipt_pending_review',
        visibility: 'owner',
        assignee_role_id: 'omar',
        reason_ar: 'إيصال عربون مرفوع وبانتظار مراجعة واعتماد المالكة',
        next_step_ar: 'فحص صورة الإيصال وتأكيد وصول المبلغ أو رفضه مع السبب',
        trigger_facts: {
          deposit_status: deposit.status,
          receipt_revision: deposit.receipt_revision || 'legacy',
          expected_deposit: rule.amount,
        },
        summary: {
          order_code: o.code,
          order_status: o.status,
          deposit_status: deposit.status,
          receipt_revision: deposit.receipt_revision || null,
          expected_deposit_egp: rule.amount,
          total_egp: totals.total,
        },
      });
    } else if (
      deposit &&
      ['quoted', 'receipt_rejected'].includes(deposit.status) &&
      rule.amount !== null &&
      rule.amount > 0 &&
      totals.paid + 0.005 < rule.amount
    ) {
      addCase({
        subject_type: 'order',
        subject_id: o.id,
        subject_code: o.code,
        case_kind: 'deposit_unpaid',
        visibility: 'owner',
        assignee_role_id: 'omar',
        reason_ar: deposit.status === 'receipt_rejected'
          ? 'رُفض الإيصال السابق وما زال العربون بانتظار إيصال صحيح'
          : 'تم إرسال عرض العربون ولم يُرفع إيصال السداد بعد',
        next_step_ar: 'متابعة العميلة لرفع إيصال التحويل دون اعتبار الطلب مؤكدًا ماليًا',
        trigger_facts: {
          deposit_status: deposit.status,
          expected_deposit: rule.amount,
          paid: totals.paid,
        },
        summary: {
          order_code: o.code,
          order_status: o.status,
          deposit_status: deposit.status,
          expected_deposit_egp: rule.amount,
          paid_egp: totals.paid,
        },
      });
    }
  }

  // 2. Standalone custom design requests (before converting to order)
  const openCustoms = all("SELECT id, status, price, deposit_percent, shipping_fee, receipt_revision, (receipt IS NOT NULL) AS has_receipt FROM custom_requests WHERE status != 'approved' ORDER BY id ASC");
  for (const cr of openCustoms) {
    const code = `CR-${cr.id}`;
    const rule = R.customRule(cr);
    if (cr.status === 'review') {
      addCase({
        subject_type: 'custom_request',
        subject_id: cr.id,
        subject_code: code,
        case_kind: 'needs_quote',
        visibility: 'owner',
        assignee_role_id: 'omar',
        reason_ar: 'طلب تصميم خاص جديد بانتظار التسعير وتحديد العربون',
        next_step_ar: 'مراجعة الصور والمقاسات وإرسال التسعير من المالكة',
        trigger_facts: { status: cr.status },
        summary: { custom_id: cr.id, subject_code: code, status: cr.status },
      });
    } else if (cr.status === 'receipt_pending' && cr.has_receipt) {
      addCase({
        subject_type: 'custom_request',
        subject_id: cr.id,
        subject_code: code,
        case_kind: 'receipt_pending_review',
        visibility: 'owner',
        assignee_role_id: 'omar',
        reason_ar: 'إيصال عربون لطلب تصميم خاص بانتظار مراجعة المالكة',
        next_step_ar: 'فحص الإيصال واعتماده لتحويل الطلب لأوردر أو رفضه',
        trigger_facts: {
          status: cr.status,
          receipt_revision: cr.receipt_revision || 'legacy',
          expected_deposit: rule.amount,
        },
        summary: {
          custom_id: cr.id,
          subject_code: code,
          status: cr.status,
          expected_deposit_egp: rule.amount,
        },
      });
    } else if (['quoted', 'receipt_rejected'].includes(cr.status)) {
      addCase({
        subject_type: 'custom_request',
        subject_id: cr.id,
        subject_code: code,
        case_kind: 'deposit_unpaid',
        visibility: 'owner',
        assignee_role_id: 'omar',
        reason_ar: cr.status === 'receipt_rejected'
          ? 'رُفض إيصال التصميم الخاص وبانتظار إيصال بديل'
          : 'تم تسعير التصميم الخاص وبانتظار رفع إيصال العربون',
        next_step_ar: 'متابعة العميلة لإرسال الإيصال قبل بدء التنفيذ',
        trigger_facts: {
          status: cr.status,
          expected_deposit: rule.amount,
        },
        summary: {
          custom_id: cr.id,
          subject_code: code,
          status: cr.status,
          expected_deposit_egp: rule.amount,
        },
      });
    }
  }

  return desired;
}

function inferResolutionReason(row) {
  if (row.subject_type === 'order') {
    const o = get('SELECT status FROM orders WHERE id = ?', row.subject_id);
    if (!o) return 'subject_removed';
    if (o.status === 'cancelled') return 'order_cancelled';
    if (o.status === 'delivered') return 'order_delivered';
    return 'condition_cleared';
  }
  const cr = get('SELECT status FROM custom_requests WHERE id = ?', row.subject_id);
  if (!cr) return 'subject_removed';
  if (cr.status === 'approved') return 'converted_to_order';
  return 'condition_cleared';
}

function syncCases(options = {}) {
  const stamp = nowStamp(options.now);
  const todayCairo = cairoDate(stamp);
  const dueSoonLimit = addDaysIso(todayCairo, 3);

  return db.transaction(() => {
    const desired = evaluateActiveConditions(todayCairo, dueSoonLimit);
    const currentlyOpen = all("SELECT * FROM office_cases WHERE state = 'open' ORDER BY id ASC");
    const openMap = new Map();
    for (const row of currentlyOpen) {
      openMap.set(`${row.subject_type}:${row.subject_id}:${row.case_kind}`, row);
    }

    let opened = 0, reopened = 0, updated = 0, resolved = 0;

    // Resolve open cases whose condition no longer holds
    for (const [key, row] of openMap.entries()) {
      if (desired.has(key)) continue;
      const reason = inferResolutionReason(row);
      run(
        "UPDATE office_cases SET state = 'resolved', updated_at = ?, resolved_at = ?, resolution_reason = ? WHERE id = ?",
        stamp, stamp, reason, row.id
      );
      run(
        `INSERT INTO office_case_events(case_id, subject_type, subject_id, case_kind, visibility, episode, event_type, trigger_hash, detail_json, created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
        row.id, row.subject_type, row.subject_id, row.case_kind, row.visibility, row.episode,
        'resolved', row.trigger_hash, canonical({ resolution_reason: reason }), stamp
      );
      resolved += 1;
    }

    // Open, reopen, or update active cases
    for (const [key, spec] of desired.entries()) {
      const existing = openMap.get(key);
      const summaryJson = canonical(spec.summary);
      if (!existing) {
        const prevEpisode = get(
          'SELECT COALESCE(MAX(episode), 0) AS n FROM office_cases WHERE subject_type = ? AND subject_id = ? AND case_kind = ?',
          spec.subject_type, spec.subject_id, spec.case_kind
        ).n;
        const nextEpisode = prevEpisode + 1;
        const eventType = prevEpisode > 0 ? 'reopened' : 'opened';
        const ins = run(
          `INSERT INTO office_cases(
             subject_type, subject_id, subject_code, case_kind, visibility, assignee_role_id,
             state, episode, trigger_hash, reason_ar, next_step_ar, summary_json, opened_at, updated_at
           ) VALUES(?,?,?,?,?,?,'open',?,?,?,?,?,?,?)`,
          spec.subject_type, spec.subject_id, spec.subject_code, spec.case_kind, spec.visibility,
          spec.assignee_role_id, nextEpisode, spec.trigger_hash, spec.reason_ar, spec.next_step_ar,
          summaryJson, stamp, stamp
        );
        const caseId = Number(ins.lastInsertRowid);
        run(
          `INSERT INTO office_case_events(case_id, subject_type, subject_id, case_kind, visibility, episode, event_type, trigger_hash, detail_json, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
          caseId, spec.subject_type, spec.subject_id, spec.case_kind, spec.visibility, nextEpisode,
          eventType, spec.trigger_hash, summaryJson, stamp
        );
        if (prevEpisode > 0) reopened += 1;
        else opened += 1;
      } else if (
        existing.trigger_hash !== spec.trigger_hash ||
        existing.summary_json !== summaryJson ||
        existing.subject_code !== spec.subject_code
      ) {
        run(
          `UPDATE office_cases
           SET subject_code = ?, reason_ar = ?, next_step_ar = ?, trigger_hash = ?, summary_json = ?, updated_at = ?
           WHERE id = ?`,
          spec.subject_code, spec.reason_ar, spec.next_step_ar, spec.trigger_hash, summaryJson, stamp, existing.id
        );
        run(
          `INSERT INTO office_case_events(case_id, subject_type, subject_id, case_kind, visibility, episode, event_type, trigger_hash, detail_json, created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
          existing.id, existing.subject_type, existing.subject_id, existing.case_kind, existing.visibility,
          existing.episode, 'context_updated', spec.trigger_hash, summaryJson, stamp
        );
        updated += 1;
      }
    }

    return { cairo_date: todayCairo, opened, reopened, updated, resolved };
  }).immediate();
}

function formatCaseRow(row) {
  return {
    id: row.id,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    subject_code: row.subject_code,
    case_kind: row.case_kind,
    visibility: row.visibility,
    assignee_role_id: row.assignee_role_id,
    state: row.state,
    episode: row.episode,
    reason_ar: row.reason_ar,
    next_step_ar: row.next_step_ar,
    summary: JSON.parse(row.summary_json),
    opened_at: row.opened_at,
    updated_at: row.updated_at,
    resolved_at: row.resolved_at,
    resolution_reason: row.resolution_reason,
  };
}

function listCases(actor, options = {}) {
  if (!actor || !['owner', 'staff'].includes(actor.role)) {
    const err = new Error('caller_not_permitted');
    err.status = 403;
    throw err;
  }
  const stateFilter = options.state === 'resolved' ? 'resolved' : (options.state === 'all' ? null : 'open');
  const clauses = [];
  const params = [];
  if (actor.role !== 'owner') {
    clauses.push("visibility = 'staff'");
  }
  if (stateFilter) {
    clauses.push('state = ?');
    params.push(stateFilter);
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const rows = all(`SELECT * FROM office_cases ${where} ORDER BY state ASC, id DESC LIMIT 200`, ...params);
  return rows.map(formatCaseRow);
}

function getSubjectCaseHistory(actor, subjectType, subjectId) {
  if (!actor || !['owner', 'staff'].includes(actor.role)) {
    const err = new Error('caller_not_permitted');
    err.status = 403;
    throw err;
  }
  if (!['order', 'custom_request'].includes(subjectType) || !Number.isSafeInteger(subjectId) || subjectId < 1) {
    const err = new Error('invalid_subject');
    err.status = 400;
    throw err;
  }
  if (actor.role !== 'owner' && subjectType === 'custom_request') {
    const err = new Error('forbidden');
    err.status = 403;
    throw err;
  }
  const visClause = actor.role === 'owner' ? '' : " AND visibility = 'staff'";
  const episodes = all(
    `SELECT * FROM office_cases WHERE subject_type = ? AND subject_id = ?${visClause} ORDER BY episode ASC, id ASC`,
    subjectType, subjectId
  ).map(formatCaseRow);
  const events = all(
    `SELECT id, case_id, case_kind, episode, event_type, detail_json, created_at
     FROM office_case_events WHERE subject_type = ? AND subject_id = ?${visClause} ORDER BY id ASC`,
    subjectType, subjectId
  ).map(ev => ({
    id: ev.id,
    case_id: ev.case_id,
    case_kind: ev.case_kind,
    episode: ev.episode,
    event_type: ev.event_type,
    detail: JSON.parse(ev.detail_json),
    created_at: ev.created_at,
  }));
  return { episodes, events };
}

module.exports = {
  syncCases,
  listCases,
  getSubjectCaseHistory,
};
