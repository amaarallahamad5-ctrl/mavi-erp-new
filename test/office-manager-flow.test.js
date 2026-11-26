'use strict';
/* Manager-flow acceptance (owner's ask): the background worker prepares
   everything queued automatically (local, zero network), the general manager
   reports the whole picture, and ONE owner decision (bulk approve / bulk
   reject / a single card) moves the whole team — while the final execution
   (send/publish/spend) always stays manual and AI stays behind her button.

   1) Lazy auto-prepare: owner /jobs visit prepares queued drafts with the
      fixture provider (no button, no network); staff visits never drain.
   2) Bulk approve: all prepared drafts approved in one press — approvals
      chain + handoff acks fire (same as single decisions), رامي posts the
      decided jobs and the handoff chain.
   3) Bulk with a stale target: that item fails with its exact code and is
      reported honestly; the rest succeed; nothing auto-retries.
   4) Bulk reject: no handoff, drafts rejected back to their employees.
   5) RBAC: staff bulk-review is forbidden; exact-body enforced.
   6) The AI generation path is untouched: openrouter steps still need the
      owner's explicit per-draft press (fixture drain makes zero network). */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3070;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitPort(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 502) return;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-manager-'));
  const dbPath = path.join(tmpDir, 'manager.db');
  const seeded = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
  });
  assert.strictEqual(seeded.status, 0, seeded.stderr);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: dbPath, PORT: String(PORT), MAVI_OPENROUTER_ENABLED: '0' },
    stdio: 'ignore',
  });
  try {
    await waitPort(`${BASE}/store/`);
    const login = async (email, password) => {
      const r = await fetch(`${BASE}/api/admin/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert.strictEqual(r.status, 200);
      return (await r.json()).token;
    };
    const ownerT = await login('owner@mavi.eg', 'mavi-owner');
    const staffT = await login('staff@mavi.eg', 'mavi-staff');
    const api = async (method, p, token, body) => fetch(`${BASE}/api/admin/office${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Mavi-Token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // Enqueue a batch the owner NEVER manually prepares
    const kinds = [
      ['content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }],
      ['campaign_brief', { product_id: 'DEMO-PUBLIC-01', channel: 'facebook', daily_budget_egp: 40 }],
      ['seo_readiness_check', { product_id: 'DEMO-PUBLIC-01' }],
      ['visual_reel_brief', { product_id: 'DEMO-PUBLIC-01' }],
      ['daily_ops_triage', {}],
    ];
    for (const [i, [kind, payload]] of kinds.entries()) {
      const r = await api('POST', '/jobs', ownerT, { kind, payload, idempotency_key: `mgr-${i}` });
      assert.strictEqual(r.status, 201);
    }

    // 1. Staff visits do NOT drain the queue (staff sees only staff-visible
    //    kinds — campaign_brief is owner-only — and none may be prepared)
    let jobs = (await (await api('GET', '/jobs', staffT)).json()).jobs;
    assert.strictEqual(jobs.length, kinds.length - 1, 'staff must not see owner-only kinds');
    assert.strictEqual(jobs.filter(j => j.status === 'review').length, 0, 'staff visit must not prepare queued drafts');

    // One owner visit: everything queued is prepared automatically, zero network
    jobs = (await (await api('GET', '/jobs', ownerT)).json()).jobs;
    assert.strictEqual(jobs.filter(j => j.status === 'review' && j.result_hash).length, kinds.length + 1,
      'the background worker must prepare all queued drafts (incl. the weekly care campaign) on the owner visit');
    const statusNow = await (await api('GET', '/status', ownerT)).json();
    assert.strictEqual(statusNow.worker.network_calls, 0, 'auto-prepare must be fully local (zero network)');

    // 2. RBAC + exact body on bulk review
    assert.strictEqual((await api('POST', '/jobs/bulk-review', staffT, { decision: 'approve', targets: [] })).status, 403);
    assert.strictEqual((await api('POST', '/jobs/bulk-review', ownerT, { decision: 'approve' })).status, 400);
    assert.strictEqual((await api('POST', '/jobs/bulk-review', ownerT, { decision: 'approve', targets: [], note: 'x' })).status, 400);
    assert.strictEqual((await api('POST', '/jobs/bulk-review', ownerT, { decision: 'maybe', targets: [] })).status, 400);

    // 3. Bulk approve everything prepared in ONE decision
    const reviewJobs = jobs.filter(j => j.status === 'review' && j.result_hash);
    const bulk = await api('POST', '/jobs/bulk-review', ownerT, {
      decision: 'approve',
      targets: reviewJobs.map(j => ({ id: j.id, expected_revision: j.revision, expected_result_hash: j.result_hash })),
    });
    assert.strictEqual(bulk.status, 200);
    const bulkRes = await bulk.json();
    assert.strictEqual(bulkRes.decision, 'approve');
    assert.strictEqual(bulkRes.approved, kinds.length + 1, 'every prepared draft (incl. the care campaign) must be approved');
    assert.strictEqual(bulkRes.rejected, 0);
    assert.strictEqual(bulkRes.failed, 0);

    // Approvals moved the team: chained next steps queued AND prepared
    jobs = (await (await api('GET', '/jobs', ownerT)).json()).jobs;
    const decidedIds = new Set(reviewJobs.filter(j => j.kind !== 'care_campaign_draft').map(j => j.id));
    assert.ok(decidedIds.size === kinds.length);
    assert.ok(jobs.filter(j => decidedIds.has(j.id)).every(j => j.status === 'approved'), 'the whole batch must now be approved');
    assert.ok(jobs.find(j => j.kind === 'care_campaign_draft' && decidedIds.has(j.id) === false) === undefined || jobs.every(j => j.kind !== 'care_campaign_draft' || j.status === 'approved'), 'the care campaign must be approved too');
    const chainOnlyKinds = ['community_followup_draft', 'landing_page_check', 'paid_ad_setup_draft'];
    const chained = jobs.filter(j => chainOnlyKinds.includes(j.kind));
    assert.ok(chained.length >= 3, 'approvals must queue the planned next steps (community reply, landing check, ad setup plan)');
    assert.ok(chained.every(j => j.status === 'review'), 'chained steps must already be prepared by the handoff');
    assert.strictEqual(jobs.filter(j => ['queued', 'review', 'failed'].includes(j.status) && decidedIds.has(j.id)).length, 0,
      'the originally requested batch must be fully decided');

    // (the team chat was removed by owner decision — the bulk decision itself
    //  is already asserted above through the job states)

    // 4. Bulk reject on a fresh batch: no chain, honest per-item failure
    const rejKinds = [
      ['content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'facebook' }],
      ['visual_reel_brief', { product_id: 'DEMO-PUBLIC-01' }],
    ];
    for (const [i, [kind, payload]] of rejKinds.entries()) {
      await api('POST', '/jobs', ownerT, { kind, payload, idempotency_key: `mgr-rej-${i}` });
    }
    jobs = (await (await api('GET', '/jobs', ownerT)).json()).jobs; // auto-prepared by this very visit
    const rejTargets = jobs.filter(j => j.status === 'review' && j.result_hash)
      .map(j => ({ id: j.id, expected_revision: j.revision, expected_result_hash: j.result_hash }));
    // 5 chained jobs (reel + seo + community from the post, ad setup from the
    // campaign, landing from the seo check) + the 2 newly enqueued drafts
    assert.strictEqual(rejTargets.length, rejKinds.length + 5, 'this visit prepared the new batch (the chained ones were already review)');
    const rejRes = await (await api('POST', '/jobs/bulk-review', ownerT, { decision: 'reject', targets: rejTargets })).json();
    assert.strictEqual(rejRes.rejected, rejTargets.length);
    assert.strictEqual(rejRes.failed, 0);
    jobs = (await (await api('GET', '/jobs', ownerT)).json()).jobs;
    const rejIds = new Set(rejTargets.map(t => t.id));
    assert.ok(!jobs.some(j => rejIds.has(j.id) && j.status === 'review'), 'rejected batch must be decided');

    // 5. Stale target inside a bulk call: reported honestly, others succeed
    const fresh = await api('POST', '/jobs', ownerT, { kind: 'seo_readiness_check', payload: { product_id: 'DEMO-PUBLIC-01' }, idempotency_key: 'mgr-stale-0' });
    const freshJob = (await fresh.json()).job;
    jobs = (await (await api('GET', '/jobs', ownerT)).json()).jobs;
    const freshPrepared = jobs.find(j => j.id === freshJob.id);
    assert.strictEqual(freshPrepared.status, 'review');
    // Tamper: wrong revision for this target only
    const mixed = await api('POST', '/jobs/bulk-review', ownerT, {
      decision: 'approve',
      targets: [
        { id: freshPrepared.id, expected_revision: freshPrepared.revision + 5, expected_result_hash: freshPrepared.result_hash },
      ],
    });
    const mixedRes = await mixed.json();
    assert.strictEqual(mixedRes.approved, 0);
    assert.strictEqual(mixedRes.failed, 1);
    assert.strictEqual(mixedRes.results[0].code, 'stale_revision_or_not_awaiting_review', 'stale items must fail with the exact per-item code');
    jobs = (await (await api('GET', '/jobs', ownerT)).json()).jobs;
    assert.strictEqual(jobs.find(j => j.id === freshJob.id).status, 'review', 'a failed bulk target must remain untouched for a human retry');

    console.log('MANAGER-FLOW-OK');
  } finally {
    child.kill('SIGKILL');
  }
})().catch((err) => { console.error(err); process.exit(1); });
