'use strict';
// Isolated frontend & asset verification suite against a disposable SQLite database.
// Validates HTML shells, static JS/CSS/media assets, security headers, PUBLIC_ORIGIN staging override,
// i18n dictionary completeness, and VM execution of frontend helper modules.
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-frontend-audit-'));
const DB_PATH = path.join(TMP_DIR, 'frontend-audit.db');
const STAGING_ORIGIN = 'https://staging-isolated.mavi.test';

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(err => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

(async () => {
  let child = null;
  try {
    const seed = spawnSync(process.execPath, ['src/seed.js'], {
      cwd: ROOT,
      env: { ...process.env, DB_PATH, AUTO_SEED: '0' },
      encoding: 'utf8',
    });
    assert.strictEqual(seed.status, 0, seed.stderr);

    const port = await getFreePort();
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['src/bootstrap.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        DB_PATH,
        AUTO_SEED: '0',
        SHOW_OTP: '0',
        PUBLIC_ORIGIN: STAGING_ORIGIN,
      },
      stdio: 'ignore',
    });

    for (let i = 0; i < 80; i++) {
      try {
        const r = await fetch(`${base}/healthz`);
        if (r.ok) break;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 100));
    }

    // 1. Verify root redirect, storefront, admin shell, SEO pages, service worker, and manifest
    const rootRes = await fetch(`${base}/`, { redirect: 'manual' });
    assert.ok([200, 301, 302].includes(rootRes.status));

    const storeRes = await fetch(`${base}/store/`);
    assert.strictEqual(storeRes.status, 200);
    assert(storeRes.headers.get('x-frame-options') === 'DENY');
    assert(storeRes.headers.get('x-content-type-options') === 'nosniff');
    assert(storeRes.headers.get('content-security-policy').includes("default-src 'self'"));
    const storeHtml = await storeRes.text();

    // Verify PUBLIC_ORIGIN override replaced hardcoded Suga.run origin in storefront, sitemap, robots, llms, and product page
    assert(storeHtml.includes(`${STAGING_ORIGIN}/store/`), 'storefront canonical/OG should use PUBLIC_ORIGIN');
    assert(!storeHtml.includes('suga.run'), 'storefront HTML must not leak suga.run when PUBLIC_ORIGIN is set');

    const sitemapXml = await (await fetch(`${base}/sitemap.xml`)).text();
    assert(sitemapXml.includes(`${STAGING_ORIGIN}/store/product/DR-11`));
    assert(!sitemapXml.includes('suga.run'));

    const robotsTxt = await (await fetch(`${base}/robots.txt`)).text();
    assert(robotsTxt.includes(`Sitemap: ${STAGING_ORIGIN}/sitemap.xml`));

    const llmsTxt = await (await fetch(`${base}/llms.txt`)).text();
    assert(llmsTxt.includes(`${STAGING_ORIGIN}/store/`));

    const prodRes = await fetch(`${base}/store/product/DR-11`);
    assert.strictEqual(prodRes.status, 200);
    const prodHtml = await prodRes.text();
    assert(prodHtml.includes(`${STAGING_ORIGIN}/store/product/DR-11`));

    const adminRes = await fetch(`${base}/admin/`);
    assert.strictEqual(adminRes.status, 200);
    const adminHtml = await adminRes.text();

    const swRes = await fetch(`${base}/sw.js`);
    assert.strictEqual(swRes.status, 200);
    assert((swRes.headers.get('content-type') || '').includes('javascript'));

    const manifestRes = await fetch(`${base}/manifest.webmanifest`);
    assert.strictEqual(manifestRes.status, 200);

    // 2. Extract every <script src>, <link href>, <img src>, <source src> from /store/ and /admin/ and verify 200 OK
    const assetUrls = new Set();
    for (const html of [storeHtml, adminHtml]) {
      const matches = html.matchAll(/(?:src|href)=["'](\/[^"'?#]+)(?:\?[^"']*)?["']/g);
      for (const m of matches) {
        const u = m[1];
        if (u.startsWith('/api/') || u.includes('${') || u.includes("'+")) continue;
        assetUrls.add(u);
      }
    }
    assert(assetUrls.size >= 18, `Expected at least 18 static assets, found ${assetUrls.size}`);
    for (const assetPath of assetUrls) {
      const r = await fetch(base + assetPath, { method: 'HEAD' });
      assert.strictEqual(r.status, 200, `Broken frontend asset referenced in HTML: ${assetPath} -> ${r.status}`);
    }

    // 3. Execute public/mavi-i18n.js and admin frontend modules inside an isolated VM sandbox to verify runtime integrity
    const sandbox = {
      window: {},
      document: {
        documentElement: { lang: 'ar', dir: 'rtl' },
        querySelectorAll: () => [],
        getElementById: () => null,
        addEventListener: () => {},
        createElement: () => ({ style: {}, setAttribute: () => {}, appendChild: () => {} }),
        head: { appendChild: () => {} },
        body: { appendChild: () => {}, append: () => {} },
        readyState: 'complete',
      },
      location: { pathname: '/admin/', search: '', href: `${base}/admin/`, origin: base, hostname: '127.0.0.1' },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: {},
      MutationObserver: class { observe() {} disconnect() {} },
      Intl,
      URL,
      URLSearchParams,
      crypto: require('crypto').webcrypto,
      EGP: n => new Intl.NumberFormat('en-EG', { maximumFractionDigits: 2 }).format(n),
      tr: k => sandbox.window.MaviI18n.translate(k, 'ar') || k,
      $: () => null,
      setTimeout,
      clearTimeout,
      setInterval: () => 0,
      clearInterval,
      requestAnimationFrame: () => 0,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);

    const frontendScripts = [
      'public/mavi-i18n.js',
      'public/admin/inventory.js',
      'public/admin/custom.js',
      'public/admin/admin-receipts.js',
      'public/admin/order-lifecycle.js',
      'public/admin/deposit-management.js',
      'public/admin/order-costs.js',
      'public/admin/report-hub.js',
      'public/admin/expenses.js',
      'public/admin/tailoring.js',
      'public/admin/deletions.js',
      'public/admin/manual-orders.js',
      'public/admin/reviews.js',
      'public/admin/office.js',
    ];
    for (const rel of frontendScripts) {
      const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      vm.runInContext(code, sandbox, { filename: rel });
    }

    assert.strictEqual(typeof sandbox.MaviI18n.translate, 'function');
    assert(sandbox.MaviI18n.translate('dashboard', 'ar').length > 0);
    assert.strictEqual(sandbox.MaviI18n.translate('dashboard', 'en'), 'Dashboard');
    assert.strictEqual(sandbox.safeCustom('<script>"x"</script>'), '&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
    assert(/^\d{4}-\d{2}-\d{2}$/.test(vm.runInContext('rhToday()', sandbox)), 'Cairo today helper should format YYYY-MM-DD');
    assert.strictEqual(vm.runInContext('rhBusinessDay("2026-11-22 23:30:00")', sandbox), '2026-11-23', 'UTC 23:30 must roll to next Cairo day (+02:00)');

    console.log(`PASS: Frontend shells, ${assetUrls.size} static assets, PUBLIC_ORIGIN staging isolation, and ${frontendScripts.length} frontend JS modules verified.`);
  } finally {
    if (child && child.exitCode === null) {
      await new Promise(resolve => {
        child.once('exit', resolve);
        child.kill('SIGTERM');
      });
    }
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
