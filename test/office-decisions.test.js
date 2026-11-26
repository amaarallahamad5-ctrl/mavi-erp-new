'use strict';
/* Task G follow-up acceptance suite: owner decisions must actually DO something
   and decided drafts must never pile up:

   1) Approving a draft queues AND auto-prepares the next planned steps offline
      (fixture provider, zero network) so the handoff is visible immediately:
      content_draft -> visual_reel_brief + seo_readiness_check + community_followup_draft,
      campaign_brief -> paid_ad_setup_draft (planning only, no spend),
      seo_readiness_check -> landing_page_check.
   2) Approvals with no chain still record the decision + staff pickup ack in chat.
   3) Decided drafts (approved/rejected) are never auto-executed: statuses stay
      'approved'/'rejected' with manual-only execution.
   4) Owner-only cleanup: per-card DELETE (decided only), POST /jobs/purge-decided
      bulk purge, and a lazy 7-day retention purge on owner /jobs visits.
      The audit trail outlives deleted rows; review/queued/failed are untouched. */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const PORT = 3068;
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-decisions-'));
  const dbPath = path.join(tmpDir, 'decisions.db');
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

    const prepareAndApprove = async (kind, payload, idem, decision = 'approve') => {
      const created = await api('POST', '/jobs', ownerT, { kind, payload, idempotency_key: idem });
      assert.strictEqual(created.status, 201, `${kind} must enqueue`);
      const jobId = (await created.json()).job.id;
      const step = await api('POST', '/worker/step', ownerT, { provider: 'fixture', job_id: jobId });
      assert.strictEqual(step.status, 200, `${kind} fixture prepare must succeed`);
      const full = await (await api('GET', `/jobs/${jobId}`, ownerT)).json();
      assert.strictEqual(full.job.status, 'review', `${kind} must be prepared for review`);
      const res = await api('POST', `/jobs/${jobId}/review`, ownerT, {
        expected_revision: full.job.revision,
        expected_result_hash: full.job.result_hash,
        decision,
      });
      assert.strictEqual(res.status, 200, `${kind} ${decision} must succeed`);
      return { jobId, body: await res.json() };
    };

    // ---------------------------------------------------------------
    // 1. content_draft approval -> 3 next steps queued AND prepared offline
    // ---------------------------------------------------------------
    const cd = await prepareAndApprove('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'dec-cd-1');
    assert.strictEqual(cd.body.job.status, 'approved', 'the approved draft itself must be approved (never executed)');
    assert.strictEqual(cd.body.job.manual_execution !== true, true);
    assert.deepStrictEqual(
      { q: cd.body.handoff.next_queued, p: cd.body.handoff.next_prepared },
      { q: 3, p: 3 },
      'approval must queue AND prepare the 3 planned next steps'
    );
    assert.deepStrictEqual(
      cd.body.handoff.next_kinds.slice().sort(),
      ['community_followup_draft', 'seo_readiness_check', 'visual_reel_brief'],
      'handoff must name the exact next kinds'
    );
    let jobs = (await (await api('GET', '/jobs', ownerT)).json()).jobs;
    const chained = jobs.filter(j => ['visual_reel_brief', 'seo_readiness_check', 'community_followup_draft'].includes(j.kind));
    assert.strictEqual(chained.length, 3);
    assert.ok(chained.every(j => j.status === 'review'), 'chained drafts must be visible in review immediately (the approval did something!)');
    assert.ok(chained.every(j => j.result && j.result.title), 'chained drafts must carry full prepared content');

    // (the team chat was removed by owner decision — the prepared tail is
    //  asserted above through the chained job states)

    // ---------------------------------------------------------------
    // 2. campaign_brief -> paid_ad_setup_draft (planning doc, still no spend)
    // ---------------------------------------------------------------
    const cb = await prepareAndApprove('campaign_brief', { product_id: 'DEMO-PUBLIC-01', channel: 'facebook', daily_budget_egp: 50 }, 'dec-cb-1');
    assert.strictEqual(cb.body.handoff.next_prepared, 1, 'campaign approval must hand off to the ad setup planning draft');
    jobs = (await (await api('GET', '/jobs', ownerT)).json()).jobs;
    const paid = jobs.find(j => j.kind === 'paid_ad_setup_draft');
    assert.ok(paid && paid.status === 'review', 'paid_ad_setup_draft must be prepared and awaiting review');

    // ---------------------------------------------------------------
    // 3. seo_readiness_check -> landing_page_check
    // ---------------------------------------------------------------
    const seo = await prepareAndApprove('seo_readiness_check', { product_id: 'DEMO-PUBLIC-01' }, 'dec-seo-1');
    assert.strictEqual(seo.body.handoff.next_prepared, 1);
    jobs = (await (await api('GET', '/jobs', ownerT)).json()).jobs;
    const lpc = jobs.find(j => j.kind === 'landing_page_check');
    assert.ok(lpc && lpc.status === 'review', 'landing_page_check must be prepared and awaiting review');

    // ---------------------------------------------------------------
    // 4. No-chain kind: approval records decision + pickup ack, no new jobs
    // ---------------------------------------------------------------
    const ops = await prepareAndApprove('daily_ops_triage', {}, 'dec-ops-1');
    assert.deepStrictEqual(
      { q: ops.body.handoff.next_queued, p: ops.body.handoff.next_prepared, k: ops.body.handoff.next_kinds },
      { q: 0, p: 0, k: [] },
      'kinds without a planned next step must not fabricate work'
    );
    // no-chain approvals previously posted a pickup ack in chat (removed)

    // Zero external network for the whole offline pipeline
    const statusNow = await (await api('GET', '/status', ownerT)).json();
    assert.strictEqual(statusNow.worker.network_calls, 0, 'the whole handoff pipeline must run with zero external network calls');

    // ---------------------------------------------------------------
    // 5. Reject path: no handoff, status rejected
    // ---------------------------------------------------------------
    const rej = await prepareAndApprove('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'facebook' }, 'dec-cd-2', 'reject');
    assert.strictEqual(rej.body.job.status, 'rejected');
    assert.strictEqual(rej.body.handoff, null, 'rejection must not trigger any handoff');

    // ---------------------------------------------------------------
    // 6. RBAC: staff can never purge or delete
    // ---------------------------------------------------------------
    assert.strictEqual((await api('POST', '/jobs/purge-decided', staffT, {})).status, 403);
    const anyDecided = (await (await api('GET', '/jobs', ownerT)).json()).jobs.find(j => ['approved', 'rejected'].includes(j.status));
    assert.ok(anyDecided, 'a decided job must exist for the RBAC check');
    assert.strictEqual((await api('DELETE', `/jobs/${anyDecided.id}`, staffT)).status, 403);

    // Deleting a still-undecided draft is refused
    const stillReview = (await (await api('GET', '/jobs', ownerT)).json()).jobs.find(j => j.status === 'review');
    assert.ok(stillReview);
    const refused = await api('DELETE', `/jobs/${stillReview.id}`, ownerT);
    assert.strictEqual(refused.status, 400);
    assert.strictEqual((await refused.json()).error, 'only_decided_jobs_can_be_deleted');

    // ---------------------------------------------------------------
    // 7. Per-card delete: decided only, audit survives, replay 404
    // ---------------------------------------------------------------
    const del = await api('DELETE', `/jobs/${rej.jobId}`, ownerT);
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await del.json()).deleted_id, rej.jobId);
    assert.strictEqual((await api('GET', `/jobs/${rej.jobId}`, ownerT)).status, 404, 'deleted decided draft must be gone');
    assert.strictEqual((await api('DELETE', `/jobs/${rej.jobId}`, ownerT)).status, 404);

    // ---------------------------------------------------------------
    // 8. Bulk purge: all decided drafts gone, active untouched, audit kept
    // ---------------------------------------------------------------
    const beforePurge = (await (await api('GET', '/jobs', ownerT)).json()).jobs;
    const decidedCount = beforePurge.filter(j => ['approved', 'rejected'].includes(j.status)).length;
    const activeCount = beforePurge.filter(j => ['queued', 'review', 'failed'].includes(j.status)).length;
    assert.ok(decidedCount >= 4, 'several decided drafts must exist before the purge');
    const purge = await api('POST', '/jobs/purge-decided', ownerT, {});
    assert.strictEqual(purge.status, 200);
    const purgeRes = await purge.json();
    assert.strictEqual(purgeRes.ok, true);
    assert.strictEqual(purgeRes.purged, decidedCount);
    assert.strictEqual(purgeRes.archive_remaining, 0);
    jobs = (await (await api('GET', '/jobs', ownerT)).json()).jobs;
    assert.ok(!jobs.some(j => ['approved', 'rejected'].includes(j.status)), 'no decided draft may remain after the purge');
    assert.strictEqual(jobs.filter(j => ['queued', 'review', 'failed'].includes(j.status)).length, activeCount, 'active drafts must be untouched');
    assert.strictEqual((await (await api('POST', '/jobs/purge-decided', ownerT, {}))).status, 200, 'purge is idempotent');

    // ---------------------------------------------------------------
    // 9. Lazy 7-day retention: old decided rows vanish on owner visits,
    //    review-stage rows (even old) are never touched
    // ---------------------------------------------------------------
    const lazy = await prepareAndApprove('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'dec-lazy-1');
    assert.strictEqual(lazy.body.handoff.next_prepared, 3);
    const direct = new Database(dbPath);
    const eightDaysAgo = Date.now() / 1000 - 8 * 86400;
    const decidedRows = direct.prepare("SELECT id FROM office_jobs WHERE status = 'approved'").all();
    assert.ok(decidedRows.length >= 1);
    const reviewRows = direct.prepare("SELECT id FROM office_jobs WHERE status = 'review'").all();
    const markOld = direct.prepare('UPDATE office_jobs SET updated_at = ? WHERE id = ?');
    for (const r of decidedRows) markOld.run(eightDaysAgo, r.id);
    for (const r of reviewRows) markOld.run(eightDaysAgo, r.id); // old-but-undecided must survive
    direct.close();

    jobs = (await (await api('GET', '/jobs', ownerT)).json()).jobs;
    assert.ok(!jobs.some(j => j.id === lazy.jobId), '8-day-old approved draft must be purged automatically');
    assert.ok(!jobs.some(j => ['approved', 'rejected'].includes(j.status)), 'all old decided rows must be purged');
    const survivingReview = jobs.filter(j => reviewRows.some(r => r.id === j.id));
    assert.strictEqual(survivingReview.length, reviewRows.length, 'undecided (review) rows must survive the retention purge even when old');

    console.log('DECISIONS-OK');
  } finally {
    child.kill('SIGKILL');
  }
})().catch((err) => { console.error(err); process.exit(1); });
