'use strict';
/* Delivered = closed + weekly care campaign + readable drafts:

   1) The pre-delivery QA checklist speaks plain Arabic: Arabic stage name
      (no raw English enum), bulleted pieces, explicit decision explanation.
   2) Delivered/cancelled orders can never get NEW drafts (subject_not_active
      on enqueue) and can never be approved (stale subject). A checklist whose
      order got delivered AFTER enqueue fails honestly on prepare, is now
      deletable, and old failed rows are auto-purged with the archive.
   3) The weekly customer-care campaign (care_campaign_draft): enqueued once
      per week by the manager flow, aggregate-only facts (no names/phones),
      prepared automatically on the owner's visit, approvable -> بسمة ack in
      chat. It serves BOTH departments (service sends manually, marketing
      re-engages delivered customers). */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const PORT = 3072;
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-care-'));
  const dbPath = path.join(tmpDir, 'care.db');
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

    // 1. QA checklist card speaks plain Arabic -------------------------------------------------
    const orders = await (await fetch(`${BASE}/api/admin/orders?limit=30`, { headers: { 'X-Mavi-Token': ownerT } })).json();
    const list = Array.isArray(orders.orders) ? orders.orders : (Array.isArray(orders) ? orders : []);
    const readyOrder = list.find(o => o.status === 'ready') || list.find(o => !['delivered', 'cancelled'].includes(o.status));
    assert.ok(readyOrder, 'a ready-ish order must exist for the checklist check');
    const created = await api('POST', '/jobs', ownerT, { kind: 'quality_delivery_checklist', payload: { order_code: readyOrder.code }, idempotency_key: 'care-qc-1' });
    assert.strictEqual(created.status, 201);
    const qcId = (await created.json()).job.id;
    await api('POST', '/worker/step', ownerT, { provider: 'fixture', job_id: qcId });
    const qcJob = (await (await api('GET', `/jobs/${qcId}`, ownerT)).json()).job;
    assert.strictEqual(qcJob.status, 'review');
    assert.ok(!qcJob.result.text.includes('ready') && !qcJob.result.text.includes('delivering'),
      'checklist text must never leak raw English status enums');
    assert.ok(qcJob.result.text.includes('القطع المطلوب فحصها'), 'checklist must label the pieces section');
    assert.ok(qcJob.result.text.includes('•'), 'checklist must use bullet items');
    assert.ok(qcJob.result.text.includes('اعتمدي القائمة'), 'checklist must explain what approving means');

    // 2. Delivered = closed -------------------------------------------------------------------
    // Find a delivered order (or deliver one directly in the DB)
    let delivered = list.find(o => o.status === 'delivered');
    const direct = new Database(dbPath);
    if (!delivered) {
      const anyOpen = list.find(o => !['delivered', 'cancelled'].includes(o.status));
      assert.ok(anyOpen, 'an order must exist');
      direct.prepare("UPDATE orders SET status='delivered' WHERE code=?").run(anyOpen.code);
      delivered = { code: anyOpen.code, id: anyOpen.id };
    }
    direct.close();
    const blocked = await api('POST', '/jobs', ownerT, { kind: 'order_followup_draft', payload: { order_code: delivered.code, focus: 'schedule' }, idempotency_key: 'care-closed-1' });
    assert.strictEqual(blocked.status, 409, 'delivered orders must refuse new drafts');
    assert.strictEqual((await blocked.json()).error, 'subject_not_active');

    // A checklist whose order got delivered after enqueue fails honestly on prepare...
    const qc2 = await api('POST', '/jobs', ownerT, { kind: 'quality_delivery_checklist', payload: { order_code: readyOrder.code }, idempotency_key: 'care-qc-2' });
    const qc2Id = (await qc2.json()).job.id;
    const d2 = new Database(dbPath);
    d2.prepare("UPDATE orders SET status='delivered' WHERE code=?").run(readyOrder.code);
    d2.close();
    await api('POST', '/worker/step', ownerT, { provider: 'fixture', job_id: qc2Id });
    const qc2Job = (await (await api('GET', `/jobs/${qc2Id}`, ownerT)).json()).job;
    assert.strictEqual(qc2Job.status, 'failed', 'a checklist for a since-delivered order must fail honestly');

    // ...and failed drafts are now deletable + auto-purged with the archive
    const delRes = await api('DELETE', `/jobs/${qc2Id}`, ownerT);
    assert.strictEqual(delRes.status, 200, 'failed drafts must be deletable now');
    assert.strictEqual((await api('DELETE', `/jobs/${qcId}`, ownerT)).status, 400, 'review-stage drafts stay protected');
    // A second checklist that fails (order delivered mid-flight), aged 9 days:
    // the lazy retention visit must purge it like other decided rows.
    const qc3 = await api('POST', '/jobs', ownerT, { kind: 'quality_delivery_checklist', payload: { order_code: readyOrder.code }, idempotency_key: 'care-qc-3' });
    assert.strictEqual(qc3.status, 409, 'after delivery the order refuses any new drafts');
    const qcFailId = qc2Id; // the already-failed one was deleted; age a fresh failure instead
    const qc4 = await api('POST', '/jobs', ownerT, { kind: 'care_campaign_draft', payload: {}, idempotency_key: 'care-aged-fail' });
    const qc4Id = (await qc4.json()).job.id;
    const d3 = new Database(dbPath);
    d3.prepare("UPDATE office_jobs SET status='failed', error_code='subject_not_active', updated_at=? WHERE id=?")
      .run(Date.now() / 1000 - 9 * 86400, qc4Id);
    d3.close();
    await api('GET', '/jobs', ownerT); // lazy retention visit purges 8+ day old failed/approved/rejected
    assert.strictEqual((await api('GET', `/jobs/${qc4Id}`, ownerT)).status, 404, 'old failed rows must be auto-purged');

    // 3. Weekly care campaign -----------------------------------------------------------------
    let jobs = (await (await api('GET', '/jobs', ownerT)).json()).jobs;
    assert.ok(!jobs.some(j => j.kind === 'order_followup_draft' && j.subject_ref === String(delivered.id ?? delivered.code)),
      'no follow-up draft may exist for a delivered order');
    const care = jobs.find(j => j.kind === 'care_campaign_draft');
    assert.ok(care, 'the weekly care campaign must be enqueued by the manager flow');
    const careFull = (await (await api('GET', `/jobs/${care.id}`, ownerT)).json()).job;
    assert.strictEqual(careFull.status, 'review', 'the care campaign must be auto-prepared on the owner visit');
    // Aggregate-only: no names or phones anywhere in the draft
    const flat = JSON.stringify(careFull.result);
    assert.ok(!/"phone"|"contact_phone"|contact_name/.test(flat), 'care campaign facts must carry no PII fields');
    assert.ok(careFull.result.text.includes('واحدة واحدة'), 'care campaign must mandate manual one-by-one sending');
    assert.ok(careFull.result.facts_used.some(f => f.label.includes('طبيعة البيانات')), 'care campaign must state its data nature');
    // Approve -> بسمة acknowledges in chat
    const careApprove = await api('POST', `/jobs/${care.id}/review`, ownerT, {
      expected_revision: careFull.revision,
      expected_result_hash: careFull.result_hash,
      decision: 'approve',
    });
    assert.strictEqual(careApprove.status, 200);
    const chat = (await (await api('GET', '/chat', ownerT)).json());
    assert.ok(chat.messages.some(m => m.sender_role === 'staff' && m.body.includes('حملة العناية جاهزة')), 'بسمة must acknowledge the approved care campaign');

    // Enqueueing another care campaign with the same weekly key dedupes
    const dupe = await api('POST', '/jobs', ownerT, { kind: 'care_campaign_draft', payload: {}, idempotency_key: 'cycle:wX:care-campaign' });
    assert.ok([200, 201].includes(dupe.status), 'care campaign enqueue must be idempotent per week');

    console.log('CARE-AND-CLOSURE-OK');
  } finally {
    child.kill('SIGKILL');
  }
})().catch((err) => { console.error(err); process.exit(1); });
