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
]);

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
  return get('SELECT * FROM chat_messages WHERE id = ?', r.lastInsertRowid);
}

function decideRequest(requestId, decision, note, actor) {
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

router.post('/requests/:id/decision', A.requireOwner, (req, res) => {
  try {
    exactBody(req.body || {}, ['decision', 'note']);
    const actor = engine.makeActor(`user:${req.user.id}`, req.user.role);
    const msg = decideRequest(req.params.id, req.body.decision, req.body.note, actor);
    res.json({ message: msg });
  } catch (err) { sendErr(res, err); }
});

module.exports = { router, listMessages, createMessage, decideRequest, STAFF_REQUEST_KINDS };
