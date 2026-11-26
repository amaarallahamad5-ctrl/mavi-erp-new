'use strict';
/* اقتراحات جاهزة للتطبيق على كروت المسودات (owner decision 26.11):
   «الكارت يديني اقتراحات تتعمل… لو عجبتي الاقتراح اختاره وادوس تطبيق فيطبق
   مباشرة سواء تعديل في طلب أو موديل أو أي حاجة ظاهرة في الكارت».
   Rules that keep this safe (same guarantees as the office execution tools):
   - owner-only apply, with the same stale-protection as the review endpoint
   - every tool writes ONE narrow change, re-reads it to verify, and keeps the
     previous value on the apply record so she can undo with one click
   - nothing here ever sends anything to a customer — the message copy/WhatsApp
     send stays manual as always */

const { db, get, all, run, audit } = require('./db');
const { NotFoundError, ConflictError, PolicyError } = require('./office-engine');

const APPLIES_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS office_suggestion_applies (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  suggestion_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  summary_ar TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  restorable INTEGER NOT NULL DEFAULT 0,
  actor TEXT NOT NULL,
  created_at REAL NOT NULL,
  restored_at REAL
);
CREATE INDEX IF NOT EXISTS idx_office_applies_job ON office_suggestion_applies(job_id, created_at DESC);`;

function ensureAppliesSchema() {
  const existing = get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'office_suggestion_applies'");
  if (!existing) db.exec(APPLIES_SCHEMA_SQL);
}
ensureAppliesSchema();

const NOTE_CHARS_BAD = /[<>&"'`\\]/;
function cleanNote(text, max = 500) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > max || NOTE_CHARS_BAD.test(t)) return null;
  return t;
}

/* ---------- per-kind suggestion catalogue ---------- */
function suggestionsForJob(job, opts = {}) {
  if (!job || !job.result || job.status !== 'review') return [];
  if (!opts.isOwner) return [];
  const res = job.result;
  const out = [];
  const add = (id, label_ar, detail_ar, tool, params) => out.push({ id, label_ar, detail_ar, tool, params });

  if (job.kind === 'order_followup_draft' || job.kind === 'workshop_followup_draft' ||
      job.kind === 'quality_delivery_checklist' || job.kind === 'customer_reply_draft' ||
      job.kind === 'deposit_followup_draft' || job.kind === 'delivery_promise_draft') {
    const orderCode = job.subject_type === 'order' ? String(job.subject_code || job.subject_ref || '') : '';
    if (orderCode) {
      const title = String(res.title || '').trim();
      if (title) {
        add('order_note', '📝 سجّلي ملاحظة المتابعة على الطلب نفسه',
          'تنفيذ حقيقي: سطر قصير يتسجل في ملاحظات الطلب يوثق إن متابعة اتحضرت وراجعتيها النهاردة. القيمة السابقة بتتحفظ وتقدري ترجعيها بضغطة.',
          'order_note', { order_code: orderCode, title });
      }
    }
  }
  if (job.kind === 'delivery_promise_draft' && res.action && res.action.type === 'set_promise_date' && res.action.proposed_date) {
    add('set_promise_date', `📅 ثبّتي موعد التسليم المقترح (${res.action.proposed_date}) على الطلب`,
      'تنفيذ حقيقي: الميعاد يتكتب على الطلب فورًا ويتحقق تلقائيًا — والميعاد السابق محفوظ وتقدري ترجعيه بضغطة.',
      'set_promise_date', { order_code: res.action.order_code, proposed_date: res.action.proposed_date });
  }
  if (job.kind === 'style_page_copy_draft') {
    const text = String(res.text || '').trim();
    if (text && job.payload && job.payload.style_id) {
      add('style_note', '✍️ اكتبي هذا الوصف على صفحة الموديل فورًا',
        'تنفيذ حقيقي: النص المعروض في الكارت (بعد تعديلك لو عدّلتيه) يتكتب في وصف الموديل على المتجر ويتحقق تلقائيًا — الوصف السابق محفوظ والاسترجاع بضغطة.',
        'style_note', { style_id: job.payload.style_id });
    }
  }
  if (job.kind === 'collection_copy_draft') {
    const text = String(res.text || '').trim();
    if (text && job.payload && job.payload.section) {
      add('collection_note', '✍️ اكتبي هذا الوصف تحت المجموعة في المتجر فورًا',
        'تنفيذ حقيقي: النص المعروض في الكارت يتكتب تحت المجموعة على المتجر ويتحقق تلقائيًا — النص السابق محفوظ والاسترجاع بضغطة.',
        'collection_note', { section: job.payload.section });
    }
  }
  if (job.kind === 'custom_design_followup_draft' && job.subject_type === 'custom_request') {
    const text = String(res.text || '').trim();
    if (text) {
      add('custom_advice', '💰 سجّلي التوصية/ملخص التسعير على طلب التصميم',
        'تنفيذ حقيقي: ملخص قصير من المسودة يتسجل في خانة التوصية على طلب التصميم الخاص — القيمة السابقة محفوظة والاسترجاع بضغطة.',
        'custom_advice', { request_id: Number(job.subject_ref), text });
    }
  }
  return out;
}

/* ---------- extra real facts shown on every card ---------- */
const ORDER_STATUS_AR = {
  new: 'مسجّل', confirmed: 'مؤكد', cut: 'القص', sewing: 'الخياطة',
  ready: 'جاهزة للتسليم', delivering: 'في التوصيل', delivered: 'اتسلمت', cancelled: 'ملغي',
};
const CUSTOM_STATUS_AR = {
  review: 'بانتظار التسعير', receipt_pending: 'بانتظار إيصال العربون', confirmed: 'مؤكد', rejected: 'مرفوض',
};

function contextFactsForJob(job) {
  if (!job || !job.subject_type || !job.subject_ref) return [];
  try {
    if (job.subject_type === 'order') {
      const o = get(
        `SELECT o.code, o.status, o.promise_date, o.created_at,
                COALESCE(NULLIF(o.contact_name,''), c.name) AS cname,
                (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id) AS items
         FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`,
        String(job.subject_ref)
      );
      if (!o) return [];
      return [
        { label: 'العميلة', value: o.cname || '—' },
        { label: 'حالة الطلب', value: ORDER_STATUS_AR[o.status] || o.status },
        { label: 'عدد القطع', value: String(o.items || 0) },
        { label: 'تاريخ الطلب', value: String(o.created_at || '').slice(0, 10) },
        { label: 'موعد التسليم', value: o.promise_date ? String(o.promise_date).slice(0, 10) : 'لسه بدون ميعاد' },
      ];
    }
    if (job.subject_type === 'custom_request') {
      const r = get('SELECT id, status, created_at, price FROM custom_requests WHERE id = ?', Number(job.subject_ref));
      if (!r) return [];
      return [
        { label: 'حالة طلب التصميم', value: CUSTOM_STATUS_AR[r.status] || r.status },
        { label: 'تاريخ الطلب', value: String(r.created_at || '').slice(0, 10) },
        { label: 'التسعير', value: r.price ? 'متسعّر' : 'لسه بدون سعر' },
      ];
    }
    if (job.subject_type === 'catalogue') {
      if (job.kind === 'collection_copy_draft') return [];
      const s = get("SELECT id, name, note, active FROM styles WHERE id = ? AND type = 'made'", String(job.subject_ref));
      if (!s) return [];
      return [
        { label: 'الموديل', value: s.name || s.id },
        { label: 'حالة الوصف', value: (s.note && String(s.note).trim()) ? 'مكتمل' : 'ناقص' },
        { label: 'نشط على الموقع', value: s.active ? 'نعم' : 'لا' },
      ];
    }
  } catch (_) {}
  return [];
}

/* ---------- apply records ---------- */
function rowToApply(r) {
  if (!r) return null;
  let before = null;
  let after = null;
  try { before = r.before_json ? JSON.parse(r.before_json) : null; } catch (_) { before = null; }
  try { after = r.after_json ? JSON.parse(r.after_json) : null; } catch (_) { after = null; }
  return {
    id: r.id,
    job_id: r.job_id,
    suggestion_id: r.suggestion_id,
    tool: r.tool,
    subject_type: r.subject_type,
    subject_ref: r.subject_ref,
    summary_ar: r.summary_ar,
    before,
    after,
    verified: !!r.verified,
    restorable: !!r.restorable && !r.restored_at,
    actor: r.actor,
    created_at: r.created_at,
    restored_at: r.restored_at || null,
  };
}

function appliesForJob(jobId) {
  return all(
    'SELECT * FROM office_suggestion_applies WHERE job_id = ? ORDER BY created_at DESC, id DESC LIMIT 10',
    String(jobId || '')
  ).map(rowToApply);
}

function recordApply({ jobId, suggestionId, tool, subjectType, subjectRef, summaryAr, before, after, verified, restorable, actor }) {
  const id = `ap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  run(
    `INSERT INTO office_suggestion_applies(id, job_id, suggestion_id, tool, subject_type, subject_ref, summary_ar, before_json, after_json, verified, restorable, actor, created_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, String(jobId), String(suggestionId), tool, String(subjectType), String(subjectRef),
    summaryAr, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
    verified ? 1 : 0, restorable ? 1 : 0, String(actor.id || actor), Date.now()
  );
  return rowToApply(get('SELECT * FROM office_suggestion_applies WHERE id = ?', id));
}

function arStamp() {
  return new Date().toISOString().slice(0, 16).replace('T', ' ');
}

/* ---------- the real tools (one narrow change + verify + undo value) ---------- */
function toolOrderNote(job, params, actor) {
  let order = get('SELECT id, code, note FROM orders WHERE code = ?', String(params.order_code || ''));
  if (!order && /^\d+$/.test(String(params.order_code || ''))) {
    order = get('SELECT id, code, note FROM orders WHERE id = ?', Number(params.order_code));
  }
  if (!order) throw new ConflictError('subject_not_active', 'الطلب غير موجود أو اتقفل');
  const line = cleanNote(`ملاحظة المكتب (${arStamp()}): ${params.title || 'مسودة متابعة'} — اتحضرت من بيانات الطلب وراجعتها المالكة.`, 260);
  if (!line) throw new PolicyError('invalid_note_text', 'نص الملاحظة غير صالح');
  const oldNote = order.note || '';
  const merged = oldNote ? `${oldNote}\n${line}` : line;
  if (merged.length > 1000) throw new PolicyError('note_limit_reached', 'ملاحظات الطلب اتملت — نظّفي الملاحظات القديمة الأول');
  run('UPDATE orders SET note = ?, updated_at = ? WHERE id = ?', merged, new Date().toISOString().replace('T', ' ').slice(0, 19), order.id);
  const after = get('SELECT note FROM orders WHERE id = ?', order.id);
  const verified = !!(after && after.note === merged);
  if (!verified) throw new ConflictError('execution_verification_failed', 'تعذر التحقق من كتابة الملاحظة؛ التعديل تراجع');
  audit('order', order.id, 'office_note_applied', actor.id, { added: line });
  return {
    tool: 'order_note',
    summary_ar: `سطر «${line}» اتسجل في ملاحظات الطلب ${order.code}`,
    before: { note: oldNote },
    after: { note: merged, order_code: order.code },
    verified,
    restorable: true,
  };
}

function toolSetPromiseDate(job, params, actor) {
  const { setPromiseDateOnly } = require('./order-lifecycle');
  const res = setPromiseDateOnly(String(params.order_code || ''), String(params.proposed_date || ''), `office:${actor.id}`);
  return {
    tool: 'set_promise_date',
    summary_ar: res.changed
      ? `موعد التسليم على الطلب ${res.code} اتحدد بـ ${res.new_date} (كان ${res.old_date || 'بدون ميعاد'})`
      : `موعد التسليم على الطلب ${res.code} مطبق بالفعل بـ ${res.new_date}`,
    before: { promise_date: res.old_date || null },
    after: { promise_date: res.new_date || null, order_code: res.code },
    verified: res.changed ? !!res.verified : true,
    restorable: !!res.changed,
  };
}

function toolStyleNote(job, params, actor) {
  const style = get("SELECT id, name, note FROM styles WHERE id = ? AND type = 'made'", String(params.style_id || ''));
  if (!style) throw new ConflictError('subject_not_active', 'الموديل غير موجود أو غير متاح');
  const note = cleanNote(params.new_note, 500);
  if (!note) throw new PolicyError('invalid_proposed_note', 'النص المقترح غير صالح (حتى ٥٠٠ حرف وبدون محارف خاصة)');
  const oldNote = style.note || '';
  run('UPDATE styles SET note = ? WHERE id = ?', note, style.id);
  const after = get('SELECT note FROM styles WHERE id = ?', style.id);
  if (!after || after.note !== note) throw new ConflictError('execution_verification_failed', 'تعذر التحقق من كتابة الوصف؛ التعديل تراجع');
  require('./public-cache').invalidateCatalogue();
  audit('style', style.id, 'note_applied_from_office_card', actor.id, { old_note: oldNote, new_note: note });
  return {
    tool: 'style_note',
    summary_ar: `وصف الموديل «${style.name}» اتكتب على صفحة الموديل (${style.id})`,
    before: { note: oldNote },
    after: { note },
    verified: true,
    restorable: true,
    link: `/store/product/${encodeURIComponent(style.id)}`,
  };
}

/* Mirrors the engine's COLLECTION_SECTIONS (not exported there): same five keys. */
const COLLECTION_SECTIONS = Object.freeze({
  all: 'الكل',
  summer: 'الصيفي',
  winter: 'الشتوي',
  trend: 'المجموعة المميزة',
  offers: 'العروض',
});

function toolCollectionNote(job, params, actor) {
  const key = String(params.section || '').toLowerCase();
  if (!COLLECTION_SECTIONS[key]) throw new ConflictError('subject_not_active', 'المجموعة غير معروفة');
  const note = cleanNote(params.new_note, 500);
  if (!note) throw new PolicyError('invalid_proposed_note', 'النص المقترح غير صالح (حتى ٥٠٠ حرف وبدون محارف خاصة)');
  const oldRow = get('SELECT note FROM collection_notes WHERE section = ?', key);
  const oldNote = (oldRow && oldRow.note) || '';
  run(
    `INSERT INTO collection_notes(section, note, updated_by, updated_at) VALUES(?,?,?,datetime('now'))
     ON CONFLICT(section) DO UPDATE SET note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    key, note, `office:${actor.id}`
  );
  const after = get('SELECT note FROM collection_notes WHERE section = ?', key);
  if (!after || after.note !== note) throw new ConflictError('execution_verification_failed', 'تعذر التحقق من كتابة الوصف؛ التعديل تراجع');
  require('./public-cache').invalidateCatalogue();
  audit('collection', key, 'note_applied_from_office_card', actor.id, { old_note: oldNote, new_note: note });
  return {
    tool: 'collection_note',
    summary_ar: `وصف المجموعة «${COLLECTION_SECTIONS[key]}» اتكتب على الموقع`,
    before: { note: oldNote },
    after: { note },
    verified: true,
    restorable: true,
    link: '/store/',
  };
}

function toolCustomAdvice(job, params, actor) {
  const r = get('SELECT id, advice FROM custom_requests WHERE id = ?', Number(params.request_id || 0));
  if (!r) throw new ConflictError('subject_not_active', 'طلب التصميم غير موجود');
  const advice = cleanNote(params.text, 300);
  if (!advice) throw new PolicyError('invalid_advice_text', 'نص التوصية غير صالح (حتى ٣٠٠ حرف وبدون محارف خاصة)');
  const oldAdvice = r.advice || '';
  run('UPDATE custom_requests SET advice = ? WHERE id = ?', advice, r.id);
  const after = get('SELECT advice FROM custom_requests WHERE id = ?', r.id);
  if (!after || after.advice !== advice) throw new ConflictError('execution_verification_failed', 'تعذر التحقق من تسجيل التوصية؛ التعديل تراجع');
  audit('custom_request', r.id, 'advice_applied_from_office', actor.id, { old: oldAdvice, new: advice });
  return {
    tool: 'custom_advice',
    summary_ar: `توصية قصيرة اتسجلت على طلب التصميم CR-${r.id}`,
    before: { advice: oldAdvice },
    after: { advice },
    verified: true,
    restorable: true,
  };
}

const TOOLS = {
  order_note: toolOrderNote,
  set_promise_date: toolSetPromiseDate,
  style_note: toolStyleNote,
  collection_note: toolCollectionNote,
  custom_advice: toolCustomAdvice,
};

/* ---------- public apply/restore ---------- */
function applySuggestion(jobRow, suggestionId, actor) {
  if (actor.role !== 'owner') throw new NotFoundError('not_found', 'غير موجود');
  const suggestions = suggestionsForJob({ ...jobRow, subject_code: jobRow.subject_code }, { isOwner: true });
  const sug = suggestions.find(s => s.id === String(suggestionId || ''));
  if (!sug) throw new NotFoundError('suggestion_not_available', 'الاقتراح ده مش متاح على المسودة دي (أو المسودة اتغيرت — حدّثيها الأول)');
  const tool = TOOLS[sug.tool];
  if (!tool) throw new PolicyError('unknown_tool', 'نوع تنفيذ غير معروف');
  const params = { ...sug.params };
  if (sug.tool === 'style_note' || sug.tool === 'collection_note' || sug.tool === 'custom_advice') {
    params.new_note = jobRow.result && jobRow.result.text ? String(jobRow.result.text) : '';
    params.text = jobRow.result && jobRow.result.text ? String(jobRow.result.text) : '';
  }
  const exec = tool(jobRow, params, actor);
  const row = recordApply({
    jobId: jobRow.id,
    suggestionId: sug.id,
    tool: exec.tool || sug.tool,
    subjectType: jobRow.subject_type,
    subjectRef: jobRow.subject_ref,
    summaryAr: exec.summary_ar,
    before: exec.before,
    after: exec.after,
    verified: exec.verified,
    restorable: exec.restorable,
    actor,
  });
  return { exec, apply: row };
}

function restoreApply(jobRow, applyId, actor) {
  if (actor.role !== 'owner') throw new NotFoundError('not_found', 'غير موجود');
  const row = get('SELECT * FROM office_suggestion_applies WHERE id = ? AND job_id = ?', String(applyId || ''), String(jobRow.id));
  if (!row) throw new NotFoundError('apply_not_found', 'سجل التطبيق غير موجود');
  if (row.restored_at) throw new ConflictError('already_restored', 'القيمة السابقة رجعت بالفعل');
  if (!row.restorable) throw new PolicyError('not_restorable', 'ده سجل ملاحظة متوثقة فقط — مش تعديل قيمة بيرجع');
  let before = null;
  let after = null;
  try { before = row.before_json ? JSON.parse(row.before_json) : null; } catch (_) { before = null; }
  try { after = row.after_json ? JSON.parse(row.after_json) : null; } catch (_) { after = null; }
  if (!before) throw new ConflictError('no_previous_value', 'مفيش قيمة سابقة محفوظة لهذا التطبيق');
  const actorTag = `office-restore:${actor.id}`;
  const orderCodeForRestore = () => {
    let code = after && after.order_code ? String(after.order_code) : '';
    if (!code || !get('SELECT id FROM orders WHERE code = ?', code)) {
      const byId = get('SELECT code FROM orders WHERE id = ?', Number(row.subject_ref) || 0);
      code = byId ? byId.code : code;
    }
    return code;
  };
  if (row.tool === 'order_note') {
    const order = get('SELECT id, code FROM orders WHERE code = ?', orderCodeForRestore());
    if (!order) throw new ConflictError('subject_not_active', 'الطلب غير موجود');
    const note = cleanNote(before.note, 1000);
    if (note === null && (before.note || '').length > 0) throw new PolicyError('invalid_note_text', 'الملاحظة السابقة غير صالحة للاسترجاع');
    run('UPDATE orders SET note = ?, updated_at = ? WHERE id = ?', before.note || '', new Date().toISOString().replace('T', ' ').slice(0, 19), order.id);
    audit('order', order.id, 'office_note_restored', actor.id, {});
  } else if (row.tool === 'set_promise_date') {
    const { setPromiseDateOnly } = require('./order-lifecycle');
    const code = orderCodeForRestore();
    if (before.promise_date) {
      setPromiseDateOnly(code, String(before.promise_date), actorTag);
    }
    // a previously-empty promise date is restored by clearing it
    if (!before.promise_date) {
      run('UPDATE orders SET promise_date = NULL, updated_at = ? WHERE code = ?', new Date().toISOString().replace('T', ' ').slice(0, 19), code);
    }
    audit('order', code, 'promise_date_restored', actor.id, { restored_to: before.promise_date || null });
  } else if (row.tool === 'style_note') {
    const style = get("SELECT id FROM styles WHERE id = ? AND type = 'made'", String(row.subject_ref));
    if (!style) throw new ConflictError('subject_not_active', 'الموديل غير موجود');
    run('UPDATE styles SET note = ? WHERE id = ?', before.note || '', style.id);
    require('./public-cache').invalidateCatalogue();
    audit('style', style.id, 'note_restored_from_office_card', actor.id, {});
  } else if (row.tool === 'collection_note') {
    const key = String(row.subject_ref).toLowerCase();
    run(
      `INSERT INTO collection_notes(section, note, updated_by, updated_at) VALUES(?,?,?,datetime('now'))
       ON CONFLICT(section) DO UPDATE SET note = excluded.note, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      key, before.note || '', actorTag
    );
    require('./public-cache').invalidateCatalogue();
    audit('collection', key, 'note_restored_from_office_card', actor.id, {});
  } else if (row.tool === 'custom_advice') {
    const r = get('SELECT id FROM custom_requests WHERE id = ?', Number(row.subject_ref));
    if (!r) throw new ConflictError('subject_not_active', 'طلب التصميم غير موجود');
    run('UPDATE custom_requests SET advice = ? WHERE id = ?', before.advice || '', r.id);
    audit('custom_request', r.id, 'advice_restored', actor.id, {});
  } else {
    throw new PolicyError('unknown_tool', 'نوع استرجاع غير معروف');
  }
  run('UPDATE office_suggestion_applies SET restored_at = ? WHERE id = ?', Date.now(), row.id);
  return rowToApply(get('SELECT * FROM office_suggestion_applies WHERE id = ?', row.id));
}

module.exports = {
  suggestionsForJob,
  contextFactsForJob,
  appliesForJob,
  applySuggestion,
  restoreApply,
};
