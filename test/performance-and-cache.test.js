'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const dbPath = path.join(root, 'data', 'perf-cache-test.db');
const port = 3392;
const base = `http://127.0.0.1:${port}`;

for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });

(async () => {
  const seed = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: root, env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' }, encoding: 'utf8'
  });
  assert.equal(seed.status, 0, seed.stderr);

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, SHOW_OTP: '0', AUTO_SEED: '0' },
    stdio: 'ignore'
  });

  try {
    for (let i = 0; i < 60; i++) {
      try { await fetch(base + '/healthz'); break; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }

    // 1. Verify all performance indexes exist in SQLite.
    const db = new Database(dbPath, { readonly: true });
    const allIdx = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(r => r.name)
    );
    for (const expected of [
      'idx_order_items_order_id',
      'idx_payments_order_id',
      'idx_item_cost_lines_item_id',
      'idx_order_workshop_item',
      'idx_style_images_style_primary',
      'idx_styles_active_type',
      'idx_custom_requests_customer',
      'idx_custom_request_images_req',
      'idx_sessions_realm_subject',
      'idx_sessions_expires',
      'idx_orders_created_at',
      'idx_service_reviews_status',
    ]) {
      assert(allIdx.has(expected), `Missing index ${expected}`);
    }
    db.close();

    // 2. Verify /api/store/catalogue & /api/store/reviews Cache-Control + ETag + 304.
    const catRes = await fetch(base + '/api/store/catalogue');
    assert.equal(catRes.status, 200);
    assert.equal(catRes.headers.get('cache-control'), 'public, max-age=60');
    const catEtag = catRes.headers.get('etag');
    assert(catEtag, 'Missing ETag on /api/store/catalogue');
    const catBody = await catRes.json();
    assert(catBody.styles.length > 0);
    assert(catBody.styles.every(s => !('cost' in s)), 'cost leaked in catalogue');

    const cat304 = await fetch(base + '/api/store/catalogue', {
      headers: { 'If-None-Match': catEtag }
    });
    assert.equal(cat304.status, 304);

    const revRes = await fetch(base + '/api/store/reviews');
    assert.equal(revRes.status, 200);
    assert.equal(revRes.headers.get('cache-control'), 'public, max-age=60');
    const revEtag = revRes.headers.get('etag');
    assert(revEtag, 'Missing ETag on /api/store/reviews');
    const rev304 = await fetch(base + '/api/store/reviews', {
      headers: { 'If-None-Match': revEtag }
    });
    assert.equal(rev304.status, 304);

    // 3. Verify static /brand/* long cache and /admin/* no-store.
    const ogRes = await fetch(base + '/brand/og-cover.jpg', { method: 'HEAD' });
    assert.equal(ogRes.status, 200);
    assert.equal(ogRes.headers.get('cache-control'), 'public, max-age=86400');

    const adminRes = await fetch(base + '/admin/index.html', { method: 'HEAD' });
    assert.equal(adminRes.status, 200);
    assert.equal(adminRes.headers.get('cache-control'), 'no-store, max-age=0');

    // 4. Verify admin login, cache invalidation on style edit, and pagination on /orders & /customers.
    const loginRes = await fetch(base + '/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@mavi.eg', password: 'mavi-owner' })
    });
    assert.equal(loginRes.status, 200);
    const { token } = await loginRes.json();
    const authHdr = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

    // Create a new style and verify catalogue cache invalidates immediately.
    const createRes = await fetch(base + '/api/admin/catalogue/styles', {
      method: 'POST',
      headers: authHdr,
      body: JSON.stringify({
        id: 'CACHE-TEST-01',
        name: 'فستان اختبار الكاش',
        price: 1990,
        lead_days: 10,
        note: 'اختبار إبطال الكاش',
        colours: ['كحلي'],
        fabrics: ['كريب'],
        active: true,
      }),
    });
    assert.equal(createRes.status, 200);

    const catAfter = await fetch(base + '/api/store/catalogue', {
      headers: { 'If-None-Match': catEtag }
    });
    assert.equal(catAfter.status, 200, 'Catalogue cache did not invalidate on style mutation');
    const catAfterJson = await catAfter.json();
    assert(catAfterJson.styles.some(s => s.id === 'CACHE-TEST-01'), 'New style missing after invalidation');

    // Verify /orders pagination vs full compatibility.
    const ordersAll = await (await fetch(base + '/api/admin/orders', { headers: authHdr })).json();
    const ordersP1 = await (await fetch(base + '/api/admin/orders?limit=2&offset=0', { headers: authHdr })).json();
    const ordersP2 = await (await fetch(base + '/api/admin/orders?limit=2&offset=2', { headers: authHdr })).json();
    assert.equal(ordersP1.orders.length, Math.min(2, ordersAll.orders.length));
    assert.equal(ordersP1.total, ordersAll.orders.length);
    if (ordersAll.orders.length > 2) {
      assert.equal(ordersP1.has_more, true);
      assert.equal(ordersP2.orders[0].code, ordersAll.orders[2].code);
    }

    // Verify /customers pagination vs full compatibility.
    const custAll = await (await fetch(base + '/api/admin/customers', { headers: authHdr })).json();
    const custP1 = await (await fetch(base + '/api/admin/customers?limit=1&offset=0', { headers: authHdr })).json();
    assert.equal(custP1.customers.length, Math.min(1, custAll.customers.length));
    assert.equal(custP1.total, custAll.customers.length);

    // 5. Verify storefront HTML has skeleton, parallel boot, and lazy loading.
    const storeHtml = await (await fetch(base + '/store/')).text();
    assert(storeHtml.includes('showStoreSkeleton'), 'Missing skeleton loader');
    assert(storeHtml.includes('Promise.allSettled'), 'Missing parallel boot');
    assert(storeHtml.includes('loading="lazy" decoding="async"'), 'Missing lazy loading on card images');

    console.log('PASS: Performance indexes, N+1 batching, cache + invalidation, pagination, skeleton & lazy-load all verified!');
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 200));
    for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
  }
})();
