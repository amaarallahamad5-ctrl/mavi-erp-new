'use strict';

/**
 * Office Virtual-Company Hardening & 128 MiB Stress Gate:
 *   1. Byte-level 64 KiB hex-scratch BLOB SHA-256 staleness verification across:
 *      - order_deposits.receipt (same-length byte flip -> 409 stale_subject_facts)
 *      - style_images.image (same-length byte flip past 512 KiB boundary -> 409 stale_subject_facts)
 *      - custom_requests.image, custom_requests.receipt, custom_request_images.image -> 409 stale_subject_facts
 *      - custom_order_links design image on order_followup_draft -> 409 stale_subject_facts
 *   2. Owner-only POST /api/admin/office/jobs/:id/recheck (403 for staff, 200 for owner).
 *   3. Zero staff hidden-state side channels when receipts, deposit quotes, or owner reviews change.
 *   4. New virtual-company fixture kinds:
 *      - seo_readiness_check (nadine, staff+owner)
 *      - custom_design_followup_draft (omar, owner-only)
 *      - executive_weekly_plan (rami, owner-only, <= 100 EGP planning cap)
 *   5. Backward-compatible schema migration from legacy `office_jobs` table without losing rows/audits.
 *   6. 300 MiB BLOB dataset (15 custom requests × 10 × 2 MiB) + concurrent 1.8 MiB base64 upload + /healthz probe
 *      under `--max-old-space-size=64`, proving VmHWM stays strictly below the 128 MiB container ceiling.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const SAMPLE_PNG = fs.readFileSync(path.join(ROOT, 'public', 'brand', 'icon-192.png'));

function readProcStatusKiB(pid, field) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = raw.match(new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, 'm'));
    return m ? Number(m[1]) : 0;
  } catch (_) {
    return 0;
  }
}

async function waitReady(base, proc) {
  for (let i = 0; i < 120; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`Server exited early (code=${proc.exitCode}, signal=${proc.signalCode})`);
    }
    try {
      const r = await fetch(base + '/healthz');
      if (r.status === 200) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Server did not become healthy in time');
}

async function stopServer(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve();
    }, 5000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

async function jsonReq(base, urlPath, { method = 'GET', cookie = '', body } = {}) {
  const headers = { Origin: base };
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const r = await fetch(base + urlPath, { method, headers, body: payload });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, text, json, headers: r.headers };
}

// Valid PNG signature/header from icon-192.png padded to target byteLength so image parsers accept it
function makeSyntheticPng(byteLength, fillByte) {
  const buf = Buffer.alloc(byteLength, fillByte);
  SAMPLE_PNG.copy(buf, 0, 0, Math.min(SAMPLE_PNG.length, byteLength));
  return buf;
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-office-hardening-'));
  let proc = null;

  try {
    const dbPath = path.join(tmpDir, 'mavi.db');

    // Seed baseline ERP schema & accounts first
    const seed = spawnSync(process.execPath, ['src/seed.js'], {
      cwd: ROOT,
      env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
      encoding: 'utf8',
    });
    assert.strictEqual(seed.status, 0, seed.stderr);

    // =========================================================================
    // PART 1: Replace `office_jobs` with legacy 2-subject schema + row/audit to verify migration
    // =========================================================================
    {
      const initDb = new Database(dbPath);
      initDb.pragma('foreign_keys = OFF');
      initDb.exec(`
        DROP TABLE IF EXISTS office_job_audit;
        DROP TABLE IF EXISTS office_jobs;
        CREATE TABLE office_jobs (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          request_hash TEXT NOT NULL,
          kind TEXT NOT NULL,
          employee_id TEXT NOT NULL,
          visibility TEXT NOT NULL CHECK(visibility IN ('staff','owner')),
          subject_type TEXT NOT NULL CHECK(subject_type IN ('order','catalogue')),
          subject_ref TEXT NOT NULL,
          subject_snapshot_hash TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued','running','review','approved','rejected','failed')),
          revision INTEGER NOT NULL DEFAULT 1,
          input_revision INTEGER NOT NULL DEFAULT 1,
          attempts INTEGER NOT NULL DEFAULT 0,
          lease_token TEXT,
          lease_until REAL,
          result TEXT,
          result_hash TEXT,
          created_by TEXT NOT NULL,
          reviewed_by TEXT,
          error_code TEXT,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL
        );
        CREATE TABLE office_job_audit (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_id TEXT NOT NULL REFERENCES office_jobs(id) ON DELETE CASCADE,
          event TEXT NOT NULL,
          actor_id TEXT NOT NULL,
          created_at REAL NOT NULL
        );
        INSERT INTO office_jobs (
          id, idempotency_key, request_hash, kind, employee_id, visibility,
          subject_type, subject_ref, subject_snapshot_hash, payload, status,
          created_by, created_at, updated_at
        ) VALUES (
          'job-legacy0001', 'legacy-idem-1', 'legacy-req-hash', 'content_draft', 'sara', 'staff',
          'catalogue', 'DEMO-PUBLIC-01', 'legacy-snap-hash', '{"channel":"instagram","product_id":"DEMO-PUBLIC-01"}', 'queued',
          'user:1', 1700000000, 1700000000
        );
        INSERT INTO office_job_audit (job_id, event, actor_id, created_at)
        VALUES ('job-legacy0001', 'queued', 'user:1', 1700000000);
      `);
      initDb.pragma('foreign_keys = ON');
      initDb.close();
    }

    const port = 15400 + Math.floor(Math.random() * 400);
    const base = `http://127.0.0.1:${port}`;
    proc = spawn(
      process.execPath,
      ['--max-old-space-size=64', '--max-semi-space-size=4', path.join(ROOT, 'src', 'server.js')],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PORT: String(port),
          DB_PATH: dbPath,
          AUTO_SEED: '0',
          SHOW_OTP: '0',
          AI_ENABLED: '0',
          MAVI_OFFICE_PROVIDER: 'disabled',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    await waitReady(base, proc);

    const ownerLogin = await jsonReq(base, '/api/admin/auth/login', {
      method: 'POST',
      body: { email: 'owner@mavi.eg', password: 'mavi-owner' },
    });
    assert.strictEqual(ownerLogin.status, 200, ownerLogin.text);
    const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];

    const staffLogin = await jsonReq(base, '/api/admin/auth/login', {
      method: 'POST',
      body: { email: 'staff@mavi.eg', password: 'mavi-staff' },
    });
    assert.strictEqual(staffLogin.status, 200, staffLogin.text);
    const staffCookie = staffLogin.headers.get('set-cookie').split(';')[0];

    const custReg = await jsonReq(base, '/api/store/auth/register', {
      method: 'POST',
      body: { phone: '01279994411', password: 'customer-password-123', name: 'عميلة اختبار تحصين' },
    });
    assert.ok([200, 201].includes(custReg.status), custReg.text);
    const custCookie = custReg.headers.get('set-cookie').split(';')[0];

    // Verify legacy row & audit survived migration intact
    const legacyGet = await jsonReq(base, '/api/admin/office/jobs/job-legacy0001', { cookie: ownerCookie });
    assert.strictEqual(legacyGet.status, 200);
    assert.strictEqual(legacyGet.json.job.id, 'job-legacy0001');
    const legacyAudit = await jsonReq(base, '/api/admin/office/jobs/job-legacy0001/audit', { cookie: ownerCookie });
    assert.strictEqual(legacyAudit.status, 200);
    assert.strictEqual(legacyAudit.json.audit.length, 1);

    // =========================================================================
    // PART 2: Same-size BLOB byte mutations & Staff Zero Side-Channel Privacy
    // =========================================================================
    const styleId = 'DR-04';
    const rwDb = new Database(dbPath);
    const initialStyleImg = makeSyntheticPng(750 * 1024, 0x41);
    const styleImgInsert = rwDb.prepare(
      'INSERT INTO style_images (style_id, image, image_type, is_primary) VALUES (?, ?, ?, 1)'
    ).run(styleId, initialStyleImg, 'image/png');
    const styleImgId = Number(styleImgInsert.lastInsertRowid);

    // Queue & generate `seo_readiness_check` on `styleId`
    const seoJobRes = await jsonReq(base, '/api/admin/office/jobs', {
      method: 'POST',
      cookie: staffCookie,
      body: {
        kind: 'seo_readiness_check',
        payload: { product_id: styleId },
        idempotency_key: 'seo-style-check-1',
      },
    });
    assert.strictEqual(seoJobRes.status, 201, seoJobRes.text);
    const seoJobId = seoJobRes.json.job.id;

    await jsonReq(base, '/api/admin/office/worker/step', {
      method: 'POST',
      cookie: ownerCookie,
      body: { provider: 'fixture', job_id: seoJobId },
    });
    const seoReady = (await jsonReq(base, `/api/admin/office/jobs/${seoJobId}`, { cookie: ownerCookie })).json.job;
    assert.strictEqual(seoReady.status, 'review');
    assert.strictEqual(seoReady.subject_stale, false);

    // Flip ONE byte inside the SECOND 512 KiB chunk (offset 650,000) without changing BLOB length or metadata!
    const mutatedStyleImg = Buffer.from(initialStyleImg);
    mutatedStyleImg[650000] ^= 0xff;
    assert.strictEqual(mutatedStyleImg.length, initialStyleImg.length);
    rwDb.prepare('UPDATE style_images SET image = ? WHERE id = ?').run(mutatedStyleImg, styleImgId);

    // Owner `recheck` detects the byte flip; Staff `recheck` is forbidden (403)
    const staffRecheck = await jsonReq(base, `/api/admin/office/jobs/${seoJobId}/recheck`, {
      method: 'POST',
      cookie: staffCookie,
      body: {},
    });
    assert.strictEqual(staffRecheck.status, 403);

    const ownerRecheckSeo = await jsonReq(base, `/api/admin/office/jobs/${seoJobId}/recheck`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {},
    });
    assert.strictEqual(ownerRecheckSeo.status, 200);
    assert.strictEqual(ownerRecheckSeo.json.subject_stale, true, 'Chunk #2 byte flip must mark owner recheck stale');

    const seoApproveStale = await jsonReq(base, `/api/admin/office/jobs/${seoJobId}/review`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        expected_revision: seoReady.revision,
        expected_result_hash: seoReady.result_hash,
        decision: 'approve',
      },
    });
    assert.strictEqual(seoApproveStale.status, 409);
    assert.strictEqual(seoApproveStale.json.error, 'stale_subject_facts');

    // Create customer measurements & store order
    await jsonReq(base, '/api/store/me/measurements', {
      method: 'PUT',
      cookie: custCookie,
      body: { bust: 96, waist: 78, hip: 104, shoulder: 40, length: 150 },
    });
    const custOrderRes = await jsonReq(base, '/api/store/orders', {
      method: 'POST',
      cookie: custCookie,
      body: {
        style_id: styleId,
        colour: 'أسود',
        qty: 1,
        delivery: true,
        governorate: 'الجيزة',
        fabric_choice: 'قماش العميلة',
      },
    });
    assert.strictEqual(custOrderRes.status, 201, custOrderRes.text);
    const orderCode = custOrderRes.json.order.code;
    const orderRow = rwDb.prepare('SELECT id FROM orders WHERE code = ?').get(orderCode);

    // Quote shipping + deposit as owner and attach a 600 KiB receipt
    await jsonReq(base, `/api/admin/order-deposits/${encodeURIComponent(orderCode)}/quote`, {
      method: 'POST',
      cookie: ownerCookie,
      body: { percent: 50, shipping_fee: 80, payment_details: 'InstaPay test' },
    });
    const receiptV1 = makeSyntheticPng(600 * 1024, 0x22);
    rwDb.prepare(
      "UPDATE order_deposits SET status = 'receipt_pending', receipt = ?, receipt_type = 'image/png', receipt_source = 'customer', receipt_revision = 1 WHERE order_id = ?"
    ).run(receiptV1, orderRow.id);

    // Create both an operational `order_followup_draft` (visible to staff) and `deposit_followup_draft` (owner-only)
    const opJobRes = await jsonReq(base, '/api/admin/office/jobs', {
      method: 'POST',
      cookie: staffCookie,
      body: {
        kind: 'order_followup_draft',
        payload: { order_code: orderCode, focus: 'schedule' },
        idempotency_key: 'op-followup-privacy-1',
      },
    });
    assert.strictEqual(opJobRes.status, 201, opJobRes.text);
    const opJobId = opJobRes.json.job.id;

    const depJobRes = await jsonReq(base, '/api/admin/office/jobs', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        kind: 'deposit_followup_draft',
        payload: { order_code: orderCode },
        idempotency_key: 'dep-followup-byte-1',
      },
    });
    assert.strictEqual(depJobRes.status, 201, depJobRes.text);
    const depJobId = depJobRes.json.job.id;

    await jsonReq(base, '/api/admin/office/worker/step', {
      method: 'POST',
      cookie: ownerCookie,
      body: { provider: 'fixture', job_id: opJobId },
    });
    await jsonReq(base, '/api/admin/office/worker/step', {
      method: 'POST',
      cookie: ownerCookie,
      body: { provider: 'fixture', job_id: depJobId },
    });

    // Snapshot exact staff view BEFORE receipt/financial/owner-review mutations
    const staffBeforeGet = (await jsonReq(base, `/api/admin/office/jobs/${opJobId}`, { cookie: staffCookie })).json.job;
    const staffBeforeList = (await jsonReq(base, '/api/admin/office/jobs', { cookie: staffCookie })).json.jobs;
    assert.strictEqual(staffBeforeGet.subject_stale, false);
    assert.strictEqual(staffBeforeGet.reviewed_by, undefined);
    assert.strictEqual(staffBeforeGet.result.provenance.subject_snapshot_hash, undefined);

    // Mutate receipt bytes at offset 550,000 (same length, same revision, same status!)
    const receiptV2 = Buffer.from(receiptV1);
    receiptV2[550000] ^= 0x55;
    rwDb.prepare('UPDATE order_deposits SET receipt = ? WHERE order_id = ?').run(receiptV2, orderRow.id);

    // Owner `deposit_followup_draft` MUST detect the same-size receipt byte mutation (409 stale_subject_facts)
    const depBeforeApprove = (await jsonReq(base, `/api/admin/office/jobs/${depJobId}`, { cookie: ownerCookie })).json.job;
    assert.strictEqual(depBeforeApprove.subject_stale, true, 'Owner single-job GET must detect same-size receipt byte flip');
    const depApprove = await jsonReq(base, `/api/admin/office/jobs/${depJobId}/review`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        expected_revision: depBeforeApprove.revision,
        expected_result_hash: depBeforeApprove.result_hash,
        decision: 'approve',
      },
    });
    assert.strictEqual(depApprove.status, 409);
    assert.strictEqual(depApprove.json.error, 'stale_subject_facts');

    // Now also change financial quote & run owner `recheck` on `opJobId` — Staff view must leak ZERO hidden signal!
    await jsonReq(base, `/api/admin/order-deposits/${encodeURIComponent(orderCode)}/quote`, {
      method: 'POST',
      cookie: ownerCookie,
      body: { percent: 60, shipping_fee: 120, payment_details: 'Updated secret quote' },
    });
    await jsonReq(base, `/api/admin/office/jobs/${opJobId}/recheck`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {},
    });

    const staffAfterGet = (await jsonReq(base, `/api/admin/office/jobs/${opJobId}`, { cookie: staffCookie })).json.job;
    const staffAfterList = (await jsonReq(base, '/api/admin/office/jobs', { cookie: staffCookie })).json.jobs;
    const staffOpAudit = (await jsonReq(base, `/api/admin/office/jobs/${opJobId}/audit`, { cookie: staffCookie })).json.audit;

    assert.deepStrictEqual(staffAfterGet, staffBeforeGet, 'Staff single-job payload must remain bit-for-bit identical across secret receipt/quote/recheck changes');
    assert.deepStrictEqual(staffAfterList, staffBeforeList, 'Staff job list must remain bit-for-bit identical across secret receipt/quote/recheck changes');
    assert.ok(!staffOpAudit.some(ev => ev.event.startsWith('recheck_')), 'Staff audit must not expose owner recheck events');

    // =========================================================================
    // PART 3: Custom Design Draft (`omar`) + Executive Weekly Plan (`rami`) + Linked Design Byte Check
    // =========================================================================
    const customImg1 = makeSyntheticPng(580 * 1024, 0x31);
    const customExtra1 = makeSyntheticPng(540 * 1024, 0x32);
    const customRec1 = makeSyntheticPng(530 * 1024, 0x33);
    const custDbId = Number(
      rwDb.prepare("INSERT INTO customers (name, phone, area) VALUES ('عميلة تصميم خاص', '01099887766', 'الزمالك')").run().lastInsertRowid
    );
    const customReqId = Number(
      rwDb.prepare(
        `INSERT INTO custom_requests (
           customer_id, status, price, deposit_percent, date_needed, details,
           fabric_choice, requested_colour, requested_fabric, shipping_fee, governorate,
           image, image_type, receipt, receipt_type, receipt_source, receipt_revision
         ) VALUES (?, 'receipt_pending', 2400, 50, '2026-12-15', 'فستان سواريه تطريز يدوي',
                   'atelier', 'كحلي', 'كريب حرير', 90, 'القاهرة',
                   ?, 'image/png', ?, 'image/png', 'customer', 1)`
      ).run(custDbId, customImg1, customRec1).lastInsertRowid
    );
    const customExtraRowId = Number(
      rwDb.prepare('INSERT INTO custom_request_images (request_id, image, image_type) VALUES (?, ?, ?)').run(customReqId, customExtra1, 'image/png').lastInsertRowid
    );

    // Also link `customReqId` to `orderRow.id` via `custom_order_links` and verify owner `order_followup_draft` catches design image byte flip!
    rwDb.prepare('INSERT INTO custom_order_links (request_id, order_id) VALUES (?, ?)').run(customReqId, orderRow.id);
    const linkedOpJobRes = await jsonReq(base, '/api/admin/office/jobs', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        kind: 'order_followup_draft',
        payload: { order_code: orderCode, focus: 'status_update' },
        idempotency_key: 'linked-order-design-1',
      },
    });
    assert.strictEqual(linkedOpJobRes.status, 201);
    const linkedOpJobId = linkedOpJobRes.json.job.id;
    await jsonReq(base, '/api/admin/office/worker/step', {
      method: 'POST',
      cookie: ownerCookie,
      body: { provider: 'fixture', job_id: linkedOpJobId },
    });
    const linkedOpReady = (await jsonReq(base, `/api/admin/office/jobs/${linkedOpJobId}`, { cookie: ownerCookie })).json.job;
    assert.strictEqual(linkedOpReady.status, 'review');

    // Staff cannot create `custom_design_followup_draft` or `executive_weekly_plan`
    const staffCustomAttempt = await jsonReq(base, '/api/admin/office/jobs', {
      method: 'POST',
      cookie: staffCookie,
      body: {
        kind: 'custom_design_followup_draft',
        payload: { request_id: customReqId },
        idempotency_key: 'staff-forbidden-custom-1',
      },
    });
    assert.strictEqual(staffCustomAttempt.status, 403);

    const staffExecAttempt = await jsonReq(base, '/api/admin/office/jobs', {
      method: 'POST',
      cookie: staffCookie,
      body: {
        kind: 'executive_weekly_plan',
        payload: { holiday_budget_egp: 100 },
        idempotency_key: 'staff-forbidden-exec-1',
      },
    });
    assert.strictEqual(staffExecAttempt.status, 403);

    // Owner creates & generates `custom_design_followup_draft`
    const ownerCustomJob = await jsonReq(base, '/api/admin/office/jobs', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        kind: 'custom_design_followup_draft',
        payload: { request_id: customReqId },
        idempotency_key: 'owner-custom-draft-1',
      },
    });
    assert.strictEqual(ownerCustomJob.status, 201, ownerCustomJob.text);
    const customJobId = ownerCustomJob.json.job.id;

    await jsonReq(base, '/api/admin/office/worker/step', {
      method: 'POST',
      cookie: ownerCookie,
      body: { provider: 'fixture', job_id: customJobId },
    });
    let customReady = (await jsonReq(base, `/api/admin/office/jobs/${customJobId}`, { cookie: ownerCookie })).json.job;
    assert.strictEqual(customReady.status, 'review');

    // Test same-length byte flips across ALL 3 custom_request BLOB columns:
    // (a) custom_requests.image -> must reject BOTH `custom_design_followup_draft` AND linked `order_followup_draft`!
    const customImgMut = Buffer.from(customImg1);
    customImgMut[530000] ^= 0xaa;
    rwDb.prepare('UPDATE custom_requests SET image = ? WHERE id = ?').run(customImgMut, customReqId);

    let customApprove = await jsonReq(base, `/api/admin/office/jobs/${customJobId}/review`, {
      method: 'POST',
      cookie: ownerCookie,
      body: { expected_revision: customReady.revision, expected_result_hash: customReady.result_hash, decision: 'approve' },
    });
    assert.strictEqual(customApprove.status, 409);
    assert.strictEqual(customApprove.json.error, 'stale_subject_facts');

    const linkedOrderApprove = await jsonReq(base, `/api/admin/office/jobs/${linkedOpJobId}/review`, {
      method: 'POST',
      cookie: ownerCookie,
      body: { expected_revision: linkedOpReady.revision, expected_result_hash: linkedOpReady.result_hash, decision: 'approve' },
    });
    assert.strictEqual(linkedOrderApprove.status, 409);
    assert.strictEqual(linkedOrderApprove.json.error, 'stale_subject_facts');

    // Refresh & re-step, then flip (b) custom_request_images.image
    await jsonReq(base, `/api/admin/office/jobs/${customJobId}`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: { payload: { request_id: customReqId }, expected_revision: customReady.revision },
    });
    await jsonReq(base, '/api/admin/office/worker/step', {
      method: 'POST',
      cookie: ownerCookie,
      body: { provider: 'fixture', job_id: customJobId },
    });
    customReady = (await jsonReq(base, `/api/admin/office/jobs/${customJobId}`, { cookie: ownerCookie })).json.job;

    const customExtraMut = Buffer.from(customExtra1);
    customExtraMut[525000] ^= 0xbb;
    rwDb.prepare('UPDATE custom_request_images SET image = ? WHERE id = ?').run(customExtraMut, customExtraRowId);
    customApprove = await jsonReq(base, `/api/admin/office/jobs/${customJobId}/review`, {
      method: 'POST',
      cookie: ownerCookie,
      body: { expected_revision: customReady.revision, expected_result_hash: customReady.result_hash, decision: 'approve' },
    });
    assert.strictEqual(customApprove.status, 409);

    // Refresh & re-step, then flip (c) custom_requests.receipt
    await jsonReq(base, `/api/admin/office/jobs/${customJobId}`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: { payload: { request_id: customReqId }, expected_revision: customReady.revision },
    });
    await jsonReq(base, '/api/admin/office/worker/step', {
      method: 'POST',
      cookie: ownerCookie,
      body: { provider: 'fixture', job_id: customJobId },
    });
    customReady = (await jsonReq(base, `/api/admin/office/jobs/${customJobId}`, { cookie: ownerCookie })).json.job;

    const customRecMut = Buffer.from(customRec1);
    customRecMut[520000] ^= 0xcc;
    rwDb.prepare('UPDATE custom_requests SET receipt = ? WHERE id = ?').run(customRecMut, customReqId);
    customApprove = await jsonReq(base, `/api/admin/office/jobs/${customJobId}/review`, {
      method: 'POST',
      cookie: ownerCookie,
      body: { expected_revision: customReady.revision, expected_result_hash: customReady.result_hash, decision: 'approve' },
    });
    assert.strictEqual(customApprove.status, 409);

    // Owner creates & approves `executive_weekly_plan` (and >100 EGP cap is strictly rejected)
    const overCapExec = await jsonReq(base, '/api/admin/office/jobs', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        kind: 'executive_weekly_plan',
        payload: { holiday_budget_egp: 150 },
        idempotency_key: 'exec-over-cap-1',
      },
    });
    assert.strictEqual(overCapExec.status, 400);
    assert.strictEqual(overCapExec.json.error, 'invalid_planning_budget');

    await jsonReq(base, '/api/admin/office/cases/sync', { method: 'POST', cookie: ownerCookie, body: {} });
    const execJobRes = await jsonReq(base, '/api/admin/office/jobs', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        kind: 'executive_weekly_plan',
        payload: { holiday_budget_egp: 100 },
        idempotency_key: 'exec-valid-1',
      },
    });
    assert.strictEqual(execJobRes.status, 201, execJobRes.text);
    const execJobId = execJobRes.json.job.id;
    await jsonReq(base, '/api/admin/office/worker/step', {
      method: 'POST',
      cookie: ownerCookie,
      body: { provider: 'fixture', job_id: execJobId },
    });
    const execReady = (await jsonReq(base, `/api/admin/office/jobs/${execJobId}`, { cookie: ownerCookie })).json.job;
    assert.strictEqual(execReady.status, 'review');
    assert.ok(execReady.result.text.includes('100 ج.م'));
    assert.deepStrictEqual(execReady.result.external_actions, []);

    const execApproved = await jsonReq(base, `/api/admin/office/jobs/${execJobId}/review`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        expected_revision: execReady.revision,
        expected_result_hash: execReady.result_hash,
        decision: 'approve',
      },
    });
    assert.strictEqual(execApproved.status, 200);
    assert.strictEqual(execApproved.json.job.status, 'approved');

    // =========================================================================
    // PART 3B: All 17 Virtual-Company Roles Active + Batch `/worker/drain` + Staff Currency Zero-Leak
    // =========================================================================
    const ownerTeamCheck = await jsonReq(base, '/api/admin/office/team', { cookie: ownerCookie });
    assert.strictEqual(ownerTeamCheck.status, 200);
    assert.strictEqual(ownerTeamCheck.json.roles.length, 17);
    assert.strictEqual(ownerTeamCheck.json.allowed_job_kinds.length, 18);
    for (const r of ownerTeamCheck.json.roles) {
      assert.ok(Array.isArray(r.job_kinds) && r.job_kinds.length >= 1, `Role ${r.id} must have >=1 active job kind`);
    }

    // Staff cannot call `/worker/drain` or create owner-only governance/analytics/ad jobs
    const staffDrainAttempt = await jsonReq(base, '/api/admin/office/worker/drain', {
      method: 'POST',
      cookie: staffCookie,
      body: { provider: 'fixture', max_steps: 10 },
    });
    assert.strictEqual(staffDrainAttempt.status, 403);

    for (const [forbiddenKind, forbiddenPayload] of [
      ['security_privacy_audit', {}],
      ['erp_data_health_report', {}],
      ['funnel_attribution_report', {}],
      ['paid_ad_setup_draft', { product_id: styleId, channel: 'instagram', daily_budget_egp: 80 }],
    ]) {
      const r = await jsonReq(base, '/api/admin/office/jobs', {
        method: 'POST',
        cookie: staffCookie,
        body: { kind: forbiddenKind, payload: forbiddenPayload, idempotency_key: `staff-deny-${forbiddenKind}` },
      });
      assert.strictEqual(r.status, 403, `Staff must receive 403 on ${forbiddenKind}`);
    }

    // Queue all remaining 10 virtual-company role templates (6 staff-operational + 4 owner-only) and drain in one batch!
    const remainingTemplates = [
      ['daily_ops_triage', {}, staffCookie],
      ['quality_delivery_checklist', { order_code: orderCode }, staffCookie],
      ['customer_reply_draft', { order_code: orderCode }, staffCookie],
      ['visual_reel_brief', { product_id: styleId }, staffCookie],
      ['landing_page_check', { product_id: styleId }, staffCookie],
      ['community_followup_draft', { product_id: styleId, channel: 'instagram' }, staffCookie],
      ['security_privacy_audit', {}, ownerCookie],
      ['erp_data_health_report', {}, ownerCookie],
      ['funnel_attribution_report', {}, ownerCookie],
      ['paid_ad_setup_draft', { product_id: styleId, channel: 'facebook', daily_budget_egp: 90 }, ownerCookie],
    ];
    const batchIds = [];
    for (const [kind, payload, ck] of remainingTemplates) {
      const r = await jsonReq(base, '/api/admin/office/jobs', {
        method: 'POST',
        cookie: ck,
        body: { kind, payload, idempotency_key: `full-company-${kind}` },
      });
      assert.strictEqual(r.status, 201, `Expected 201 for ${kind}, got ${r.status}: ${r.text}`);
      batchIds.push(r.json.job.id);
    }

    const drainRes = await jsonReq(base, '/api/admin/office/worker/drain', {
      method: 'POST',
      cookie: ownerCookie,
      body: { provider: 'fixture', max_steps: 25 },
    });
    assert.strictEqual(drainRes.status, 200, drainRes.text);
    assert.ok(drainRes.json.drain.processed_count >= 10);
    assert.strictEqual(drainRes.json.drain.network_calls, 0);

    for (const jid of batchIds) {
      const jr = await jsonReq(base, `/api/admin/office/jobs/${jid}`, { cookie: ownerCookie });
      assert.strictEqual(jr.status, 200);
      assert.strictEqual(jr.json.job.status, 'review', `Drained job ${jid} must stop at 'review', never auto-approved`);
      assert.deepStrictEqual(jr.json.job.result.external_actions, []);
    }

    // Verify staff job list across all generated operational templates contains ZERO currency strings
    const staffFullList = await jsonReq(base, '/api/admin/office/jobs', { cookie: staffCookie });
    assert.strictEqual(staffFullList.status, 200);
    assert.ok(!/ج\.م|جنيه|EGP/i.test(JSON.stringify(staffFullList.json)), 'Staff job list must contain zero currency text across all 10 staff templates');

    // Verify `/cycle/run` and `/audit` RBAC + idempotent non-duplicating daily cycle + zero auto-approval
    assert.strictEqual((await jsonReq(base, '/api/admin/office/cycle/run', { method: 'POST', cookie: staffCookie, body: {} })).status, 403);
    assert.strictEqual((await jsonReq(base, '/api/admin/office/audit', { cookie: staffCookie })).status, 403);

    const cycleRun1 = await jsonReq(base, '/api/admin/office/cycle/run', {
      method: 'POST',
      cookie: ownerCookie,
      body: { provider: 'fixture', holiday_budget_egp: 100 },
    });
    assert.strictEqual(cycleRun1.status, 200, cycleRun1.text);
    assert.strictEqual(cycleRun1.json.cycle.auto_approved_count, 0);
    assert.strictEqual(cycleRun1.json.cycle.external_actions_executed, 0);
    assert.strictEqual(cycleRun1.json.cycle.network_calls, 0);

    // Immediate second run skips all already-active jobs without duplicating queue entries
    const cycleRun2 = await jsonReq(base, '/api/admin/office/cycle/run', {
      method: 'POST',
      cookie: ownerCookie,
      body: { provider: 'fixture', holiday_budget_egp: 100 },
    });
    assert.strictEqual(cycleRun2.status, 200, cycleRun2.text);
    assert.strictEqual(cycleRun2.json.cycle.enqueued_count, 0);
    assert.ok(cycleRun2.json.cycle.skipped_active_count >= 5);

    const ownerAuditRes = await jsonReq(base, '/api/admin/office/audit?limit=200', { cookie: ownerCookie });
    assert.strictEqual(ownerAuditRes.status, 200);
    assert.ok(Array.isArray(ownerAuditRes.json.events) && ownerAuditRes.json.events.length >= 10);
    assert.ok(ownerAuditRes.json.events.some(e => e.event === 'draft_approved_no_execution'));

    // =========================================================================
    // PART 4: 300 MiB BLOB Stress Benchmark + Concurrent 1.8 MiB Base64 Upload under 64 MiB Heap
    // =========================================================================
    const twoMiB = makeSyntheticPng(2 * 1024 * 1024, 0x4d);
    const insReq = rwDb.prepare(
      `INSERT INTO custom_requests (
         customer_id, status, price, deposit_percent, date_needed, details,
         image, image_type
       ) VALUES (?, 'review', NULL, 50, '2026-12-20', 'اختبار ضغط ذاكرة ٣٠٠ ميجا', ?, 'image/png')`
    );
    const insExtra = rwDb.prepare('INSERT INTO custom_request_images (request_id, image, image_type) VALUES (?, ?, ?)');

    const stressReqIds = [];
    const seedTx = rwDb.transaction(() => {
      for (let i = 0; i < 15; i++) {
        const cid = Number(insReq.run(custDbId, twoMiB).lastInsertRowid);
        stressReqIds.push(cid);
        for (let k = 0; k < 9; k++) {
          insExtra.run(cid, twoMiB, 'image/png');
        }
      }
    });
    seedTx();
    rwDb.close();

    // Enqueue 5 custom_design_followup_draft jobs pointing to 50 MiB of those custom requests
    for (let i = 0; i < 5; i++) {
      const r = await jsonReq(base, '/api/admin/office/jobs', {
        method: 'POST',
        cookie: ownerCookie,
        body: {
          kind: 'custom_design_followup_draft',
          payload: { request_id: stressReqIds[i] },
          idempotency_key: `stress-custom-job-${i}`,
        },
      });
      assert.strictEqual(r.status, 201, r.text);
      await jsonReq(base, '/api/admin/office/worker/step', {
        method: 'POST',
        cookie: ownerCookie,
        body: { provider: 'fixture', job_id: r.json.job.id },
      });
    }

    let stopHealthProbe = false;
    let maxHealthLatencyMs = 0;
    const healthProbe = (async () => {
      while (!stopHealthProbe) {
        const t0 = performance.now();
        const hr = await fetch(base + '/healthz');
        const dt = performance.now() - t0;
        assert.strictEqual(hr.status, 200);
        if (dt > maxHealthLatencyMs) maxHealthLatencyMs = dt;
        await new Promise(r => setTimeout(r, 25));
      }
    })();

    const uploadDataUri = 'data:image/png;base64,' + makeSyntheticPng(Math.floor(1.8 * 1024 * 1024), 0x61).toString('base64');

    const tListStart = performance.now();
    const [casesRes, ownerJobsRes, staffJobsRes, uploadRes] = await Promise.all([
      jsonReq(base, '/api/admin/office/cases?sync=1', { cookie: ownerCookie }),
      jsonReq(base, '/api/admin/office/jobs', { cookie: ownerCookie }),
      jsonReq(base, '/api/admin/office/jobs', { cookie: staffCookie }),
      jsonReq(base, '/api/store/custom-requests', {
        method: 'POST',
        cookie: custCookie,
        body: {
          image: uploadDataUri,
          governorate: 'الجيزة',
          fabric_choice: 'قماش العميلة',
          details: 'تجربة رفع ١.٨ ميجا أثناء قراءة المكتب',
        },
      }),
    ]);
    const listElapsedMs = performance.now() - tListStart;
    stopHealthProbe = true;
    await healthProbe;

    assert.strictEqual(casesRes.status, 200);
    assert.strictEqual(ownerJobsRes.status, 200);
    assert.strictEqual(staffJobsRes.status, 200);
    assert.strictEqual(uploadRes.status, 201, uploadRes.text);

    const vmHwmKiB = readProcStatusKiB(proc.pid, 'VmHWM');
    const vmRssKiB = readProcStatusKiB(proc.pid, 'VmRSS');
    const vmHwmMiB = Number((vmHwmKiB / 1024).toFixed(1));
    const vmRssMiB = Number((vmRssKiB / 1024).toFixed(1));

    console.log(
      `# [office-company-hardening] 300MiB BLOB + 1.8MiB upload metrics: ` +
      `VmHWM=${vmHwmMiB} MiB, VmRSS=${vmRssMiB} MiB, concurrent_elapsed=${listElapsedMs.toFixed(1)}ms, max_healthz=${maxHealthLatencyMs.toFixed(1)}ms`
    );

    assert.ok(
      vmHwmMiB < 118,
      `Expected process VmHWM < 118 MiB (well below 128 MiB container cap), got ${vmHwmMiB} MiB`
    );
    assert.ok(
      maxHealthLatencyMs < 350,
      `Expected /healthz latency < 350ms during concurrent 300 MiB list + upload, got ${maxHealthLatencyMs.toFixed(1)}ms`
    );

    console.log('# office-company-hardening.test.js PASSED');
  } finally {
    await stopServer(proc);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
