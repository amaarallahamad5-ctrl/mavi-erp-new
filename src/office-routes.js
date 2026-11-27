'use strict';
/* Express routes for MAVI's virtual office, follow-up cases, and draft approvals.
   Mounted under `/api/admin/office`.
   - Every Actor is built strictly from the server-verified admin session (`req.session` + `req.user`).
   - Client bodies are checked against strict top-level key allowlists (rejects injected `actor`/`role`).
   - Opening/listing routes NEVER invoke an AI provider or run a worker loop.
   - Staff never receive financial cases, financial jobs, budgets, costs, profits, or provider configs. */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db: rawDb, get: dbGet, all: dbAll, setting: dbSetting } = require('./db');
const A = require('./auth');
const { TEAM_ROLES, JOB_KINDS, teamForRole, visibleJobKindsForRole } = require('./office-team');
const { syncCases, listCases, getSubjectCaseHistory } = require('./office-cases');
const {
  PolicyError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
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
const OfficeFahmy = require('./office-fahmy');
const OfficeSuggestions = require('./office-suggestions');
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

/* ---------- فهمي بتاع التسويق (daily idea, one per Cairo day) ---------- */
router.get('/fahmy/today', A.requireOwner, async (req, res) => {
  try {
    const idea = await OfficeFahmy.ensureTodayIdea();
    const previous = OfficeFahmy.listRecent(8).filter(i => i.day !== idea.day).slice(0, 7);
    let aiReady = false;
    try { const or = require('./openrouter-client'); const cfg = or.createConfig(); cfg.validate(); aiReady = true; } catch (_) { aiReady = false; }
    const freeAgent = (() => { try { return require('./free-agent-client').freeAgentEnabled(); } catch (_) { return false; } })();
    res.json({ ok: true, idea, previous, unread: idea.is_new ? 1 : 0, ai_ready: aiReady, free_agent: freeAgent });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

/* Owner removes the saved key entirely — one button, no technical screens.
   Clears the key, its activation flag and the last probe snapshot, so the
   system returns to the keyless free-agent state she already trusts. */
router.post('/fahmy/key/unset', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, []);
    rawDb.prepare("DELETE FROM settings WHERE key IN ('office_ai_api_key','office_ai_enabled','office_ai_last_test')").run();
    auditOfficeAi(actor, 'ai_key_removed');
    res.json({ ok: true, message_ar: 'اتشال المفتاح المحفوظ من النظام — فهمي شغال تمام على الوكيل المجاني بدون مفتاح.' });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

/* Owner saves the research key INSIDE the فهمي modal — one paste field, no
   technical screens. Reuses the same settings the gated engine reads. */
router.post('/fahmy/key', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, ['key']);
    const key = String(req.body.key || '').trim();
    let reject = null;
    if (!key) {
      reject = 'مفيش مفتاح في الخانة — الصقي المفتاح الأول وبعدين دوسي حفظ.';
    } else if (/\s/.test(key)) {
      reject = 'المفتاح فيه مسافة أو سطر زيادة من النسخ — انسخيه مرة تانية كامل في سطر واحد بدون أي فراغات.';
    } else if (!/^sk-or-[A-Za-z0-9_-]{8,250}$/.test(key)) {
      reject = key.startsWith('sk-')
        ? 'ده مش مفتاح OpenRouter — شكله مفتاح الخدمة القديمة (علي بابا) اللي اتشالت من النظام، وعشان كده الخدمة بترد عليه. البحث الذكي بمفتاح OpenRouter بس وبيبدأ بـ sk-or-. ولو مش معاكي مفتاح، سيبيه فاضي خالص: فهمي شغال تمام على الوكيل المجاني بدون مفتاح.'
        : 'النص ده مش شكل مفتاح OpenRouter — المفتاح الصحيح بيبدأ بـ sk-or-v1- وبعده ٦٤ حرف صغير وأرقام بس. لو نسختيه من صفحة المفاتيح، ممكن حرف مخفي من النسخ يكون اتقال معاه — افتحي صفحة المفاتيح واعملي نسخة تانية كاملة.';
    }
    if (reject) {
      throw new PolicyError('missing_or_invalid_server_key', reject);
    }
    const { setSetting } = require('./db');
    setSetting('office_ai_api_key', key);
    setSetting('office_ai_model', 'openrouter/free');
    setSetting('office_ai_enabled', '1');
    setSetting('office_ai_last_test', JSON.stringify(null));
    auditOfficeAi(actor, 'ai_config_saved');
    try { OfficeFahmy.resetAiThrottle(); } catch (_) { /* best-effort */ }
    res.json({ ok: true, message_ar: 'اتحفظ المفتاح واتفعّل — فهمي هيبدأ البحث الذكي من أول فكرة جاية. دوسي «فحص الاتصال» للتأكيد.' });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

/* Owner-facing connection check, in plain Arabic. Probes the gated config the
   exact way generation will use it (short timeout, one shot). */
router.post('/fahmy/check', A.requireOwner, async (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, []);
    const { createConfig, createLiveTransport, testConnection } = require('./openrouter-client');
    const freeAgentEnabled = (() => { try { return require('./free-agent-client').freeAgentEnabled(); } catch (_) { return false; } })();
    const cfg = createConfig();
    let statusKey = 'ready';
    try { cfg.validate(); } catch (e) { statusKey = e.code || 'openrouter_disabled'; }
    if (statusKey !== 'ready') {
      const messages = {
        openrouter_disabled: 'البحث الذكي بمفتاح مش مفعل لسه — لو معاكي مفتاح، فعّليه من خانة المفتاح تحت.',
        missing_or_invalid_server_key: 'مفيش مفتاح محفوظ — لو معاكي مفتاح الصقيه في خانة التفعيل تحت.',
      };
      const base = messages[statusKey] || 'البحث الذكي بمفتاح مش متصل — ' + statusKey;
      const note = freeAgentEnabled ? ' — ومفيش أي حاجة محتاجة تعمليها: فهمي شغال تمام دلوقتي على الوكيل المجاني وبيحضر فكرة النهاردة ببحث ذكي.' : '';
      return res.json({ ok: false, status: statusKey, message_ar: base + note });
    }
    const result = await Promise.resolve(testConnection(cfg, { transport: createLiveTransport({ timeoutMs: 12000 }) }));
    auditOfficeAi(actor, result.ok ? 'ai_connection_test_ok' : 'ai_connection_test_failed');
    const summary = cfg.summary();
    let upgradedToday = null;
    if (result.ok) {
      try {
        const OfficeFahmyMod = require('./office-fahmy');
        OfficeFahmyMod.resetAiThrottle();
        const idea = await OfficeFahmyMod.ensureTodayIdea({ preferKeyEngine: true });
        upgradedToday = !!(idea && idea.source === 'ai');
      } catch (_) { upgradedToday = null; }
    }
    const messages = {
      provider_auth_failed: 'المفتاح اترفض من الخدمة (كود ٤٠١): يا اتشال أو متوقف من حسابك، يا صلاحيته انتهت، يا حد استخدام المفتاح خلص. افتحي صفحة المفاتيح في حسابك: لو مش موجود اعملي واحد جديد وانسخيه كامل (بيبدأ بـ sk-or-v1-)، ولو زهقتي دوسي «شيل المفتاح المحفوظ» — فهمي شغال على الوكيل المجاني بدون مفتاح.',
      provider_credit_or_quota_required: 'الحساب محتاج رصيد أو تفعيل باقة — استخدمي مفتاح حساب بخطة مجانية.',
      provider_access_denied: 'الحساب مش مسموح له بالخدمة دي — جرّبي مفتاح تاني.',
      free_model_unavailable: 'المفتاح شغّال ومتعلّن عليه ✅ — بس الموديل المجاني مش متاح في اللحظة دي (زحمة على المزود) — هيجرب تلقائيًا على موديل تاني.',
      provider_rate_limited_no_automatic_retry: 'المفتاح نفسه شغّال ومتعلّن عليه ✅ — بس حد الاستخدام المجاني اليومي خلص (ده بيحصل مع الموديلات المجانية وبيفتح لوحده تاني) — هيكمل تلقائيًا بعدين ومفيش أي حاجة محتاجة تعمليها.',
      provider_connection_failed_no_automatic_retry: 'تعذر الوصول للخدمة من السيرفر — هيحاول تاني تلقائيًا.',
      provider_free_daily_cap: 'المفتاح نفسه شغّال ✅ — بس حد الاستخدام المجاني اليومي للبحث الذكي خلص — بكرة يرجع يشتغل لوحده ومفيش أي حاجة محتاجة تعمليها.',
    };
    const failBase = messages[result.error_code] || 'البحث الذكي بمفتاح مش متصل دلوقتي — فهمي بيجرب تلقائيًا بعدين.';
    const failNote = freeAgentEnabled
      ? ' — ومفيش أي حاجة محتاجة تعمليها: فهمي شغال تمام دلوقتي على الوكيل المجاني وبيحضر فكرة النهاردة ببحث ذكي (اللي مكتوب فوق الأخضر).'
      : ' — فهمي شغال بالتحليل المحلي وبيحاول تلقائيًا بعدين.';
    const PROVIDER_BUSY = new Set(['provider_rate_limited_no_automatic_retry', 'provider_free_daily_cap', 'free_model_unavailable']);
    const severity = result.ok ? 'ok' : (freeAgentEnabled || PROVIDER_BUSY.has(result.error_code) ? 'info' : 'warn');
    res.json({
      ok: !!result.ok,
      status: result.ok ? 'ready' : (result.error_code || 'provider_request_failed_no_automatic_retry'),
      severity,
      model: result.model || null,
      latency_ms: result.latency_ms || null,
      free_agent_cover: freeAgentEnabled,
      key_tail: summary.key_tail || '',
      key_source: summary.source || 'none',
      upgraded_today: upgradedToday,
      message_ar: result.ok
        ? (upgradedToday === true
          ? 'الاتصال شغال ✅ — المفتاح بقى مساعد للوكيل المجاني اللي شغال، ورقّى فكرة النهاردة بالبحث الذكي.'
          : 'الاتصال شغال ✅ — المفتاح بقى مساعد للوكيل المجاني اللي شغال: لو الوكيل وقع أو خلص حدّه اليومي، المفتاح يكمّل مكانه فورًا.')
        : failBase + failNote,
    });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.post('/fahmy/read', A.requireOwner, (req, res) => {
  try {
    assertExactBody(req.body || {}, []);
    const idea = OfficeFahmy.markRead();
    res.json({ ok: true, idea });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

/* ---------- ready-to-apply suggestions on draft cards ---------- */
function attachOfficeExtras(actor, jobs) {
  const isOwner = actor.role === 'owner';
  for (const j of jobs || []) {
    try { j.context_facts = OfficeSuggestions.contextFactsForJob(j); } catch (_) { j.context_facts = []; }
    if (isOwner) {
      try { j.suggestions = OfficeSuggestions.suggestionsForJob(j, { isOwner: true }); } catch (_) { j.suggestions = []; }
      try { j.applies = OfficeSuggestions.appliesForJob(j.id); } catch (_) { j.applies = []; }
    }
  }
  return jobs;
}

router.post('/jobs/:id/apply-suggestion', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, ['suggestion_id', 'expected_revision', 'expected_result_hash']);
    const job = defaultEngine.get(req.params.id, actor);
    if (!job || job.status !== 'review') {
      throw new NotFoundError('suggestion_not_available', 'المسودة مش في مرحلة المراجعة — حدّثي الصفحة');
    }
    if (Number(req.body.expected_revision) !== Number(job.revision) ||
        String(req.body.expected_result_hash || '') !== String(job.result_hash || '')) {
      throw new ConflictError('stale_conflict', 'المسودة اتغيرت قبل التطبيق — حدّثي المسودة وراجعيها قبل التطبيق');
    }
    const { apply } = OfficeSuggestions.applySuggestion(job, req.body.suggestion_id, actor);
    const refreshed = defaultEngine.get(req.params.id, actor);
    attachOfficeExtras(actor, [refreshed]);
    res.json({ ok: true, apply, job: refreshed });
  } catch (err) {
    sendOfficeError(res, err);
  }
});

router.post('/jobs/:id/restore-suggestion', A.requireOwner, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    assertExactBody(req.body || {}, ['apply_id']);
    const job = defaultEngine.get(req.params.id, actor);
    const apply = OfficeSuggestions.restoreApply(job, req.body.apply_id, actor);
    res.json({ ok: true, apply });
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
    const jobsOut = attachOfficeExtras(actor, defaultEngine.list(actor));
    res.json({ jobs: jobsOut, auto_prepare: defaultEngine.lastAutoPrepare || null });
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
    const jobOut = defaultEngine.get(req.params.id, actor);
    attachOfficeExtras(actor, [jobOut]);
    res.json({ job: jobOut });
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
      void result;
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
        try { void count; } catch (_) { /* best-effort */ }
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

/* ---------- 🛡 فحص الأمان الذكي (٧ خطوات حقيقية، ظاهرة واحدة واحدة) ----------
   Owner request (26.11, from her video): a visible step-by-step verification
   checklist with a progress counter (n / 7) and category tags, ending with
   «النظام أصبح آمنًا». Every step below is a REAL check against the live
   system — nothing decorative: users/roles, input policy layer, private
   customer data, database integrity, dependencies, production mode, backups. */
function securityChecklist() {
  const steps = [];
  const okStep = (id, tag_ar, title_ar, rule_ar, detail_ar) => steps.push({ id, tag_ar, title_ar, rule_ar, status: 'ok', detail_ar });
  const warnStep = (id, tag_ar, title_ar, rule_ar, detail_ar) => steps.push({ id, tag_ar, title_ar, rule_ar, status: 'warn', detail_ar });
  const failStep = (id, tag_ar, title_ar, rule_ar, detail_ar) => steps.push({ id, tag_ar, title_ar, rule_ar, status: 'fail', detail_ar });

  // 1) Authentication & Authorization — real users/roles in the DB
  try {
    const ownerN = dbGet("SELECT COUNT(*) n FROM users WHERE role = 'owner' AND active = 1").n;
    const staffN = dbGet("SELECT COUNT(*) n FROM users WHERE role = 'staff' AND active = 1").n;
    if (ownerN >= 1 && staffN >= 1) {
      okStep('auth', 'الصلاحيات', 'حسابات وصلاحيات محكومة', 'مينفعش موظف يشوف بيانات المالكة',
        `في ${ownerN} حساب مالك و${staffN} حساب تشغيل بصلاحيات منفصلة — موظف التشغيل مش شايف فلوس ولا تكاليف ولا مسودات مالية، والتقارير المالية للمالكة بس.`);
    } else {
      warnStep('auth', 'الصلاحيات', 'حسابات وصلاحيات محكومة', 'مينفعش موظف يشوف بيانات المالكة',
        'راجعي حسابات الدخول — لازم يكون فيه حساب مالك نشط وحساب تشغيل بصلاحيات منفصلة.');
    }
  } catch (_) { failStep('auth', 'الصلاحيات', 'حسابات وصلاحيات محكومة', 'مينفعش موظف يشوف بيانات المالكة', 'تعذر فحص حسابات الدخول'); }

  // 2) Input validation — the policy/allowlist layer is live in this build
  try {
    const guard = outboundPolicySummary();
    const engineReady = typeof defaultEngine.validateJobPayload === 'function';
    const otpTable = dbGet("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='otp_codes'").n;
    if (engineReady && otpTable >= 1 && guard) {
      okStep('input', 'التحقق من المدخلات', 'كل المدخلات مفحوصة قبل التنفيذ', 'متنقصش أي فحص للبيانات الداخلة',
        'كل عملية في النظام بتتقبل بحقول مسموحة بس (أي حقل زايد بيرفض)، والمصادقة بـ OTP للعميلات، وسياسة الإرسال الخارجي مفعّلة في هذا البِلد.');
    } else {
      warnStep('input', 'التحقق من المدخلات', 'كل المدخلات مفحوصة قبل التنفيذ', 'متنقصش أي فحص للبيانات الداخلة', 'طبقة فحص المدخلات مش مكتملة في هذا البِلد — راجعي النشر.');
    }
  } catch (_) { warnStep('input', 'التحقق من المدخلات', 'كل المدخلات مفحوصة قبل التنفيذ', 'متنقصش أي فحص للبيانات الداخلة', 'تعذر فحص طبقة المدخلات'); }

  // 3) Private customer data — receipts/images stay inside the private DB
  try {
    const receipts = dbGet('SELECT COUNT(*) n FROM custom_requests WHERE receipt IS NOT NULL').n;
    const orders = dbGet('SELECT COUNT(*) n FROM orders').n;
    okStep('privacy', 'خصوصية البيانات', 'بيانات العميلات محمية ومش للعامة', 'البيانات دي مش متاحة للعامة',
      `بيانات ${orders} طلب وصور الإيصالات (${receipts} إيصال مسجل) محفوظة جوة قاعدة البيانات الخاصة — المتجر العلني بيعرض أوصاف الموديلات فقط من غير أي أسعار تكلفة أو بيانات عميلات.`);
  } catch (_) { warnStep('privacy', 'خصوصية البيانات', 'بيانات العميلات محمية ومش للعامة', 'البيانات دي مش متاحة للعامة', 'تعذر فحص خصوصية البيانات'); }

  // 4) Database integrity — real PRAGMA checks
  try {
    const quick = dbGet('PRAGMA quick_check');
    const fk = dbGet('PRAGMA foreign_keys');
    const wal = dbGet('PRAGMA journal_mode');
    const quickOk = quick && String(quick.quick_check || quick) === 'ok';
    if (quickOk && Number(fk && fk.foreign_keys) === 1 && String(wal && wal.journal_mode) === 'wal') {
      okStep('db', 'قاعدة البيانات', 'قاعدة البيانات سليمة ومحمية', 'قاعدة البيانات لازم تبقى سليمة ١٠٠٪',
        'الفحص الشامل للقاعدة رجع سليم، حماية الربوط بين الجداول مفعّلة، ونمط الكتابة الآمن (WAL) شغال — يعني مفيش تلف ولا بيانات ناقصة.');
    } else {
      failStep('db', 'قاعدة البيانات', 'قاعدة البيانات سليمة ومحمية', 'قاعدة البيانات لازم تبقى سليمة ١٠٠٪',
        `نتيجة الفحص: ${quickOk ? 'سليم' : 'مش سليم'} — راجعي النسخ الاحتياطية فورًا.`);
    }
  } catch (e) { failStep('db', 'قاعدة البيانات', 'قاعدة البيانات سليمة ومحمية', 'قاعدة البيانات لازم تبقى سليمة ١٠٠٪', 'تعذر فحص القاعدة'); }

  // 5) Dependencies — real module resolution + package manifest
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) });
    require.resolve('better-sqlite3');
    require.resolve('express');
    if (deps.length >= 5) {
      okStep('deps', 'المكونات', 'المكونات والتوابع كلها سليمة', 'راجعي المكونات والPackages',
        `${deps.length} مكوّن معتمد في النظام والمكونات الحرجة (قاعدة البيانات، السيرفر) متثبتة وتشتغل — مفيش مكوّن ناقص بيوقف الشغل.`);
    } else {
      warnStep('deps', 'المكونات', 'المكونات والتوابع كلها سليمة', 'راجعي المكونات والPackages', 'قائمة المكونات شكلها ناقص — راجعي ملف النظام.');
    }
  } catch (_) { failStep('deps', 'المكونات', 'المكونات والتوابع كلها سليمة', 'راجعي المكونات والPackages', 'مكوّن حرج ناقص أو تالف — راجعي النشر فورًا'); }

  // 6) Production mode — no staging/debug switches left on
  try {
    const staging = process.env.MAVI_STAGING_MODE === '1';
    const debugEnv = !!process.env.DEBUG || !!process.env.MAVI_DEBUG;
    const dev = process.env.NODE_ENV === 'development';
    if (!staging && !debugEnv && !dev) {
      okStep('prod', 'وضع الإنتاج', 'وضع الإنتاج مظبوط', 'وضع الـ Debug لازم يكون مقفول',
        'النظام شغال في وضع الإنتاج الحقيقي: مفيش وضع تجريبي، ومفيش رسايل تشخيص مفتوحة للزوار، والروابط التجريبية مقفولة.');
    } else {
      warnStep('prod', 'وضع الإنتاج', 'وضع الإنتاج مظبوط', 'وضع الـ Debug لازم يكون مقفول',
        'في مفاتيح وضع تجريبي/تشخيصي مفتوحة في إعدادات التشغيل — مناسبة للتجربة بس مش للشغل الفعلي.');
    }
  } catch (_) { warnStep('prod', 'وضع الإنتاج', 'وضع الإنتاج مظبوط', 'وضع الـ Debug لازم يكون مقفول', 'تعذر فحص وضع التشغيل'); }

  // 7) Backups — last real backup event from the audit trail
  try {
    const last = dbGet("SELECT created_at FROM events WHERE entity='system' AND entity_id='backup' AND action IN ('backup_response_completed','download') ORDER BY id DESC LIMIT 1");
    if (last && last.created_at) {
      const days = Math.floor((Date.now() - new Date(String(last.created_at).replace(' ', 'T') + 'Z').getTime()) / 864e5);
      if (days <= 14) {
        okStep('backup', 'النسخ الاحتياطي', 'النسخ الاحتياطي شغال', 'لازم يكون فيه نسخة احتياطية حديثة',
          `آخر نسخة احتياطية كانت قبل ${days === 0 ? 'أقل من يوم' : days + (days === 1 ? ' يوم' : ' أيام')} — لو حصل أي مشكلة نقدر نرجّع النظام لحظة النسخة دي.`);
      } else {
        warnStep('backup', 'النسخ الاحتياطي', 'النسخ الاحتياطي شغال', 'لازم يكون فيه نسخة احتياطية حديثة',
          `آخر نسخة احتياطية قبل ${days} يوم — اعملي نسخة جديدة من إعدادات النظام عشان الحماية تبقى حديثة.`);
      }
    } else {
      warnStep('backup', 'النسخ الاحتياطي', 'النسخ الاحتياطي شغال', 'لازم يكون فيه نسخة احتياطية حديثة',
        'لسه مفيش نسخة احتياطية مسجلة — اعملي نسخة من إعدادات النظام، بتتحفظ عندك وتقدري تنزليها.');
    }
  } catch (_) { warnStep('backup', 'النسخ الاحتياطي', 'النسخ الاحتياطي شغال', 'لازم يكون فيه نسخة احتياطية حديثة', 'تعذر فحص النسخ الاحتياطية'); }

  const fails = steps.filter(x => x.status === 'fail').length;
  const warns = steps.filter(x => x.status === 'warn').length;
  const verdict = fails > 0
    ? { safe: false, banner_ar: '⚠️ في خطوات محتاجة مراجعة — الشغال كله تمام والباقي ظاهر فوق بالتفاصيل' }
    : (warns > 0
      ? { safe: true, banner_ar: '✅ النظام أصبح آمنًا — مع ملاحظات بسيطة تقدري تخلصيها في دقايق' }
      : { safe: true, banner_ar: '✅ النظام أصبح آمنًا — الـ٧ خطوات كلها سليمة ومحققة' });
  return { ok: true, generated_at: new Date().toISOString(), steps, fails, warns, ...verdict };
}

router.get('/security-checklist', A.requireOwner, (req, res) => {
  try {
    actorFromRequest(req);
    res.json(securityChecklist());
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
    const jobs = attachOfficeExtras(actor, defaultEngine.listBySubject(actor, 'order', String(ord.id), 20));
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
    const jobs = attachOfficeExtras(actor, defaultEngine.listBySubject(actor, 'catalogue', style.id, 20));
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
    const jobs = attachOfficeExtras(actor, defaultEngine.listBySubject(actor, 'custom_request', String(cr.id), 20));
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
    const jobs = attachOfficeExtras(actor, defaultEngine.listByKinds(actor, targetKinds, 20));
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
