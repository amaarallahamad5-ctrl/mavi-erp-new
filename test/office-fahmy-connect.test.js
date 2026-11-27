'use strict';
/* فهمي connection & key activation (owner request 26.11: use what she sent
   before + the keyless free agent):
   - POST /fahmy/key: owner-only, ONE paste field contract, saves the key into
     the same settings the gated engine reads and flips office_ai_enabled on
   - GET /fahmy/today then reports ai_ready (key present + enabled) and
     free_agent (the keyless fallback availability)
   - POST /fahmy/check: owner-only plain-Arabic probe of the gated config;
     failures stay honest (ok:false + message_ar) and never throw HTML errors
   - staff gets 403 everywhere */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

test('Fahmy connect: key activation inside the modal, engine status, honest check, owner-only', async () => {
  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');
  assert.ok(uiSrc.includes('officeSaveFahmyKey') && uiSrc.includes('of-fahmy-key-input'), 'the one-field key activation must exist inside the فهمي modal');
  assert.ok(uiSrc.includes('officeFahmyCheckConnection'), 'the connection check must be reachable from the modal');
  // since the owner re-commissioned the gated provider, its NAME may appear ONLY
  // inside the optional key-activation hint (she needs to know where to get a key)
  const nameCount = (uiSrc.match(/openrouter/gi) || []).length;
  assert.ok(nameCount >= 1 && nameCount <= 4, 'the provider name appears only in the key hint, count: ' + nameCount);
  assert.ok(uiSrc.includes('sk-or-'), 'the hint must tell her the key prefix');

  const routesSrc = fs.readFileSync(path.join(ROOT, 'src/office-routes.js'), 'utf8');
  assert.ok(routesSrc.includes("router.post('/fahmy/key', A.requireOwner"), 'the key route must be owner-only');
  assert.ok(routesSrc.includes("router.post('/fahmy/check', A.requireOwner"), 'the check route must be owner-only');
  assert.ok(routesSrc.includes('resetAiThrottle'), 'saving a key must reset the upgrade throttle so today idea upgrades');

  const faSrc = fs.readFileSync(path.join(ROOT, 'src/free-agent-client.js'), 'utf8');
  assert.ok(faSrc.includes('text.pollinations.ai'), 'the keyless free agent endpoint must be declared');
  assert.ok(faSrc.includes('private: true'), 'free-agent generations must be marked private');
  assert.ok(faSrc.includes('isStagingMode'), 'the free agent must be disabled in staging');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-fahmy-conn-'));
  const dbPath = path.join(tmpDir, 'conn.db');
  const seeded = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
  });
  assert.strictEqual(seeded.status, 0, seeded.stderr);

  const PORT = 3096;
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

    // engine status before activation: nothing ready, free agent available
    const before = await api('GET', '/fahmy/today', ownerT);
    assert.strictEqual(before.status, 200);
    const bb = await before.json();
    assert.strictEqual(bb.ai_ready, false, 'without a saved key the gated engine is not ready');
    assert.strictEqual(bb.free_agent, true, 'the keyless free agent is available in non-staging');

    // staff never touches the key/check routes
    const staffKey = await api('POST', '/fahmy/key', staffT, { key: 'sk-valid-looking-key-123456' });
    assert.strictEqual(staffKey.status, 403, 'staff must never save a key');
    const staffCheck = await api('POST', '/fahmy/check', staffT, {});
    assert.strictEqual(staffCheck.status, 403, 'staff must never run the connection probe');

    // bad key shape -> honest 400 with SPECIFIC plain-Arabic diagnosis
    const bad = await api('POST', '/fahmy/key', ownerT, { key: 'short' });
    assert.strictEqual(bad.status, 400);
    const badBody = await bad.json();
    assert.ok(badBody.message && badBody.message.length > 10, 'the bad-key reply explains in plain Arabic');

    // whitespace-wrapped paste (the usual mobile-copy failure) gets its own message
    // internal whitespace (the usual mobile-copy failure) gets its own message
    const ws = await api('POST', '/fahmy/key', ownerT, { key: 'sk-or-v1-aaaa aaa aaaaaaaa' });
    assert.strictEqual(ws.status, 400);
    const wsBody = await ws.json();
    assert.ok(wsBody.message.includes('مسافة أو سطر'), 'internal whitespace gets the spaces diagnosis, got: ' + wsBody.message);

    // an old-provider (Alibaba-era) sk- key gets the exact diagnosis at PASTE time
    // — this is what got stored before and then rejected by the provider
    const wp = await api('POST', '/fahmy/key', ownerT, { key: 'sk-alibaba-1234567890abcdef' });
    assert.strictEqual(wp.status, 400);
    const wpBody = await wp.json();
    assert.ok(wpBody.message.includes('علي بابا') && wpBody.message.includes('sk-or-'), 'old-provider keys get the true diagnosis, got: ' + wpBody.message);

    // a valid-shape OpenRouter key still saves fine
    const goodShape = await api('POST', '/fahmy/key', ownerT, { key: 'sk-or-v1-abcdef1234567890' });
    assert.strictEqual(goodShape.status, 200, goodShape.status !== 200 ? await goodShape.clone().text() : 'valid OpenRouter shape must save');

    // saving a well-shaped key succeeds and flips ai_ready
    const saved = await api('POST', '/fahmy/key', ownerT, { key: 'sk-or-test-key-000000000001' });
    assert.strictEqual(saved.status, 200, saved.status !== 200 ? await saved.clone().text() : 'save must succeed');
    const savedBody = await saved.json();
    assert.strictEqual(savedBody.ok, true);
    assert.ok(savedBody.message_ar.includes('اتحفظ'), 'the save reply speaks plain Arabic');
    const after = await api('GET', '/fahmy/today', ownerT);
    const ab = await after.json();
    assert.strictEqual(ab.ai_ready, true, 'the saved key must light up the gated engine status');

    // the probe answers honestly (in the test sandbox the network fails fast
    // -> ok:false with an Arabic explanation; the shape is what matters here)
    const check = await api('POST', '/fahmy/check', ownerT, {});
    assert.strictEqual(check.status, 200);
    const cb = await check.json();
    assert.strictEqual(typeof cb.ok, 'boolean');
    assert.ok(cb.message_ar && cb.message_ar.length > 10, 'the probe always answers in plain Arabic');
    if (!cb.ok) {
      assert.strictEqual(cb.free_agent_cover, true, 'a failed key probe must report the free-agent cover flag');
      assert.ok(cb.message_ar.includes('الوكيل المجاني'), 'a failed probe must reassure: the free agent already covers the day, got: ' + cb.message_ar);
    }

    // transparency: the probe shows WHICH credential it actually used
    assert.ok(typeof cb.key_tail === 'string' && cb.key_tail.length > 0, 'the probe shows the key tail it used');
    assert.strictEqual(cb.key_source, 'settings', 'the owner-saved key wins over any stale env key');
    // covered failures (free agent up) must surface as calm INFO, never a scary warning
    assert.strictEqual(cb.severity, cb.ok ? 'ok' : 'info', 'free-agent-covered probe failures are calm info, got: ' + cb.severity);

    // provider busy states (rate limit / daily cap / model busy) say the key itself is FINE
    const routesSrc2 = fs.readFileSync(path.join(ROOT, 'src/office-routes.js'), 'utf8');
    for (const phrase of ['المفتاح نفسه شغّال ومتعلّن عليه', 'المفتاح نفسه شغّال ✅ — بس حد الاستخدام المجاني اليومي']) {
      assert.ok(routesSrc2.includes(phrase), 'busy-state messages must celebrate the working key: ' + phrase);
    }

    // owner removes the key: back to the keyless free-agent state she trusts
    const unset = await api('POST', '/fahmy/key/unset', ownerT, {});
    assert.strictEqual(unset.status, 200, unset.status !== 200 ? await unset.clone().text() : 'unset works');
    const ub = await unset.json();
    assert.ok(ub.ok === true && ub.message_ar.includes('اتشال'), 'the removal speaks plain Arabic');
    const afterUnset = await api('GET', '/fahmy/today', ownerT);
    const au = await afterUnset.json();
    assert.strictEqual(au.ai_ready, false, 'after removal the gated engine is dark again');
    assert.strictEqual(au.free_agent, true, 'the free agent keeps covering the day');
    const resave = await api('POST', '/fahmy/key', ownerT, { key: 'sk-or-v1-abcdef1234567890' });
    assert.strictEqual(resave.status, 200, 'after removal a fresh key can be saved again');
  } finally {
    child.kill('SIGKILL');
  }

  console.log('FAHMY-CONNECT-OK');
});
