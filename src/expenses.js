'use strict';
// General/operating overhead belongs to the business, never to an order item.
// Existing records in `expenses` remain the source used by finance and reports.
const express = require('express');
const { db, get, all, run, audit } = require('./db');
const A = require('./auth');
const { validDate, cairoDate } = require('./business-date');

const router = express.Router();
const fail = (res, status, error, message) => res.status(status).json({ error, message });
const invalid = 'راجعي اسم المصروف والمبلغ الموجب (بحد أقصى منزلتين عشريتين) وتاريخًا صحيحًا والملاحظة.';
const maxAmount = 100000000;

function normalise(body, defaultDay) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (typeof body.category !== 'string' || (body.note != null && typeof body.note !== 'string')) return null;
  const category = body.category.trim(), note = (body.note || '').trim();
  const raw = body.amount;
  if ((typeof raw !== 'string' && typeof raw !== 'number') || String(raw).trim() === '') return null;
  const text = String(raw).trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  if (!category || category.length > 100 || note.length > 500 || !Number.isFinite(amount) || amount <= 0 || amount > maxAmount) return null;
  const spent = body.spent_on == null || body.spent_on === '' ? defaultDay : body.spent_on;
  if (typeof spent !== 'string' || !validDate(spent)) return null;
  return { category, amount, spent_on: spent, note };
}
function snapshot(x) {
  return { category: x.category, amount: Number(x.amount), spent_on: x.spent_on, note: x.note || '', revision: Number(x.revision) };
}
function same(a, b) {
  return a.category === b.category && Number(a.amount) === b.amount && a.spent_on === b.spent_on && (a.note || '') === b.note;
}
function validId(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

router.get('/money/expenses', A.requireOwner, (_req, res) => {
  res.json({ expenses: all('SELECT id,category,amount,spent_on,note,revision,date(spent_on) AS report_day FROM expenses ORDER BY spent_on DESC,id DESC') });
});

router.get('/money/expenses/history', A.requireOwner, (_req, res) => {
  // Only changes since this feature was added are known; no legacy history is invented.
  const rows = all(`SELECT e.id,e.entity_id,e.action,e.created_at,e.detail,u.name AS actor_name
                    FROM events e LEFT JOIN users u ON e.actor=('user:' || u.id)
                    WHERE e.entity='expense' AND e.action IN ('created','updated','deleted')
                    ORDER BY e.id DESC LIMIT 200`);
  const history = rows.map(row => {
    let detail = {};
    try { detail = JSON.parse(row.detail || '{}') || {}; } catch (_) { /* old malformed event */ }
    return { id: row.id, expense_id: row.entity_id, action: row.action, created_at: row.created_at,
      actor_name: row.actor_name || null, detail };
  });
  res.json({ history });
});

router.post('/money/expenses', A.requireOwner, (req, res) => {
  const input = normalise(req.body, cairoDate(new Date().toISOString()));
  const suppliedToken = req.body?.request_id;
  // Accept old API clients without a token, while the new UI always sends one.
  if (suppliedToken != null && (typeof suppliedToken !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(suppliedToken)))
    return fail(res, 400, 'bad_token', 'رمز العملية غير صحيح؛ أعيدي فتح نموذج المصروف.');
  if (!input) return fail(res, 400, 'bad_expense', invalid);
  const token = suppliedToken || null;
  const result = db.transaction(() => {
    const previous = token && get('SELECT * FROM expense_creation_requests WHERE request_id=?', token);
    if (previous) {
      if (!same(previous, input)) return { conflict: true };
      if (previous.expense_id == null) return { deleted: true };
      return { id: previous.expense_id, replay: true };
    }
    const row = run('INSERT INTO expenses(category,amount,spent_on,note) VALUES(?,?,?,?)',
      input.category, input.amount, input.spent_on, input.note || null);
    const id = Number(row.lastInsertRowid);
    if (token) run('INSERT INTO expense_creation_requests(request_id,expense_id,category,amount,spent_on,note) VALUES(?,?,?,?,?,?)',
      token, id, input.category, input.amount, input.spent_on, input.note);
    audit('expense', id, 'created', `user:${req.user.id}`, { after: snapshot({ ...input, revision: 1 }) });
    return { id, replay: false };
  }).immediate();
  if (result.conflict) return fail(res, 409, 'token_conflict', 'الطلب السابق بنفس الرمز له بيانات مختلفة؛ راجعي السجل قبل إضافة مصروف جديد.');
  if (result.deleted) return fail(res, 409, 'request_deleted', 'المصروف الناتج عن المحاولة السابقة حُذف؛ لن يُسجّل مرة أخرى تلقائيًا.');
  return res.status(result.replay ? 200 : 201).json(result);
});

router.patch('/money/expenses/:id', A.requireOwner, (req, res) => {
  const id = validId(req.params.id), input = normalise(req.body, null);
  const rev = validId(req.body?.revision);
  if (req.body?.reason != null && typeof req.body.reason !== 'string') return fail(res, 400, 'bad_reason', 'راجعي سبب التعديل.');
  const reason = (req.body?.reason || '').trim();
  if (!id || !rev || !input || reason.length > 300) return fail(res, 400, 'bad_expense', invalid);
  const result = db.transaction(() => {
    const old = get('SELECT id,category,amount,spent_on,note,revision FROM expenses WHERE id=?', id);
    if (!old) return { missing: true };
    if (Number(old.revision) !== rev) return { conflict: true };
    if (same(old, input)) return { unchanged: true, expense: old };
    run('UPDATE expenses SET category=?,amount=?,spent_on=?,note=?,revision=revision+1 WHERE id=?',
      input.category, input.amount, input.spent_on, input.note || null, id);
    const updated = get('SELECT id,category,amount,spent_on,note,revision FROM expenses WHERE id=?', id);
    audit('expense', id, 'updated', `user:${req.user.id}`, { before: snapshot(old), after: snapshot(updated), reason });
    return { expense: updated };
  }).immediate();
  if (result.missing) return fail(res, 404, 'not_found', 'المصروف غير موجود.');
  if (result.conflict) return fail(res, 409, 'stale_expense', 'المصروف اتغيّر في نافذة أخرى؛ افتحيه وراجعيه من جديد قبل الحفظ.');
  return res.json(result);
});

module.exports = { router };
