'use strict';
/* Owner-only Office AI configuration endpoints (task G):
   - POST /ai/config stores the OpenRouter key/model/enabled in ERP settings
     (never returns the raw key; free-model IDs only; exact body enforced).
   - POST /ai/test runs the real connection check and persists office_ai_last_test.
   - GET /status exposes the honest provider summary to the owner only,
     including the supported marketing kinds (derived). */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { AI_SUPPORTED_KINDS } = require(path.join(ROOT, 'src/openrouter-client.js'));
const PORT = 3066;
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-ai-config-'));
  const dbPath = path.join(tmpDir, 'ai-config.db');
  const seeded = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
  });
  assert.strictEqual(seeded.status, 0, seeded.stderr);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: dbPath, PORT: String(PORT), MAVI_OPENROUTER_ENABLED: '0', MAVI_OFFICE_AI_NO_MODEL_DISCOVERY: '1' },
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
    const api = (method, p, token, body) => fetch(`${BASE}/api/admin/office${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Mavi-Token': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // 1. Staff is never allowed to configure or test the provider
    const staffCfg = await api('POST', '/ai/config', staffT, { api_key: 'x'.repeat(20), model: 'openrouter/free', enabled: true });
    assert.strictEqual(staffCfg.status, 403);
    const staffTest = await api('POST', '/ai/test', staffT, {});
    assert.strictEqual(staffTest.status, 403);

    // 2. Status before configuration: no env key, settings empty -> not enabled
    const st0 = await (await api('GET', '/status', ownerT)).json();
    assert.ok(st0.openrouter, 'owner status must include the provider summary');
    assert.strictEqual(st0.openrouter.key_present, false);
    assert.strictEqual(st0.openrouter.enabled, false);
    assert.notStrictEqual(st0.openrouter.status, 'ready');

    // 3. Paid model ids are rejected
    const paid = await api('POST', '/ai/config', ownerT, { api_key: 'k'.repeat(20), model: 'openai/gpt-4o', enabled: true });
    assert.strictEqual(paid.status, 400);
    assert.strictEqual((await paid.json()).error, 'only_free_model_ids_are_allowed');

    // 4. Extra body fields are rejected (exact-body contract)
    const extra = await api('POST', '/ai/config', ownerT, { api_key: 'k'.repeat(20), model: 'openrouter/free', enabled: true, temperature: 0.7 });
    assert.strictEqual(extra.status, 400);

    // 5. Saving a valid free configuration enables the provider from settings alone
    const saved = await api('POST', '/ai/config', ownerT, { api_key: 'or-live-test-123456', model: 'openrouter/free', enabled: true });
    assert.strictEqual(saved.status, 200);
    const sum = (await saved.json()).openrouter;
    assert.strictEqual(sum.status, 'ready', 'settings-saved key must make the provider ready without env vars');
    assert.strictEqual(sum.source, 'settings');
    assert.strictEqual(sum.key_present, true);
    assert.strictEqual(sum.key_tail, '3456');
    assert.strictEqual(sum.enabled, true);
    assert.ok(Array.isArray(sum.supported_kinds) && sum.supported_kinds.length === AI_SUPPORTED_KINDS.length, 'supported kinds must mirror the client allowlist (derived, no hardcoded counts)');
    assert.strictEqual(sum.free_models_only, true);
    assert.strictEqual(sum.automatic_retry, false);

    // 6. Status reflects the saved configuration for the owner (and only the owner)
    const st1 = await (await api('GET', '/status', ownerT)).json();
    assert.strictEqual(st1.openrouter.status, 'ready');
    const stStaff = await (await api('GET', '/status', staffT)).json();
    assert.strictEqual(stStaff.openrouter, undefined, 'staff must not see provider configuration');

    // 7. Real connection test against the fake key: honest failure, persisted
    const test = await api('POST', '/ai/test', ownerT, {});
    assert.strictEqual(test.status, 200);
    const tr = await test.json();
    assert.strictEqual(tr.ok, false, 'a fake key must fail the live connection test');
    assert.strictEqual(typeof tr.error_code, 'string');
    assert.strictEqual(typeof tr.latency_ms, 'number');
    const st2 = await (await api('GET', '/status', ownerT)).json();
    assert.ok(st2.openrouter.last_test && st2.openrouter.last_test.ok === false, 'the failed test must be persisted as last_test');

    // 8. Explicit clear: empty api_key removes the stored key and disables the provider
    const cleared = await api('POST', '/ai/config', ownerT, { api_key: '', model: 'openrouter/free', enabled: false });
    assert.strictEqual(cleared.status, 200);
    const sumC = (await cleared.json()).openrouter;
    assert.strictEqual(sumC.key_present, false);
    assert.strictEqual(sumC.enabled, false);
    assert.notStrictEqual(sumC.status, 'ready');

    // 9. Keeping the key (empty field omitted) only toggles state
    const keep = await api('POST', '/ai/config', ownerT, { api_key: 'or-live-test-123456', model: 'openrouter/free', enabled: false });
    assert.strictEqual(keep.status, 200);
    const sumK = (await keep.json()).openrouter;
    assert.strictEqual(sumK.key_present, true);
    assert.strictEqual(sumK.enabled, false, 'enabled:false must keep the key stored but disable generation');
    assert.strictEqual(sumK.key_tail, '3456');

    // 10. Free-models list endpoint: owner only, array shape
    assert.strictEqual((await api('GET', '/ai/models', staffT)).status, 403);
    const modelsRes = await api('GET', '/ai/models', ownerT);
    assert.strictEqual(modelsRes.status, 200);
    assert.ok(Array.isArray((await modelsRes.json()).models), '/ai/models must return a models array');

    console.log('AI-CONFIG-HTTP-OK');
  } finally {
    child.kill('SIGKILL');
  }
})().catch((err) => { console.error(err); process.exit(1); });
