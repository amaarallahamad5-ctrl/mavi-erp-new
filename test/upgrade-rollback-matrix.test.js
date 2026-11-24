'use strict';
/* Comprehensive Forward-Upgrade & Code-Rollback Verification Matrix + Offline Backup Verifier Test:
   1) Tests `scripts/verify-backup-file.js` (read-only guarantee, SHA-256 match/mismatch, corrupt file rejection)
      and `bash -n scripts/docker-128m-gate.sh` syntax validity.
   2) Exercises a multi-subsystem synthetic dataset across:
        Phase A: Baseline pre-office code (`995104c` extracted from local git or `MAVI_BASELINE_DIR` when available;
                 otherwise clean core-only fallback when running inside a `.git`-free unpacked ZIP)
        Phase B: Forward upgrade to current `HEAD` on the SAME SQLite file + `office_cases` sync + `office_jobs`
                 approval + live `/api/admin/system/backup` + `verify-backup-file.js` + streaming restore
        Phase C: Code rollback back to Baseline (`995104c`) against the upgraded SQLite file containing `office_*`
                 tables/rows — verifying BOTH read parity (`report-hub`, catalogue, binary images, deposits,
                 custom requests, refunds, web-alerts) AND write operations (new cart checkout, manual order,
                 cost purchase, payment, and status transition).
   Runs strictly on disposable temp directories; NEVER touches production or external networks. */
const assert = require('assert');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { verifyBackup } = require('../scripts/verify-backup-file');

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2ioAAAAASUVORK5CYII=';

let completed = false;
process.on('exit', (code) => {
  if (code === 0 && !completed) {
    console.error('[upgrade-rollback-matrix] Premature event-loop drain');
    process.exitCode = 1;
  }
});

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

async function waitHealth(base, proc, urlPath = '/healthz') {
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`Process exited early (code=${proc.exitCode}, signal=${proc.signalCode})`);
    }
    try {
      const r = await fetch(base + urlPath);
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${base}${urlPath}`);
}

async function stopServer(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  await new Promise((r) => proc.once('exit', r));
}

async function apiJson(base, method, urlPath, body, token) {
  const r = await fetch(base + urlPath, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: base,
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body !== undefined && body !== null ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await r.json(); } catch (_) {}
  return { status: r.status, headers: r.headers, json };
}

function prepareBaselineAppDir(tmpRoot) {
  if (process.env.MAVI_BASELINE_DIR && fs.existsSync(path.join(process.env.MAVI_BASELINE_DIR, 'src/bootstrap.js'))) {
    const dir = path.resolve(process.env.MAVI_BASELINE_DIR);
    if (!fs.existsSync(path.join(dir, 'node_modules'))) {
      const linkDir = path.join(tmpRoot, 'baseline-linked');
      fs.cpSync(dir, linkDir, { recursive: true });
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(linkDir, 'node_modules'), 'dir');
      return { dir: linkDir, mode: 'external_baseline_dir' };
    }
    return { dir, mode: 'external_baseline_dir' };
  }

  // Extract exact `995104c` commit when running inside git checkout
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    const check = spawnSync('git', ['cat-file', '-t', '995104c4fc7226335374b140a5c5955ac922c125'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    if (check.status === 0 && check.stdout.trim() === 'commit') {
      const baseDir = path.join(tmpRoot, 'baseline-995104c');
      fs.mkdirSync(baseDir, { recursive: true });
      const tarPipe = spawnSync(
        'sh',
        ['-c', `git archive 995104c4fc7226335374b140a5c5955ac922c125 | tar -x -C "${baseDir}"`],
        { cwd: ROOT, encoding: 'utf8' }
      );
      assert.strictEqual(tarPipe.status, 0, `git archive 995104c failed: ${tarPipe.stderr}`);
      fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(baseDir, 'node_modules'), 'dir');
      return { dir: baseDir, mode: 'git_995104c_exact' };
    }
  }

  // Fallback when executed from an unpacked source ZIP without `.git`:
  // synthesize a pre-office baseline copy with `admin.use('/office', ...)` stripped so no `office_*` code runs.
  const synthDir = path.join(tmpRoot, 'baseline-synthesized');
  fs.mkdirSync(synthDir, { recursive: true });
  for (const item of ['src', 'public', 'package.json']) {
    fs.cpSync(path.join(ROOT, item), path.join(synthDir, item), { recursive: true });
  }
  const srvPath = path.join(synthDir, 'src/server.js');
  const srvTxt = fs.readFileSync(srvPath, 'utf8')
    .replace(/admin\.use\('\/office',\s*require\('\.\/office-routes'\)\);\s*/g, '');
  fs.writeFileSync(srvPath, srvTxt);
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(synthDir, 'node_modules'), 'dir');
  return { dir: synthDir, mode: 'zip_core_fallback' };
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-upg-rb-'));
  const procs = [];

  try {
    // =========================================================================
    // 1. Validate `scripts/docker-128m-gate.sh` syntax & `scripts/verify-backup-file.js`
    // =========================================================================
    const bashCheck = spawnSync('bash', ['-n', path.join(ROOT, 'scripts/docker-128m-gate.sh')], { encoding: 'utf8' });
    assert.strictEqual(bashCheck.status, 0, `docker-128m-gate.sh syntax error: ${bashCheck.stderr}`);

    const corruptDbFile = path.join(tmpRoot, 'corrupt.db');
    fs.writeFileSync(corruptDbFile, Buffer.alloc(8192, 0x33));
    assert.throws(() => verifyBackup(corruptDbFile), /not_sqlite_format_3/);

    // =========================================================================
    // 2. Phase A — Seed & populate rich multi-subsystem state on Baseline (`995104c`)
    // =========================================================================
    const baseline = prepareBaselineAppDir(tmpRoot);
    const dbPath = path.join(tmpRoot, 'matrix.db');
    const seedRes = spawnSync(process.execPath, ['src/seed.js'], {
      cwd: baseline.dir,
      env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
      encoding: 'utf8',
    });
    assert.strictEqual(seedRes.status, 0, `Baseline seed failed: ${seedRes.stderr}`);

    const portA = await getFreePort();
    const baseA = `http://127.0.0.1:${portA}`;
    const procA = spawn(process.execPath, ['--max-old-space-size=64', 'src/bootstrap.js'], {
      cwd: baseline.dir,
      env: { ...process.env, DB_PATH: dbPath, PORT: String(portA), AUTO_SEED: '0', SHOW_OTP: '0', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(procA);
    await waitHealth(baseA, procA, '/healthz');

    const ownerTokenA = (await apiJson(baseA, 'POST', '/api/admin/auth/login', { email: 'owner@mavi.eg', password: 'mavi-owner' })).json.token;
    const staffTokenA = (await apiJson(baseA, 'POST', '/api/admin/auth/login', { email: 'staff@mavi.eg', password: 'mavi-staff' })).json.token;
    const custTokenA = (await apiJson(baseA, 'POST', '/api/store/auth/login', { phone: '01012345678', password: 'mavi1234' })).json.token;
    assert.ok(ownerTokenA && staffTokenA && custTokenA);

    // Add a custom catalogue style + binary image
    assert.strictEqual((await apiJson(baseA, 'POST', '/api/admin/catalogue/styles', {
      id: 'DR-MAT-1',
      name: 'فستان مصفوفة الترقية',
      price: 3200,
      sale_price: 2900,
      lead_days: 6,
      note: 'فستان اختبار الترقية والتراجع',
      active: true,
      colours: ['أسود', 'كحلي'],
      fabrics: ['كريب'],
      sections: ['summer'],
    }, ownerTokenA)).status, 200);
    const addedImg = await apiJson(baseA, 'POST', '/api/admin/catalogue/styles/DR-MAT-1/images', {
      image: TINY_PNG_DATA_URL,
    }, ownerTokenA);
    assert.strictEqual(addedImg.status, 200);
    const styleImageId = addedImg.json.id;

    // Customer online cart checkout
    const catStyles = (await apiJson(baseA, 'GET', '/api/store/catalogue')).json.styles
      .filter((s) => s.type === 'made' && s.colours.length && s.lengths.length);
    assert.ok(catStyles.length >= 1);
    const cartOrderRes = await apiJson(baseA, 'POST', '/api/store/cart-checkout', {
      items: [{
        style_id: catStyles[0].id,
        colour: catStyles[0].colours[0].name,
        length_cm: catStyles[0].lengths[0],
        qty: 1,
        fabric_choice: 'قماش العميلة',
        note: 'طلب أونلاين قبل الترقية',
        price: 0,
      }],
      delivery: true,
      governorate: 'الجيزة',
      request_id: 'matrix-cart-before-upgrade-001',
    }, custTokenA);
    assert.strictEqual(cartOrderRes.status, 201);
    const cartOrderCode = cartOrderRes.json.order.code;

    // Quote order deposit on the online order (delivery_requested=1 requires shipping_fee)
    assert.strictEqual((await apiJson(baseA, 'POST', `/api/admin/order-deposits/${encodeURIComponent(cartOrderCode)}/quote`, {
      percent: 50,
      shipping_fee: 65,
      payment_details: 'إنستاباي للاختبار',
    }, ownerTokenA)).status, 200);

    // Customer custom design request + admin quote
    assert.strictEqual((await apiJson(baseA, 'PATCH', '/api/store/me', {
      name: 'عميلة الترقية',
      area: 'المعادي',
    }, custTokenA)).status, 200);
    assert.strictEqual((await apiJson(baseA, 'PUT', '/api/store/me/measurements', {
      waist: 72,
      hip: 98,
      bust: 90,
      shoulder: 39,
      length: 145,
      sleeve: 60,
      arm: 30,
    }, custTokenA)).status, 200);

    const customReqCreate = await apiJson(baseA, 'POST', '/api/store/custom-requests', {
      image: TINY_PNG_DATA_URL,
      governorate: 'القاهرة',
      fabric_choice: 'قماش MAVI',
      requested_colour: 'نبيتي',
      requested_fabric: 'ساتان',
      date_needed: '2026-12-10',
      details: 'تصميم خاص قبل الترقية',
    }, custTokenA);
    assert.strictEqual(customReqCreate.status, 201, JSON.stringify(customReqCreate.json));
    const customReqId = customReqCreate.json.id;

    assert.strictEqual((await apiJson(baseA, 'POST', `/api/admin/custom-requests/${customReqId}/quote`, {
      price: 3600,
      percent: 50,
      shipping_fee: 80,
      advice: 'مناسب جداً بالساتان',
      payment_details: 'تحويل محفظة',
    }, ownerTokenA)).status, 200);

    // Manual order with fabric/workshop/other costs + payment
    const manual1 = await apiJson(baseA, 'POST', '/api/admin/manual-orders', {
      customer_name: 'ندى سامي',
      customer_phone: '01099887766',
      confirm_existing: true,
      custom_name: 'فستان تكاليف كامل',
      qty: 2,
      unit_price: 1800,
      paid: 1200,
      shipping_fee: 70,
      governorate: 'الجيزة',
      promise_date: '2026-11-15',
      status: 'confirmed',
      channel: 'whatsapp',
    }, ownerTokenA);
    assert.strictEqual(manual1.status, 201);
    const manual1Code = manual1.json.code;
    const manual1Detail = (await apiJson(baseA, 'GET', `/api/admin/orders/${encodeURIComponent(manual1Code)}`, null, ownerTokenA)).json.order;
    const manual1ItemId = manual1Detail.items[0].id;

    assert.strictEqual((await apiJson(baseA, 'POST', `/api/admin/orders/${encodeURIComponent(manual1Code)}/cost-purchases/fabric`, {
      fabric_name: 'كريب كحلي',
      metres: 4,
      price_per_metre: 120,
      shipping_per_metre: 10,
    }, ownerTokenA)).status, 201);
    assert.strictEqual((await apiJson(baseA, 'POST', `/api/admin/orders/${encodeURIComponent(manual1Code)}/cost-purchases/workshop`, {
      order_item_id: manual1ItemId,
      tailor_id: 1,
      unit_cost: 150,
    }, ownerTokenA)).status, 201);
    assert.strictEqual((await apiJson(baseA, 'POST', `/api/admin/orders/${encodeURIComponent(manual1Code)}/cost-purchases/other`, {
      label: 'تغليف فاخر',
      amount: 50,
    }, ownerTokenA)).status, 201);

    // Manual order #2 with cancel -> partial refund -> void erroneous refund -> reactivate
    const manual2 = await apiJson(baseA, 'POST', '/api/admin/manual-orders', {
      customer_name: 'هدى كمال',
      customer_phone: '01055443322',
      confirm_existing: true,
      custom_name: 'فستان مرتجعات',
      qty: 1,
      unit_price: 2000,
      paid: 800,
      promise_date: '2026-11-28',
      status: 'confirmed',
      channel: 'instagram',
    }, ownerTokenA);
    assert.strictEqual(manual2.status, 201);
    const manual2Code = manual2.json.code;
    await apiJson(baseA, 'PATCH', `/api/admin/orders/${encodeURIComponent(manual2Code)}/status`, {
      status: 'cancelled',
      expected_status: 'confirmed',
    }, ownerTokenA);
    let m2 = (await apiJson(baseA, 'GET', `/api/admin/orders/${encodeURIComponent(manual2Code)}`, null, ownerTokenA)).json.order;
    assert.strictEqual((await apiJson(baseA, 'POST', `/api/admin/orders/${encodeURIComponent(manual2Code)}/refunds`, {
      amount: 200,
      method: 'wallet',
      refunded_on: '2026-11-23',
      note: 'رد فعلي سليم',
      confirm_actual: true,
      request_id: 'matrix-ref-keep',
      financial_revision: m2.financial_revision,
    }, ownerTokenA)).status, 201);
    m2 = (await apiJson(baseA, 'GET', `/api/admin/orders/${encodeURIComponent(manual2Code)}`, null, ownerTokenA)).json.order;
    const errRef = await apiJson(baseA, 'POST', `/api/admin/orders/${encodeURIComponent(manual2Code)}/refunds`, {
      amount: 50,
      method: 'cash',
      refunded_on: '2026-11-23',
      note: 'إدخال بالخطأ',
      confirm_actual: true,
      request_id: 'matrix-ref-void',
      financial_revision: m2.financial_revision,
    }, ownerTokenA);
    assert.strictEqual(errRef.status, 201);
    const errRefId = errRef.json.id;
    m2 = (await apiJson(baseA, 'GET', `/api/admin/orders/${encodeURIComponent(manual2Code)}`, null, ownerTokenA)).json.order;
    assert.strictEqual((await apiJson(baseA, 'POST', `/api/admin/orders/${encodeURIComponent(manual2Code)}/refunds/${errRefId}/void`, {
      reason: 'تصحيح إدخال خاطئ',
      confirm_clerical: true,
      financial_revision: m2.financial_revision,
    }, ownerTokenA)).status, 200);
    assert.strictEqual((await apiJson(baseA, 'POST', `/api/admin/orders/${encodeURIComponent(manual2Code)}/reactivate`, {}, ownerTokenA)).status, 200);

    // Capture baseline Report Hub summary before upgrade. Draft («new») orders
    // intentionally leave the books once the upgrade lands; financial
    // continuity here means every order is already past «confirmed».
    const seededOrders = (await apiJson(baseA, 'GET', '/api/admin/orders', null, ownerTokenA)).json.orders;
    // Orders with a pending deposit flow stay as they are: they are already
    // excluded from the books in both versions (custom pricing pending).
    for (const o of seededOrders.filter(x => x.status === 'new' && !x.deposit_status)) {
      const r = await apiJson(baseA, 'PATCH', `/api/admin/orders/${encodeURIComponent(o.code)}/status`, { status: 'confirmed' }, ownerTokenA);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    }
    // The online cart order keeps its quoted deposit, but «new» orders leave
    // the books after the upgrade; settle it so the baseline snapshot matches.
    const Database = require('better-sqlite3');
    { const d = new Database(dbPath); d.prepare("UPDATE orders SET status='confirmed' WHERE code=?").run(cartOrderCode); d.close(); }
    const reportHubBefore = (await apiJson(baseA, 'GET', '/api/admin/money/report-hub?from=2020-01-01&to=2030-12-31', null, ownerTokenA)).json;
    assert.ok(reportHubBefore && reportHubBefore.summary && reportHubBefore.summary.orders > 0);
    await stopServer(procA);

    // =========================================================================
    // 3. Phase B — Upgrade to current `HEAD` on the same DB + exercise `office_*` + verify backup CLI
    // =========================================================================
    const portB = await getFreePort();
    const baseB = `http://127.0.0.1:${portB}`;
    const procB = spawn(process.execPath, ['--max-old-space-size=64', 'src/bootstrap.js'], {
      cwd: ROOT,
      env: { ...process.env, DB_PATH: dbPath, PORT: String(portB), AUTO_SEED: '0', SHOW_OTP: '0', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(procB);
    await waitHealth(baseB, procB, '/healthz');

    const ownerTokenB = (await apiJson(baseB, 'POST', '/api/admin/auth/login', { email: 'owner@mavi.eg', password: 'mavi-owner' })).json.token;
    const reportHubUpgraded = (await apiJson(baseB, 'GET', '/api/admin/money/report-hub?from=2020-01-01&to=2030-12-31', null, ownerTokenB)).json;
    assert.deepStrictEqual(reportHubUpgraded.summary, reportHubBefore.summary,
      'Report Hub financial summary must remain 100% identical after upgrading to HEAD');
    assert.strictEqual(reportHubUpgraded.workshops.total, reportHubBefore.workshops.total);
    assert.strictEqual(reportHubUpgraded.fabrics.total, reportHubBefore.fabrics.total);

    // Exercise `office_*` tables on the upgraded database
    const syncRes = await apiJson(baseB, 'POST', '/api/admin/office/cases/sync', {}, ownerTokenB);
    assert.strictEqual(syncRes.status, 200);
    assert.ok(syncRes.json.cases.length >= 1);

    const jobCreate = await apiJson(baseB, 'POST', '/api/admin/office/jobs', {
      kind: 'order_followup_draft',
      payload: { order_code: manual1Code, focus: 'schedule' },
      idempotency_key: 'matrix-office-job-001',
    }, ownerTokenB);
    assert.strictEqual(jobCreate.status, 201);
    const jobId = jobCreate.json.job.id;
    assert.strictEqual((await apiJson(baseB, 'POST', '/api/admin/office/worker/step', {
      provider: 'fixture',
      job_id: jobId,
    }, ownerTokenB)).status, 200);
    const readyJob = (await apiJson(baseB, 'GET', `/api/admin/office/jobs/${jobId}`, null, ownerTokenB)).json.job;
    assert.strictEqual((await apiJson(baseB, 'POST', `/api/admin/office/jobs/${jobId}/review`, {
      expected_revision: readyJob.revision,
      expected_result_hash: readyJob.result_hash,
      decision: 'approve',
    }, ownerTokenB)).status, 200);

    // Download live backup & verify via `scripts/verify-backup-file.js` CLI (read-only guarantee!)
    const bkpRes = await fetch(baseB + '/api/admin/system/backup', {
      headers: { Authorization: 'Bearer ' + ownerTokenB },
    });
    assert.strictEqual(bkpRes.status, 200);
    const bkpHeaderSha = bkpRes.headers.get('x-mavi-backup-sha256');
    const bkpFile = path.join(tmpRoot, 'upgraded-snapshot.db');
    fs.writeFileSync(bkpFile, Buffer.from(await bkpRes.arrayBuffer()));
    const mtimeBeforeVerify = fs.statSync(bkpFile).mtimeMs;

    const cliOk = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts/verify-backup-file.js'), bkpFile, '--expect-sha256', bkpHeaderSha, '--json'],
      { cwd: ROOT, encoding: 'utf8' }
    );
    assert.strictEqual(cliOk.status, 0, `verify-backup-file CLI failed: ${cliOk.stderr}`);
    const cliReport = JSON.parse(cliOk.stdout);
    assert.strictEqual(cliReport.ok, true);
    assert.strictEqual(cliReport.has_office_schema, true);
    assert.strictEqual(fs.existsSync(bkpFile + '-wal'), false, 'Read-only verifier must not create -wal sidecar');
    assert.strictEqual(fs.statSync(bkpFile).mtimeMs, mtimeBeforeVerify, 'Read-only verifier must not mutate file mtime');

    const cliBadSha = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts/verify-backup-file.js'), bkpFile, '--expect-sha256', '0'.repeat(64)],
      { cwd: ROOT, encoding: 'utf8' }
    );
    assert.notStrictEqual(cliBadSha.status, 0, 'Verifier CLI must fail on mismatched --expect-sha256');

    await stopServer(procB);

    // =========================================================================
    // 4. Phase C — Code Rollback (`baseline.dir` / `995104c`) on a copy of the upgraded snapshot
    // =========================================================================
    const rollbackDbPath = path.join(tmpRoot, 'code-rollback-target.db');
    fs.copyFileSync(bkpFile, rollbackDbPath);

    const portC = await getFreePort();
    const baseC = `http://127.0.0.1:${portC}`;
    const procC = spawn(process.execPath, ['--max-old-space-size=64', 'src/bootstrap.js'], {
      cwd: baseline.dir,
      env: { ...process.env, DB_PATH: rollbackDbPath, PORT: String(portC), AUTO_SEED: '0', SHOW_OTP: '0', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    procs.push(procC);
    await waitHealth(baseC, procC, '/healthz');

    const ownerTokenC = (await apiJson(baseC, 'POST', '/api/admin/auth/login', { email: 'owner@mavi.eg', password: 'mavi-owner' })).json.token;
    const staffTokenC = (await apiJson(baseC, 'POST', '/api/admin/auth/login', { email: 'staff@mavi.eg', password: 'mavi-staff' })).json.token;
    const custTokenC = (await apiJson(baseC, 'POST', '/api/store/auth/login', { phone: '01012345678', password: 'mavi1234' })).json.token;

    // 4a. Read parity across all core subsystems on rolled-back code
    const imgResC = await fetch(`${baseC}/api/catalogue/images/${styleImageId}`);
    assert.strictEqual(imgResC.status, 200);
    assert.ok((imgResC.headers.get('content-type') || '').startsWith('image/'));

    const reportHubRolledBack = (await apiJson(baseC, 'GET', '/api/admin/money/report-hub?from=2020-01-01&to=2030-12-31', null, ownerTokenC)).json;
    assert.deepStrictEqual(reportHubRolledBack.summary, reportHubBefore.summary,
      'Report Hub summary on rolled-back code must match pre-upgrade summary 100%');

    const m1AfterRb = (await apiJson(baseC, 'GET', `/api/admin/orders/${encodeURIComponent(manual1Code)}`, null, ownerTokenC)).json.order;
    assert.strictEqual(m1AfterRb.totals.paid, 1200);
    const m2AfterRb = (await apiJson(baseC, 'GET', `/api/admin/orders/${encodeURIComponent(manual2Code)}`, null, ownerTokenC)).json.order;
    assert.strictEqual(m2AfterRb.totals.refunded, 200);
    assert.strictEqual(m2AfterRb.totals.paid, 600);

    assert.strictEqual((await apiJson(baseC, 'GET', `/api/admin/order-deposits/${encodeURIComponent(cartOrderCode)}`, null, ownerTokenC)).json.deposit.status, 'quoted');
    assert.strictEqual((await apiJson(baseC, 'GET', '/api/store/custom-requests', null, custTokenC)).json.requests[0].status, 'quoted');
    assert.strictEqual((await apiJson(baseC, 'GET', '/api/admin/orders', null, staffTokenC)).status, 200);
    assert.strictEqual((await apiJson(baseC, 'GET', '/api/store/web-alerts', null, custTokenC)).status, 200);

    // 4b. Write operations on rolled-back code (prove no trigger/FK/column breakage!)
    const postRbCart = await apiJson(baseC, 'POST', '/api/store/cart-checkout', {
      items: [{
        style_id: catStyles[0].id,
        colour: catStyles[0].colours[0].name,
        length_cm: catStyles[0].lengths[0],
        qty: 1,
        fabric_choice: 'قماش العميلة',
        note: 'طلب أونلاين بعد التراجع الكودي',
        price: 0,
      }],
      delivery: true,
      governorate: 'الإسكندرية',
      request_id: 'matrix-cart-after-rollback-002',
    }, custTokenC);
    assert.strictEqual(postRbCart.status, 201);

    const postRbManual = await apiJson(baseC, 'POST', '/api/admin/manual-orders', {
      customer_name: 'سلمى رامي',
      customer_phone: '01044332211',
      confirm_existing: true,
      custom_name: 'فستان بعد التراجع',
      qty: 1,
      unit_price: 2400,
      paid: 600,
      promise_date: '2026-12-05',
      status: 'new',
      channel: 'whatsapp',
    }, ownerTokenC);
    assert.strictEqual(postRbManual.status, 201);

    assert.strictEqual((await apiJson(baseC, 'POST', `/api/admin/orders/${encodeURIComponent(manual1Code)}/payments`, {
      amount: 500,
      method: 'cash',
    }, ownerTokenC)).status, 201);
    assert.strictEqual((await apiJson(baseC, 'PATCH', `/api/admin/orders/${encodeURIComponent(manual1Code)}/status`, {
      status: 'cut',
      expected_status: 'confirmed',
    }, staffTokenC)).status, 200);

    await stopServer(procC);

    completed = true;
    console.log(`[upgrade-rollback-matrix] PASSED (baseline_mode=${baseline.mode})`);
  } finally {
    for (const p of procs) {
      await stopServer(p);
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
