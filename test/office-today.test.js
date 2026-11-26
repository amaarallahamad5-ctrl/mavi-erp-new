'use strict';
/* TODAY BOARD («شغل النهاردة») — the owner's single page of everything she
   owes today, built ONLY from real system data (no AI):
   - active orders whose promise_date passed or is today -> late_order rows
   - active orders with zero payments -> no_deposit rows
   - approved unused customer replies + order follow-ups -> ready_reply rows
   - wa.me phone normalization (Egyptian 01xxxxxxxxx -> 20xxxxxxxxx)
   - owner-only (staff 403)
   Also locks the Alibaba/local removal: zero references left in the office
   UI and routes, while the one-button smart setup stays. */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

test('Today board: real-data rows, WhatsApp normalization, owner-only, Alibaba fully removed', async () => {
  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');
  assert.ok(uiSrc.includes('شغل النهاردة'), 'the board title must exist in the office UI');
  assert.ok(uiSrc.includes("officeApi('/today-board'"), 'the board must load from the today-board endpoint');
  assert.ok(uiSrc.includes("https://wa.me/' + phone + '?text='"), 'the WhatsApp send must be a wa.me link');
  assert.ok(uiSrc.includes('officeTbSend') && uiSrc.includes('officeTbDone'), 'send + done handlers must exist');
  // Owner decision (final shape): every AI surface is retired — the office runs on real data only.
  assert.strictEqual(uiSrc.includes('officeSmartSetup') || uiSrc.includes('officeOpenAiSettings') || uiSrc.includes('officeOpenIdeasModal'), false, 'zero AI UI surfaces may remain');
  assert.strictEqual(uiSrc.includes('alibaba') || uiSrc.includes('Alibaba') || uiSrc.includes('of-ai2'), false, 'zero Alibaba UI references may remain');
  assert.strictEqual(uiSrc.includes('of-loc-') || uiSrc.includes('officeTestAi3'), false, 'zero local-layer UI references may remain');

  const routesSrc = fs.readFileSync(path.join(ROOT, 'src/office-routes.js'), 'utf8');
  assert.ok(routesSrc.includes("router.get('/today-board'"), 'the today-board route must exist');
  assert.strictEqual(routesSrc.includes('/ai/alibaba') || routesSrc.includes('/ai/local/'), false, 'the removed endpoints must be gone from the routes');
  assert.ok(routesSrc.includes('function waPhone'), 'the phone normalizer must exist');
  assert.ok(fs.existsSync(path.join(ROOT, 'src/alibaba-client.js')) === false, 'alibaba-client.js must be deleted');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-today-'));
  const dbPath = path.join(tmpDir, 'board.db');
  const seeded = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
  });
  assert.strictEqual(seeded.status, 0, seeded.stderr);

  // Real rows: customer + late order + no-deposit order + an approved reply job
  // (dates are computed HERE and interpolated, not inside the fill script)
  const y = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const fill = `process.env.DB_PATH = ${JSON.stringify(dbPath)};
const { run, get } = require(${JSON.stringify(path.join(ROOT, 'src/db'))});
require(${JSON.stringify(path.join(ROOT, 'src/office-engine'))}); // office_jobs table lives with the engine's schema
// The demo seed already owns ids 1..N — insert with unique phones and look up the real ids.
run("INSERT OR IGNORE INTO customers(phone,name,area) VALUES('01099988877','سعاد عميلة','المهندسين')");
run("INSERT OR IGNORE INTO customers(phone,name,area) VALUES('01099988888','حنان عميلة','الدقي')");
const suadId = get("SELECT id FROM customers WHERE phone = ?", '01099988877').id;
const hananId = get("SELECT id FROM customers WHERE phone = ?", '01099988888').id;
run("INSERT INTO orders(code,customer_id,channel,status,promise_date,created_at,updated_at) VALUES('MV-2601-001'," + suadId + ",'whatsapp','sewing','${y(3)}','2026-01-05','2026-01-06')");
run("INSERT INTO orders(code,customer_id,channel,status,promise_date,created_at,updated_at) VALUES('MV-2601-002'," + hananId + ",'facebook','confirmed','${y(1)}','2026-01-04','2026-01-05')");
run("INSERT INTO orders(code,customer_id,channel,status,promise_date,created_at,updated_at) VALUES('MV-2601-003'," + hananId + ",'online','ready',NULL,'2026-01-06','2026-01-06')");
const suadOrderId = get("SELECT id FROM orders WHERE code = ?", 'MV-2601-001').id;
run("INSERT INTO office_jobs(id,idempotency_key,request_hash,kind,employee_id,visibility,subject_type,subject_ref,subject_snapshot_hash,payload,status,revision,result,created_by,created_at,updated_at) VALUES('tb-reply-1','ik-tb-1','h','customer_reply_draft','user:1','owner','order','" + suadOrderId + "','h','{}','approved',1,?,'user:1'," + Date.now() + "," + Date.now() + ")", JSON.stringify({ title: 'رد على سؤال العميلة سعاد', text: 'مساء الخير سعاد 🌷 طلبك تحت التجهيز وهنوصلك بالتحديث أول ما يبدأ التغليف.' }));
console.log('FILL-OK');
`;
  const fillPath = path.join(tmpDir, 'fill.js');
  fs.writeFileSync(fillPath, fill);
  const filled = spawnSync(process.execPath, [fillPath], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(filled.status, 0, filled.stderr);
  assert.ok(filled.stdout.includes('FILL-OK'));

  const PORT = 3086;
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
    const staffRes = await api('GET', '/today-board', staffT);
    assert.strictEqual(staffRes.status, 403, 'staff must never see the owner board');
    const res = await api('GET', '/today-board', ownerT);
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    const items = body.items;
    const late = items.filter((it) => it.category === 'late_order');
    const dep = items.filter((it) => it.category === 'no_deposit');
    const replies = items.filter((it) => it.category === 'ready_reply');
    assert.ok(late.length >= 2, 'both late orders must appear, got: ' + JSON.stringify(late.map((l) => l.order_code)));
    const first = late.find((it) => it.order_code === 'MV-2601-001');
    assert.ok(first, 'the 3-day-late order must be present');
    assert.strictEqual(first.days_late, 3, 'days_late must be computed from promise_date');
    assert.ok(first.text.includes('MV-2601-001'), 'the draft must name the real order code');
    assert.ok(first.text.includes('سعاد'), 'the draft must use the real customer name');
    assert.strictEqual(first.wa_phone, '201099988877', 'Egyptian 01xxxxxxxxx must normalize to 20xxxxxxxxx');
    const second = late.find((it) => it.order_code === 'MV-2601-002');
    assert.ok(second, 'the 1-day-late order must be present');
    assert.strictEqual(second.wa_phone, '201099988888', 'the second customer phone must normalize too');
    assert.ok(dep.some((it) => it.order_code === 'MV-2601-003'), 'the payment-less order must show in the deposit group');
    assert.strictEqual(dep.filter((it) => it.order_code === 'MV-2601-003').length, 1, 'orders already present in the late group are not duplicated');
    assert.ok(dep.every((it) => it.text.includes('عربون')), 'the deposit draft must mention the deposit');
    const reply = replies.find((it) => it.id === 'reply-tb-reply-1');
    assert.ok(reply, 'the approved unused reply must appear');
    assert.ok(reply.text.includes('تحت التجهيز'), 'the ready reply keeps its approved draft text');
    assert.ok(items.every((it) => it.id && typeof it.text === 'string' && it.text.length > 0), 'every row carries a usable draft');
  } finally {
    child.kill('SIGKILL');
  }

  console.log('TODAY-BOARD-OK');
});
