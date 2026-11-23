'use strict';
/* Express routes for MAVI's virtual office, follow-up cases, and draft approvals.
   Mounted under `/api/admin/office`.
   - Every Actor is built strictly from the server-verified admin session (`req.session` + `req.user`).
   - Client bodies are checked against strict top-level key allowlists (rejects injected `actor`/`role`).
   - Opening/listing routes NEVER invoke an AI provider or run a worker loop.
   - Staff never receive financial cases, financial jobs, budgets, costs, profits, or provider configs. */
const express = require('express');
const A = require('./auth');
const { teamForRole, visibleJobKindsForRole } = require('./office-team');
const { syncCases, listCases, getSubjectCaseHistory } = require('./office-cases');
const {
  PolicyError,
  actorFromRequest,
  assertExactBody,
  defaultEngine,
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

router.post('/worker/step', A.requireOwner, (req, res) => {
  try {
    actorFromRequest(req);
    assertExactBody(req.body || {}, ['provider', 'job_id']);
    const requested = req.body && req.body.provider !== undefined
      ? req.body.provider
      : (process.env.MAVI_OFFICE_PROVIDER || 'disabled');
    const jobId = req.body && req.body.job_id !== undefined ? req.body.job_id : null;
    // Only 'disabled' and deterministic offline 'fixture' are permitted on this endpoint.
    const step = defaultEngine.runOnce({ provider: requested, jobId, actor: WORKER_ACTOR });
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

module.exports = router;
