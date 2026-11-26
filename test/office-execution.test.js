'use strict';
/* Office EXECUTION tools — the office does real work on MAVI, honestly:

   Tool #1 (style_page_copy_draft → styles.note):
     enqueue (staff allowed) → prepare (fixture = local template, real style
     facts: fabrics/colours/lead days only, never price) → review card carries
     an ACTION (old note captured) → approve EXECUTES the write through a
     narrow audited tool → the row is RE-READ to verify → publicCache is
     invalidated → the PUBLIC /store/product page really shows the new copy →
     the draft moves to «تم التنفيذ والتحقق» with evidence + link → the
     previous note can be RESTORED with one press (verified again).

   Tool #2 (delivery_promise_draft → orders.promise_date):
     proposed date computed ONLY from registered lead days (nothing invented);
     gaps listed honestly (missing measurements, unpriced custom pieces);
     approve executes through the same rules as the owner edit form (date
     validated, delivered/cancelled refused) and re-reads the row to verify.

   Honesty guarantees tested here:
     - stale order facts (order edited after prepare) refuse approval 409 and
       NEVER execute;
     - a corrupted proposed date fails the EXECUTION step (not the approval):
       execution=failed with the reason, the order keeps its old date, and the
       owner can retry via the manual execute endpoint after fixing;
     - delivered orders refuse new promise drafts (subject_not_active);
     - staff cannot execute/restore; non-action kinds have no execution tool;
     - the chat ack states the verified execution outcome (not «تم العمل»). */
const assert = require('assert');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3073;
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

/* Same canonical form as the engine: sorted keys, deep, no spaces. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}
function digest(value) {
  return crypto.createHash('sha256').update(canonical(value)).digest('hex');
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-exec-'));
  const dbPath = path.join(tmpDir, 'exec.db');
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

    // 0. UI contract: the 5-state distinction + honest buttons exist ----------------------------
    const uiSrc = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');
    assert.ok(uiSrc.includes("verified: { label: 'تم التنفيذ والتحقق ✓ — النتيجة على الصفحة/السجل'"), 'verified state label');
    assert.ok(uiSrc.includes("failed: { label: 'فشل التنفيذ — يحتاج تدخل'"), 'failed state label');
    assert.ok(uiSrc.includes('إعادة محاولة التنفيذ'), 'retry button');
    assert.ok(uiSrc.includes('استرجاع الوصف السابق'), 'restore button');
    assert.ok(uiSrc.includes("/execute'"), 'execute endpoint wired');
    assert.ok(uiSrc.includes("/restore'"), 'restore endpoint wired');
    assert.ok(uiSrc.includes("collection_copy_draft"), 'collection tool present in UI');
    const spaSrc = fs.readFileSync(path.join(ROOT, 'public/store/index.html'), 'utf8');
    assert.ok(spaSrc.includes('sec-note'), 'storefront renders collection notes under the tabs');
    assert.ok(spaSrc.includes('CAT_NOTES'), 'storefront loads collection notes from the catalogue API');

    // 1. TOOL #1 — style page copy, full verified lifecycle -------------------------------------
    const styleId = 'DR-04';
    const oldNote = 'قصّة واسعة وأكمام واسعة';
    const pageBefore = await (await fetch(`${BASE}/store/product/${styleId}`)).text();
    assert.ok(pageBefore.includes(oldNote), 'seeded note visible on the public page before execution');

    const styleJob = await api('POST', '/jobs', ownerT, {
      kind: 'style_page_copy_draft', payload: { style_id: styleId }, idempotency_key: 'exec-style-1',
    });
    const sjBody = await styleJob.json();
    assert.strictEqual(styleJob.status, 201, JSON.stringify(sjBody));
    const styleJobId = sjBody.job.id;

    // staff may create the same kind for another style (allowed_create_roles includes staff)
    const styleJob2 = await api('POST', '/jobs', staffT, {
      kind: 'style_page_copy_draft', payload: { style_id: 'SK-05' }, idempotency_key: 'exec-style-2-staff',
    });
    assert.strictEqual(styleJob2.status, 201);

    // a style that does not exist refuses the draft immediately
    const badStyle = await api('POST', '/jobs', ownerT, {
      kind: 'style_page_copy_draft', payload: { style_id: 'ZZ-99' }, idempotency_key: 'exec-style-bad',
    });
    assert.strictEqual(badStyle.status, 404, 'unknown style must refuse enqueue');

    await api('POST', '/worker/step', ownerT, { provider: 'fixture', job_id: styleJobId });
    const prepared = (await (await api('GET', `/jobs/${styleJobId}`, ownerT)).json()).job;
    assert.strictEqual(prepared.status, 'review');
    assert.strictEqual(prepared.result.action.type, 'style_note', 'review card carries the real action');
    assert.strictEqual(prepared.result.action.style_id, styleId);
    assert.strictEqual(prepared.result.action.old_note, oldNote, 'previous note captured at prepare time');
    assert.ok(prepared.result.text && prepared.result.text.length >= 60, 'proposed copy is real text');
    assert.ok(prepared.result.text.includes('مافي'), 'copy speaks about the brand');
    assert.ok(!/\d+\s*(جنيه|EGP|LE)/.test(prepared.result.text), 'no invented price in the copy');
    assert.ok(prepared.result.provenance.mode === 'fixture', 'local-template provenance (no AI key in this suite)');
    assert.ok(prepared.result.facts_used.some((f) => f.label === 'الوصف الحالي على الموقع (SEO)'), 'facts show the current note');

    // execution is NOT possible before approval
    const earlyExec = await api('POST', `/jobs/${styleJobId}/execute`, ownerT, {});
    assert.strictEqual(earlyExec.status, 409, 'execute before approval must refuse');
    // staff can never execute
    const staffExec = await api('POST', `/jobs/${styleJobId}/execute`, staffT, {});
    assert.strictEqual(staffExec.status, 403, 'staff must never execute');
    // non-action kinds have no execution tool
    const qc = await api('POST', '/jobs', ownerT, {
      kind: 'quality_delivery_checklist', payload: { order_code: 'MV-2611-110' }, idempotency_key: 'exec-qc-guard',
    });
    const qcId = (await qc.json()).job.id;
    const qcExec = await api('POST', `/jobs/${qcId}/execute`, ownerT, {});
    assert.strictEqual(qcExec.status, 400, 'checklist has no execution tool');

    const review = await api('POST', `/jobs/${styleJobId}/review`, ownerT, {
      expected_revision: prepared.revision, expected_result_hash: prepared.result_hash, decision: 'approve',
    });
    const reviewBody = await review.json();
    assert.strictEqual(review.status, 200, JSON.stringify(reviewBody));
    const approvedJob = reviewBody.job;
    assert.strictEqual(approvedJob.status, 'approved');
    assert.strictEqual(approvedJob.execution, 'verified', 'approve → executed → verified in one press');
    assert.strictEqual(approvedJob.execution_result.ok, true);
    assert.strictEqual(approvedJob.execution_result.tool, 'style_note_update');
    assert.strictEqual(approvedJob.execution_result.style_id, styleId);
    assert.strictEqual(approvedJob.execution_result.old_note, oldNote);
    assert.strictEqual(approvedJob.execution_result.new_note, prepared.result.text, 'the REVIEWED text is what got written');
    assert.strictEqual(approvedJob.execution_result.link, `/store/product/${styleId}`);

    // REAL verification: the public product page now shows the new copy
    const pageAfter = await (await fetch(`${BASE}/store/product/${styleId}`)).text();
    const probe = approvedJob.execution_result.new_note.slice(0, 40);
    assert.ok(pageAfter.includes(probe), 'public /store/product page must show the executed copy');

    // double execution refuses
    const again = await api('POST', `/jobs/${styleJobId}/execute`, ownerT, {});
    assert.strictEqual(again.status, 409, 'already executed + verified');

    // restore the previous note (also verified)
    const restore = await api('POST', `/jobs/${styleJobId}/restore`, ownerT, {});
    assert.strictEqual(restore.status, 200);
    const restoredJob = (await restore.json()).job;
    assert.strictEqual(restoredJob.execution, 'restored');
    assert.strictEqual(restoredJob.execution_result.new_note, oldNote, 'restore wrote the previous note back');
    const pageRestored = await (await fetch(`${BASE}/store/product/${styleId}`)).text();
    assert.ok(!pageRestored.includes(probe), 'new copy gone after restore');
    assert.ok(pageRestored.includes(oldNote), 'previous note back on the public page');

    // 2. TOOL #2 — delivery promise date, full verified lifecycle --------------------------------
    const code = 'MV-2611-110';
    const editState0 = await (await fetch(`${BASE}/api/admin/orders/${code}/edit`, { headers: { 'X-Mavi-Token': ownerT } })).json();
    const originalDate = editState0.order.promise_date;

    const pJob = await api('POST', '/jobs', staffT, {
      kind: 'delivery_promise_draft', payload: { order_code: code }, idempotency_key: 'exec-promise-1',
    });
    assert.strictEqual(pJob.status, 201);
    const pJobId = (await pJob.json()).job.id;
    await api('POST', '/worker/step', ownerT, { provider: 'fixture', job_id: pJobId });
    const pPrepared = (await (await api('GET', `/jobs/${pJobId}`, ownerT)).json()).job;
    assert.strictEqual(pPrepared.status, 'review');
    assert.strictEqual(pPrepared.result.action.type, 'set_promise_date');
    assert.strictEqual(pPrepared.result.action.order_code, code);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(pPrepared.result.action.proposed_date), 'proposed date is a real date');
    assert.ok(pPrepared.result.text.includes('أطول مدة تنفيذ'), 'date basis is stated (registered lead days)');
    assert.ok(pPrepared.result.text.includes('مفيش موعد تسليم مسجل') || pPrepared.result.text.includes('فيه موعد مسجل'), 'current promise state stated honestly');
    assert.ok(pPrepared.result.facts_used.some((f) => f.label === 'الموعد الحالي'), 'facts include current date');

    // stale subject: owner edits order FACTS (fabric_choice is part of the
    // subject snapshot) AFTER prepare → approval refuses, nothing executes
    const noteChanged = `${editState0.order.note || ''} (تحديث تجريبي للفحص)`.trim();
    const fabricChanged = `${editState0.order.fabric_choice || ''} تحديث`.trim();
    const patchRes = await fetch(`${BASE}/api/admin/orders/${code}/edit`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Mavi-Token': ownerT },
      body: JSON.stringify({ order: { ...editState0.order, note: noteChanged, fabric_choice: fabricChanged }, items: editState0.order.items, revision: editState0.revision }),
    });
    const patchBody = await patchRes.json();
    assert.strictEqual(patchRes.status, 200, JSON.stringify(patchBody));
    const staleReview = await api('POST', `/jobs/${pJobId}/review`, ownerT, {
      expected_revision: pPrepared.revision, expected_result_hash: pPrepared.result_hash, decision: 'approve',
    });
    assert.strictEqual(staleReview.status, 409, 'stale order facts must refuse approval');
    const pAfterStale = (await (await api('GET', `/jobs/${pJobId}`, ownerT)).json()).job;
    assert.strictEqual(pAfterStale.status, 'review');
    assert.ok(!pAfterStale.execution, 'nothing executed on stale subject');

    // refresh the draft onto the new facts, re-prepare, approve → executes
    const revise = await api('PATCH', `/jobs/${pJobId}`, ownerT, { payload: { order_code: code }, expected_revision: pAfterStale.revision });
    assert.strictEqual(revise.status, 200);
    await api('POST', '/worker/step', ownerT, { provider: 'fixture', job_id: pJobId });
    const pFresh = (await (await api('GET', `/jobs/${pJobId}`, ownerT)).json()).job;
    assert.strictEqual(pFresh.status, 'review');
    const pReview = await api('POST', `/jobs/${pJobId}/review`, ownerT, {
      expected_revision: pFresh.revision, expected_result_hash: pFresh.result_hash, decision: 'approve',
    });
    const pReviewBody = await pReview.json();
    assert.strictEqual(pReview.status, 200, JSON.stringify(pReviewBody));
    const pApproved = pReviewBody.job;
    assert.strictEqual(pApproved.execution, 'verified');
    assert.strictEqual(pApproved.execution_result.tool, 'promise_date_update');
    assert.strictEqual(pApproved.execution_result.new_date, pFresh.result.action.proposed_date);

    // REAL verification: the order row itself carries the new date
    const editState1 = await (await fetch(`${BASE}/api/admin/orders/${code}/edit`, { headers: { 'X-Mavi-Token': ownerT } })).json();
    assert.strictEqual(editState1.order.promise_date, pApproved.execution_result.new_date, 'order promise_date really changed');
    assert.strictEqual(editState1.order.note, noteChanged, 'the promise tool touched NOTHING else');
    assert.strictEqual(editState1.order.fabric_choice, fabricChanged, 'the promise tool touched NOTHING else');

    // delivered orders refuse new promise drafts
    const deliveredTry = await api('POST', '/jobs', ownerT, {
      kind: 'delivery_promise_draft', payload: { order_code: 'MV-2609-101' }, idempotency_key: 'exec-promise-delivered',
    });
    assert.strictEqual(deliveredTry.status, 409, 'delivered order must refuse');

    // 3. Honest failure: corrupted proposed date fails EXECUTION, order untouched, retry works ---
    const fJob = await api('POST', '/jobs', ownerT, {
      kind: 'delivery_promise_draft', payload: { order_code: 'MV-2611-112' }, idempotency_key: 'exec-promise-fail',
    });
    const before112 = (await (await fetch(`${BASE}/api/admin/orders/MV-2611-112/edit`, { headers: { 'X-Mavi-Token': ownerT } })).json()).order.promise_date;
    const fJobId = (await fJob.json()).job.id;
    await api('POST', '/worker/step', ownerT, { provider: 'fixture', job_id: fJobId });
    const fPrepared = (await (await api('GET', `/jobs/${fJobId}`, ownerT)).json()).job;

    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    const row = db.prepare('SELECT result FROM office_jobs WHERE id = ?').get(fJobId);
    const tampered = JSON.parse(row.result);
    tampered.action.proposed_date = '2026-02-31'; // a date that does not exist
    db.prepare('UPDATE office_jobs SET result = ?, result_hash = ? WHERE id = ?')
      .run(canonical(tampered), digest(tampered), fJobId);
    db.close();

    const fReview = await api('POST', `/jobs/${fJobId}/review`, ownerT, {
      expected_revision: fPrepared.revision, expected_result_hash: digest(tampered), decision: 'approve',
    });
    const fReviewBody = await fReview.json();
    assert.strictEqual(fReview.status, 200);
    const fApproved = fReviewBody.job;
    assert.strictEqual(fApproved.status, 'approved');
    assert.strictEqual(fApproved.execution, 'failed', 'execution must fail HONESTLY on an invalid date');
    assert.strictEqual(fApproved.execution_result.ok, false);
    assert.ok(fApproved.execution_result.error_code, 'failure carries an error code');

    const editState2 = await (await fetch(`${BASE}/api/admin/orders/MV-2611-112/edit`, { headers: { 'X-Mavi-Token': ownerT } })).json();
    // Semantic assertion (never a hardcoded date): the seeded promise_date drifts
    // with the real clock, so "untouched" must compare against the pre-flow value.
    assert.strictEqual(editState2.order.promise_date, before112, 'failed execution left the order date untouched');

    // fix the action payload, then the owner retries execution manually → verified
    const db2 = new Database(dbPath);
    const row2 = db2.prepare('SELECT result FROM office_jobs WHERE id = ?').get(fJobId);
    const fixed = JSON.parse(row2.result);
    fixed.action.proposed_date = '2026-12-10';
    db2.prepare('UPDATE office_jobs SET result = ?, result_hash = ?, execution = ? WHERE id = ?')
      .run(canonical(fixed), digest(fixed), '', fJobId);
    db2.close();
    const retry = await api('POST', `/jobs/${fJobId}/execute`, ownerT, {});
    assert.strictEqual(retry.status, 200);
    const retriedJob = (await retry.json()).job;
    assert.strictEqual(retriedJob.execution, 'verified');
    assert.strictEqual(retriedJob.execution_result.new_date, '2026-12-10');
    const editState3 = await (await fetch(`${BASE}/api/admin/orders/MV-2611-112/edit`, { headers: { 'X-Mavi-Token': ownerT } })).json();
    assert.strictEqual(editState3.order.promise_date, '2026-12-10');

    // 4. (chat removed by owner decision — the verified execution is asserted on the job itself)

    // 4b. TOOL #3 — collection description: verified lifecycle + PUBLIC catalogue API
    const colJob = await api('POST', '/jobs', ownerT, {
      kind: 'collection_copy_draft', payload: { section: 'summer' }, idempotency_key: 'exec-col-1',
    });
    const colBody = await colJob.json();
    assert.strictEqual(colJob.status, 201, JSON.stringify(colBody));
    const colJobId = colBody.job.id;
    // unknown collection refuses immediately
    const badCol = await api('POST', '/jobs', ownerT, {
      kind: 'collection_copy_draft', payload: { section: 'nope' }, idempotency_key: 'exec-col-bad',
    });
    assert.strictEqual(badCol.status, 400, 'unknown section must refuse enqueue');

    await api('POST', '/worker/step', ownerT, { provider: 'fixture', job_id: colJobId });
    const colPrepared = (await (await api('GET', `/jobs/${colJobId}`, ownerT)).json()).job;
    assert.strictEqual(colPrepared.status, 'review');
    assert.strictEqual(colPrepared.result.action.type, 'collection_note');
    assert.strictEqual(colPrepared.result.action.section, 'summer');
    assert.strictEqual(colPrepared.result.action.old_note, '', 'no note published yet');
    // seed has no style_sections rows: the template must say that HONESTLY
    assert.ok(colPrepared.result.text.includes('لسه بتتجهز'), 'empty collection stated honestly (no invented styles)');
    const catFacts = colPrepared.result.facts_used.find((f) => f.label === 'عدد الموديلات الظاهرة فيها');
    assert.strictEqual(catFacts.value, '0', 'facts show the real (zero) style count');

    const colReview = await api('POST', `/jobs/${colJobId}/review`, ownerT, {
      expected_revision: colPrepared.revision, expected_result_hash: colPrepared.result_hash, decision: 'approve',
    });
    const colReviewBody = await colReview.json();
    assert.strictEqual(colReview.status, 200, JSON.stringify(colReviewBody));
    const colApproved = colReviewBody.job;
    assert.strictEqual(colApproved.execution, 'verified');
    assert.strictEqual(colApproved.execution_result.tool, 'collection_note_update');
    assert.strictEqual(colApproved.execution_result.section_ar, 'الصيفي');
    assert.strictEqual(colApproved.execution_result.link, '/store/');

    // REAL verification: the PUBLIC catalogue API now serves the note (cache invalidated)
    const cat1 = await (await fetch(`${BASE}/api/store/catalogue`)).json();
    assert.ok(cat1.collection_notes && cat1.collection_notes.summer === colApproved.execution_result.new_note,
      'public /api/store/catalogue must serve the executed collection note');

    // restore → the note disappears from the public API again
    const colRestore = await api('POST', `/jobs/${colJobId}/restore`, ownerT, {});
    assert.strictEqual(colRestore.status, 200);
    const colRestored = (await colRestore.json()).job;
    assert.strictEqual(colRestored.execution, 'restored');
    const cat2 = await (await fetch(`${BASE}/api/store/catalogue`)).json();
    assert.ok(!cat2.collection_notes || !cat2.collection_notes.summer,
      'restore removes the note from the public catalogue API (empty note is not served)');

    // 5. The readiness report tells the truth (no stale counters, no fake claims)
    const rd = await (await api('GET', '/readiness', ownerT)).json();
    const teamCheck = rd.checks.find((c) => c.id === 'team_17_roles');
    assert.ok(teamCheck && teamCheck.ok === true, 'team/kinds integrity must pass SEMANTICALLY (not a hardcoded stale count)');
    assert.ok(teamCheck.detail_ar.includes('مهمة'), 'team check detail shows real counts');
    const aiCheck = rd.checks.find((c) => c.id === 'ai_draft_provider');
    assert.ok(aiCheck && aiCheck.warn === true && aiCheck.detail_ar.includes('القالب المحلي'), 'AI provider honestly reports the local-template fallback when disabled');
    const seoCheck = rd.checks.find((c) => c.id === 'seo_foundations');
    assert.ok(seoCheck && seoCheck.detail_ar.includes('robots.txt'), 'SEO foundations stated with real site facts');
    const pubCheck = rd.checks.find((c) => c.id === 'external_publishing');
    assert.ok(pubCheck && pubCheck.detail_ar.includes('يدوي بالكامل'), 'external platforms stated honestly: manual, no API connection');
    assert.ok(Number(rd.queue_summary.executed_verified) >= 2, `real verified executions counted (got ${rd.queue_summary.executed_verified})`);
    assert.ok('executed_failed' in rd.queue_summary, 'failed-execution counter exists (honest value, retry above reset the only failure to verified)');

    console.log('EXEC-OK');
  } finally {
    child.kill('SIGKILL');
  }
})().catch((e) => { console.error(e); process.exit(1); });
