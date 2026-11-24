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
  console.error('[office-routes]', err && err.code ? err.code : 'unexpected_error');
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
    const out = {
      worker: {
        mode: workerDefault,
        ai_connected: false,
        external_execution_enabled: false,
        network_calls: telemetry.total_network_attempts,
      },
      staging: outboundPolicySummary(),
      outbound_telemetry: telemetry,
    };
    if (actor.role === 'owner') {
      out.openrouter = createOpenRouterConfig().summary();
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

router.get('/jobs', A.requireStaff, (req, res) => {
  try {
    const actor = actorFromRequest(req);
    res.json({ jobs: defaultEngine.list(actor) });
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
    const job = defaultEngine.review(
      req.params.id,
      req.body.expected_revision,
      req.body.expected_result_hash,
      req.body.decision,
      actor
    );
    // الموافقة = إذن تنفيذ: الموظف المسؤول يعلن الاستلام في الشات (visible handoff)
    if (req.body.decision === 'approve') {
      try {
        const chatMod = require('./office-chat');
        const nextSpecs = defaultEngine.constructor.NEXT_STEPS()[job.kind];
        chatMod.postHandoffForJob(job.kind, Array.isArray(nextSpecs) ? nextSpecs.length : 0);
      } catch (_) { /* handoff ack is best-effort */ }
    }
    res.json({ job });
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


router.post('/worker/step', A.requireOwner, async (req, res) => {
  try {
    actorFromRequest(req);
    assertExactBody(req.body || {}, ['provider', 'job_id']);
    const requested = req.body && req.body.provider !== undefined
      ? req.body.provider
      : (process.env.MAVI_OFFICE_PROVIDER || 'disabled');
    const jobId = req.body && req.body.job_id !== undefined ? req.body.job_id : null;
    // Owner-only endpoint: 'disabled' + deterministic offline 'fixture' always; 'openrouter' additionally
    // gated by engine-side config (enabled key, free models, public-catalogue fields, no retries).
    // runOnce returns a Promise for 'openrouter' (one awaitable network call) and a plain object otherwise.
    const step = await Promise.resolve(defaultEngine.runOnce({ provider: requested, jobId, actor: WORKER_ACTOR }));
    res.json({ step });
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
      used_manually: (dbGet('SELECT COUNT(*) AS n FROM office_jobs WHERE used_at IS NOT NULL') || { n: 0 }).n,
    };
    const telemetry = getOutboundTelemetry();

    const checks = [
      {
        id: 'sqlite_wal',
        ok: String(journalMode).toLowerCase() === 'wal',
        label_ar: 'قاعدة البيانات وسلامة التخزين (SQLite WAL)',
        detail_ar: `وضع السجل: ${journalMode} · الطلبات: ${ordersCount} · الموديلات الظاهرة: ${stylesCount} · العميلات: ${customersCount}`,
      },
      {
        id: 'team_17_roles',
        ok: TEAM_ROLES.length === 17 && Object.keys(JOB_KINDS).length === 18,
        label_ar: 'اكتمال الفريق الافتراضي وربطه بالـ ERP',
        detail_ar: `${TEAM_ROLES.length} قالب مسؤولية عبر ${Object.keys(JOB_KINDS).length} مهمة مدمجة في الطلبات والكانبان والكتالوج والمالية والتقارير والأمان`,
      },
      {
        id: 'zero_auto_outbound',
        ok: telemetry.total_network_attempts === 0,
        label_ar: 'عزل الإرسال والصرف التلقائي (اعتماد بشري ١٠٠٪)',
        detail_ar: `٠ اتصالات خارجية مسجلة · لا إرسال آلي للعميلات ولا صرف إعلاني بدون تدخل يدوي`,
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
