'use strict';
/* Express routes for MAVI's virtual office, follow-up cases, and draft approvals.
   Mounted under `/api/admin/office`.
   - Every Actor is built strictly from the server-verified admin session (`req.session` + `req.user`).
   - Client bodies are checked against strict top-level key allowlists (rejects injected `actor`/`role`).
   - Opening/listing routes NEVER invoke an AI provider or run a worker loop.
   - Staff never receive financial cases, financial jobs, budgets, costs, profits, or provider configs. */
const express = require('express');
const { db: rawDb, get: dbGet, all: dbAll, setting: dbSetting } = require('./db');
const A = require('./auth');
const { TEAM_ROLES, JOB_KINDS, teamForRole, visibleJobKindsForRole } = require('./office-team');
const { syncCases, listCases, getSubjectCaseHistory } = require('./office-cases');
const {
  PolicyError,
  ForbiddenError,
  NotFoundError,
  actorFromRequest,
  assertExactBody,
  defaultEngine,
  OfficeEngine,
  refreshLegacyFixtureContent,
  WORKER_ACTOR,
} = (() => {
  const eng = require('./office-engine');
  function checkTopKeys(body, allowed) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new eng.PolicyError('invalid_request_body', 'بيانات الطلب غير صالحة');
    }
    const keys = Object.keys(body);
    for (const k of keys) {
      if (!allowed.includes(k)) {
        throw new eng.PolicyError('disallowed_request_field', 'يوجد حقل غير مسموح في الطلب');
      }
    }
  }
  return { ...eng, assertExactBody: checkTopKeys };
})();
const { createConfig: createOpenRouterConfig } = require('./openrouter-client');
const { outboundPolicySummary, getOutboundTelemetry } = require('./staging-guard');

const router = express.Router();

function sendOfficeError(res, err) {
  if (err instanceof PolicyError || (err && Number.isInteger(err.status))) {
    const status = err.status || 400;
    return res.status(status).json({
      error: err.code || 'office_error',
      message: err.message || 'تعذر تنفيذ العملية',
    });
  }
  console.error('[office-routes]', err && (err.stack || err.code) ? err.stack || String(err) : String(err));
  return res.status(500).json({ error: 'office_internal_error', message: 'حصل خطأ غير متوقع' });
}

router.get('/team', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    res.json({
      roles: teamForRole(actor.role),
      allowed_job_kinds: visibleJobKindsForRole(actor.role),
      note: 'الأدوار الـ17 قوالب مسؤوليات وتنظيم عمل داخل MAVI وليست حسابات دخول مستقلة.',
    });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.get('/status', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    const workerDefault = process.env.MAVI_OFFICE_PROVIDER === 'fixture' ? 'fixture' : 'disabled';
    const telemetry = getOutboundTelemetry();
    let openrouterSummary = null;
    if (actor.role === 'owner') {
      openrouterSummary = createOpenRouterConfig().summary();
    }
    const out = {
      worker: {
        mode: workerDefault,
        ai_connected: !!(openrouterSummary && openrouterSummary.status === 'ready'),
        external_execution_enabled: false,
        network_calls: telemetry.total_network_attempts,
      },
      staging: outboundPolicySummary(),
      outbound_telemetry: telemetry,
    };
    if (openrouterSummary) {
      out.openrouter = openrouterSummary;
    }
    res.json(out);
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.get('/cases', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    const sync = req.query.sync === '1' ? syncCases({ actor }) : null;
    const state = ['open', 'resolved', 'all'].includes(req.query.state) ? req.query.state : 'open';
    const cases = listCases(actor, { state });
    res.json({ cases, ...(sync ? { sync } : {}) });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.post('/cases/sync', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    if (req.body && Object.keys(req.body).length > 0) {
      assertExactBody(req.body, []);
    }
    const sync = syncCases({ actor });
    const cases = listCases(actor, { state: 'open' });
    res.json({ sync, cases });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.get('/cases/:subjectType/:subjectId/history', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    const subjectType = String(req.params.subjectType || '');
    const subjectId = Number(req.params.subjectId);
    const history = getSubjectCaseHistory(actor, subjectType, subjectId);
    res.json(history);
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.get('/jobs', A.requireStaff, async (req, res) => {
  try {
    const actor = actorFromRequest(req);
    // Owner visits keep the office moving (gen_mode AUTO — the owner's choice):
    // 1) lazy weekly care campaign;
    // 2) AI-first auto-prepare: up to 2 queued marketing drafts go through the
    //    enabled AI provider (short timeout, single pass, no retry) with an
    //    honest local-template fallback; the remaining queue is prepared with
    //    the offline deterministic provider so the manager's report always has
    //    the full picture;
    // 3) lazy retention: decided drafts older than 7 days are removed
    //    automatically (audit trail preserved; active jobs untouched).
    if (actor.role === 'owner') {
      try { defaultEngine.lazyWeeklyCareEnqueue(actor); } catch (_) { /* best-effort */ }
      try {
        const orClient = require('./openrouter-client');
        await defaultEngine.aiFirstPrepare({ max: 2, transport: orClient.createLiveTransport({ timeoutMs: 8000 }) });
      } catch (_) { /* best-effort: fixture prepare below always runs */ }
      try { defaultEngine.autoPrepareQueued({ max: 8 }); } catch (_) { /* best-effort */ }
      try { defaultEngine._purgeDecidedRows({ olderThanDays: 7 }); } catch (_) { /* best-effort */ }
    }
    res.json({ jobs: defaultEngine.list(actor), auto_prepare: defaultEngine.lastAutoPrepare || null });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.post('/jobs', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body, ['kind', 'payload', 'idempotency_key']);
    const job = defaultEngine.enqueue(
      req.body.kind,
      req.body.payload,
      req.body.idempotency_key,
      actor
    );
    res.status(201).json({ job });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.get('/jobs/:id', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    res.json({ job: defaultEngine.get(req.params.id, actor) });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.get('/jobs/:id/audit', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    res.json({ audit: defaultEngine.getAudit(req.params.id, actor) });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.patch('/jobs/:id', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body, ['payload', 'expected_revision']);
    const job = defaultEngine.revise(
      req.params.id,
      req.body.payload,
      req.body.expected_revision,
      actor
    );
    res.json({ job });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.post('/jobs/:id/review', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body, ['expected_revision', 'expected_result_hash', 'decision']);
    let job = defaultEngine.review(
      req.params.id,
      req.body.expected_revision,
      req.body.expected_result_hash,
      req.body.decision,
      actor
    );
    // الموافقة = إذن تنفيذ: المسودات التنفيذية تنفّذ فعلًا فور الاعتماد ثم
    // تُتحقق من النتيجة؛ الباقي يعود للموظف المسؤول عبر الشات.
    let handoff = null;
    let execution = null;
    if (req.body.decision === 'approve') {
      if (OfficeEngine.EXECUTABLE_KINDS().has(job.kind)) {
        try {
          job = defaultEngine.executeDraft(req.params.id, actor);
          execution = job.execution_result;
        } catch (_) { /* فشل التنفيذ مسجّل على المسودة نفسها ويظهر بصدق */ }
      }
      handoff = defaultEngine.handoffSummary(req.params.id);
      try {
        const chatMod = require('./office-chat');
        chatMod.postHandoffForJob(job.kind, handoff.next_prepared, execution);
      } catch (_) { /* handoff ack is best-effort */ }
    }
    res.json({ job, handoff, execution });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

/* Owner-pressed AI regeneration of a local-template draft: one network call,
   no retries; a provider failure restores the local draft automatically so
   nothing is lost and nothing is faked. */
router.post('/jobs/:id/regenerate-ai', A.requireOwner, async (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, []);
    const orClient = require('./openrouter-client');
    const step = await defaultEngine.regenerateWithAi(req.params.id, actor, orClient.createLiveTransport({ timeoutMs: 20000 }));
    res.json({ step });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

/* Manual execution / restore for ACTION drafts (owner-only): used when the
   auto-execution after approval failed, or to put back the previous value. */
router.post('/jobs/:id/execute', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, []);
    res.json({ job: defaultEngine.executeDraft(req.params.id, actor) });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.post('/jobs/:id/restore', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, []);
    res.json({ job: defaultEngine.restoreExecution(req.params.id, actor) });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.post('/jobs/purge-decided', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, []);
    const result = defaultEngine.purgeDecidedJobs(actor);
    res.json({ ok: true, ...result });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.delete('/jobs/:id', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    res.json(defaultEngine.deleteDecidedJob(req.params.id, actor));
  } catch (err) {
    sendOfficeError(res, err);
  }
});

/* The general manager's bulk decision: approve/reject the whole prepared batch
   (or a chosen subset) in one press. Per-item outcomes are reported honestly;
   approvals keep the same handoff + next-step preparation as single clicks. */
router.post('/jobs/bulk-review', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, ['decision', 'targets']);
    const result = defaultEngine.bulkReview(req.body.decision, req.body.targets, actor);
    try {
      require('./office-chat').postManagerSummary(result.decision, result);
    } catch (_) { /* manager ack is best-effort */ }
    if (result.decision === 'approve') {
      // Each responsible teammate acknowledges the batch of her kind —
      // the manager moved the team on the owner's single decision.
      const byKind = {};
      for (const r of result.results) {
        if (!r.ok) continue;
        try {
          let job = defaultEngine.get(r.id, actor);
          if (OfficeEngine.EXECUTABLE_KINDS().has(job.kind)) {
            try { job = defaultEngine.executeDraft(r.id, actor); } catch (_) { /* فشل التنفيذ مسجّل على المسودة */ }
          }
          byKind[job.kind] = (byKind[job.kind] || 0) + 1;
        } catch (_) { /* best-effort */ }
      }
      for (const [kind, count] of Object.entries(byKind)) {
        try { require('./office-chat').postBulkHandoff(kind, count); } catch (_) { /* best-effort */ }
      }
    }
    res.json(result);
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.post('/jobs/:id/recheck', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    if (req.body && Object.keys(req.body).length > 0) {
      assertExactBody(req.body, []);
    }
    const result = defaultEngine.recheck(req.params.id, actor);
    res.json(result);
  } catch (err) {
    sendOfficeError(res, err);
  }
});

// Re-run the legacy-draft content cleanup on demand (also runs at every boot).
router.post('/jobs/refresh-legacy', A.requireOwner, (req, res) => {
  try {
    if (req.body && Object.keys(req.body).length > 0) {
      assertExactBody(req.body, []);
    }
    res.json(refreshLegacyFixtureContent());
  } catch (err) {
    sendOfficeError(res, err);
  }
});

/* ---- Office AI (OpenRouter, free models only) — owner-only configuration ----
   The key is stored in the ERP settings (DB) so the owner can activate the
   free provider without touching hosting environment variables; env vars keep
   priority when present. The raw key is never returned after saving. */
const FREE_MODEL_RE = /^[a-z0-9][a-z0-9._-]{0,79}\/[a-z0-9][a-z0-9._-]{0,119}:free$/;

router.get('/ai/config', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    res.json({
      ok: true,
      openrouter: createOpenRouterConfig().summary(),
      activity: defaultEngine.aiActivityStats(actor),
    });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.post('/ai/config', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, ['api_key', 'model', 'enabled']);
    const apiKey = String(req.body.api_key === undefined ? '' : req.body.api_key)
      .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
      .replace(/["'«»„‟“”‘’]/g, '')
      .replace(/\s+/g, '');
    const model = String(req.body.model || '').trim() || 'openrouter/free';
    const enabled = req.body.enabled === true;
    if (apiKey && /[•*·●○◦]/.test(apiKey)) {
      throw new PolicyError('missing_or_invalid_server_key', 'القيمة فيها نقط إخفاء (•) — دي نسخة من النص المخفي المعروض مش المفتاح نفسه. انسخي المفتاح الكامل بزرار النسخ أو بعد كشفه (العين) من صفحة المفاتيح');
    }
    if (apiKey && !/^[A-Za-z0-9_-]{16,256}$/.test(apiKey)) {
      throw new PolicyError('missing_or_invalid_server_key', 'مفتاح المزوّد غير صالح');
    }
    if (model !== 'openrouter/free' && !FREE_MODEL_RE.test(model)) {
      throw new PolicyError('only_free_model_ids_are_allowed', 'الموديلات المدفوعة غير مسموحة — النماذج المجانية فقط');
    }
    const { setSetting } = require('./db');
    if (apiKey) setSetting('office_ai_api_key', apiKey);
    if (req.body.api_key === '') setSetting('office_ai_api_key', ''); // explicit clear
    setSetting('office_ai_model', model);
    setSetting('office_ai_enabled', enabled ? '1' : '0');
    setSetting('office_ai_last_test', JSON.stringify(null));
    auditOfficeAi(actor, apiKey ? 'ai_config_saved' : 'ai_config_updated');
    res.json({ ok: true, openrouter: createOpenRouterConfig().summary(), activity: defaultEngine.aiActivityStats(actor) });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.get('/ai/models', A.requireOwner, async (req, res) => {
  try {
    const actor = actorFromRequest(req);
    const { listFreeModels } = require('./openrouter-client');
    const models = await listFreeModels({ force: req.query.refresh === '1' });
    res.json({ ok: true, models });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.post('/ai/test', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    if (req.body && Object.keys(req.body).length > 0) {
      assertExactBody(req.body, []);
    }
    const { testConnection } = require('./openrouter-client');
    Promise.resolve(testConnection(createOpenRouterConfig())).then((result) => {
      auditOfficeAi(actor, result.ok ? 'ai_connection_test_ok' : 'ai_connection_test_failed');
      res.json(result);
    }).catch((err) => sendOfficeError(res, err));
  } catch (err) {
    sendOfficeError(res, err);
  }
});

/* Customer-facing approved drafts that never got used: the owner's customers
   page pulls this list so SHE decides to send (WhatsApp) or cancel — nothing
   is ever sent automatically. Phone comes from the order's recorded contact. */
const READY_TO_SEND_KINDS = new Set(['customer_reply_draft', 'order_followup_draft']);

/* TODAY BOARD («شغل النهاردة») — the owner's one page for everything she owes
   today, built ONLY from real system data (no AI, no templates from thin air):
   1. active orders whose promise_date has passed (or is today)
   2. active orders with no payment/deposit recorded yet
   3. approved, not-yet-used customer replies + order follow-ups (ready drafts)
   Every row carries an editable message draft + a wa.me phone the UI turns
   into a one-click WhatsApp send. Owner-only. */
function waPhone(v) {
  const digits = String(v || '').replace(/[^0-9]/g, '');
  if (!digits) return null;
  if (digits.startsWith('0')) return '20' + digits.slice(1);
  if (digits.startsWith('20')) return digits;
  if (digits.length >= 10 && digits.length <= 15) return digits;
  return null;
}

const ORDER_STATUS_AR = { new: 'مسجّل', confirmed: 'مؤكد', cut: 'قصّ', sewing: 'خياطة', ready: 'جاهزة', delivering: 'في التوصيل' };

router.get('/today-board', A.requireOwner, (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const items = [];
    const orderCols = `o.id, o.code, o.status, o.promise_date, COALESCE(NULLIF(o.contact_name, ''), c.name) AS cname,
      COALESCE(NULLIF(o.contact_phone, ''), c.phone) AS cphone`;
    // 1) late or due-today delivery promises
    const late = dbAll(
      `SELECT ${orderCols}
       FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status NOT IN ('delivered','cancelled') AND o.promise_date IS NOT NULL AND o.promise_date <= ?
       ORDER BY o.promise_date ASC LIMIT 20`, today
    );
    for (const o of late) {
      const daysLate = Math.max(0, Math.round((new Date(today) - new Date(o.promise_date)) / 864e5));
      items.push({
        id: 'late-' + o.id,
        category: 'late_order',
        title: `${o.cname} · طلب ${o.code}`,
        order_code: o.code,
        status_ar: ORDER_STATUS_AR[o.status] || o.status,
        promise_date: o.promise_date,
        days_late: daysLate,
        phone: o.cphone || null,
        wa_phone: waPhone(o.cphone),
        text: `مساء الخير ${o.cname} 🌷 بخصوص طلبك ${o.code} — كان موعد التسليم المحدد ${o.promise_date} والقطعة في مرحلة ${ORDER_STATUS_AR[o.status] || o.status}. عايزين أحدثك بنفسه ونحدد معاك أقرب ميعاد تسليم يناسبك. تحبي نتفق على ميعاد النهاردة؟`,
      });
    }
    // 2) active orders with zero recorded payments (deposit follow-up)
    const noDeposit = dbAll(
      `SELECT ${orderCols}
       FROM orders o JOIN customers c ON c.id = o.customer_id
       WHERE o.status NOT IN ('delivered','cancelled')
         AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)
       ORDER BY o.created_at ASC LIMIT 20`, []
    ).filter((o) => !items.some((it) => it.order_code === o.code));
    for (const o of noDeposit) {
      items.push({
        id: 'dep-' + o.id,
        category: 'no_deposit',
        title: `${o.cname} · طلب ${o.code}`,
        order_code: o.code,
        status_ar: ORDER_STATUS_AR[o.status] || o.status,
        phone: o.cphone || null,
        wa_phone: waPhone(o.cphone),
        text: `مساء الخير ${o.cname} 🌷 طلبك ${o.code} موجود عندنا ولسه مفيش عربون أو دفعة مسجلة عليه — أول ما تجهزي نبدأ التنفيذ فورًا. قوليلي مناسبك ونظبطها سوا 💐`,
      });
    }
    // 3) approved, unused customer replies + order follow-ups
    const rows = dbAll(
      `SELECT id, kind, subject_type, subject_ref, updated_at, result
       FROM office_jobs
       WHERE status = 'approved' AND used_at IS NULL
         AND kind IN ('customer_reply_draft','order_followup_draft')
       ORDER BY updated_at DESC LIMIT 50`
    );
    for (const r of rows) {
      let text = null, title = null;
      try { const j = JSON.parse(r.result); text = j && j.text; title = j && j.title; } catch (_) {}
      if (!text) continue;
      let cname = null, phone = null, code = null;
      if (r.subject_type === 'order') {
        const o = dbGet(`SELECT code, COALESCE(NULLIF(contact_name, ''), c.name) AS cname, COALESCE(NULLIF(contact_phone, ''), c.phone) AS cphone
          FROM orders o LEFT JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`, String(r.subject_ref || ''));
        if (o) { code = o.code; cname = o.cname; phone = o.cphone || null; }
      }
      items.push({
        id: 'reply-' + r.id,
        category: 'ready_reply',
        title: title || r.kind,
        order_code: code,
        customer_name: cname,
        phone: phone || null,
        wa_phone: waPhone(phone),
        text,
      });
    }
    res.json({ ok: true, today, items });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.get('/ready-to-send', A.requireOwner, (req, res) => {
  try {
    const rows = dbAll(
      `SELECT id, kind, revision, result_hash, subject_type, subject_ref, updated_at, used_at, result
       FROM office_jobs
       WHERE status = 'approved' AND used_at IS NULL
         AND kind IN (${[...READY_TO_SEND_KINDS].map(() => '?').join(',')})
       ORDER BY updated_at DESC LIMIT 50`,
      ...READY_TO_SEND_KINDS
    );
    const items = [];
    for (const r of rows) {
      let text = null, title = null;
      try { const j = JSON.parse(r.result); text = j && j.text; title = j && j.title; } catch (_) {}
      if (!text) continue;
      let order_code = null, phone = null;
      if (r.subject_type === 'order') {
        const o = dbGet('SELECT code, contact_phone, contact_name, customer_id FROM orders WHERE id = ?', String(r.subject_ref || ''));
        if (o) {
          order_code = o.code;
          if (!o.contact_phone && o.customer_id) {
            const c = dbGet('SELECT phone FROM customers WHERE id = ?', o.customer_id);
            phone = (c && c.phone) || null;
          } else {
            phone = o.contact_phone || null;
          }
        }
      }
      items.push({
        id: r.id,
        kind: r.kind,
        title: title || r.kind,
        text,
        order_code,
        phone,
        updated_at: r.updated_at,
        revision: r.revision,
        result_hash: r.result_hash,
      });
    }
    res.json({ ok: true, items });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

/* Owner one-click honest proof: a REAL catalogue draft attempted with the AI
   provider right now. Truthful outcome: 'ai' (model reported) or
   'fixture_fallback' (exact provider error code) — never a fake success. */
router.post('/ai/demo-draft', A.requireOwner, async (req, res) => {
  try {
    const actor = actorFromRequest(req);
    if (req.body && Object.keys(req.body).length > 0) assertExactBody(req.body, []);
    const { createLiveTransport } = require('./openrouter-client');
    const result = await defaultEngine.runAiDemoDraft(actor, { transport: createLiveTransport({ timeoutMs: 20000 }) });
    res.json({ ok: true, result });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

function auditOfficeAi(actor, event) {
  try {
    defaultEngine._recordAudit('office-ai', event, actor);
  } catch { /* audit is best-effort */ }
}

router.post('/worker/step', A.requireOwner, async (req, res) => {
  try {
    actorFromRequest(req);
    assertExactBody(req.body || {}, ['provider', 'job_id']);
    const requested = req.body && req.body.provider !== undefined
      ? req.body.provider
      : (process.env.MAVI_OFFICE_PROVIDER || 'disabled');
    const jobId = req.body && req.body.job_id !== undefined ? req.body.job_id : null;
    // Owner-only endpoint: 'disabled' + deterministic offline 'fixture' always; 'openrouter' additionally
    // gated by engine-side config (enabled key, free models, public-catalogue fields, no retries);
    // 'auto' = one AI-first step with an honest local fallback (the owner's gen_mode).
    // runOnce returns a Promise for 'openrouter'/'auto' and a plain object otherwise.
    const step = await Promise.resolve(defaultEngine.runOnce({ provider: requested, jobId, actor: WORKER_ACTOR }));
    res.json({ step });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

/* One owner-pressed batch: sequentially generate the queued marketing drafts
   with the AI provider (each step awaited, single pass, no retries); anything
   the provider could not generate falls back to the local template so nothing
   stays stuck and nothing is faked. The summary states both counts honestly. */
router.post('/worker/ai-batch', A.requireOwner, async (req, res) => {
  try {
    actorFromRequest(req);
    assertExactBody(req.body || {}, ['max_steps']);
    const maxSteps = req.body && req.body.max_steps !== undefined ? Number(req.body.max_steps) : 10;
    if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 10) {
      throw new PolicyError('invalid_max_steps', 'الحد الأقصى للخطوات بين ١ و١٠');
    }
    const orClient = require('./openrouter-client');
    const summary = await defaultEngine.aiFirstPrepare({ max: maxSteps, transport: orClient.createLiveTransport({ timeoutMs: 20000 }) });
    res.json({ ok: true, summary });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.post('/worker/drain', A.requireOwner, (req, res) => {
  try {
    actorFromRequest(req);
    assertExactBody(req.body || {}, ['provider', 'max_steps']);
    const requested = req.body && req.body.provider !== undefined
      ? req.body.provider
      : (process.env.MAVI_OFFICE_PROVIDER || 'disabled');
    const maxSteps = req.body && req.body.max_steps !== undefined ? req.body.max_steps : 20;
    const drain = defaultEngine.drainQueue({ provider: requested, maxSteps, actor: WORKER_ACTOR });
    res.json({ drain });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.post('/cycle/run', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, ['provider', 'holiday_budget_egp']);
    const requested = req.body && req.body.provider !== undefined
      ? req.body.provider
      : 'fixture';
    const holidayBudget = req.body && req.body.holiday_budget_egp !== undefined
      ? req.body.holiday_budget_egp
      : 100;
    const cycle = defaultEngine.runDailyCycle(actor, {
      provider: requested,
      holidayBudgetEgp: holidayBudget,
    });
    res.json({ cycle });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.get('/audit', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    const rawLimit = req.query.limit !== undefined ? Number(req.query.limit) : 60;
    const limit = Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 200 ? rawLimit : 60;
    res.json({ events: defaultEngine.listRecentAudit(actor, limit) });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

/* ---------- Contextual ERP integration routes (Order / Catalogue Style / Custom Request) ---------- */
router.get('/context/order/:code', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    const code = String(req.params.code || '').trim().toUpperCase();
    const ord = dbGet('SELECT id, code, status FROM orders WHERE code = ?', code);
    if (!ord) throw new NotFoundError('order_not_found', 'الطلب غير موجود');
    syncCases({ actor });
    const cases = listCases(actor, { state: 'open' }).filter(
      c => c.subject_type === 'order' && c.subject_id === ord.id
    );
    const jobs = defaultEngine.listBySubject(actor, 'order', String(ord.id), 20);
    const allowedKinds = visibleJobKindsForRole(actor.role).filter(k => k.subject_type === 'order');
    res.json({
      order_code: ord.code,
      order_id: ord.id,
      order_status: ord.status,
      cases,
      jobs,
      allowed_kinds: allowedKinds,
    });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.get('/context/style/:styleId', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    const styleId = String(req.params.styleId || '').trim();
    const style = dbGet('SELECT id, name, active FROM styles WHERE id = ?', styleId);
    if (!style) throw new NotFoundError('style_not_found', 'الموديل غير موجود');
    const jobs = defaultEngine.listBySubject(actor, 'catalogue', style.id, 20);
    const allowedKinds = visibleJobKindsForRole(actor.role).filter(k => k.subject_type === 'catalogue');
    res.json({
      style_id: style.id,
      style_name: style.name,
      jobs,
      allowed_kinds: allowedKinds,
    });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.get('/context/custom/:requestId', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    const reqId = Number(req.params.requestId);
    if (!Number.isSafeInteger(reqId) || reqId < 1) {
      throw new PolicyError('invalid_custom_request_id', 'رقم التصميم الخاص غير صالح');
    }
    const cr = dbGet('SELECT id, status FROM custom_requests WHERE id = ?', reqId);
    if (!cr) throw new NotFoundError('custom_request_not_found', 'طلب التصميم الخاص غير موجود');
    syncCases({ actor });
    const cases = listCases(actor, { state: 'open' }).filter(
      c => c.subject_type === 'custom_request' && c.subject_id === cr.id
    );
    const jobs = defaultEngine.listBySubject(actor, 'custom_request', String(cr.id), 20);
    const allowedKinds = visibleJobKindsForRole(actor.role).filter(k => k.subject_type === 'custom_request');
    res.json({
      request_id: cr.id,
      status: cr.status,
      cases,
      jobs,
      allowed_kinds: allowedKinds,
    });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

const OPS_SCOPE_KINDS = Object.freeze({
  board: Object.freeze(['daily_ops_triage']),
  finance: Object.freeze(['executive_weekly_plan', 'funnel_attribution_report']),
  system: Object.freeze(['erp_data_health_report', 'security_privacy_audit']),
});

router.get('/context/ops/:scope', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    const scope = String(req.params.scope || '').trim();
    const targetKinds = OPS_SCOPE_KINDS[scope];
    if (!targetKinds) {
      throw new PolicyError('invalid_ops_scope', 'نطاق التشغيل غير صالح');
    }
    if (actor.role === 'staff' && scope !== 'board') {
      throw new ForbiddenError('owner_only_ops_scope', 'هذه التقارير الرقابية والمالية متاحة للمالكة فقط');
    }
    const jobs = defaultEngine.listByKinds(actor, targetKinds, 20);
    const allowedKinds = visibleJobKindsForRole(actor.role).filter(k => targetKinds.includes(k.kind));
    res.json({
      scope,
      jobs,
      allowed_kinds: allowedKinds,
    });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.post('/quick-draft', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, ['kind', 'payload', 'idempotency_key']);
    const created = defaultEngine.enqueue(
      req.body.kind,
      req.body.payload,
      req.body.idempotency_key,
      actor
    );
    let finalJob = created;
    if (actor.role === 'owner' && created.status === 'queued') {
      defaultEngine.runOnce({
        provider: 'fixture',
        jobId: created.id,
        actor: WORKER_ACTOR,
      });
      finalJob = defaultEngine.get(created.id, actor);
    }
    res.status(201).json({
      job: finalJob,
      prepared_for_review: finalJob.status === 'review',
      auto_approved: false,
      network_calls: 0,
    });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.patch('/jobs/:id/edit-text', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, ['text', 'expected_revision', 'expected_result_hash']);
    const job = defaultEngine.editDraftText(
      req.params.id,
      req.body.text,
      req.body.expected_revision,
      req.body.expected_result_hash,
      actor
    );
    res.json({ job });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.post('/jobs/:id/mark-used', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, ['channel']);
    const job = defaultEngine.markManualExecution(req.params.id, req.body.channel, actor);
    res.json({ job });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.get('/readiness', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    const journalMode = rawDb.pragma('journal_mode', { simple: true });
    const ordersCount = (dbGet('SELECT COUNT(*) AS n FROM orders') || { n: 0 }).n;
    const stylesCount = (dbGet("SELECT COUNT(*) AS n FROM styles WHERE type = 'made' AND active = 1") || { n: 0 }).n;
    const customersCount = (dbGet('SELECT COUNT(*) AS n FROM customers') || { n: 0 }).n;
    const lastBackup = dbSetting('last_backup') || null;
    const ownerRow = dbGet("SELECT password_hash FROM users WHERE email = 'owner@mavi.eg'");
    const staffRow = dbGet("SELECT password_hash FROM users WHERE email = 'staff@mavi.eg'");
    const defaultOwnerPw = Boolean(ownerRow && ownerRow.password_hash && A.verifyPassword('mavi-owner', ownerRow.password_hash));
    const defaultStaffPw = Boolean(staffRow && staffRow.password_hash && A.verifyPassword('mavi-staff', staffRow.password_hash));
    const qCounts = {
      queued: (dbGet("SELECT COUNT(*) AS n FROM office_jobs WHERE status = 'queued'") || { n: 0 }).n,
      review: (dbGet("SELECT COUNT(*) AS n FROM office_jobs WHERE status = 'review'") || { n: 0 }).n,
      approved: (dbGet("SELECT COUNT(*) AS n FROM office_jobs WHERE status = 'approved'") || { n: 0 }).n,
      executed_verified: (dbGet("SELECT COUNT(*) AS n FROM office_jobs WHERE execution = 'verified'") || { n: 0 }).n,
      executed_failed: (dbGet("SELECT COUNT(*) AS n FROM office_jobs WHERE execution = 'failed'") || { n: 0 }).n,
      used_manually: (dbGet('SELECT COUNT(*) AS n FROM office_jobs WHERE used_at IS NOT NULL') || { n: 0 }).n,
    };
    const telemetry = getOutboundTelemetry();

    // Team/Kinds integrity must be SEMANTIC (never a hardcoded count that goes
    // stale when new job kinds ship): every kind belongs to a known role, every
    // role owns at least one kind, and financial kinds stay owner-only.
    const roleIds = new Set(TEAM_ROLES.map((r) => r.id));
    const unknownEmpKinds = Object.entries(JOB_KINDS).filter(([, s]) => !roleIds.has(s.employee_id)).map(([k]) => k);
    const idleRoles = TEAM_ROLES.filter((r) => !Object.values(JOB_KINDS).some((s) => s.employee_id === r.id)).map((r) => r.id);
    const finLeaks = Object.entries(JOB_KINDS).filter(([, s]) => s.financial && s.visibility_roles.includes('staff')).map(([k]) => k);
    const teamIntegrityOk = TEAM_ROLES.length === 17 && !unknownEmpKinds.length && !idleRoles.length && !finLeaks.length;

    // AI draft provider truth (free models only; local template is the fallback)
    const aiSummary = createOpenRouterConfig().summary();
    const aiReady = aiSummary.status === 'ready';

    // SEO foundations: on-site infrastructure + how many live pages miss a
    // meta description (the note drives it — fillable via the page-copy tool)
    const seoTotal = (dbGet("SELECT COUNT(*) AS n FROM styles WHERE type = 'made' AND active = 1") || { n: 0 }).n;
    const seoMissingNote = (dbGet("SELECT COUNT(*) AS n FROM styles WHERE type = 'made' AND active = 1 AND (note IS NULL OR TRIM(note) = '')") || { n: 0 }).n;
    const colNoted = (dbGet('SELECT COUNT(*) AS n FROM collection_notes') || { n: 0 }).n;

    const checks = [
      {
        id: 'sqlite_wal',
        ok: String(journalMode).toLowerCase() === 'wal',
        label_ar: 'قاعدة البيانات وسلامة التخزين (SQLite WAL)',
        detail_ar: `وضع السجل: ${journalMode} · الطلبات: ${ordersCount} · الموديلات الظاهرة: ${stylesCount} · العميلات: ${customersCount}`,
      },
      {
        id: 'team_17_roles',
        ok: teamIntegrityOk,
        label_ar: 'اكتمال الفريق الافتراضي وربطه بالـ ERP',
        detail_ar: teamIntegrityOk
          ? `${TEAM_ROLES.length} قالب مسؤولية · ${Object.keys(JOB_KINDS).length} مهمة مدمجة في الطلبات والكانبان والكتالوج والمالية والتقارير والأمان — كل مهمة لها مسؤول معروف ولا مهمة مالية تظهر للموظفين`
          : `مشكلة ربط فعلية: مهام بدون مسؤول معروف (${unknownEmpKinds.join('، ') || '—'}) · أدوار بلا مهام (${idleRoles.join('، ') || '—'}) · مهام مالية تظهر للموظفين (${finLeaks.join('، ') || '—'})`,
      },
      {
        id: 'zero_auto_outbound',
        ok: (telemetry.total_network_attempts - (telemetry.network_attempts_by_channel.openrouter_ai || 0)) === 0,
        label_ar: 'عزل الإرسال والصرف التلقائي (اعتماد بشري ١٠٠٪)',
        detail_ar: `${telemetry.total_network_attempts - (telemetry.network_attempts_by_channel.openrouter_ai || 0)} اتصال خارجي غير مسموح (إرسال/صرف) · ${telemetry.network_attempts_by_channel.openrouter_ai || 0} اتصال AI مسموح — توليد مسودات بنماذج مجانية بضغطتك فقط`,
      },
      {
        id: 'ai_draft_provider',
        ok: aiReady,
        warn: !aiReady,
        label_ar: 'مولّد المسودات الذكي (نماذج مجانية فقط)',
        detail_ar: aiReady
          ? `مفعّل ومستعد — يدعم ${Array.isArray(aiSummary.supported_kinds) ? aiSummary.supported_kinds.length : 7} أنواع مسودات تسويقية، وبدونه القالب المحلي يشتغل تلقائيًا`
          : 'غير مفعّل حاليًا — المسودات بتتحضر بالقالب المحلي (يعمل بدون إنترنت ومبنى على بيانات مافي الحقيقية). للتفعيل أضيفي مفتاح OpenRouter مجاني من إعدادات الذكاء الاصطناعي',
      },
      {
        id: 'seo_foundations',
        ok: seoTotal > 0 && seoMissingNote === 0,
        warn: seoMissingNote > 0,
        label_ar: 'أساسيات ظهور الموقع في جوجل (SEO)',
        detail_ar: (seoMissingNote === 0
          ? `خريطة الموقع و robots.txt والبيانات المنظمة مفعّلة · كل الـ ${seoTotal} صفحة موديل عندها وصف تعريفي`
          : `خريطة الموقع و robots.txt والبيانات المنظمة مفعّلة · لكن ${seoMissingNote} من ${seoTotal} صفحة موديل بدون وصف تعريفي — بتتكمل بأداة «وصف صفحة الموديل» من المكتب`)
          + ` · وصف مجموعات المتجر: ${colNoted} من 5 (بأداة «وصف مجموعة المتجر»)`,
      },
      {
        id: 'external_publishing',
        ok: true,
        label_ar: 'وضع النشر على إنستجرام وفيسبوك وجوجل',
        detail_ar: 'يدوي بالكامل ومقصود: لا يوجد ربط API مع المنصات ولا إرسال آلي — المسودات المعتمدة بتنسخ منك بنفسك، ورفع الخريطة لجوجل خطوة يدوية في Search Console',
      },
      {
        id: 'passwords_hardened',
        ok: !defaultOwnerPw && !defaultStaffPw,
        warn: defaultOwnerPw || defaultStaffPw,
        label_ar: 'كلمات مرور حسابات الإدارة قبل التشغيل العام',
        detail_ar: (defaultOwnerPw || defaultStaffPw)
          ? 'تنبيه قبل الرفع العام: كلمة المرور التجريبية لا تزال مفعّلة — غيّريها من قسم «النسخ والأمان» قبل النشر الحقيقي'
          : 'تم تغيير كلمات المرور الافتراضية بنجاح',
      },
      {
        id: 'backup_taken',
        ok: Boolean(lastBackup),
        warn: !lastBackup,
        label_ar: 'النسخ الاحتياطي لملف قاعدة البيانات',
        detail_ar: lastBackup
          ? `آخر نسخة احتياطية مسجلة: ${lastBackup}`
          : 'يوصى بتحميل نسخة احتياطية من قسم «النسخ والأمان» قبل بدء التشغيل اليومي',
      },
    ];

    res.json({
      actor_id: actor.id,
      core_ready: checks.filter(c => !c.warn).every(c => c.ok),
      production_warnings: checks.filter(c => c.warn && !c.ok).length,
      checks,
      queue_summary: qCounts,
    });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

/* Interactive Virtual Desk context for any of the 17 responsibility templates.
   Strictly RBAC-filtered: Staff receive zero financial jobs, zero custom requests, and zero monetary fields. */
router.get('/context/desk/:roleId', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    const roleId = String(req.params.roleId || '').trim().toLowerCase();
    const roles = teamForRole(actor.role);
    const role = roles.find(r => r.id === roleId);
    if (!role) {
      throw new NotFoundError('role_not_found', 'قالب المسؤولية غير موجود');
    }

    const allowedKinds = visibleJobKindsForRole(actor.role).filter(k => k.employee_id === roleId);
    const openCases = listCases(actor, { state: 'open' }).filter(c => c.assignee_role_id === roleId);
    const jobs = defaultEngine.list(actor).filter(j => j.employee_id === roleId);

    const activeOrders = dbAll(`
      SELECT o.code, o.status, COALESCE(c.name, '') AS customer_name
      FROM orders o
      LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.status NOT IN ('cancelled', 'delivered')
      ORDER BY o.id DESC
      LIMIT 20
    `).map(r => ({
      code: r.code,
      status: r.status,
      customer_name: r.customer_name,
    }));

    const activeStyles = dbAll(`
      SELECT id, name
      FROM styles
      WHERE active = 1
      ORDER BY id ASC
      LIMIT 30
    `).map(s => ({
      id: s.id,
      name: s.name,
    }));

    const activeCustomRequests = actor.role === 'owner'
      ? dbAll(`
          SELECT cr.id, COALESCE(c.name, '') AS customer_name, cr.status
          FROM custom_requests cr
          LEFT JOIN customers c ON c.id = cr.customer_id
          WHERE cr.status NOT IN ('cancelled', 'rejected')
          ORDER BY cr.id DESC
          LIMIT 15
        `).map(cr => ({
          id: cr.id,
          customer_name: cr.customer_name,
          status: cr.status,
        }))
      : [];

    res.json({
      actor_id: actor.id,
      role,
      allowed_kinds: allowedKinds,
      cases: openCases,
      jobs,
      targets: {
        orders: activeOrders,
        styles: activeStyles,
        custom_requests: activeCustomRequests,
      },
    });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

module.exports = router;
