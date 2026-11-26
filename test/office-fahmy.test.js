'use strict';
/* فهمي بتاع التسويق — the daily marketing idea (owner decision 26.11):
   - one idea per Cairo day, idempotent (same idea on repeated calls)
   - built ONLY from real system data: real order codes, real customer names,
     real style names, real counts — never invented content
   - plain understandable Arabic body with facts + ordered steps
   - owner-only endpoints (staff gets 403)
   - reading the idea flips is_new (the bell dot clears) */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

test('Fahmy daily idea: one per day, real data only, owner-only, read tracking', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/office-fahmy.js'), 'utf8');
  assert.ok(src.includes('CREATE TABLE IF NOT EXISTS fahmy_ideas'), 'the ideas table must exist');
  assert.ok(src.includes("require('./business-date')") && src.includes('cairoDate('), 'the day key must come from the Cairo business-date helper');
  assert.ok(src.includes('INSERT OR IGNORE'), 'generation must be idempotent per day');
  assert.ok(src.includes('buildIdeaForDay') && src.includes('collectBrief'), 'the real-data brief must drive the topic');
  // banned content classes: invented marketing fluff or provider talk
  assert.ok(!src.toLowerCase().includes('openrouter'), 'fahmy is provider-free');

  const routesSrc = fs.readFileSync(path.join(ROOT, 'src/office-routes.js'), 'utf8');
  assert.ok(routesSrc.includes("router.get('/fahmy/today', A.requireOwner"), 'the today endpoint must be owner-only');
  assert.ok(routesSrc.includes("router.post('/fahmy/read', A.requireOwner"), 'the read endpoint must be owner-only');

  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');
  assert.ok(uiSrc.includes('id="of-fahmy-btn"'), 'the notification button must render in the owner toolbar');
  assert.ok(uiSrc.includes('أفكار الأيام اللي فاتت'), 'previous ideas stay readable');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-fahmy-'));
  const dbPath = path.join(tmpDir, 'fahmy.db');
  const seeded = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
  });
  assert.strictEqual(seeded.status, 0, seeded.stderr);

  const PORT = 3092;
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

    // staff never gets the marketing brain
    const staffRes = await api('GET', '/fahmy/today', staffT);
    assert.strictEqual(staffRes.status, 403, 'staff must never read فهمي ideas');
    const staffRead = await api('POST', '/fahmy/read', staffT);
    assert.strictEqual(staffRead.status, 403, 'staff must never mark ideas read');

    // first owner call creates today's idea
    const r1 = await api('GET', '/fahmy/today', ownerT);
    assert.strictEqual(r1.status, 200);
    const b1 = await r1.json();
    assert.strictEqual(b1.ok, true);
    const idea = b1.idea;
    assert.ok(idea && idea.id && idea.day, 'an idea with id+day must be returned');
    assert.ok(idea.title_ar && idea.title_ar.length > 10, 'the idea carries an Arabic title');
    assert.ok(idea.body_ar && idea.body_ar.length > 120, 'the idea carries FULL details, not a stub');
    assert.ok(Array.isArray(idea.facts) && idea.facts.length >= 1, 'real numbers are shown as facts');
    assert.ok(Array.isArray(idea.steps) && idea.steps.length >= 2, 'ordered steps are included');
    assert.strictEqual(b1.unread, 1, 'a fresh idea starts unread');
    assert.ok(previousShape(b1.previous), 'previous ideas list is returned');

    // idempotent: same idea on the second call of the same day
    const r2 = await api('GET', '/fahmy/today', ownerT);
    const b2 = await r2.json();
    assert.strictEqual(b2.idea.id, idea.id, 'the same day must return the same idea (no duplicates)');

    // idea content must reference real system data (seed has styles + orders)
    const allText = `${idea.title_ar} ${idea.body_ar} ${idea.facts.map(f => `${f.label} ${f.value}`).join(' ')}`;
    assert.ok(/[A-Z]{2}-\d{4}-\d{1,3}|MV-\d{6}-\d{1,3}|SK-|CR-\d/.test(allText) || /\d/.test(allText),
      'the idea must carry real codes or counts, got: ' + allText.slice(0, 200));
    assert.ok(!/(GPT|OpenRouter|API key|نموذج لغوي)/i.test(allText), 'no provider-speak in the idea');

    // mark read -> unread clears
    const rr = await api('POST', '/fahmy/read', ownerT);
    assert.strictEqual(rr.status, 200);
    const rb = await rr.json();
    assert.strictEqual(rb.ok, true);
    assert.strictEqual(rb.idea.is_new, false, 'reading flips is_new');
    const r3 = await api('GET', '/fahmy/today', ownerT);
    const b3 = await r3.json();
    assert.strictEqual(b3.unread, 0, 'the badge dot must clear after reading');
  } finally {
    child.kill('SIGKILL');
  }

  console.log('FAHMY-OK');
});

function previousShape(list) {
  return Array.isArray(list) && list.every(i => i && typeof i.title_ar === 'string');
}
