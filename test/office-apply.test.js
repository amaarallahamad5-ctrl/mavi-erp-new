'use strict';
/* Apply-able suggestions on draft cards (owner decision 26.11):
   - owner review cards carry suggestions (per kind) with a dedicated apply
     button NEXT TO the approve/reject buttons (approval flow unchanged)
   - apply performs ONE real verified system edit and records it (with the
     previous value) on the job; staff never sees suggestions or apply
   - stale protection: applying against a changed draft -> 409, nothing applied
   - restore puts the previous value back and marks the apply record restored */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

test('Draft-card suggestions: real verified apply, stale 409, undo restore, owner-only', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/office-suggestions.js'), 'utf8');
  assert.ok(src.includes('CREATE TABLE IF NOT EXISTS office_suggestion_applies'), 'the apply-record table must exist');
  assert.ok(src.includes('before_json'), 'the previous value must be stored for undo');
  assert.ok(src.includes('invalidateCatalogue'), 'style/collection writes must refresh the public catalogue');

  const routesSrc = fs.readFileSync(path.join(ROOT, 'src/office-routes.js'), 'utf8');
  assert.ok(routesSrc.includes("router.post('/jobs/:id/apply-suggestion', A.requireOwner"), 'apply must be owner-only');
  assert.ok(routesSrc.includes('stale_conflict'), 'apply must carry stale protection');
  assert.ok(routesSrc.includes('attachOfficeExtras(actor, defaultEngine.list(actor))'), 'the jobs list must attach suggestions');

  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');
  assert.ok(uiSrc.includes('⚡ تطبيق الاختيار على النظام'), 'the dedicated apply button must exist on the decision card');
  assert.ok(uiSrc.includes('بيانات الكارت الحقيقية من النظام'), 'cards must show the real context facts');
  assert.ok(uiSrc.includes('↩ رجّعي القيمة السابقة'), 'undo must be reachable from the card');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-apply-'));
  const dbPath = path.join(tmpDir, 'apply.db');
  const seeded = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
  });
  assert.strictEqual(seeded.status, 0, seeded.stderr);

  // Fill: one real order + two review jobs on it (order follow-up with a title,
  // and a delivery-promise draft carrying the executable action).
  const now = Date.now();
  const fill = `process.env.DB_PATH = ${JSON.stringify(dbPath)};
const { run, get } = require(${JSON.stringify(path.join(ROOT, 'src/db'))});
require(${JSON.stringify(path.join(ROOT, 'src/office-engine'))});
run("INSERT OR IGNORE INTO customers(phone,name,area) VALUES('01077766655','سلمى عميلة','مصر الجديدة')");
const cid = get("SELECT id FROM customers WHERE phone = ?", '01077766655').id;
run("INSERT INTO orders(code,customer_id,channel,status,promise_date,created_at,updated_at) VALUES('MV-2605-777'," + cid + ",'whatsapp','sewing','2026-05-01','2026-05-02','2026-05-02')");
const oid = get("SELECT id FROM orders WHERE code = ?", 'MV-2605-777').id;
run("INSERT INTO office_jobs(id,idempotency_key,request_hash,kind,employee_id,visibility,subject_type,subject_ref,subject_snapshot_hash,payload,status,revision,result,created_by,created_at,updated_at) VALUES('ap-job-1','ik-ap-1','h','order_followup_draft','user:1','owner','order',?,'${'f'.repeat(64)}',?,'review',1,?,'user:1',?,?)",
  String(oid), JSON.stringify({ focus: 'schedule' }), JSON.stringify({ title: 'متابعة موعد تسليم طلب سلمى', text: 'مساء الخير سلمى 🌷 بخصوص طلبك MV-2605-777 — القطعة في مرحلة الخياطة وهنثبت معاك ميعاد التسليم أول ما يثبت.' }), ${now}, ${now});
run("INSERT INTO office_jobs(id,idempotency_key,request_hash,kind,employee_id,visibility,subject_type,subject_ref,subject_snapshot_hash,payload,status,revision,result,created_by,created_at,updated_at) VALUES('ap-job-2','ik-ap-2','h','delivery_promise_draft','user:1','owner','order',?,'${'e'.repeat(64)}',?,'review',1,?,'user:1',?,?)",
  String(oid), JSON.stringify({ focus: 'promise' }), JSON.stringify({ title: 'موعد تسليم مقترح لطلب سلمى', text: 'ميعاد التسليم المقترح 2026-05-10 بعد اكتمال التشطيب.', action: { type: 'set_promise_date', order_code: 'MV-2605-777', proposed_date: '2026-05-10' } }), ${now}, ${now});
console.log('FILL-OK');
`;
  const fillPath = path.join(tmpDir, 'fill.js');
  fs.writeFileSync(fillPath, fill);
  const filled = spawnSync(process.execPath, [fillPath], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(filled.status, 0, filled.stderr);
  assert.ok(filled.stdout.includes('FILL-OK'));

  const PORT = 3093;
  const BASE = `http://127.0.0.1:${PORT}`;
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: dbPath, PORT: String(PORT), MAVI_OPENROUTER_ENABLED: '0' },
    stdio: 'ignore',
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start')), 20000);
      const poll = async () => {
        try { const r = await fetch(`${BASE}/store/`); if (r.status < 502) return resolve(); } catch (_) {}
        setTimeout(poll, 250);
      };
      poll();
    });
    const login = async (email, password) => {
      const r = await fetch(`${BASE}/api/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      assert.strictEqual(r.status, 200);
      return (await r.json()).token;
    };
    const ownerT = await login('owner@mavi.eg', 'mavi-owner');
    const staffT = await login('staff@mavi.eg', 'mavi-staff');
    const api = (method, p, token, body) => fetch(`${BASE}/api/admin/office${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Mavi-Token': token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    // The list attaches suggestions + context facts (owner), never for staff
    const listStaff = await api('GET', '/jobs', staffT);
    assert.strictEqual(listStaff.status, 200);
    const ls = await listStaff.json();
    assert.ok(ls.jobs.every(j => !j.suggestions && !j.applies), 'staff must never receive suggestions or apply records');
    const list = await api('GET', '/jobs', ownerT);
    assert.strictEqual(list.status, 200);
    const lb = await list.json();
    const j1 = lb.jobs.find(j => j.id === 'ap-job-1');
    const j2 = lb.jobs.find(j => j.id === 'ap-job-2');
    assert.ok(j1 && j2, 'both review jobs must be listed');
    assert.ok(Array.isArray(j1.suggestions) && j1.suggestions.some(s => s.id === 'order_note'), 'the follow-up card suggests the real order-note edit');
    assert.ok(j2.suggestions.some(s => s.id === 'set_promise_date' && s.params.proposed_date === '2026-05-10'), 'the promise card suggests the real date edit');
    assert.ok(Array.isArray(j1.context_facts) && j1.context_facts.some(f => f.label === 'موعد التسليم'), 'cards show real context facts');

    // staff cannot apply
    const staffApply = await api('POST', '/jobs/ap-job-1/apply-suggestion', staffT, { suggestion_id: 'order_note', expected_revision: j1.revision, expected_result_hash: j1.result_hash });
    assert.strictEqual(staffApply.status, 403, 'staff must never apply');

    // stale protection: wrong revision -> 409 and NOTHING applied
    const stale = await api('POST', '/jobs/ap-job-1/apply-suggestion', ownerT, { suggestion_id: 'order_note', expected_revision: 99, expected_result_hash: j1.result_hash });
    assert.strictEqual(stale.status, 409, 'stale revision must be rejected');
    const ordersStale = await fetch(`${BASE}/store/`);
    assert.ok(ordersStale.status < 502);
    const checkStale = await api('GET', '/jobs/ap-job-1', ownerT);
    const cs = await checkStale.json();
    assert.strictEqual(cs.job.applies.length, 0, 'a rejected apply must not record anything');

    // real apply: the order note lands on the order, verified, with undo
    const ap1 = await api('POST', '/jobs/ap-job-1/apply-suggestion', ownerT, { suggestion_id: 'order_note', expected_revision: j1.revision, expected_result_hash: j1.result_hash });
    assert.strictEqual(ap1.status, 200, ap1.status !== 200 ? await ap1.text() : 'apply must succeed');
    const ap1b = await ap1.json();
    assert.strictEqual(ap1b.ok, true);
    assert.strictEqual(ap1b.apply.verified, true, 'the write must be verified by re-read');
    assert.ok(ap1b.apply.summary_ar.includes('MV-2605-777'), 'the summary names the real order');
    assert.ok(ap1b.job.applies.length === 1 && ap1b.job.applies[0].restorable, 'the card will show the applied banner with undo');

    // second apply: promise date changes for real
    const ap2 = await api('POST', '/jobs/ap-job-2/apply-suggestion', ownerT, { suggestion_id: 'set_promise_date', expected_revision: j2.revision, expected_result_hash: j2.result_hash });
    assert.strictEqual(ap2.status, 200, ap2.status !== 200 ? await ap2.text() : 'promise apply must succeed');
    const ap2b = await ap2.json();
    assert.strictEqual(ap2b.apply.verified, true);

    // verify the DB through a fresh job read: context fact shows the new date
    const re = await api('GET', '/jobs/ap-job-2', ownerT);
    const reb = await re.json();
    const promiseFact = (reb.job.context_facts || []).find(f => f.label === 'موعد التسليم');
    assert.ok(promiseFact && promiseFact.value === '2026-05-10', 'the applied promise date must be visible as a real fact, got: ' + JSON.stringify(reb.job.context_facts));

    // undo the promise date -> previous value (2026-05-01) is back
    const ap2Record = ap2b.apply;
    const undo = await api('POST', '/jobs/ap-job-2/restore-suggestion', ownerT, { apply_id: ap2Record.id });
    assert.strictEqual(undo.status, 200, undo.status !== 200 ? await undo.text() : 'restore must succeed');
    const re2 = await api('GET', '/jobs/ap-job-2', ownerT);
    const re2b = await re2.json();
    const promiseFact2 = (re2b.job.context_facts || []).find(f => f.label === 'موعد التسليم');
    assert.ok(promiseFact2 && promiseFact2.value === '2026-05-01', 'restore must put the previous promise date back');

    // double restore is rejected
    const undo2 = await api('POST', '/jobs/ap-job-2/restore-suggestion', ownerT, { apply_id: ap2Record.id });
    assert.strictEqual(undo2.status, 409, 'restoring twice must be rejected');
  } finally {
    child.kill('SIGKILL');
  }

  console.log('APPLY-OK');
});
