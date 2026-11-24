'use strict';
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3521;
const BASE = `http://127.0.0.1:${PORT}`;

const FORBIDDEN_FINANCE_KEYS = new Set([
  'cost', 'unit_cost', 'cost_material', 'cost_tailoring', 'cost_other_base',
  'profit', 'gross_profit', 'net_profit', 'margin',
  'budget', 'daily_budget_egp', 'rate_per_piece', 'buy_price',
  'total', 'subtotal', 'paid', 'gross_paid', 'refunded', 'due',
  'delivery_fee', 'shipping_fee', 'discount', 'deposit', 'confirmed_amount',
  'expected_deposit_egp', 'total_egp', 'paid_egp', 'effective_price', 'openrouter',
]);

function assertZeroFinancialExposure(value, pathLabel = 'root') {
  if (value === null || value === undefined) return;
  if (typeof value === 'string') {
    assert.ok(
      !/ج\.م|جنيه|EGP/i.test(value),
      `Staff-visible string at ${pathLabel} leaked currency text: ${value}`
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => assertZeroFinancialExposure(item, `${pathLabel}[${idx}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      assert.ok(!FORBIDDEN_FINANCE_KEYS.has(k), `Staff-visible object leaked forbidden key "${k}" at ${pathLabel}`);
      assertZeroFinancialExposure(v, `${pathLabel}.${k}`);
    }
  }
}

async function req(urlPath, { method = 'GET', cookie = '', body, headers = {} } = {}) {
  const h = { Origin: BASE, ...headers };
  if (cookie) h.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(BASE + urlPath, { method, headers: h, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, headers: r.headers, text, json };
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-office-rbac-'));
  const dbPath = path.join(tmpDir, 'office-rbac.db');

  // Direct unit checks on OfficeEngine lease/fencing/retry contracts on an isolated temp DB first
  const unitDbPath = path.join(tmpDir, 'unit-engine.db');
  const unitRun = spawnSync(process.execPath, ['-e', `
    (async () => {
    process.env.DB_PATH = ${JSON.stringify(unitDbPath)};
    const assert = require('assert');
    const { OfficeEngine, makeActor, WORKER_ACTOR, ConflictError, PolicyError } = require('./src/office-engine');
    let now = 1000;
    const engine = new OfficeEngine({ clock: () => now, leaseSeconds: 30, maxAttempts: 2 });
    const owner = makeActor('user:1', 'owner');

    // Default worker is paused with zero network calls
    const paused = engine.runOnce();
    assert.strictEqual(paused.status, 'paused');
    assert.strictEqual(paused.network_calls, 0);

    // Gated OpenRouter provider refused WITHOUT claiming or network IO when env is unset (tests default).
    // runOnce is async for the openrouter provider, so the rejection must be awaited.
    await assert.rejects(() => engine.runOnce({ provider: 'openrouter' }), err => err instanceof PolicyError && err.code === 'openrouter_disabled');

    // Enqueue synthetic content draft + idempotency checks
    const j1 = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'idem-1', owner);
    const j1Replay = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'idem-1', owner);
    assert.strictEqual(j1.id, j1Replay.id);
    assert.throws(
      () => engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'facebook' }, 'idem-1', owner),
      err => err instanceof ConflictError && err.code === 'idempotency_key_reused_with_different_request'
    );

    // Only one worker claims; expired lease fences old worker and caps attempts
    const claim1 = engine.claim(WORKER_ACTOR);
    assert.ok(claim1 && claim1.token);
    assert.strictEqual(engine.claim(WORKER_ACTOR), null);

    now += 35; // expire first lease (attempt 1 -> requeued, claim2 becomes attempt 2)
    const claim2 = engine.claim(WORKER_ACTOR);
    assert.ok(claim2 && claim2.token !== claim1.token);
    assert.strictEqual(claim2.job.attempts, 2);

    // Old worker token is fenced out
    assert.throws(
      () => engine.completeFixture(j1.id, claim1.token, WORKER_ACTOR),
      err => err instanceof ConflictError && err.code === 'stale_or_expired_worker_lease'
    );

    // Expire second attempt -> reaches maxAttempts (2) -> transitions to failed
    now += 35;
    assert.strictEqual(engine.claim(WORKER_ACTOR), null);
    assert.strictEqual(engine.get(j1.id, owner).status, 'failed');

    // External execution is unconditionally disabled
    assert.throws(() => engine.executeExternal(), err => err instanceof PolicyError && err.code === 'external_execution_not_implemented_and_disabled');

    // Style/catalogue drift invalidates stale content/campaign draft approval inside the review transaction
    const { run } = require('./src/db');
    run("INSERT INTO styles(id, name, type, price, cost, active, lead_days) VALUES('ST-CAT-DRIFT', 'عباية كتان', 'made', 1200, 500, 1, 5)");
    const styleJob = engine.enqueue('content_draft', { product_id: 'ST-CAT-DRIFT', channel: 'instagram' }, 'idem-style-drift', owner);
    engine.runOnce({ provider: 'fixture', actor: WORKER_ACTOR });
    const styleReady = engine.get(styleJob.id, owner);
    assert.strictEqual(styleReady.status, 'review');
    run("UPDATE styles SET price = 1350 WHERE id = 'ST-CAT-DRIFT'");
    assert.throws(
      () => engine.review(styleJob.id, styleReady.revision, styleReady.result_hash, 'approve', owner),
      err => err instanceof ConflictError && err.code === 'stale_subject_facts'
    );
    })().catch(e => { console.error('CHILD-ERR', e && e.message || e); process.exit(1); });
  `], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(unitRun.status, 0, 'Unit engine test failed: ' + unitRun.stderr + unitRun.stdout);

  // Seed isolated server DB
  const seed = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
    encoding: 'utf8',
  });
  assert.strictEqual(seed.status, 0, seed.stderr);

  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      DB_PATH: dbPath,
      AUTO_SEED: '0',
      SHOW_OTP: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(BASE + '/healthz'); if (r.ok) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 100));
    }

    // Authenticate owner, staff, and customer
    const ownerLogin = await req('/api/admin/auth/login', {
      method: 'POST',
      body: { email: 'owner@mavi.eg', password: 'mavi-owner' },
    });
    assert.strictEqual(ownerLogin.status, 200);
    const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];

    const staffLogin = await req('/api/admin/auth/login', {
      method: 'POST',
      body: { email: 'staff@mavi.eg', password: 'mavi-staff' },
    });
    assert.strictEqual(staffLogin.status, 200);
    const staffCookie = staffLogin.headers.get('set-cookie').split(';')[0];

    const custReg = await req('/api/store/auth/register', {
      method: 'POST',
      body: { phone: '01273194826', password: 'customer-password-123', name: 'عميلة اختبار' },
    });
    assert.ok([200, 201].includes(custReg.status), custReg.text);
    const custCookie = custReg.headers.get('set-cookie').split(';')[0];

    // 1. Anonymous & customer realm cannot touch office endpoints
    assert.strictEqual((await req('/api/admin/office/team')).status, 401);
    assert.strictEqual((await req('/api/admin/office/team', { cookie: custCookie })).status, 401);
    assert.strictEqual((await req('/api/admin/office/jobs', { cookie: custCookie })).status, 401);

    // 2. 17 role templates & strict zero-finance projection for staff
    const staffTeam = await req('/api/admin/office/team', { cookie: staffCookie });
    assert.strictEqual(staffTeam.status, 200);
    assert.strictEqual(staffTeam.json.roles.length, 17);
    assert.ok(staffTeam.json.roles.every(r => r.template_only === true && r.is_auth_principal === false));
    assert.deepStrictEqual(
      staffTeam.json.allowed_job_kinds.map(k => k.kind).sort(),
      [
        'community_followup_draft',
        'content_draft',
        'customer_reply_draft',
        'daily_ops_triage',
        'landing_page_check',
        'order_followup_draft',
        'quality_delivery_checklist',
        'seo_readiness_check',
        'visual_reel_brief',
        'workshop_followup_draft',
      ]
    );
    assertZeroFinancialExposure(staffTeam.json, 'staffTeam');

    const staffStatus = await req('/api/admin/office/status', { cookie: staffCookie });
    assert.strictEqual(staffStatus.status, 200);
    assert.strictEqual(staffStatus.json.worker.mode, 'disabled');
    assert.strictEqual(staffStatus.json.openrouter, undefined);
    assertZeroFinancialExposure(staffStatus.json, 'staffStatus');

    const ownerTeam = await req('/api/admin/office/team', { cookie: ownerCookie });
    assert.strictEqual(ownerTeam.status, 200);
    assert.strictEqual(ownerTeam.json.allowed_job_kinds.length, 18);
    assert.ok(ownerTeam.json.roles.every(r => Array.isArray(r.job_kinds) && r.job_kinds.length >= 1), 'Every 17 virtual office role must have >= 1 active job kind for owner');

    // 3. Reject client-injected actor/role fields in request JSON
    const spoofed = await req('/api/admin/office/jobs', {
      method: 'POST',
      cookie: staffCookie,
      body: {
        kind: 'content_draft',
        payload: { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' },
        idempotency_key: 'spoof-1',
        actor: { id: 'user:1', role: 'owner' },
      },
    });
    assert.strictEqual(spoofed.status, 400);
    assert.strictEqual(spoofed.json.error, 'disallowed_request_field');

    // 4. Create a real online order via customer storefront so it has a real order_deposits row
    const measRes = await req('/api/store/me/measurements', {
      method: 'PUT',
      cookie: custCookie,
      body: { bust: 96, waist: 78, hip: 104, shoulder: 40, length: 150 },
    });
    assert.strictEqual(measRes.status, 200, measRes.text);

    const storeOrderRes = await req('/api/store/orders', {
      method: 'POST',
      cookie: custCookie,
      body: {
        style_id: 'DR-04',
        colour: 'أسود',
        qty: 1,
        delivery: true,
        governorate: 'الجيزة',
        fabric_choice: 'قماش العميلة',
      },
    });
    assert.strictEqual(storeOrderRes.status, 201, storeOrderRes.text);
    const orderCode = storeOrderRes.json.order.code;

    // Quote deposit on the order as owner
    const quoteRes = await req(`/api/admin/order-deposits/${encodeURIComponent(orderCode)}/quote`, {
      method: 'POST',
      cookie: ownerCookie,
      body: { percent: 50, shipping_fee: 60, payment_details: 'InstaPay mavi@instapay' },
    });
    assert.strictEqual(quoteRes.status, 200, quoteRes.text);

    // 5. Staff CANNOT create, view, revise, or audit financial jobs (`campaign_brief` & `deposit_followup_draft`)
    const staffBriefAttempt = await req('/api/admin/office/jobs', {
      method: 'POST',
      cookie: staffCookie,
      body: {
        kind: 'campaign_brief',
        payload: { product_id: 'DEMO-PUBLIC-01', channel: 'instagram', daily_budget_egp: 100 },
        idempotency_key: 'staff-brief-blocked',
      },
    });
    assert.strictEqual(staffBriefAttempt.status, 403);
    assertZeroFinancialExposure(staffBriefAttempt.json, 'staffBriefAttempt');

    const staffDepositAttempt = await req('/api/admin/office/jobs', {
      method: 'POST',
      cookie: staffCookie,
      body: {
        kind: 'deposit_followup_draft',
        payload: { order_code: orderCode },
        idempotency_key: 'staff-dep-blocked',
      },
    });
    assert.strictEqual(staffDepositAttempt.status, 403);
    assertZeroFinancialExposure(staffDepositAttempt.json, 'staffDepositAttempt');

    // Owner creates both financial jobs
    const ownerBrief = await req('/api/admin/office/jobs', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        kind: 'campaign_brief',
        payload: { product_id: 'DEMO-PUBLIC-01', channel: 'instagram', daily_budget_egp: 100 },
        idempotency_key: 'owner-brief-1',
      },
    });
    assert.strictEqual(ownerBrief.status, 201);
    const briefId = ownerBrief.json.job.id;

    const ownerDepJob = await req('/api/admin/office/jobs', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        kind: 'deposit_followup_draft',
        payload: { order_code: orderCode },
        idempotency_key: 'owner-dep-1',
      },
    });
    assert.strictEqual(ownerDepJob.status, 201);
    const depJobId = ownerDepJob.json.job.id;

    // Staff cannot read, revise, or read audit of owner-only jobs
    for (const restrictedId of [briefId, depJobId]) {
      const g = await req(`/api/admin/office/jobs/${restrictedId}`, { cookie: staffCookie });
      assert.strictEqual(g.status, 403);
      assertZeroFinancialExposure(g.json, 'staffGetRestricted');

      const a = await req(`/api/admin/office/jobs/${restrictedId}/audit`, { cookie: staffCookie });
      assert.strictEqual(a.status, 403);
      assertZeroFinancialExposure(a.json, 'staffAuditRestricted');

      const p = await req(`/api/admin/office/jobs/${restrictedId}`, {
        method: 'PATCH',
        cookie: staffCookie,
        body: { payload: { order_code: orderCode }, expected_revision: 1 },
      });
      assert.strictEqual(p.status, 403);
      assertZeroFinancialExposure(p.json, 'staffReviseRestricted');
    }

    // 6. Staff creates allowed operational job (`order_followup_draft`) — Actor comes from staff session
    const staffFollowup = await req('/api/admin/office/jobs', {
      method: 'POST',
      cookie: staffCookie,
      body: {
        kind: 'order_followup_draft',
        payload: { order_code: orderCode, focus: 'schedule' },
        idempotency_key: 'staff-followup-1',
      },
    });
    assert.strictEqual(staffFollowup.status, 201);
    assert.strictEqual(staffFollowup.json.job.created_by, `user:${staffLogin.json.user.id}`);
    assert.strictEqual(staffFollowup.json.job.status, 'queued'); // Enqueue never runs worker automatically
    assertZeroFinancialExposure(staffFollowup.json, 'staffFollowupCreate');
    const followupId = staffFollowup.json.job.id;

    // Staff cannot run worker or approve jobs
    assert.strictEqual(
      (await req('/api/admin/office/worker/step', { method: 'POST', cookie: staffCookie, body: { provider: 'fixture' } })).status,
      403
    );

    // Owner runs default worker step (disabled) -> paused, job stays queued
    const defaultStep = await req('/api/admin/office/worker/step', {
      method: 'POST',
      cookie: ownerCookie,
      body: {},
    });
    assert.strictEqual(defaultStep.status, 200);
    assert.strictEqual(defaultStep.json.step.status, 'paused');
    assert.strictEqual(defaultStep.json.step.network_calls, 0);

    // Owner runs explicit fixture steps for the 3 queued jobs
    for (let i = 0; i < 3; i++) {
      const step = await req('/api/admin/office/worker/step', {
        method: 'POST',
        cookie: ownerCookie,
        body: { provider: 'fixture' },
      });
      assert.strictEqual(step.status, 200);
      assert.strictEqual(step.json.step.status, 'review');
      assert.strictEqual(step.json.step.ai_generated, false);
      assert.strictEqual(step.json.step.network_calls, 0);
    }

    // Verify staff list ONLY returns the operational job and contains zero money figures anywhere
    const staffJobsList = await req('/api/admin/office/jobs', { cookie: staffCookie });
    assert.strictEqual(staffJobsList.status, 200);
    assert.strictEqual(staffJobsList.json.jobs.length, 1);
    assert.strictEqual(staffJobsList.json.jobs[0].id, followupId);
    assertZeroFinancialExposure(staffJobsList.json, 'staffJobsList');

    const staffAudit = await req(`/api/admin/office/jobs/${followupId}/audit`, { cookie: staffCookie });
    assert.strictEqual(staffAudit.status, 200);
    assertZeroFinancialExposure(staffAudit.json, 'staffJobAudit');

    // Staff still cannot approve even their own operational draft
    const readyFollowup = staffJobsList.json.jobs[0];
    const staffApproveAttempt = await req(`/api/admin/office/jobs/${followupId}/review`, {
      method: 'POST',
      cookie: staffCookie,
      body: {
        expected_revision: readyFollowup.revision,
        expected_result_hash: readyFollowup.result_hash,
        decision: 'approve',
      },
    });
    assert.strictEqual(staffApproveAttempt.status, 403);

    // 7. CRITICAL REQUIREMENT #2: Mutating order facts invalidates stale draft approval with 409!
    // Edit the order's promise_date via MAVI's order edit endpoint
    const editGet = await req(`/api/admin/orders/${encodeURIComponent(orderCode)}/edit`, { cookie: ownerCookie });
    assert.strictEqual(editGet.status, 200);
    const editPayload = {
      revision: editGet.json.revision,
      order: {
        ...editGet.json.order,
        promise_date: '2026-12-12', // changed after the draft was generated!
      },
      items: editGet.json.order.items,
    };
    const editPatch = await req(`/api/admin/orders/${encodeURIComponent(orderCode)}/edit`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: editPayload,
    });
    assert.strictEqual(editPatch.status, 200, editPatch.text);

    // GET job now flags subject_stale = true
    const afterDrift = await req(`/api/admin/office/jobs/${followupId}`, { cookie: ownerCookie });
    assert.strictEqual(afterDrift.status, 200);
    assert.strictEqual(afterDrift.json.job.subject_stale, true);

    // Owner tries to approve the stale operational draft -> MUST fail with 409 stale_subject_facts!
    const staleApprove = await req(`/api/admin/office/jobs/${followupId}/review`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        expected_revision: readyFollowup.revision,
        expected_result_hash: readyFollowup.result_hash,
        decision: 'approve',
      },
    });
    assert.strictEqual(staleApprove.status, 409);
    assert.strictEqual(staleApprove.json.error, 'stale_subject_facts');

    // Also test financial drift on `deposit_followup_draft`: changing deposit rule invalidates approval with 409!
    // Note: promise_date also drifted on the order, so let's revise depJobId first, generate fresh draft, then change deposit rule!
    const depBefore = (await req(`/api/admin/office/jobs/${depJobId}`, { cookie: ownerCookie })).json.job;
    const depRevise = await req(`/api/admin/office/jobs/${depJobId}`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: { payload: { order_code: orderCode }, expected_revision: depBefore.revision },
    });
    assert.strictEqual(depRevise.status, 200);
    await req('/api/admin/office/worker/step', { method: 'POST', cookie: ownerCookie, body: { provider: 'fixture' } });
    const depReady = (await req(`/api/admin/office/jobs/${depJobId}`, { cookie: ownerCookie })).json.job;
    assert.strictEqual(depReady.status, 'review');
    assert.strictEqual(depReady.subject_stale, false);

    // Change explicit deposit requirement on the order -> mutates financial facts!
    const mgmtGet = await req(`/api/admin/orders/${encodeURIComponent(orderCode)}/deposit-management`, { cookie: ownerCookie });
    assert.strictEqual(mgmtGet.status, 200);
    const ruleChange = await req(`/api/admin/orders/${encodeURIComponent(orderCode)}/deposit-requirement`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        mode: 'fixed',
        value: 900,
        reason: 'تعديل العربون لاختبار إبطال المسودة القديمة',
        request_id: 'req-rule-drift-123456',
        revision: mgmtGet.json.revision,
        confirm_requirement: true,
      },
    });
    assert.strictEqual(ruleChange.status, 201, ruleChange.text);

    // Approving `depReady` now MUST fail with 409 stale_subject_facts!
    const staleDepApprove = await req(`/api/admin/office/jobs/${depJobId}/review`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        expected_revision: depReady.revision,
        expected_result_hash: depReady.result_hash,
        decision: 'approve',
      },
    });
    assert.strictEqual(staleDepApprove.status, 409);
    assert.strictEqual(staleDepApprove.json.error, 'stale_subject_facts');

    // Revise operational draft on updated order facts, regenerate, and approve cleanly!
    const revisedFollowup = await req(`/api/admin/office/jobs/${followupId}`, {
      method: 'PATCH',
      cookie: staffCookie,
      body: {
        payload: { order_code: orderCode, focus: 'schedule' },
        expected_revision: readyFollowup.revision,
      },
    });
    assert.strictEqual(revisedFollowup.status, 200);
    assert.strictEqual(revisedFollowup.json.job.status, 'queued');

    await req('/api/admin/office/worker/step', { method: 'POST', cookie: ownerCookie, body: { provider: 'fixture' } });
    const freshFollowup = (await req(`/api/admin/office/jobs/${followupId}`, { cookie: ownerCookie })).json.job;
    assert.strictEqual(freshFollowup.status, 'review');
    assert.ok(freshFollowup.result.text.includes('2026-12-12'));

    // Tampered hash is rejected with 409
    const badHashApprove = await req(`/api/admin/office/jobs/${followupId}/review`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        expected_revision: freshFollowup.revision,
        expected_result_hash: '0'.repeat(64),
        decision: 'approve',
      },
    });
    assert.strictEqual(badHashApprove.status, 409);
    assert.strictEqual(badHashApprove.json.error, 'output_changed');

    // Exact revision + exact hash + unchanged order facts -> 200 approved!
    const cleanApprove = await req(`/api/admin/office/jobs/${followupId}/review`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        expected_revision: freshFollowup.revision,
        expected_result_hash: freshFollowup.result_hash,
        decision: 'approve',
      },
    });
    assert.strictEqual(cleanApprove.status, 200);
    assert.strictEqual(cleanApprove.json.job.status, 'approved');
    assert.strictEqual(cleanApprove.json.job.reviewed_by, `user:${ownerLogin.json.user.id}`);

    // Revising an approved job invalidates prior approval
    const postApproveRevise = await req(`/api/admin/office/jobs/${followupId}`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: {
        payload: { order_code: orderCode, focus: 'status_update' },
        expected_revision: cleanApprove.json.job.revision,
      },
    });
    assert.strictEqual(postApproveRevise.status, 200);
    assert.strictEqual(postApproveRevise.json.job.status, 'queued');
    assert.strictEqual(postApproveRevise.json.job.reviewed_by, null);
    assert.strictEqual(postApproveRevise.json.job.result, null);

    console.log('office-engine-rbac.test.js PASSED');
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => server.once('exit', r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
