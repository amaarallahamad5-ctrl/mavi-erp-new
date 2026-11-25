'use strict';
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { AI_SUPPORTED_KINDS } = require(path.join(__dirname, '..', 'src/openrouter-client.js'));
const PORT = 3522;
const BASE = `http://127.0.0.1:${PORT}`;

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-staging-or-'));
  const dbPath = path.join(tmpDir, 'staging.db');

  // 1. Unit-test OpenRouter disabled contract & offline mock transport + Notify & WebPush staging disablement
  const unitPushDb = path.join(tmpDir, 'unit-push-staging.db');
  const unit = spawnSync(process.execPath, ['-e', `
    process.env.DB_PATH = ${JSON.stringify(unitPushDb)};
    process.env.AUTO_SEED = '0';
    const assert = require('assert');
    const { createConfig, buildBody, generateSyntheticTest, ProviderError, AI_SUPPORTED_KINDS } = require('./src/openrouter-client');

    // Default: disabled, zero network calls
    const defCfg = createConfig({});
    assert.deepStrictEqual(defCfg.summary(), {
      status: 'openrouter_disabled',
      enabled: false,
      source: 'none',
      key_present: false,
      key_tail: '',
      model: 'openrouter/free',
      last_test: null,
      free_models_only: true,
      automatic_retry: false,
      queue_connected: false,
      production_connected: false,
      network_calls: 0,
      supported_kinds: AI_SUPPORTED_KINDS,
    });

    // Secret never leaked in object keys, JSON, inspect, summary, or error
    const fakeSecret = 'sk_test_synthetic_secret_value_1234567890';
    const enabledCfg = createConfig({
      MAVI_OPENROUTER_ENABLED: '1',
      OPENROUTER_API_KEY: fakeSecret,
      OPENROUTER_MODEL: 'openrouter/free',
    });
    assert.ok(!JSON.stringify(enabledCfg).includes(fakeSecret));
    assert.ok(!JSON.stringify(enabledCfg.summary()).includes(fakeSecret));
    assert.strictEqual(enabledCfg.summary().key_present, true);

    // Forced disabled in staging even if MAVI_OPENROUTER_ENABLED=1!
    const stagingCfg = createConfig({
      MAVI_STAGING_MODE: '1',
      MAVI_OPENROUTER_ENABLED: '1',
      OPENROUTER_API_KEY: fakeSecret,
      OPENROUTER_MODEL: 'openrouter/free',
    });
    assert.strictEqual(stagingCfg.summary().enabled, false);
    assert.strictEqual(stagingCfg.summary().status, 'openrouter_disabled_in_staging');

    // Reject paid models and customer/arbitrary fields
    const paidCfg = createConfig({
      MAVI_OPENROUTER_ENABLED: '1',
      OPENROUTER_API_KEY: fakeSecret,
      OPENROUTER_MODEL: 'openai/gpt-4o',
    });
    assert.strictEqual(paidCfg.summary().status, 'only_free_model_ids_are_allowed');
    assert.throws(
      () => buildBody('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram', daily_budget_egp: 50, customer_phone: '01012345678' }, 'openrouter/free'),
      err => err instanceof ProviderError && err.code === 'only_allowlisted_demo_fields_are_supported'
    );

    // Live transport without mock is explicitly disabled in Phase 1
    (async () => {
      await assert.rejects(
        () => generateSyntheticTest(enabledCfg),
        err => err instanceof ProviderError && err.code === 'live_network_transport_disabled_in_phase1'
      );

      // Mock transport verifies zero-cost / no-fallback request body & structured draft parsing
      const ok = await generateSyntheticTest(enabledCfg, {
        transport: async (body, secret) => {
          assert.strictEqual(secret, fakeSecret);
          assert.strictEqual(body.provider.allow_fallbacks, false);
          assert.strictEqual(body.provider.data_collection, 'deny');
          assert.deepStrictEqual(body.provider.max_price, { prompt: 0, completion: 0 });
          assert.strictEqual(body.tools, undefined);
          return {
            status: 200,
            raw: Buffer.from(JSON.stringify({
              model: 'meta-llama/llama-3.3-8b-instruct:free',
              choices: [{
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    title: 'مسودة اختبار وهمية',
                    text: 'محتوى عربي تجريبي لقطعة مصطنعة.',
                    review_checklist: ['مراجعة المالكة قبل النشر'],
                  }),
                },
              }],
              usage: { prompt_tokens: 40, completion_tokens: 25, total_tokens: 65, cost: 0 },
            })),
          };
        },
      });
      assert.strictEqual(ok.ai_generated, true);
      assert.strictEqual(ok.requires_human_review, true);
      assert.deepStrictEqual(ok.external_actions, []);

      // Reject unexpected non-zero reported cost
      await assert.rejects(
        () => generateSyntheticTest(enabledCfg, {
          transport: async () => ({
            status: 200,
            raw: Buffer.from(JSON.stringify({
              model: 'meta-llama/llama-3.3-8b-instruct:free',
              choices: [{
                finish_reason: 'stop',
                message: { content: JSON.stringify({ title: 'أ', text: 'ب', review_checklist: ['ج'] }) },
              }],
              usage: { cost: 0.01 },
            })),
          }),
        }),
        err => err instanceof ProviderError && err.code === 'unexpected_reported_cost_stop_and_check_dashboard'
      );

      // Reject reflected secret in provider output
      await assert.rejects(
        () => generateSyntheticTest(enabledCfg, {
          transport: async () => ({
            status: 200,
            raw: Buffer.from(JSON.stringify({
              model: 'meta-llama/llama-3.3-8b-instruct:free',
              choices: [{
                finish_reason: 'stop',
                message: { content: JSON.stringify({ title: 'أ', text: fakeSecret, review_checklist: ['ج'] }) },
              }],
            })),
          }),
        }),
        err => err instanceof ProviderError && err.code === 'provider_response_redacted'
      );

      // Test Notify sendCode under MAVI_STAGING_MODE=1 even when Twilio env vars are populated
      process.env.MAVI_STAGING_MODE = '1';
      process.env.TWILIO_SID = 'AC_FAKE_SID';
      process.env.TWILIO_TOKEN = 'FAKE_TOKEN';
      process.env.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';
      let fetchCalled = false;
      global.fetch = async () => { fetchCalled = true; throw new Error('outbound_fetch_must_not_run'); };
      delete require.cache[require.resolve('./src/notify')];
      const notify = require('./src/notify');
      assert.strictEqual(notify.enabled, false);
      const sendRes = await notify.sendCode('01012345678', '123456');
      assert.strictEqual(fetchCalled, false);
      assert.strictEqual(sendRes.sent, false);
      assert.strictEqual(sendRes.channel, 'staging_disabled');

      // Test Web Push dispatch under MAVI_STAGING_MODE=1 even when a subscription & queued event exist in SQLite
      const webpush = require('web-push');
      let pushSendCalls = 0;
      webpush.sendNotification = async () => { pushSendCalls++; throw new Error('webpush_must_not_send_in_staging'); };
      const { run } = require('./src/db');
      const webAlerts = require('./src/web-alerts');
      run("INSERT INTO web_push_subscriptions(endpoint, realm, subject_id, subscription) VALUES('https://fcm.googleapis.com/fcm/send/test', 'admin', 1, ?)", JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/test', keys: { p256dh: 'A'.repeat(86), auth: 'B'.repeat(22) } }));
      run("INSERT INTO web_alert_events(realm, subject_id, kind) VALUES('admin', 1, 'new_order')");
      await new Promise(r => setTimeout(r, 120));
      assert.strictEqual(pushSendCalls, 0, 'webpush.sendNotification must never run in staging');
      if (typeof webAlerts.stop === 'function') webAlerts.stop();
      process.exit(0);
    })().catch(e => { console.error(e); process.exit(1); });
  `], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(unit.status, 0, unit.stderr + unit.stdout);

  // 2. HTTP integration test of `MAVI_STAGING_MODE=1` access gate, noindex, CSP, GA disablement, and Push block
  const seed = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
    encoding: 'utf8',
  });
  assert.strictEqual(seed.status, 0, seed.stderr);

  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(PORT),
      DB_PATH: dbPath,
      AUTO_SEED: '0',
      SHOW_OTP: '0',
      MAVI_STAGING_MODE: '1',
      TWILIO_SID: 'AC_FAKE_STAGING',
      TWILIO_TOKEN: 'FAKE_STAGING_TOKEN',
      TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    for (let i = 0; i < 50; i++) {
      try { const r = await fetch(BASE + '/healthz'); if (r.ok) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 100));
    }

    // Healthz & robots.txt are reachable and carry noindex
    const hz = await fetch(BASE + '/healthz');
    assert.strictEqual(hz.status, 200);
    assert.strictEqual(hz.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');

    const robots = await fetch(BASE + '/robots.txt');
    assert.strictEqual(robots.status, 200);
    assert.strictEqual(robots.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    assert.strictEqual(await robots.text(), 'User-agent: *\nDisallow: /\n');

    // Admin login shell is reachable so admin can authenticate
    const adminShell = await fetch(BASE + '/admin/');
    assert.strictEqual(adminShell.status, 200);
    assert.strictEqual(adminShell.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');

    // Unauthenticated visitors are BLOCKED (401) from storefront, catalogue API, product SEO pages, sitemap, llms.txt
    for (const blockedPath of ['/', '/store/', '/store/custom-design', '/sitemap.xml', '/llms.txt', '/api/store/catalogue']) {
      const r = await fetch(BASE + blockedPath, { redirect: 'manual' });
      assert.strictEqual(r.status, 401, `Expected 401 on ${blockedPath} in staging without admin login, got ${r.status}`);
      assert.strictEqual(r.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    }

    // Login as admin (owner)
    const login = await fetch(BASE + '/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: JSON.stringify({ email: 'owner@mavi.eg', password: 'mavi-owner' }),
    });
    assert.strictEqual(login.status, 200);
    const adminCookie = login.headers.get('set-cookie').split(';')[0];

    // Authenticated admin CAN access storefront & catalogue in staging, still with noindex + strict staging CSP
    const storeAuthed = await fetch(BASE + '/store/', { headers: { Cookie: adminCookie } });
    assert.strictEqual(storeAuthed.status, 200);
    assert.strictEqual(storeAuthed.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
    const csp = storeAuthed.headers.get('content-security-policy') || '';
    assert.ok(!csp.includes('google-analytics.com') && !csp.includes('googletagmanager.com'), 'Staging CSP must exclude GA/GTM: ' + csp);

    // Analytics script is explicitly stubbed out in staging
    const gaStub = await fetch(BASE + '/store/analytics-consent.js', { headers: { Cookie: adminCookie } });
    assert.strictEqual(gaStub.status, 200);
    const gaCode = await gaStub.text();
    assert.ok(gaCode.includes("window['ga-disable-G-JYBHFBY025']=true"));
    assert.ok(!gaCode.includes('googletagmanager.com'));

    // Web Push subscription is explicitly blocked in staging (403)
    const pushSub = await fetch(BASE + '/api/admin/web-alerts/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE, Cookie: adminCookie },
      body: JSON.stringify({
        subscription: {
          endpoint: 'https://fcm.googleapis.com/fcm/send/fake',
          keys: { p256dh: 'A'.repeat(86), auth: 'B'.repeat(22) },
        },
      }),
    });
    assert.strictEqual(pushSub.status, 403);
    const pushJson = await pushSub.json();
    assert.strictEqual(pushJson.error, 'staging_push_disabled');

    // Office status confirms all 4 outbound channels are disabled in staging
    const st = await fetch(BASE + '/api/admin/office/status', { headers: { Cookie: adminCookie } });
    assert.strictEqual(st.status, 200);
    const stJson = await st.json();
    assert.strictEqual(stJson.staging.staging_mode, true);
    assert.strictEqual(stJson.staging.channels.twilio_whatsapp.active, false);
    assert.strictEqual(stJson.staging.channels.web_push.active, false);
    assert.strictEqual(stJson.staging.channels.google_analytics.active, false);
    assert.strictEqual(stJson.staging.channels.openrouter_ai.active, false);
    assert.strictEqual(stJson.openrouter.status, 'openrouter_disabled_in_staging');

    console.log('staging-and-openrouter.test.js PASSED');
  } finally {
    server.kill('SIGTERM');
    await new Promise(r => server.once('exit', r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
