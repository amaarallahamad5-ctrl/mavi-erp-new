'use strict';
/* Admin manual orders with multiple dresses per order:
   - items array accepted (catalogue style + off-catalogue custom mixed)
   - totals computed server-side from the item rows; paid can never exceed subtotal+shipping
   - legacy single-item fields still work; validation errors return clear Arabic messages */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const PORT = 3059;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitPort(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.status < 502) return; } catch (_) { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

test('Manual orders: multiple dresses in one order (admin)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-multi-'));
  const dbPath = path.join(tmpDir, 'multi.db');
  const seeded = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
  });
  assert.strictEqual(seeded.status, 0, 'seed must succeed');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT, env: { ...process.env, DB_PATH: dbPath, PORT: String(PORT) }, stdio: 'ignore',
  });
  try {
    await waitPort(`${BASE}/store/`);
    const login = await fetch(`${BASE}/api/admin/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@mavi.eg', password: 'mavi-owner' }),
    });
    const token = (await login.json()).token;
    const H = { 'Content-Type': 'application/json', 'X-Mavi-Token': token };

    // 1. Two dresses in one order: catalogue + off-catalogue custom
    let r = await fetch(`${BASE}/api/admin/manual-orders`, {
      method: 'POST', headers: H,
      body: JSON.stringify({
        customer_name: 'عميلة متعددة', customer_phone: '01200000009', channel: 'whatsapp',
        items: [
          { style_id: 'DR-04', colour: 'أسود', qty: 1, unit_price: 850 },
          { custom_name: 'بدلة شتوية منفصلة', qty: 2, unit_price: 1200 },
        ],
        paid: 500, shipping_fee: 60, governorate: 'الجيزة',
      }),
    });
    assert.strictEqual(r.status, 201);
    const created = await r.json();
    assert.strictEqual(created.items_count, 2);

    // Verify DB rows + server-computed total (850*1 + 1200*2 + 60 shipping = 3310)
    const verify = spawnSync(process.execPath, ['-e', `
      process.env.DB_PATH = ${JSON.stringify(dbPath)};
      const db = require('./src/db');
      const o = db.get('SELECT id, code FROM orders ORDER BY id DESC LIMIT 1');
      const items = db.all('SELECT style_id, description, qty, unit_price FROM order_items WHERE order_id=?', o.id);
      const assert = require('assert');
      assert.strictEqual(items.length, 2);
      assert.strictEqual(items[0].style_id, 'DR-04');
      assert.strictEqual(items[1].style_id, 'MANUAL-CUSTOM');
      assert.strictEqual(items[1].description, 'بدلة شتوية منفصلة');
      const t = require('./src/domain').orderTotals(o.id);
      assert.strictEqual(t.total, 3310);
      console.log('ROWS-OK');
    `], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
    assert.ok(verify.stdout.includes('ROWS-OK'), (verify.stderr || '') + verify.stdout);

    // 2. Item with neither model nor description -> rejected
    r = await fetch(`${BASE}/api/admin/manual-orders`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ customer_name: 'x', customer_phone: '01200000009', channel: 'whatsapp', items: [{ qty: 1, unit_price: 100 }] }),
    });
    assert.strictEqual(r.status, 400);

    // 3. Paid exceeding items+shipping -> rejected
    r = await fetch(`${BASE}/api/admin/manual-orders`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ customer_name: 'عميلة تانية', customer_phone: '01200000011', channel: 'whatsapp', items: [{ style_id: 'DR-04', qty: 1, unit_price: 100 }], paid: 99999 }),
    });
    assert.strictEqual(r.status, 400);

    // 4. Legacy single-item body still works (backward compatible)
    r = await fetch(`${BASE}/api/admin/manual-orders`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ customer_name: 'عميلة عادية', customer_phone: '01200000012', channel: 'walkin', style_id: 'DR-04', colour: 'أسود', qty: 1, unit_price: 850, paid: 0 }),
    });
    assert.strictEqual(r.status, 201, 'legacy single-item manual order must still work');
  } finally {
    child.kill('SIGKILL');
  }
  console.log('manual-order-multi-item.test.js PASSED');
});
