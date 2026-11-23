'use strict';
/* Pre-deployment laboratory readiness suite (runs strictly on disposable temp directories;
   NEVER touches production, Suga, GitHub main, or external networks):
   1) Dockerfile, .dockerignore, & render.yaml static deployment-contract audit
   2) Production + Staging gate (`NODE_ENV=production`, `MAVI_STAGING_MODE=1`, `X-Forwarded-Proto: https`):
      - Rejects `AUTO_SEED=1` in production
      - Initializes owner from 16+ char secret & scrubs `INITIAL_ADMIN_PASSWORD` from runtime env
      - Enforces 401 login gate + `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet` on public/store routes
      - Enforces Secure + HttpOnly + SameSite session cookies behind HTTPS proxy
      - Verifies outbound communications/tracking/AI are disabled (`network_calls: 0`)
   3) Live WAL Backup (`GET /api/admin/system/backup`) + One-time Safe Restore (`MAVI_RESTORE_MODE=1`)
      + Two-path Rollback Drill (Point-in-time DB rollback & Core-ERP schema backward compatibility)
   4) Live container-budget memory measurement (`VmRSS` & `VmHWM` under `--max-old-space-size=64`) */
const assert = require('assert');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

async function waitHealth(base, proc, urlPath = '/healthz') {
  for (let i = 0; i < 80; i++) {
    if (proc.exitCode !== null) {
      throw new Error(`Process exited early with code ${proc.exitCode}`);
    }
    try {
      const r = await fetch(base + urlPath);
      if (r.ok) return;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${base}${urlPath}`);
}

async function stopServer(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  await new Promise(r => proc.once('exit', r));
}

function readProcMemoryKib(pid) {
  if (!fs.existsSync(`/proc/${pid}/status`)) return null;
  const txt = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const rss = Number((txt.match(/^VmRSS:\s+(\d+)\s+kB$/m) || [])[1] || 0);
  const hwm = Number((txt.match(/^VmHWM:\s+(\d+)\s+kB$/m) || [])[1] || 0);
  return { rssKib: rss, hwmKib: hwm };
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-predeploy-'));
  const runningProcs = [];

  try {
    // =========================================================================
    // 1. Static audit of Dockerfile, .dockerignore, and render.yaml
    // =========================================================================
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
      .split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
    const renderYaml = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');

    assert.ok(dockerfile.includes('npm ci --omit=dev'), 'Dockerfile must install production deps reproducibly from lockfile');
    assert.ok(dockerfile.includes('ENV NODE_ENV=production'), 'Dockerfile must enforce NODE_ENV=production');
    assert.ok(dockerfile.includes('ENV NODE_OPTIONS=--max-old-space-size=64'), 'Dockerfile must cap V8 old-space at 64 MiB for 128 MiB hosts');
    assert.ok(dockerfile.includes('ENV DB_PATH=/data/mavi.db') && dockerfile.includes('VOLUME ["/data"]'),
      'Dockerfile must point DB_PATH to persistent /data volume');
    assert.ok(dockerfile.includes('/healthz'), 'Dockerfile must configure /healthz healthcheck');
    assert.ok(dockerfile.includes('CMD ["node", "src/bootstrap.js"]'), 'Dockerfile must boot via src/bootstrap.js');

    for (const requiredIgnore of ['node_modules', 'data', '.git', '*.db', '.env', 'test']) {
      assert.ok(dockerignore.includes(requiredIgnore), `.dockerignore must exclude ${requiredIgnore}`);
    }
    for (const mustNotIgnore of ['src', 'public', 'package.json', 'package-lock.json']) {
      assert.ok(!dockerignore.includes(mustNotIgnore), `.dockerignore must NOT exclude runtime asset ${mustNotIgnore}`);
    }
    assert.ok(renderYaml.includes('mountPath: /data') && renderYaml.includes('AUTO_SEED') && renderYaml.includes('"0"'));

    // =========================================================================
    // 2. Production safety + Staging Gate + HTTPS Cookie & Outbound Isolation
    // =========================================================================
    const prodDir = path.join(tmpRoot, 'prod-staging');
    fs.mkdirSync(prodDir, { recursive: true });
    const prodDbPath = path.join(prodDir, 'mavi.db');

    // 2a. `AUTO_SEED=1` MUST refuse to run when `NODE_ENV=production`
    const refuseSeed = spawnSync(process.execPath, ['src/bootstrap.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        AUTO_SEED: '1',
        DB_PATH: prodDbPath,
      },
      encoding: 'utf8',
    });
    assert.notStrictEqual(refuseSeed.status, 0, 'Production bootstrap MUST refuse AUTO_SEED=1');
    assert.ok(refuseSeed.stderr.includes('Demo seeding is disabled in production'));

    // 2b. Boot production + staging server with strong initial owner password (24 chars)
    const ownerEmail = 'staging-owner@mavi.eg';
    const ownerPassword = 'Stg!' + crypto.randomBytes(16).toString('hex');
    const stgPort = await getFreePort();
    const stgBase = `http://127.0.0.1:${stgPort}`;
    const stgProc = spawn(process.execPath, ['--max-old-space-size=64', 'src/bootstrap.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        MAVI_STAGING_MODE: '1',
        AUTO_SEED: '0',
        SHOW_OTP: '0',
        PORT: String(stgPort),
        DB_PATH: prodDbPath,
        INITIAL_ADMIN_EMAIL: ownerEmail,
        INITIAL_ADMIN_PASSWORD: ownerPassword,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningProcs.push(stgProc);
    await waitHealth(stgBase, stgProc, '/healthz');

    // Unauthenticated visitors are blocked across root, store, sitemap, and store APIs with noindex headers
    for (const blockedPath of ['/', '/store/', '/api/store/styles', '/sitemap.xml']) {
      const r = await fetch(stgBase + blockedPath);
      assert.strictEqual(r.status, 401, `Staging gate must return 401 on unauthenticated ${blockedPath}`);
      assert.ok((r.headers.get('x-robots-tag') || '').includes('noindex'), `Missing X-Robots-Tag on ${blockedPath}`);
    }
    // /robots.txt explicitly stays 200 with Disallow: / + X-Robots-Tag so crawlers honor the block
    const robotsRes = await fetch(stgBase + '/robots.txt');
    assert.strictEqual(robotsRes.status, 200);
    assert.ok((await robotsRes.text()).includes('Disallow: /'));
    assert.ok((robotsRes.headers.get('x-robots-tag') || '').includes('noindex'));
    // Admin login shell remains reachable so the owner can sign in
    const adminShellRes = await fetch(stgBase + '/admin/');
    assert.strictEqual(adminShellRes.status, 200);
    assert.ok((adminShellRes.headers.get('x-robots-tag') || '').includes('noindex'));

    // Plain HTTP behind reverse proxy (`X-Forwarded-Proto: http`) in production MUST 301 redirect to HTTPS
    const httpRedirectRes = await fetch(stgBase + '/admin/', {
      headers: { 'X-Forwarded-Proto': 'http' },
      redirect: 'manual',
    });
    assert.strictEqual(httpRedirectRes.status, 301, 'Plain HTTP behind proxy in production must redirect 301 to HTTPS');
    assert.strictEqual(httpRedirectRes.headers.get('location'), `https://127.0.0.1:${stgPort}/admin/`);

    // Cross-origin POST MUST be blocked by CSRF Origin check (403)
    const csrfBlocked = await fetch(stgBase + '/api/admin/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
    });
    assert.strictEqual(csrfBlocked.status, 403, 'Mismatched Origin must be blocked with 403');

    // Same-host HTTPS login (`X-Forwarded-Proto: https`) -> HSTS + Secure + HttpOnly + SameSite cookie
    const loginHttps = await fetch(stgBase + '/api/admin/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `https://127.0.0.1:${stgPort}`,
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
    });
    assert.strictEqual(loginHttps.status, 200);
    assert.ok((loginHttps.headers.get('strict-transport-security') || '').includes('max-age=31536000'),
      'HTTPS response in production must include Strict-Transport-Security');
    const rawSetCookie = loginHttps.headers.get('set-cookie') || '';
    assert.ok(/HttpOnly/i.test(rawSetCookie), 'Session cookie must set HttpOnly');
    assert.ok(/SameSite=Lax/i.test(rawSetCookie), 'Session cookie must set SameSite=Lax');
    assert.ok(/Secure/i.test(rawSetCookie), 'Session cookie behind HTTPS proxy must set Secure');
    const ownerToken = (await loginHttps.json()).token;
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + ownerToken,
    };

    // Verify staging outbound blocks & scrubbed initial secret
    const officeStatus = await (await fetch(stgBase + '/api/admin/office/status', { headers: authHeaders })).json();
    assert.strictEqual(officeStatus.staging.staging_mode, true);
    assert.strictEqual(officeStatus.staging.channels.twilio_whatsapp.active, false);
    assert.strictEqual(officeStatus.staging.channels.web_push.active, false);
    assert.strictEqual(officeStatus.staging.channels.google_analytics.active, false);
    assert.strictEqual(officeStatus.staging.channels.openrouter_ai.active, false);
    assert.strictEqual(officeStatus.worker.network_calls, 0);
    assert.ok(!JSON.stringify(officeStatus).includes(ownerPassword));

    // =========================================================================
    // 3. Backup (`GET /api/admin/system/backup`), Restore (`MAVI_RESTORE_MODE=1`), and Rollback Drill
    // =========================================================================
    // Seed a catalogue style into this production-like DB so we can create orders, refunds, cases, and drafts
    {
      const direct = new Database(prodDbPath);
      direct.prepare(
        "INSERT OR IGNORE INTO styles(id, name, type, price, cost, active, lead_days) VALUES('DR-READY-1', 'فستان جاهزية النشر', 'made', 2800, 1200, 1, 7)"
      ).run();
      direct.prepare("INSERT OR IGNORE INTO tailors(id, name) VALUES(1, 'ورشة المعادي')").run();
      direct.close();
    }

    // Create Order #1 with payment, cancel + record partial refund, reactivate, sync cases, and approve a draft
    const ord1Res = await fetch(stgBase + '/api/admin/manual-orders', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        customer_name: 'ليلى محمود',
        customer_phone: '01022334455',
        confirm_existing: true,
        custom_name: 'فستان النسخة الاحتياطية ١',
        qty: 1,
        unit_price: 2500,
        paid: 1000,
        promise_date: '2026-11-18',
        status: 'confirmed',
        channel: 'whatsapp',
      }),
    });
    assert.strictEqual(ord1Res.status, 201);
    const order1Code = (await ord1Res.json()).code;

    // Cancel -> record actual refund of 150 -> reactivate so WAL has multi-table financial history
    await fetch(`${stgBase}/api/admin/orders/${encodeURIComponent(order1Code)}/status`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'cancelled', expected_status: 'confirmed' }),
    });
    const ord1Detail = (await (await fetch(`${stgBase}/api/admin/orders/${encodeURIComponent(order1Code)}`, { headers: authHeaders })).json()).order;
    const refRes = await fetch(`${stgBase}/api/admin/orders/${encodeURIComponent(order1Code)}/refunds`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        amount: 150,
        method: 'wallet',
        refunded_on: '2026-11-23',
        note: 'رد جزئي للاختبار',
        confirm_actual: true,
        request_id: 'predeploy-refund-001',
        financial_revision: ord1Detail.financial_revision,
      }),
    });
    assert.strictEqual(refRes.status, 201);
    const reactRes = await fetch(`${stgBase}/api/admin/orders/${encodeURIComponent(order1Code)}/reactivate`, {
      method: 'POST',
      headers: authHeaders,
      body: '{}',
    });
    assert.strictEqual(reactRes.status, 200);

    // Sync follow-up cases + create, prepare, and approve an office draft on Order #1
    await fetch(stgBase + '/api/admin/office/cases/sync', { method: 'POST', headers: authHeaders, body: '{}' });
    const draft1Create = await fetch(stgBase + '/api/admin/office/jobs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        kind: 'order_followup_draft',
        payload: { order_code: order1Code, focus: 'schedule' },
        idempotency_key: 'predeploy-draft-v1',
      }),
    });
    assert.strictEqual(draft1Create.status, 201);
    const draft1Id = (await draft1Create.json()).job.id;
    await fetch(stgBase + '/api/admin/office/worker/step', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ provider: 'fixture', job_id: draft1Id }),
    });
    const draft1Ready = (await (await fetch(`${stgBase}/api/admin/office/jobs/${draft1Id}`, { headers: authHeaders })).json()).job;
    const draft1Approve = await fetch(`${stgBase}/api/admin/office/jobs/${draft1Id}/review`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        expected_revision: draft1Ready.revision,
        expected_result_hash: draft1Ready.result_hash,
        decision: 'approve',
      }),
    });
    assert.strictEqual(draft1Approve.status, 200);

    // Take Point-in-Time Backup V1 (`GET /api/admin/system/backup`) while server & WAL are live!
    const backupV1Res = await fetch(stgBase + '/api/admin/system/backup', { headers: { Authorization: 'Bearer ' + ownerToken } });
    assert.strictEqual(backupV1Res.status, 200);
    const backupV1Bytes = Buffer.from(await backupV1Res.arrayBuffer());
    assert.ok(backupV1Bytes.length > 4096, 'Backup V1 must be a non-empty SQLite file');
    const backupV1Path = path.join(tmpRoot, 'backup-v1.db');
    fs.writeFileSync(backupV1Path, backupV1Bytes);

    // Verify `last_backup` is now recorded in `/api/admin/system/info/status`
    const sysStatus = await (await fetch(stgBase + '/api/admin/system/info/status', { headers: authHeaders })).json();
    assert.ok(sysStatus.last_backup, 'System status must record last_backup timestamp after download');

    // Mutate state AFTER Backup V1 (create Order #2) so we can prove both V2 restore AND V1 point-in-time rollback!
    const ord2Res = await fetch(stgBase + '/api/admin/manual-orders', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        customer_name: 'رنا فؤاد',
        customer_phone: '01066778899',
        confirm_existing: true,
        custom_name: 'فستان بعد النسخة الأولى ٢',
        qty: 1,
        unit_price: 3100,
        paid: 900,
        promise_date: '2026-11-25',
        status: 'new',
        channel: 'instagram',
      }),
    });
    assert.strictEqual(ord2Res.status, 201);
    const order2Code = (await ord2Res.json()).code;

    const backupV2Bytes = Buffer.from(await (await fetch(stgBase + '/api/admin/system/backup', {
      headers: { Authorization: 'Bearer ' + ownerToken },
    })).arrayBuffer());

    // 4. Measure live server memory under 64 MiB V8 heap limit before stopping `stgProc`
    const mem = readProcMemoryKib(stgProc.pid);
    if (mem) {
      // Must fit comfortably within 128 MiB (131,072 KiB) container ceiling
      assert.ok(mem.hwmKib > 0 && mem.hwmKib < 122880,
        `Peak VmHWM (${mem.hwmKib} KiB) exceeded safe 120 MiB threshold for 128 MiB container`);
      console.log(`[predeploy-readiness] Measured 64MiB-heap server memory: VmRSS=${(mem.rssKib / 1024).toFixed(1)} MiB, VmHWM=${(mem.hwmKib / 1024).toFixed(1)} MiB`);
    }

    await stopServer(stgProc);

    // =========================================================================
    // 3b. Exercise official One-Time Restore Service (`MAVI_RESTORE_MODE=1`) for V2
    // =========================================================================
    const restoreDir = path.join(tmpRoot, 'restore-target');
    fs.mkdirSync(restoreDir, { recursive: true });
    const restoreSecret = 'RestoreSecret-' + crypto.randomBytes(24).toString('hex');
    const restorePort = await getFreePort();
    const restoreBase = `http://127.0.0.1:${restorePort}`;
    const restoreProc = spawn(process.execPath, ['src/bootstrap.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        MAVI_RESTORE_MODE: '1',
        MAVI_RESTORE_SECRET: restoreSecret,
        PORT: String(restorePort),
        DB_PATH: path.join(restoreDir, 'mavi.db'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningProcs.push(restoreProc);
    await waitHealth(restoreBase, restoreProc, '/');

    // Wrong secret -> 403
    const badSecretRes = await fetch(restoreBase + '/import', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-secret', 'Content-Type': 'application/octet-stream' },
      body: backupV2Bytes,
    });
    assert.strictEqual(badSecretRes.status, 403);

    // Corrupt non-SQLite payload -> 400 and leaves no destination file
    const corruptPayload = Buffer.alloc(2048, 0x41);
    const corruptRes = await fetch(restoreBase + '/import', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + restoreSecret, 'Content-Type': 'application/octet-stream' },
      body: corruptPayload,
    });
    assert.strictEqual(corruptRes.status, 400);
    assert.strictEqual(fs.existsSync(path.join(restoreDir, 'mavi-restored.db')), false);

    // Valid Backup V2 -> 200 ok & stages `mavi-restored.db`
    const validImportRes = await fetch(restoreBase + '/import', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + restoreSecret, 'Content-Type': 'application/octet-stream' },
      body: backupV2Bytes,
    });
    assert.strictEqual(validImportRes.status, 200);
    const restoredDbPath = path.join(restoreDir, 'mavi-restored.db');
    assert.strictEqual(fs.existsSync(restoredDbPath), true);

    // Second upload attempt while `mavi-restored.db` exists -> 409 (never overwrites!)
    const duplicateImportRes = await fetch(restoreBase + '/import', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + restoreSecret, 'Content-Type': 'application/octet-stream' },
      body: backupV2Bytes,
    });
    assert.strictEqual(duplicateImportRes.status, 409);
    await stopServer(restoreProc);

    // Boot normal server against `mavi-restored.db` and verify ALL orders, net refunds, cases, and approved draft survived!
    const verifyPort = await getFreePort();
    const verifyBase = `http://127.0.0.1:${verifyPort}`;
    const verifyProc = spawn(process.execPath, ['--max-old-space-size=64', 'src/bootstrap.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        AUTO_SEED: '0',
        SHOW_OTP: '0',
        PORT: String(verifyPort),
        DB_PATH: restoredDbPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningProcs.push(verifyProc);
    await waitHealth(verifyBase, verifyProc, '/healthz');

    const vLogin = await (await fetch(verifyBase + '/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: verifyBase },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
    })).json();
    const vHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + vLogin.token };

    const restoredOrd1 = (await (await fetch(`${verifyBase}/api/admin/orders/${encodeURIComponent(order1Code)}`, { headers: vHeaders })).json()).order;
    assert.strictEqual(restoredOrd1.totals.gross_paid, 1000);
    assert.strictEqual(restoredOrd1.totals.refunded, 150);
    assert.strictEqual(restoredOrd1.totals.paid, 850);

    const restoredOrd2 = await fetch(`${verifyBase}/api/admin/orders/${encodeURIComponent(order2Code)}`, { headers: vHeaders });
    assert.strictEqual(restoredOrd2.status, 200);

    const restoredDraft = (await (await fetch(`${verifyBase}/api/admin/office/jobs/${draft1Id}`, { headers: vHeaders })).json()).job;
    assert.strictEqual(restoredDraft.status, 'approved');
    await stopServer(verifyProc);

    // =========================================================================
    // 3c. Rollback Drill (Path A: Point-in-Time Rollback to Backup V1; Path B: Core-ERP Schema Independence)
    // =========================================================================
    // Path A: Boot against `backup-v1.db` -> Order #1 & its approved draft exist, Order #2 (post-V1) is absent
    const rbPort = await getFreePort();
    const rbBase = `http://127.0.0.1:${rbPort}`;
    const rbProc = spawn(process.execPath, ['--max-old-space-size=64', 'src/bootstrap.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        AUTO_SEED: '0',
        SHOW_OTP: '0',
        PORT: String(rbPort),
        DB_PATH: backupV1Path,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningProcs.push(rbProc);
    await waitHealth(rbBase, rbProc, '/healthz');

    const rbLogin = await (await fetch(rbBase + '/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: rbBase },
      body: JSON.stringify({ email: ownerEmail, password: ownerPassword }),
    })).json();
    const rbHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + rbLogin.token };
    assert.strictEqual((await fetch(`${rbBase}/api/admin/orders/${encodeURIComponent(order1Code)}`, { headers: rbHeaders })).status, 200);
    assert.strictEqual((await fetch(`${rbBase}/api/admin/orders/${encodeURIComponent(order2Code)}`, { headers: rbHeaders })).status, 404,
      'Point-in-time rollback to Backup V1 must exclude post-backup Order #2');
    await stopServer(rbProc);

    // Path B: Verify zero foreign-key or trigger coupling from core ERP tables into `office_*` tables
    // (so rolling back application code to pre-office `main` against an upgraded SQLite file cannot break core ERP writes!)
    const schemaCheckDb = new Database(restoredDbPath, { readonly: true });
    assert.strictEqual(schemaCheckDb.pragma('integrity_check', { simple: true }), 'ok');
    assert.strictEqual(schemaCheckDb.pragma('foreign_key_check').length, 0);
    const nonOfficeRefsToOffice = schemaCheckDb.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE sql IS NOT NULL
        AND name NOT LIKE 'office_%'
        AND name NOT LIKE 'idx_office_%'
        AND lower(sql) LIKE '%office_%'
    `).all();
    assert.strictEqual(nonOfficeRefsToOffice.length, 0,
      'Core MAVI tables/triggers must have zero references to office_* tables for safe code rollback: ' + JSON.stringify(nonOfficeRefsToOffice));
    schemaCheckDb.close();

    console.log('predeploy-readiness.test.js PASSED');
  } finally {
    for (const p of runningProcs) {
      await stopServer(p);
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
