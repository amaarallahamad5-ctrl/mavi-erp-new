'use strict';
/* Laboratory pre-deployment & recovery readiness suite (runs strictly on disposable temp directories;
   NEVER touches production, Suga, GitHub main, or external networks. Note: laboratory checks are a
   prerequisite gate, NOT a substitute for a real `docker build`/`--memory=128m` container test or
   verified external production backups):
   1) Static contract check of Dockerfile, .dockerignore, & render.yaml
   2) Two-step owner initialization (`MAVI_INIT_OWNER_ONLY=1` + `INITIAL_ADMIN_PASSWORD_FILE`)
      verifying on Linux that the subsequent long-lived server process has ZERO bootstrap secret in `/proc/<pid>/environ`,
      plus production Staging Gate, HTTP->HTTPS 301, HSTS, CSRF Origin block, & Secure/HttpOnly/SameSite cookies
   3) Behavioral outbound-block verification using active function mocks (Twilio `fetch`, `webpush.sendNotification`,
      Google Analytics consent script/CSP, & OpenRouter) in `MAVI_STAGING_MODE=1`
   4) Backup telemetry truthfulness: injected `db.backup()` failure (500) and mid-stream socket abort MUST NOT
      populate `last_backup`, whereas a completed stream populates `last_backup` + matching `SHA-256`
   5) Streaming restore >12 MiB (~16 MiB SQLite snapshot with binary blobs) under `--max-old-space-size=64`,
      active-DB overwrite refusal, full multi-table digest comparison, and repeatable rollback via `MAVI_RESTORE_TARGET_NAME` */
const assert = require('assert');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
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
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

async function waitHealth(base, proc, urlPath = '/healthz') {
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) {
      throw new Error(`Process exited early with code ${proc.exitCode}`);
    }
    try {
      const r = await fetch(base + urlPath);
      if (r.ok) return;
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for ${base}${urlPath}`);
}

let suiteCompleted = false;
process.on('exit', (code) => {
  if (code === 0 && !suiteCompleted) {
    console.error('[predeploy-readiness] Premature event-loop drain before completion');
    process.exitCode = 1;
  }
});

async function stopServer(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill('SIGTERM');
  await new Promise((r) => proc.once('exit', r));
}

function readProcMemoryKib(pid) {
  if (!fs.existsSync(`/proc/${pid}/status`)) return null;
  const txt = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const rss = Number((txt.match(/^VmRSS:\s+(\d+)\s+kB$/m) || [])[1] || 0);
  const hwm = Number((txt.match(/^VmHWM:\s+(\d+)\s+kB$/m) || [])[1] || 0);
  return { rssKib: rss, hwmKib: hwm };
}

function snapshotLogicalDigest(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const tableNames = [
      'users',
      'customers',
      'styles',
      'style_images',
      'orders',
      'order_items',
      'payments',
      'order_refunds',
      'office_cases',
      'office_case_events',
      'office_jobs',
      'office_job_audit',
    ];
    const summary = {};
    for (const name of tableNames) {
      const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
      if (!exists) {
        summary[name] = [];
        continue;
      }
      const rows = db.prepare(`SELECT * FROM "${name}" ORDER BY id`).all();
      summary[name] = rows.map((row) => {
        const clean = {};
        for (const [k, v] of Object.entries(row)) {
          clean[k] = Buffer.isBuffer(v)
            ? `blob:${v.length}:${crypto.createHash('sha256').update(v).digest('hex')}`
            : v;
        }
        return clean;
      });
    }
    return crypto.createHash('sha256').update(JSON.stringify(summary)).digest('hex');
  } finally {
    db.close();
  }
}

(async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-predeploy-'));
  const runningProcs = [];

  try {
    // =========================================================================
    // 1. Static configuration contract check (Dockerfile, .dockerignore, render.yaml)
    // =========================================================================
    const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
    const dockerignore = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
      .split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
    const renderYaml = fs.readFileSync(path.join(ROOT, 'render.yaml'), 'utf8');

    assert.ok(dockerfile.includes('npm ci --omit=dev'), 'Dockerfile must install production deps from lockfile');
    assert.ok(dockerfile.includes('ENV NODE_ENV=production'), 'Dockerfile must enforce NODE_ENV=production');
    assert.ok(
      /ENV NODE_OPTIONS=.*--max-old-space-size=64/.test(dockerfile),
      'Dockerfile must cap V8 old-space at 64 MiB'
    );
    assert.ok(dockerfile.includes('ENV DB_PATH=/data/mavi.db') && dockerfile.includes('VOLUME ["/data"]'));
    assert.ok(dockerfile.includes('/healthz') && dockerfile.includes('CMD ["node", "src/bootstrap.js"]'));

    for (const requiredIgnore of ['node_modules', 'data', '.git', '*.db', '.env', 'test']) {
      assert.ok(dockerignore.includes(requiredIgnore), `.dockerignore must exclude ${requiredIgnore}`);
    }
    for (const mustNotIgnore of ['src', 'public', 'package.json', 'package-lock.json']) {
      assert.ok(!dockerignore.includes(mustNotIgnore), `.dockerignore must NOT exclude runtime asset ${mustNotIgnore}`);
    }
    assert.ok(renderYaml.includes('mountPath: /data') && renderYaml.includes('AUTO_SEED') && renderYaml.includes('"0"'));

    // =========================================================================
    // 2. Two-step owner init (`MAVI_INIT_OWNER_ONLY=1` + secret file) + Staging & HTTPS Gate
    // =========================================================================
    const prodDir = path.join(tmpRoot, 'prod-staging');
    fs.mkdirSync(prodDir, { recursive: true });
    const prodDbPath = path.join(prodDir, 'mavi.db');

    // 2a. `AUTO_SEED=1` MUST refuse to run in production
    const refuseSeed = spawnSync(process.execPath, ['src/bootstrap.js'], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: 'production', AUTO_SEED: '1', DB_PATH: prodDbPath },
      encoding: 'utf8',
    });
    assert.notStrictEqual(refuseSeed.status, 0);
    assert.ok(refuseSeed.stderr.includes('Demo seeding is disabled in production'));

    // 2b. One-shot owner initialization via secret file (deleted immediately before starting server)
    const ownerEmail = 'staging-owner@mavi.eg';
    const syntheticPassword = 'Stg!' + crypto.randomBytes(18).toString('hex');
    const secretFilePath = path.join(tmpRoot, 'owner-init.secret');
    fs.writeFileSync(secretFilePath, syntheticPassword + '\n', { mode: 0o600 });

    const cleanEnv = { ...process.env };
    delete cleanEnv.INITIAL_ADMIN_PASSWORD;
    delete cleanEnv.INITIAL_ADMIN_PASSWORD_FILE;
    delete cleanEnv.INITIAL_ADMIN_EMAIL;

    const initStep = spawnSync(process.execPath, ['src/bootstrap.js'], {
      cwd: ROOT,
      env: {
        ...cleanEnv,
        NODE_ENV: 'production',
        AUTO_SEED: '0',
        MAVI_INIT_OWNER_ONLY: '1',
        DB_PATH: prodDbPath,
        INITIAL_ADMIN_EMAIL: ownerEmail,
        INITIAL_ADMIN_PASSWORD_FILE: secretFilePath,
      },
      encoding: 'utf8',
    });
    fs.rmSync(secretFilePath, { force: true });
    assert.strictEqual(initStep.status, 0, `One-shot owner init failed: ${initStep.stderr}`);

    // Start long-lived staging server WITHOUT any bootstrap password in env or on disk
    const stgPort = await getFreePort();
    const stgBase = `http://127.0.0.1:${stgPort}`;
    const stgProc = spawn(process.execPath, ['--max-old-space-size=64', 'src/bootstrap.js'], {
      cwd: ROOT,
      env: {
        ...cleanEnv,
        NODE_ENV: 'production',
        MAVI_STAGING_MODE: '1',
        AUTO_SEED: '0',
        SHOW_OTP: '0',
        PORT: String(stgPort),
        DB_PATH: prodDbPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningProcs.push(stgProc);
    await waitHealth(stgBase, stgProc, '/healthz');

    // On Linux, verify `/proc/<pid>/environ` of the running server process does NOT contain the synthetic password
    if (fs.existsSync(`/proc/${stgProc.pid}/environ`)) {
      const rawEnviron = fs.readFileSync(`/proc/${stgProc.pid}/environ`);
      assert.strictEqual(
        rawEnviron.includes(Buffer.from(syntheticPassword, 'utf8')),
        false,
        'Long-lived server /proc/<pid>/environ must not retain bootstrap password after two-step init'
      );
    }

    // Staging gate checks
    for (const blockedPath of ['/', '/store/', '/api/store/styles', '/sitemap.xml']) {
      const r = await fetch(stgBase + blockedPath);
      assert.strictEqual(r.status, 401, `Staging gate must return 401 on unauthenticated ${blockedPath}`);
      assert.ok((r.headers.get('x-robots-tag') || '').includes('noindex'));
      assert.ok(!(r.headers.get('content-security-policy') || '').includes('googletagmanager.com'),
        'Staging CSP must strip external Google Analytics origins');
    }
    const robotsRes = await fetch(stgBase + '/robots.txt');
    assert.strictEqual(robotsRes.status, 200);
    assert.ok((await robotsRes.text()).includes('Disallow: /'));

    // HTTP -> HTTPS 301 redirect & CSRF Origin enforcement
    const httpRedirectRes = await fetch(stgBase + '/admin/', {
      headers: { 'X-Forwarded-Proto': 'http' },
      redirect: 'manual',
    });
    assert.strictEqual(httpRedirectRes.status, 301);
    assert.strictEqual(httpRedirectRes.headers.get('location'), `https://127.0.0.1:${stgPort}/admin/`);

    const csrfBlocked = await fetch(stgBase + '/api/admin/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ email: ownerEmail, password: syntheticPassword }),
    });
    assert.strictEqual(csrfBlocked.status, 403);

    const loginHttps = await fetch(stgBase + '/api/admin/auth/login', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: `https://127.0.0.1:${stgPort}`,
        'X-Forwarded-Proto': 'https',
      },
      body: JSON.stringify({ email: ownerEmail, password: syntheticPassword }),
    });
    assert.strictEqual(loginHttps.status, 200);
    assert.ok((loginHttps.headers.get('strict-transport-security') || '').includes('max-age=31536000'));
    const rawSetCookie = loginHttps.headers.get('set-cookie') || '';
    assert.ok(/HttpOnly/i.test(rawSetCookie) && /SameSite=Lax/i.test(rawSetCookie) && /Secure/i.test(rawSetCookie));
    const ownerToken = (await loginHttps.json()).token;
    const authHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ownerToken };

    // Verify GA script route serves explicit disablement stub even to authenticated admin in staging
    const gaStubRes = await fetch(stgBase + '/store/analytics-consent.js', { headers: { Authorization: 'Bearer ' + ownerToken } });
    assert.strictEqual(gaStubRes.status, 200);
    const gaStubText = await gaStubRes.text();
    assert.ok(gaStubText.includes('ga-disable-') && !gaStubText.includes('googletagmanager.com'));

    // Verify Web Push subscribe route is blocked in staging (403)
    const pushSubBlocked = await fetch(stgBase + '/api/admin/web-alerts/subscribe', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/fake', keys: { p256dh: 'A'.repeat(86), auth: 'B'.repeat(22) } } }),
    });
    assert.strictEqual(pushSubBlocked.status, 403);

    // =========================================================================
    // 3. Behavioral outbound-channel mock test in Staging (`Twilio`, `WebPush`, `OpenRouter`)
    // =========================================================================
    const outboundProbeScript = path.join(tmpRoot, 'outbound-mock-probe.cjs');
    fs.writeFileSync(outboundProbeScript, `'use strict';
      const assert = require('assert');
      const webpush = require(${JSON.stringify(require.resolve('web-push', { paths: [ROOT] }))});
      let externalFetchCalls = 0;
      let webpushSendCalls = 0;
      global.fetch = async (url) => { externalFetchCalls++; throw new Error('Unexpected fetch to ' + url); };
      webpush.sendNotification = async () => { webpushSendCalls++; throw new Error('Unexpected webpush send'); };

      const { run } = require(${JSON.stringify(path.join(ROOT, 'src/db'))});
      const notify = require(${JSON.stringify(path.join(ROOT, 'src/notify'))});
      const webAlerts = require(${JSON.stringify(path.join(ROOT, 'src/web-alerts'))});
      const openrouter = require(${JSON.stringify(path.join(ROOT, 'src/openrouter-client'))});
      const { getOutboundTelemetry } = require(${JSON.stringify(path.join(ROOT, 'src/staging-guard'))});

      (async () => {
        // Seed a pending alert + push subscription, then trigger both notify.sendCode & webAlerts.dispatchNow
        run("INSERT INTO users(email,name,role,password_hash) VALUES('o@mavi.eg','Owner','owner','x')");
        run("INSERT INTO web_push_subscriptions(endpoint,realm,subject_id,subscription) VALUES('https://fcm.googleapis.com/fcm/send/1','admin',1,?)",
          JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/1', keys: { p256dh: 'A'.repeat(86), auth: 'B'.repeat(22) } }));
        run("INSERT INTO web_alert_events(realm,kind) VALUES('admin','new_order')");

        const smsRes = await notify.sendCode('01012345678', '654321');
        assert.strictEqual(smsRes.sent, false);
        assert.strictEqual(smsRes.channel, 'staging_disabled');

        await webAlerts.dispatchNow();

        const cfg = openrouter.createConfig(process.env);
        assert.throws(() => cfg.validate(), /openrouter_disabled_in_staging/);

        assert.strictEqual(externalFetchCalls, 0, 'Twilio/external fetch must not fire in staging');
        assert.strictEqual(webpushSendCalls, 0, 'WebPush sendNotification must not fire in staging');
        const tel = getOutboundTelemetry();
        assert.strictEqual(tel.total_network_attempts, 0);
        assert.ok(tel.blocked_in_staging.twilio_whatsapp >= 1);
        assert.ok(tel.blocked_in_staging.web_push >= 1);
      })().catch((e) => { console.error(e); process.exit(1); });
    `);
    const outboundProbe = spawnSync(process.execPath, [outboundProbeScript], {
      cwd: ROOT,
      env: {
        ...cleanEnv,
        MAVI_STAGING_MODE: '1',
        MAVI_OPENROUTER_ENABLED: '1',
        OPENROUTER_API_KEY: 'synthetic_unused_staging_key_123456',
        TWILIO_SID: 'AC_synthetic_sid',
        TWILIO_TOKEN: 'synthetic_twilio_token',
        TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
        DB_PATH: path.join(tmpRoot, 'outbound-mock.db'),
      },
      encoding: 'utf8',
    });
    assert.strictEqual(outboundProbe.status, 0, `Behavioral outbound probe failed: ${outboundProbe.stderr}`);

    // =========================================================================
    // 4. Backup truthfulness: injected failure (500) & aborted download MUST NOT set `last_backup`
    // =========================================================================
    {
      const failDbPath = path.join(tmpRoot, 'backup-fail-probe.db');
      fs.copyFileSync(prodDbPath, failDbPath);
      const preloadFail = path.join(tmpRoot, 'inject-backup-fail.cjs');
      fs.writeFileSync(
        preloadFail,
        `const DB=require(${JSON.stringify(require.resolve('better-sqlite3', { paths: [ROOT] }))}); DB.prototype.backup=function(){return Promise.reject(new Error('synthetic_backup_error'));};\n`
      );
      const failPort = await getFreePort();
      const failBase = `http://127.0.0.1:${failPort}`;
      const failProc = spawn(process.execPath, ['--require', preloadFail, 'src/bootstrap.js'], {
        cwd: ROOT,
        env: { ...cleanEnv, NODE_ENV: 'production', AUTO_SEED: '0', SHOW_OTP: '0', PORT: String(failPort), DB_PATH: failDbPath },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      runningProcs.push(failProc);
      await waitHealth(failBase, failProc, '/healthz');

      const fLogin = await (await fetch(failBase + '/api/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: failBase },
        body: JSON.stringify({ email: ownerEmail, password: syntheticPassword }),
      })).json();
      const fHeaders = { Authorization: 'Bearer ' + fLogin.token };

      const beforeFail = await (await fetch(failBase + '/api/admin/system/info/status', { headers: fHeaders })).json();
      assert.strictEqual(beforeFail.last_backup, null);

      const failedBackupRes = await fetch(failBase + '/api/admin/system/backup', { headers: fHeaders });
      assert.strictEqual(failedBackupRes.status, 500);

      const afterFail = await (await fetch(failBase + '/api/admin/system/info/status', { headers: fHeaders })).json();
      assert.strictEqual(afterFail.last_backup, null, 'Failed SQLite backup MUST NOT populate last_backup');
      assert.ok(afterFail.backup_status.last_failed_at, 'Failed backup must record backup_status.last_failed_at');
      await stopServer(failProc);
    }

    // =========================================================================
    // 5. Populate orders, refunds, office state, & >15 MiB binary data; test abort, backup, >12MiB restore, & rollback
    // =========================================================================
    {
      const direct = new Database(prodDbPath);
      direct.prepare(
        "INSERT OR IGNORE INTO styles(id, name, type, price, cost, active, lead_days) VALUES('DR-READY-1', 'فستان جاهزية النشر', 'made', 2800, 1200, 1, 7)"
      ).run();
      direct.prepare("INSERT OR IGNORE INTO tailors(id, name) VALUES(1, 'ورشة المعادي')").run();
      direct.close();
    }

    // Create Order #1, partial refund, reactivate, sync cases, and approve draft #1
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

    await fetch(`${stgBase}/api/admin/orders/${encodeURIComponent(order1Code)}/status`, {
      method: 'PATCH',
      headers: authHeaders,
      body: JSON.stringify({ status: 'cancelled', expected_status: 'confirmed' }),
    });
    const ord1Detail = (await (await fetch(`${stgBase}/api/admin/orders/${encodeURIComponent(order1Code)}`, { headers: authHeaders })).json()).order;
    assert.strictEqual((await fetch(`${stgBase}/api/admin/orders/${encodeURIComponent(order1Code)}/refunds`, {
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
    })).status, 201);
    assert.strictEqual((await fetch(`${stgBase}/api/admin/orders/${encodeURIComponent(order1Code)}/reactivate`, {
      method: 'POST',
      headers: authHeaders,
      body: '{}',
    })).status, 200);

    await fetch(stgBase + '/api/admin/office/cases/sync', { method: 'POST', headers: authHeaders, body: '{}' });
    const draft1Id = (await (await fetch(stgBase + '/api/admin/office/jobs', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        kind: 'order_followup_draft',
        payload: { order_code: order1Code, focus: 'schedule' },
        idempotency_key: 'predeploy-draft-v1',
      }),
    })).json()).job.id;
    await fetch(stgBase + '/api/admin/office/worker/step', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ provider: 'fixture', job_id: draft1Id }),
    });
    const draft1Ready = (await (await fetch(`${stgBase}/api/admin/office/jobs/${draft1Id}`, { headers: authHeaders })).json()).job;
    assert.strictEqual((await fetch(`${stgBase}/api/admin/office/jobs/${draft1Id}/review`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        expected_revision: draft1Ready.revision,
        expected_result_hash: draft1Ready.result_hash,
        decision: 'approve',
      }),
    })).status, 200);

    // Take Backup V1 (point-in-time before large images & Order #2) and verify SHA-256 header
    const backupV1Res = await fetch(stgBase + '/api/admin/system/backup', { headers: { Authorization: 'Bearer ' + ownerToken } });
    assert.strictEqual(backupV1Res.status, 200);
    const backupV1Bytes = Buffer.from(await backupV1Res.arrayBuffer());
    const backupV1Sha = crypto.createHash('sha256').update(backupV1Bytes).digest('hex');
    assert.strictEqual(backupV1Res.headers.get('x-mavi-backup-sha256'), backupV1Sha);
    assert.strictEqual(Number(backupV1Res.headers.get('x-mavi-backup-bytes')), backupV1Bytes.length);
    const backupV1Path = path.join(tmpRoot, 'backup-v1.db');
    fs.writeFileSync(backupV1Path, backupV1Bytes);
    const v1Digest = snapshotLogicalDigest(backupV1Path);

    // Verify completed backup recorded SHA-256 & `client_storage_verified: false`
    const statusAfterV1 = await (await fetch(stgBase + '/api/admin/system/info/status', { headers: authHeaders })).json();
    assert.ok(statusAfterV1.last_backup);
    assert.strictEqual(statusAfterV1.backup_status.last_snapshot_sha256, backupV1Sha);
    assert.strictEqual(statusAfterV1.backup_status.client_storage_verified, false);

    // Add >15 MiB of binary image rows + Order #2 so Backup V2 exceeds the old 12 MiB restore limit!
    {
      const direct = new Database(prodDbPath);
      const chunk = Buffer.alloc(4 * 1024 * 1024, 0x5a); // 4 MiB deterministic binary payload
      const insImg = direct.prepare('INSERT INTO style_images(style_id, image, image_type, is_primary) VALUES(?, ?, ?, ?)');
      for (let i = 1; i <= 4; i++) {
        insImg.run('DR-READY-1', chunk, 'image/webp', i === 1 ? 1 : 0);
      }
      direct.close();
    }

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

    // Test mid-stream client abort on the ~16 MiB backup: MUST record `last_aborted_at` and NOT update `last_snapshot_sha256`
    await new Promise((resolve, reject) => {
      const reqAbort = http.get(
        `${stgBase}/api/admin/system/backup`,
        { headers: { Authorization: 'Bearer ' + ownerToken } },
        (res) => {
          res.once('data', () => {
            reqAbort.destroy();
            setTimeout(resolve, 150);
          });
        }
      );
      reqAbort.on('error', () => {});
      setTimeout(() => reject(new Error('Abort backup probe timed out')), 10000).unref();
    });
    const statusAfterAbort = await (await fetch(stgBase + '/api/admin/system/info/status', { headers: authHeaders })).json();
    assert.ok(statusAfterAbort.backup_status.last_aborted_at, 'Aborted backup stream must record last_aborted_at');
    assert.strictEqual(statusAfterAbort.backup_status.last_snapshot_sha256, backupV1Sha,
      'Aborted backup stream must NOT advance last completed backup digest');

    // Now download full ~16+ MiB Backup V2 cleanly
    const backupV2Res = await fetch(stgBase + '/api/admin/system/backup', {
      headers: { Authorization: 'Bearer ' + ownerToken },
    });
    assert.strictEqual(backupV2Res.status, 200);
    const backupV2Bytes = Buffer.from(await backupV2Res.arrayBuffer());
    assert.ok(backupV2Bytes.length > 15 * 1024 * 1024, `Expected V2 snapshot >15 MiB, got ${backupV2Bytes.length}`);
    const backupV2Sha = crypto.createHash('sha256').update(backupV2Bytes).digest('hex');
    assert.strictEqual(backupV2Res.headers.get('x-mavi-backup-sha256'), backupV2Sha);
    const backupV2TmpCheck = path.join(tmpRoot, 'backup-v2-check.db');
    fs.writeFileSync(backupV2TmpCheck, backupV2Bytes);
    const v2Digest = snapshotLogicalDigest(backupV2TmpCheck);
    fs.unlinkSync(backupV2TmpCheck);
    assert.notStrictEqual(v1Digest, v2Digest);

    const serverMem = readProcMemoryKib(stgProc.pid);
    if (serverMem) {
      assert.ok(serverMem.hwmKib > 0 && serverMem.hwmKib < 122880,
        `Server VmHWM (${serverMem.hwmKib} KiB) exceeded safe 120 MiB threshold`);
      console.log(`[predeploy-readiness] 64MiB-heap server after >16MiB online backup: VmRSS=${(serverMem.rssKib / 1024).toFixed(1)} MiB, VmHWM=${(serverMem.hwmKib / 1024).toFixed(1)} MiB`);
    }
    await stopServer(stgProc);

    // =========================================================================
    // 6. Streaming Restore Service (`MAVI_RESTORE_MODE=1` under `--max-old-space-size=64`)
    // =========================================================================
    const restoreDir = path.join(tmpRoot, 'restore-target');
    fs.mkdirSync(restoreDir, { recursive: true });
    const restoreSecret = 'RestoreSecret-' + crypto.randomBytes(24).toString('hex');

    // 6a. Refuses to start if `MAVI_RESTORE_TARGET_NAME` collides with active `DB_PATH` basename
    const refuseOverwriteActive = spawnSync(process.execPath, ['src/bootstrap.js'], {
      cwd: ROOT,
      env: {
        ...cleanEnv,
        MAVI_RESTORE_MODE: '1',
        MAVI_RESTORE_SECRET: restoreSecret,
        DB_PATH: path.join(restoreDir, 'mavi.db'),
        MAVI_RESTORE_TARGET_NAME: 'mavi.db',
      },
      encoding: 'utf8',
    });
    assert.notStrictEqual(refuseOverwriteActive.status, 0, 'Restore service must refuse overwriting active DB_PATH');

    // 6b. Start streaming restore service capped at `--max-old-space-size=64` and upload >15 MiB Backup V2
    const restorePort = await getFreePort();
    const restoreBase = `http://127.0.0.1:${restorePort}`;
    const restoreProc = spawn(process.execPath, ['--max-old-space-size=64', 'src/bootstrap.js'], {
      cwd: ROOT,
      env: {
        ...cleanEnv,
        MAVI_RESTORE_MODE: '1',
        MAVI_RESTORE_SECRET: restoreSecret,
        PORT: String(restorePort),
        DB_PATH: path.join(restoreDir, 'mavi.db'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningProcs.push(restoreProc);
    await waitHealth(restoreBase, restoreProc, '/');

    assert.strictEqual((await fetch(restoreBase + '/import', {
      method: 'POST',
      headers: { Authorization: 'Bearer wrong-secret', 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(1024, 0x41),
    })).status, 403);

    assert.strictEqual((await fetch(restoreBase + '/import', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + restoreSecret, 'Content-Type': 'application/octet-stream' },
      body: Buffer.alloc(2048, 0x41),
    })).status, 400);
    assert.strictEqual(fs.existsSync(path.join(restoreDir, 'mavi-restored.db')), false);

    // Upload the >15 MiB V2 SQLite snapshot (previously rejected with 413 at 12 MiB!)
    const validImportRes = await fetch(restoreBase + '/import', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + restoreSecret, 'Content-Type': 'application/octet-stream' },
      body: backupV2Bytes,
    });
    assert.strictEqual(validImportRes.status, 200, 'Streaming restore must accept valid >15 MiB SQLite snapshot');
    assert.strictEqual(validImportRes.headers.get('x-mavi-restored-sha256'), backupV2Sha);
    assert.strictEqual(validImportRes.headers.get('x-mavi-restored-file'), 'mavi-restored.db');

    const restoreMem = readProcMemoryKib(restoreProc.pid);
    if (restoreMem) {
      assert.ok(restoreMem.hwmKib > 0 && restoreMem.hwmKib < 122880,
        `Restore service VmHWM (${restoreMem.hwmKib} KiB) exceeded safe 120 MiB threshold`);
      console.log(`[predeploy-readiness] 64MiB-heap streaming restore (>16MiB DB): VmRSS=${(restoreMem.rssKib / 1024).toFixed(1)} MiB, VmHWM=${(restoreMem.hwmKib / 1024).toFixed(1)} MiB`);
    }

    // Duplicate upload to `mavi-restored.db` -> 409
    assert.strictEqual((await fetch(restoreBase + '/import', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + restoreSecret, 'Content-Type': 'application/octet-stream' },
      body: backupV1Bytes,
    })).status, 409);
    await stopServer(restoreProc);

    const restoredV2Path = path.join(restoreDir, 'mavi-restored.db');
    assert.strictEqual(snapshotLogicalDigest(restoredV2Path), v2Digest,
      'Restored V2 database logical digest across all 12 tables + binary images must match V2 snapshot');

    // Boot normal server on `mavi-restored.db` and verify API reads
    const verifyPort = await getFreePort();
    const verifyBase = `http://127.0.0.1:${verifyPort}`;
    const verifyProc = spawn(process.execPath, ['--max-old-space-size=64', 'src/bootstrap.js'], {
      cwd: ROOT,
      env: { ...cleanEnv, NODE_ENV: 'production', AUTO_SEED: '0', SHOW_OTP: '0', PORT: String(verifyPort), DB_PATH: restoredV2Path },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningProcs.push(verifyProc);
    await waitHealth(verifyBase, verifyProc, '/healthz');

    const vLogin = await (await fetch(verifyBase + '/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: verifyBase },
      body: JSON.stringify({ email: ownerEmail, password: syntheticPassword }),
    })).json();
    const vHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + vLogin.token };
    const restoredOrd1 = (await (await fetch(`${verifyBase}/api/admin/orders/${encodeURIComponent(order1Code)}`, { headers: vHeaders })).json()).order;
    assert.strictEqual(restoredOrd1.totals.paid, 850);
    assert.strictEqual((await fetch(`${verifyBase}/api/admin/orders/${encodeURIComponent(order2Code)}`, { headers: vHeaders })).status, 200);
    await stopServer(verifyProc);

    // =========================================================================
    // 7. Repeatable Point-in-Time Rollback in the SAME directory via `MAVI_RESTORE_TARGET_NAME`
    // =========================================================================
    const rbImportPort = await getFreePort();
    const rbImportBase = `http://127.0.0.1:${rbImportPort}`;
    const rbImportProc = spawn(process.execPath, ['--max-old-space-size=64', 'src/bootstrap.js'], {
      cwd: ROOT,
      env: {
        ...cleanEnv,
        MAVI_RESTORE_MODE: '1',
        MAVI_RESTORE_SECRET: restoreSecret,
        MAVI_RESTORE_TARGET_NAME: 'mavi-rollback-v1.db',
        PORT: String(rbImportPort),
        DB_PATH: restoredV2Path, // active DB is mavi-restored.db; stage rollback alongside it without conflict!
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningProcs.push(rbImportProc);
    await waitHealth(rbImportBase, rbImportProc, '/');

    const rbStageRes = await fetch(rbImportBase + '/import', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + restoreSecret, 'Content-Type': 'application/octet-stream' },
      body: backupV1Bytes,
    });
    assert.strictEqual(rbStageRes.status, 200);
    assert.strictEqual(rbStageRes.headers.get('x-mavi-restored-file'), 'mavi-rollback-v1.db');
    await stopServer(rbImportProc);

    const rollbackV1Path = path.join(restoreDir, 'mavi-rollback-v1.db');
    assert.strictEqual(snapshotLogicalDigest(rollbackV1Path), v1Digest,
      'Staged rollback DB must match exact logical digest of Backup V1 across all tables');
    assert.strictEqual(snapshotLogicalDigest(restoredV2Path), v2Digest,
      'Previous mavi-restored.db must remain untouched during rollback staging');

    suiteCompleted = true;
    console.log('predeploy-readiness.test.js PASSED');
  } finally {
    for (const p of runningProcs) {
      await stopServer(p);
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
