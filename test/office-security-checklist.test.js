'use strict';
/* 🛡 Security smart check (owner request 26.11, from her video): a visible
   step-by-step verification with a progress counter (n / 7) and category
   tags, ending with «النظام أصبح آمنًا». Every step is a REAL check:
   users/roles, input policy layer, private customer data, DB integrity
   (PRAGMA quick_check + foreign_keys + WAL), dependencies, production mode,
   backups (last backup event). Owner-only, plain Arabic, never decorative. */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

test('Security smart check: 7 real steps, verdict banner, animated UI, owner-only', async () => {
  const routesSrc = fs.readFileSync(path.join(ROOT, 'src/office-routes.js'), 'utf8');
  assert.ok(routesSrc.includes("router.get('/security-checklist', A.requireOwner"), 'the endpoint must be owner-only');
  assert.ok(routesSrc.includes('PRAGMA quick_check'), 'the DB integrity check must be real');
  assert.ok(routesSrc.includes("entity_id='backup'"), 'the backup check must read the real audit trail');
  assert.ok(routesSrc.includes('النظام أصبح آمنًا'), 'the verdict must speak plain Arabic');

  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');
  assert.ok(uiSrc.includes('officeSecurityCheckModal'), 'the animated modal must exist');
  assert.ok(uiSrc.includes('🛡 فحص الأمان الذكي (٧ خطوات)'), 'the button must exist in the owner tools');
  assert.ok(uiSrc.includes('of-sec-counter') && uiSrc.includes('of-sec-bar'), 'the progress counter and segmented bar must render');
  assert.ok(uiSrc.includes('قاعدتك:'), 'each step must show the owner rule bubble like the video');
  assert.ok(uiSrc.includes('✅ النظام أصبح آمنًا'), 'the final safe banner must exist');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-sec-'));
  const dbPath = path.join(tmpDir, 'sec.db');
  const seeded = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
  });
  assert.strictEqual(seeded.status, 0, seeded.stderr);

  const PORT = 3098;
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
    const api = (method, p, token) => fetch(`${BASE}/api/admin/office${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Mavi-Token': token } : {}) },
    });

    const staffRes = await api('GET', '/security-checklist', staffT);
    assert.strictEqual(staffRes.status, 403, 'staff must never run the security check');

    const res = await api('GET', '/security-checklist', ownerT);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.steps.length, 7, 'exactly seven steps like the video, got: ' + body.steps.length);
    const ids = body.steps.map(s => s.id);
    assert.deepStrictEqual(ids, ['auth', 'input', 'privacy', 'db', 'deps', 'prod', 'backup'], 'the seven categories must match the video');
    for (const st of body.steps) {
      assert.ok(st.tag_ar && st.title_ar && st.rule_ar && st.detail_ar, 'every step carries full Arabic details');
      assert.ok(['ok', 'warn', 'fail'].includes(st.status), 'every step carries an honest status');
    }
    const dbStep = body.steps.find(s => s.id === 'db');
    assert.strictEqual(dbStep.status, 'ok', 'the fresh seeded DB must pass the integrity check: ' + dbStep.detail_ar);
    const authStep = body.steps.find(s => s.id === 'auth');
    assert.strictEqual(authStep.status, 'ok', 'seeded owner+staff users must pass the roles check');
    const privacyStep = body.steps.find(s => s.id === 'privacy');
    assert.ok(privacyStep.detail_ar.length > 30, 'the privacy step reports real numbers');
    assert.strictEqual(typeof body.safe, 'boolean', 'the verdict is explicit');
    assert.ok(body.banner_ar.includes('النظام'), 'the verdict speaks plain Arabic');
  } finally {
    child.kill('SIGKILL');
  }

  console.log('SECURITY-CHECK-OK');
});
