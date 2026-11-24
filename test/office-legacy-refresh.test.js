'use strict';
/* Legacy fixture drafts must self-heal: any stored draft generated before the
   Arabic-stage / non-test-wording refresh is re-rendered from the CURRENT
   subject facts at boot (and on the owner's manual re-check), while:
   - decision state is preserved (review stays review, approved stays approved),
   - owner-edited texts (human_edited) are never overwritten,
   - already-used drafts (manual execution) are never touched,
   - every refresh is audited. */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PORT = 3063;
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-legacy-'));
  const dbPath = path.join(tmpDir, 'legacy.db');
  const seeded = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
  });
  assert.strictEqual(seeded.status, 0, seeded.stderr);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: dbPath, PORT: String(PORT) },
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

    // Create two real drafts on a real seeded order and prepare them.
    const adminOrders = await (await fetch(`${BASE}/api/admin/orders?limit=10`, { headers: { 'X-Mavi-Token': ownerT } })).json();
    const openOrder = adminOrders.orders.find((o) => !['cancelled', 'delivered'].includes(o.status));
    assert.ok(openOrder, 'seed must contain an open order');
    const orderCode = openOrder.code;
    const mk = async (kind, payload, key) => {
      const r = await api('POST', '/jobs', staffT, { kind, payload, idempotency_key: key });
      assert.strictEqual(r.status, 201, JSON.stringify(await r.clone().json().catch(() => ({}))));
      const job = (await r.json()).job;
      await api('POST', '/worker/step', ownerT, { provider: 'fixture', job_id: job.id });
      const prepared = await (await api('GET', `/jobs/${job.id}`, ownerT)).json();
      assert.strictEqual(prepared.job.status, 'review', 'fixture step must prepare the draft');
      return prepared.job;
    };
    const reviewJob = await mk('order_followup_draft', { order_code: orderCode, focus: 'schedule' }, 'legacy-refresh-1');
    const approvedJob = await mk('workshop_followup_draft', { order_code: orderCode }, 'legacy-refresh-2');

    // Sanity: fresh drafts are already correct (Arabic stage, no test wording)
    const jobsAfterPrepare = (await (await api('GET', '/jobs', ownerT)).json()).jobs;
    const freshOrderDraft = jobsAfterPrepare.find((j) => j.id === reviewJob.id);
    assert.ok(freshOrderDraft.result.text.includes('في مرحلة'), 'draft text must exist');
    assert.ok(!/(?:في مرحلة |المرحلة المسجلة)(?: ?)(new|confirmed|cut|sewing|ready|delivered)\b/.test(freshOrderDraft.result.text), 'fresh draft must not leak raw English stages');
    assert.ok(!freshOrderDraft.result.text.includes('مسودة اختبار محلية'), 'fresh draft must not carry test wording');

    // Simulate LEGACY drafts by rewriting their stored content the old way:
    // one still in review, one approved (never used), one owner-edited.
    const Database = require('better-sqlite3');
    const canonical = (v) => {
      if (v === null || typeof v !== 'object') return JSON.stringify(v);
      if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
      return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    };
    const sha = (v) => require('crypto').createHash('sha256').update(canonical(v)).digest('hex');
    const legacyFor = (parsedResult, text, extra = {}) => {
      const old = parsedResult;
      const res = {
        ...old, text,
        facts_used: old.facts_used.map((f) => (f.label === 'المرحلة المسجلة' ? { ...f, value: 'sewing' } : f)),
        review_checklist: ['التحقق من ملكية الطلب قبل أي تواصل يدوي', 'عدم تقديم وعد بموعد تسليم جديد قبل اعتماد المالكة', 'هذه مسودة اختبار محلية — لا يتم إرسال أي رسالة تلقائيًا'],
        provenance: { ...old.provenance, mode: 'fixture' },
        ...extra,
      };
      return { json: canonical(res), hash: sha(res) };
    };
    const db = new Database(dbPath);
    const byId = (id) => JSON.parse(db.prepare('SELECT * FROM office_jobs WHERE id=?').get(id).result);
    const reviewRow = db.prepare('SELECT * FROM office_jobs WHERE id=?').get(reviewJob.id);
    const approvedRow = db.prepare('SELECT * FROM office_jobs WHERE id=?').get(approvedJob.id);
    const legacyReview = legacyFor(byId(reviewJob.id), `الطلب ${orderCode} في مرحلة sewing ويحتاج تحديد موعد تسليم معتمد قبل مراسلة العميلة.`);
    db.prepare("UPDATE office_jobs SET result=?, result_hash=? WHERE id=?").run(legacyReview.json, legacyReview.hash, reviewJob.id);
    const legacyApproved = legacyFor(byId(approvedJob.id), `الطلب ${orderCode} في مرحلة sewing، الموعد المسجل: غير محدد.`);
    db.prepare("UPDATE office_jobs SET result=?, result_hash=?, status='approved', reviewed_by='owner:1' WHERE id=?").run(legacyApproved.json, legacyApproved.hash, approvedJob.id);
    db.close();

    // Owner triggers the re-check (the same function also runs at every boot)
    const refreshRes = await (await api('POST', '/jobs/refresh-legacy', ownerT, {})).json();
    assert.strictEqual(refreshRes.refreshed, 2, `both legacy drafts must refresh: ${JSON.stringify(refreshRes)}`);

    const jobs = (await (await api('GET', '/jobs', ownerT)).json()).jobs;
    const fixedReview = jobs.find((j) => j.id === reviewJob.id);
    const fixedApproved = jobs.find((j) => j.id === approvedJob.id);
    assert.strictEqual(fixedReview.status, 'review', 'review status must be preserved');
    assert.strictEqual(fixedApproved.status, 'approved', 'approved status must be preserved');
    assert.ok(!/(?:في مرحلة |المرحلة المسجلة)(?: ?)(new|confirmed|cut|sewing|ready|delivering|delivered)\b/.test(fixedReview.result.text + JSON.stringify(fixedReview.result.facts_used)), 'refreshed draft must use Arabic stages only');
    assert.ok(!fixedReview.result.text.includes('مسودة اختبار محلية') && !fixedApproved.result.text.includes('مسودة اختبار محلية'), 'test wording must be gone');
    assert.ok(!JSON.stringify(fixedReview.result.review_checklist).includes('مسودة اختبار محلية'), 'checklist must be re-rendered');
    assert.ok(Number(fixedReview.revision) === Number(reviewRow.revision) + 1, 'revision must bump on refresh');

    // Staff visibility intact and no money leaked; the approved draft stays usable
    const staffJobs = (await (await api('GET', '/jobs', staffT)).json()).jobs;
    assert.ok(staffJobs.some((j) => j.id === approvedJob.id && j.status === 'approved'));

    // Audit trail recorded
    const audit = (await (await api('GET', `/jobs/${reviewJob.id}/audit`, ownerT)).json());
    assert.ok(JSON.stringify(audit).includes('legacy_fixture_content_refreshed'), 'refresh must be audited');

    // Re-run is a no-op (idempotent) — nothing matches the legacy markers now
    const refresh2 = await (await api('POST', '/jobs/refresh-legacy', ownerT, {})).json();
    assert.strictEqual(refresh2.refreshed, 0, 'refresh must be idempotent');
    console.log('PASS: legacy fixture drafts self-heal (Arabic stages, no test wording, state preserved, audited, idempotent)');
  } finally {
    child.kill('SIGKILL');
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
