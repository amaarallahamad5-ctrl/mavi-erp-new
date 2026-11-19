'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const Database = require('better-sqlite3');

const root = path.join(__dirname, '..');
const dbPath = path.join(root, 'data', 'seo-measurements-test.db');
const port = 3391;
const base = `http://127.0.0.1:${port}`;

for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });

(async () => {
  // 1. Verify additive shoulder migration preserves legacy database rows.
  const seed = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: root, env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' }, encoding: 'utf8'
  });
  assert.equal(seed.status, 0, seed.stderr);
  const legacyDb = new Database(dbPath);
  legacyDb.pragma('foreign_keys = OFF');
  legacyDb.exec('ALTER TABLE measurements DROP COLUMN shoulder;');
  const beforeRow = legacyDb.prepare('SELECT customer_id, waist, hip, bust, length, sleeve, arm FROM measurements ORDER BY customer_id LIMIT 1').get();
  legacyDb.close();

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

    // Migration kept legacy measurements intact and added nullable shoulder column.
    const migratedDb = new Database(dbPath, { readonly: true });
    const cols = migratedDb.pragma('table_info(measurements)').map(c => c.name);
    assert(cols.includes('shoulder'), 'shoulder column missing after migration');
    const afterRow = migratedDb.prepare('SELECT customer_id, waist, hip, bust, length, sleeve, arm, shoulder FROM measurements WHERE customer_id = ?').get(beforeRow.customer_id);
    assert.deepEqual(
      { customer_id: afterRow.customer_id, waist: afterRow.waist, hip: afterRow.hip, bust: afterRow.bust, length: afterRow.length, sleeve: afterRow.sleeve, arm: afterRow.arm },
      beforeRow
    );
    assert.equal(afterRow.shoulder, null);
    migratedDb.close();

    // 2. Verify robots.txt, llms.txt, static OG/WebP/video assets & CSP.
    const robots = await (await fetch(base + '/robots.txt')).text();
    assert(robots.includes('Disallow: /admin/'));
    assert(robots.includes('Disallow: /api/'));
    assert(robots.includes('Allow: /api/catalogue/images/'));
    assert(robots.includes('Allow: /api/store/catalogue$'));
    assert(robots.includes('Allow: /api/store/collections$'));
    assert(robots.includes('Allow: /api/store/reviews$'));
    assert(robots.includes('Sitemap: https://'));

    const llmsRes = await fetch(base + '/llms.txt');
    assert.equal(llmsRes.status, 200);
    const llms = await llmsRes.text();
    assert(llms.includes('# MAVI'));
    assert(!llms.includes('ماڤي'));
    assert(llms.includes('/store/custom-design'));
    assert(llms.includes('/store/returns'));

    const ogRes = await fetch(base + '/brand/og-cover.jpg');
    assert.equal(ogRes.status, 200);
    assert(ogRes.headers.get('content-type').includes('image/jpeg'));

    const emblemWebp = await fetch(base + '/brand/emblem_small.webp');
    assert.equal(emblemWebp.status, 200);
    assert(emblemWebp.headers.get('content-type').includes('image/webp'));

    const videoRes = await fetch(base + '/brand/measurements-guide.mp4', { method: 'HEAD' });
    assert.equal(videoRes.status, 200);
    assert(Number(videoRes.headers.get('content-length')) > 100000);

    // 3. Verify sitemap.xml dynamically lists seeded made styles and zero bogus ?lang=en links.
    const sitemapRes = await fetch(base + '/sitemap.xml');
    assert.equal(sitemapRes.status, 200);
    const sitemap = await sitemapRes.text();
    assert(sitemap.includes('/store/custom-design'));
    assert(sitemap.includes('/store/returns'));
    assert(sitemap.includes('/store/product/SK-01'));
    assert(sitemap.includes('/store/product/DR-11'));
    assert(!sitemap.includes('DRESS1'));
    assert(!sitemap.includes('?lang=en'));

    // 4. Verify storefront HTML metadata, JSON-LD, video embed, CSP media-src, and no fbq.
    const storeRes = await fetch(base + '/store/');
    assert.equal(storeRes.status, 200);
    assert(storeRes.headers.get('content-security-policy').includes("media-src 'self'"));
    const storeHtml = await storeRes.text();
    assert(!storeHtml.includes('ماڤي'));
    assert(!storeHtml.includes('fbq'));
    assert(storeHtml.includes('/brand/og-cover.jpg'));
    assert(storeHtml.includes('summary_large_image'));
    assert(storeHtml.includes('/brand/measurements-guide.mp4'));
    assert(storeHtml.includes('m_shoulder') || storeHtml.includes("['shoulder',tr('shoulder_width')]"));
    const storeLdMatch = storeHtml.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    assert(storeLdMatch, 'missing store JSON-LD');
    const storeLd = JSON.parse(storeLdMatch[1]);
    const types = storeLd['@graph'].map(n => n['@type']);
    assert(types.includes('ClothingStore') && types.includes('FAQPage') && types.includes('HowTo') && types.includes('VideoObject'));
    const howTo = storeLd['@graph'].find(n => n['@type'] === 'HowTo');
    assert.equal(howTo.step.length, 7);
    assert(howTo.step.some(s => s.name.includes('عرض الكتف')));

    // 5. Verify /store/custom-design and /store/returns JSON-LD and content.
    for (const p of ['/store/custom-design', '/store/returns']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200);
      const html = await r.text();
      assert(!html.includes('ماڤي'));
      assert(html.includes('/brand/og-cover.jpg'));
      const m = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
      assert(m, `missing JSON-LD on ${p}`);
      JSON.parse(m[1]);
    }
    const cdHtml = await (await fetch(base + '/store/custom-design')).text();
    assert(cdHtml.includes('عرض الكتف'));
    assert(cdHtml.includes('/brand/measurements-guide.mp4'));
    assert(cdHtml.includes('preload="none"'));

    // 6. Verify /api/store/me/measurements saves and returns shoulder + keeps legacy compatibility.
    const loginRes = await fetch(base + '/api/store/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: '01012345678', password: 'mavi1234' })
    });
    assert.equal(loginRes.status, 200);
    const cookie = loginRes.headers.get('set-cookie').split(';')[0];

    const putMeas = await fetch(base + '/api/store/me/measurements', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ waist: 88, hip: 102, bust: 96, shoulder: 41, length: 142, sleeve: 59, arm: 31 })
    });
    assert.equal(putMeas.status, 200);
    const measJson = await putMeas.json();
    assert.equal(measJson.measurements.shoulder, 41);

    const badShoulder = await fetch(base + '/api/store/me/measurements', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ waist: 88, hip: 102, bust: 96, shoulder: 10, length: 142 })
    });
    assert.equal(badShoulder.status, 400);

    console.log('PASS: SEO, llms.txt, dynamic sitemap, JSON-LD, OG cover, WebP/video assets, and shoulder measurement tests all passed!');
  } finally {
    child.kill();
    for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
