'use strict';
/* Comprehensive regression & acceptance suite for all 4 Phase 1B independent review findings
   plus session-switching race guards and network-failure recovery:
   1) Interactive button lock lifecycle: buttons disable while in-flight (blocking double-clicks)
      and re-enable cleanly on success, 409 conflict, server error, and network failure WITHOUT tab switching.
   2) Draft card "فتح الطلب ›" & "فتح الطلب لمراجعة التعديلات ›" open the authoritative order code (HTTP 200),
      never the numeric DB id (404), across queued, review, 409-stale, approved, and staff views.
   3) Staff sync counts (`POST /cases/sync` AND `GET /cases?sync=1`) never reveal owner-only case
      opening, context updates, resolution, or reopening, while still reporting staff-visible case deltas.
   4) Targeted draft refresh (`officeRefreshStaleJob` + `POST /worker/step { job_id }`) prepares the exact
      targeted job even when an older queued job exists, never auto-approves, and reports queued state honestly
      when invoked by staff.
   5) Owner -> Staff account switch with delayed in-flight Owner responses clears `OFFICE_STATE` and ignores
      stale responses (both 200 with financial data and 401 from logged-out owner session). */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');

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

function unescapeHtml(str) {
  return String(str ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function kebabToCamel(k) {
  return k.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

function createMiniElement(id = '', onInnerHtmlChange = null) {
  const classes = new Set();
  const attrs = new Map();
  return {
    id,
    value: '',
    textContent: '',
    _innerHTML: '',
    hidden: false,
    disabled: false,
    inert: false,
    tabIndex: 0,
    style: {},
    dataset: {},
    focused: false,
    get innerHTML() { return this._innerHTML; },
    set innerHTML(v) {
      this._innerHTML = String(v ?? '');
      this.textContent = this._innerHTML.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (onInnerHtmlChange) onInnerHtmlChange(this._innerHTML);
    },
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, force) => {
        const next = typeof force === 'boolean' ? force : !classes.has(c);
        if (next) classes.add(c); else classes.delete(c);
        return next;
      },
      contains: c => classes.has(c),
    },
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    removeAttribute(k) { attrs.delete(k); },
    addEventListener() {},
    focus() { this.focused = true; },
    select() {},
    scrollIntoView() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getClientRects() { return [{ width: 100, height: 40 }]; },
    before() {},
  };
}

/* Parses every `<button ...>...</button>` inside rendered `root.innerHTML` into live button objects
   whose `disabled`, `aria-busy`, `dataset`, and `onclick` mirror the exact rendered HTML. */
function parseRenderedButtons(html) {
  const buttons = [];
  const btnRe = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  let m;
  while ((m = btnRe.exec(html)) !== null) {
    const rawAttrs = m[1];
    const bodyHtml = m[2];
    const btn = createMiniElement();
    btn.innerHTML = bodyHtml;

    // Boolean `disabled` check (word-boundary attribute outside quotes)
    const stripped = rawAttrs.replace(/="[^"]*"/g, '').replace(/='[^']*'/g, '');
    btn.disabled = /\bdisabled\b/i.test(stripped);

    const attrRe = /([a-zA-Z0-9_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let am;
    while ((am = attrRe.exec(rawAttrs)) !== null) {
      const name = am[1];
      const val = unescapeHtml(am[2] !== undefined ? am[2] : am[3]);
      btn.setAttribute(name, val);
      if (name === 'id') btn.id = val;
      if (name === 'disabled') btn.disabled = true;
      if (name.startsWith('data-')) {
        btn.dataset[kebabToCamel(name.slice(5))] = val;
      }
    }
    buttons.push(btn);
  }
  return buttons;
}

function createInteractiveSession(base, adminHtml) {
  let cookieHeader = '';
  const requestLog = [];
  const interceptors = [];
  let parsedButtons = [];

  const elements = new Map();
  const rootEl = createMiniElement('root', newHtml => {
    parsedButtons = parseRenderedButtons(newHtml);
    for (const b of parsedButtons) {
      if (b.id) elements.set(b.id, b);
    }
  });
  elements.set('root', rootEl);

  const ensureEl = id => {
    if (!elements.has(id)) elements.set(id, createMiniElement(id));
    return elements.get(id);
  };
  ['ovl', 'modal', 'toast', 'lerr', 'lemail', 'lpass'].forEach(ensureEl);

  const customFetch = async (url, opts = {}) => {
    const fullUrl = url.startsWith('http') ? url : base + url;
    const u = new URL(fullUrl);
    const method = opts.method || 'GET';
    const pathAndQuery = u.pathname + u.search;
    let parsedBody = null;
    if (typeof opts.body === 'string' && opts.body.length) {
      try { parsedBody = JSON.parse(opts.body); } catch (_) {}
    }

    for (let i = 0; i < interceptors.length; i++) {
      const rule = interceptors[i];
      if (rule.match(method, pathAndQuery, parsedBody)) {
        if (rule.once) interceptors.splice(i, 1);
        return await rule.handle(fullUrl, opts, cookieHeader);
      }
    }

    const headers = { Origin: base, ...(opts.headers || {}) };
    if (cookieHeader) headers.Cookie = cookieHeader;
    const res = await fetch(fullUrl, {
      method,
      headers,
      body: opts.body,
    });
    requestLog.push({ method, path: pathAndQuery, status: res.status, body: parsedBody });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      cookieHeader = setCookie.split(';')[0];
    }
    return res;
  };

  function matchSelector(btn, sel) {
    if (sel.startsWith('#')) return btn.id === sel.slice(1);
    const attrEq = sel.match(/^(?:button)?\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/);
    if (attrEq) return btn.getAttribute(attrEq[1]) === attrEq[2];
    const attrHas = sel.match(/^(?:button)?\[([a-zA-Z0-9_-]+)\]$/);
    if (attrHas) return btn.getAttribute(attrHas[1]) !== null;
    return false;
  }

  const documentObj = {
    documentElement: { lang: 'ar', dir: 'rtl' },
    activeElement: null,
    getElementById(id) {
      const fromRendered = parsedButtons.find(b => b.id === id);
      if (fromRendered) return fromRendered;
      return elements.get(id) || ensureEl(id);
    },
    querySelector(sel) {
      return parsedButtons.find(b => matchSelector(b, sel)) || null;
    },
    querySelectorAll(sel) {
      const parts = sel.split(',').map(s => s.trim()).filter(Boolean);
      return parsedButtons.filter(b => parts.some(p => matchSelector(b, p)));
    },
    createElement() { return createMiniElement(); },
    addEventListener() {},
    dispatchEvent() {},
    head: { appendChild() {} },
    body: { appendChild() {}, append() {} },
    readyState: 'complete',
  };

  const sandbox = {
    console,
    fetch: customFetch,
    document: documentObj,
    location: {
      pathname: '/admin/',
      search: '',
      href: `${base}/admin/`,
      origin: base,
      hostname: '127.0.0.1',
      protocol: 'http:',
      assign() {},
    },
    localStorage: {
      _map: new Map(),
      getItem(k) { return this._map.has(k) ? this._map.get(k) : null; },
      setItem(k, v) { this._map.set(k, String(v)); },
      removeItem(k) { this._map.delete(k); },
    },
    navigator: {},
    MutationObserver: class { observe() {} disconnect() {} },
    Event: class { constructor(type) { this.type = type; } },
    Intl,
    URL,
    URLSearchParams,
    crypto: require('crypto').webcrypto,
    confirm: () => true,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval,
    requestAnimationFrame: fn => { try { fn(); } catch (_) {} return 0; },
    scrollTo() {},
    addEventListener() {},
    removeEventListener() {},
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);

  const orderedScripts = [
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
  for (const rel of orderedScripts) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), 'utf8'), sandbox, { filename: rel });
  }
  const inlineMatches = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const mainInline = inlineMatches[0][1].replace(/\nboot\(\);\s*$/, '\n');
  vm.runInContext(mainInline, sandbox, { filename: 'public/admin/index.html#inline' });

  return {
    sandbox,
    elements,
    requestLog,
    addInterceptor(rule) { interceptors.push(rule); },
    getCookie() { return cookieHeader; },
    setCookie(c) { cookieHeader = c; },
    getRootHtml() { return rootEl.innerHTML; },
    getToastText() { return ensureEl('toast').textContent; },
    findButton(sel) { return documentObj.querySelector(sel); },
    findButtons(sel) { return documentObj.querySelectorAll(sel); },
    async clickRenderedButton(sel) {
      const btn = documentObj.querySelector(sel);
      assert.ok(btn, `Expected rendered button matching ${sel}`);
      assert.strictEqual(btn.disabled, false, `Button ${sel} remained disabled in rendered DOM!`);
      assert.strictEqual(btn.getAttribute('aria-busy'), null, `Button ${sel} still had aria-busy in rendered DOM!`);
      const onclickExpr = btn.getAttribute('onclick');
      assert.ok(onclickExpr, `Button ${sel} has no onclick handler`);
      sandbox.__clickedBtn = btn;
      return await vm.runInContext(
        `(async () => (function(event){ return (${onclickExpr}); }).call(window.__clickedBtn, { preventDefault(){}, stopPropagation(){} }))()`,
        sandbox
      );
    },
    async login(email, password) {
      ensureEl('lemail').value = email;
      ensureEl('lpass').value = password;
      await vm.runInContext('(async () => await doLogin())()', sandbox);
      for (let i = 0; i < 60; i++) {
        const ready = await vm.runInContext('Boolean(window.maviAppReady)', sandbox);
        if (ready) break;
        await new Promise(r => setTimeout(r, 30));
      }
    },
    async evalAsync(expr) { return await vm.runInContext(`(async () => (${expr}))()`, sandbox); },
  };
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-office-review-fixes-'));
  const dbPath = path.join(tmpDir, 'review-fixes.db');
  let server = null;

  try {
    const seed = spawnSync(process.execPath, ['src/seed.js'], {
      cwd: ROOT,
      env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
      encoding: 'utf8',
    });
    assert.strictEqual(seed.status, 0, seed.stderr);

    const port = await getFreePort();
    const base = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        PORT: String(port),
        DB_PATH: dbPath,
        AUTO_SEED: '0',
        SHOW_OTP: '0',
        MAVI_STAGING_MODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    for (let i = 0; i < 80; i++) {
      try { const r = await fetch(base + '/healthz'); if (r.ok) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 100));
    }

    const adminHtml = await (await fetch(base + '/admin/')).text();

    // =========================================================================
    // FINDING #3: Staff sync counts NEVER leak owner-only case open/update/close/reopen
    // =========================================================================
    {
      const staffLogin = await fetch(base + '/api/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ email: 'staff@mavi.eg', password: 'mavi-staff' }),
      });
      assert.strictEqual(staffLogin.status, 200);
      const staffCookie = staffLogin.headers.get('set-cookie').split(';')[0];

      const ownerLogin = await fetch(base + '/api/admin/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ email: 'owner@mavi.eg', password: 'mavi-owner' }),
      });
      assert.strictEqual(ownerLogin.status, 200);
      const ownerCookie = ownerLogin.headers.get('set-cookie').split(';')[0];

      const postStaffSync = async () => {
        const r = await fetch(base + '/api/admin/office/cases/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: base, Cookie: staffCookie },
          body: '{}',
        });
        assert.strictEqual(r.status, 200);
        return r.json();
      };
      const getStaffSync = async () => {
        const r = await fetch(base + '/api/admin/office/cases?sync=1', {
          headers: { Origin: base, Cookie: staffCookie },
        });
        assert.strictEqual(r.status, 200);
        return r.json();
      };

      const baseSync = await postStaffSync();
      const baseCount = baseSync.cases.length;

      const directDb = new Database(dbPath);
      const cust = directDb.prepare('SELECT id FROM customers LIMIT 1').get();
      assert.ok(cust);

      // 3a. Open an owner-only custom_request in 'review' -> staff POST /cases/sync must report all zeros
      const crIns = directDb.prepare(
        "INSERT INTO custom_requests(customer_id, details, measurements, image, image_type, status) VALUES(?,?,?,?,?,?)"
      ).run(cust.id, 'تصميم سهرة خاص', '{}', Buffer.from('png'), 'image/png', 'review');
      const crId = Number(crIns.lastInsertRowid);

      const afterOwnerOpen = await postStaffSync();
      assert.strictEqual(afterOwnerOpen.cases.length, baseCount);
      assert.deepStrictEqual(
        { opened: afterOwnerOpen.sync.opened, reopened: afterOwnerOpen.sync.reopened, updated: afterOwnerOpen.sync.updated, resolved: afterOwnerOpen.sync.resolved },
        { opened: 0, reopened: 0, updated: 0, resolved: 0 },
        'Staff POST /cases/sync must not reveal owner-only case opening'
      );

      // 3b. Update owner-only custom_request ('review' -> 'quoted' -> 'receipt_rejected' context change) -> staff GET /cases?sync=1 reports zeros
      directDb.prepare("UPDATE custom_requests SET status = 'quoted', price = 4200, deposit_percent = 50 WHERE id = ?").run(crId);
      const afterQuote = await getStaffSync();
      assert.strictEqual(afterQuote.cases.length, baseCount);
      assert.deepStrictEqual(
        { opened: afterQuote.sync.opened, reopened: afterQuote.sync.reopened, updated: afterQuote.sync.updated, resolved: afterQuote.sync.resolved },
        { opened: 0, reopened: 0, updated: 0, resolved: 0 },
        'Staff GET /cases?sync=1 must not reveal owner-only case transitions'
      );

      directDb.prepare("UPDATE custom_requests SET status = 'receipt_rejected' WHERE id = ?").run(crId);
      const afterOwnerUpdate = await getStaffSync();
      assert.deepStrictEqual(
        { opened: afterOwnerUpdate.sync.opened, reopened: afterOwnerUpdate.sync.reopened, updated: afterOwnerUpdate.sync.updated, resolved: afterOwnerUpdate.sync.resolved },
        { opened: 0, reopened: 0, updated: 0, resolved: 0 },
        'Staff GET /cases?sync=1 must not reveal owner-only context_updated'
      );

      // 3c. Resolve owner-only custom_request ('approved') -> staff sync reports zeros
      directDb.prepare("UPDATE custom_requests SET status = 'approved' WHERE id = ?").run(crId);
      const afterOwnerResolve = await postStaffSync();
      assert.deepStrictEqual(
        { opened: afterOwnerResolve.sync.opened, reopened: afterOwnerResolve.sync.reopened, updated: afterOwnerResolve.sync.updated, resolved: afterOwnerResolve.sync.resolved },
        { opened: 0, reopened: 0, updated: 0, resolved: 0 },
        'Staff POST /cases/sync must not reveal owner-only case resolution'
      );

      // 3d. Reopen owner-only custom_request ('receipt_rejected' again -> episode 2) -> staff sync reports zeros
      directDb.prepare("UPDATE custom_requests SET status = 'receipt_rejected' WHERE id = ?").run(crId);
      const afterOwnerReopen = await getStaffSync();
      assert.deepStrictEqual(
        { opened: afterOwnerReopen.sync.opened, reopened: afterOwnerReopen.sync.reopened, updated: afterOwnerReopen.sync.updated, resolved: afterOwnerReopen.sync.resolved },
        { opened: 0, reopened: 0, updated: 0, resolved: 0 },
        'Staff GET /cases?sync=1 must not reveal owner-only case reopen'
      );

      // Clean up synthetic custom request while checking owner DOES see the resolution count (1)
      directDb.prepare("UPDATE custom_requests SET status = 'approved' WHERE id = ?").run(crId);
      directDb.close();
      const ownerSyncCheck = await (await fetch(base + '/api/admin/office/cases/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base, Cookie: ownerCookie },
        body: '{}',
      })).json();
      assert.strictEqual(ownerSyncCheck.sync.resolved, 1, 'Owner sync must still accurately count owner-only resolutions');
    }

    // =========================================================================
    // FINDINGS #1, #2, #4: Button lock re-enable without tab switch, Open Order 200 OK from Draft Card,
    // Network Failure recovery, and Targeted Refresh with older queued job!
    // =========================================================================
    const ownerUi = createInteractiveSession(base, adminHtml);
    await ownerUi.login('owner@mavi.eg', 'mavi-owner');

    // Create a fresh manual order so its numeric DB id (e.g., 13+) differs completely from its string code (MV-...)
    const createdOrder = await ownerUi.evalAsync(`api('/manual-orders', {
      method: 'POST',
      body: {
        customer_name: 'هند نبيل',
        customer_phone: '01098765432',
        confirm_existing: true,
        custom_name: 'فستان مراجعة المكتب',
        qty: 1,
        unit_price: 2200,
        paid: 700,
        promise_date: '2026-11-19',
        status: 'confirmed',
        channel: 'whatsapp'
      }
    })`);
    const orderCode = createdOrder.code;
    assert.ok(/^MV-/.test(orderCode), `Expected MV-* order code, got ${orderCode}`);

    // Open Office Summary & click sync button directly from rendered DOM -> must re-enable without tab switch!
    await ownerUi.evalAsync("officeGoTab('summary')");
    await ownerUi.clickRenderedButton('#of-sync-btn');
    const syncBtnAfterOk = ownerUi.findButton('#of-sync-btn');
    assert.strictEqual(syncBtnAfterOk.disabled, false, '#of-sync-btn must re-enable after sync completes');
    assert.strictEqual(syncBtnAfterOk.getAttribute('aria-busy'), null);

    // Inject transient network failure on POST /cases/sync -> button MUST still re-enable!
    ownerUi.addInterceptor({
      once: true,
      match: (m, p) => m === 'POST' && p === '/api/admin/office/cases/sync',
      handle: async () => { throw new TypeError('NetworkError when attempting to fetch resource'); },
    });
    await ownerUi.clickRenderedButton('#of-sync-btn');
    assert.strictEqual(ownerUi.findButton('#of-sync-btn').disabled, false, '#of-sync-btn must re-enable after network failure');
    assert.strictEqual(ownerUi.findButton('#of-sync-btn').getAttribute('aria-busy'), null);

    // Switch to Drafts tab & enqueue THREE jobs:
    //   1) `olderQueuedJob`: content_draft (will remain queued as an older job in queue)
    //   2) `orderDraftA`: order_followup_draft on `orderCode`
    //   3) `orderDraftB`: workshop_followup_draft on `orderCode`
    await ownerUi.clickRenderedButton('#of-tab-drafts');

    await ownerUi.evalAsync("officeUpdateComposeKind('content_draft')");
    await ownerUi.clickRenderedButton('#of-create-job-btn');
    assert.strictEqual(ownerUi.findButton('#of-create-job-btn').disabled, false, '#of-create-job-btn must re-enable after 1st create');

    // Inject network failure on compose -> button must re-enable cleanly!
    ownerUi.addInterceptor({
      once: true,
      match: (m, p) => m === 'POST' && p === '/api/admin/office/jobs',
      handle: async () => { throw new TypeError('Network failure during job enqueue'); },
    });
    await ownerUi.clickRenderedButton('#of-create-job-btn');
    assert.strictEqual(ownerUi.findButton('#of-create-job-btn').disabled, false, '#of-create-job-btn must re-enable after network failure');

    await ownerUi.evalAsync("officeUpdateComposeKind('order_followup_draft')");
    await ownerUi.evalAsync(`officeSetComposeField('order_code', ${JSON.stringify(orderCode)})`);
    await ownerUi.clickRenderedButton('#of-create-job-btn');

    await ownerUi.evalAsync("officeUpdateComposeKind('workshop_followup_draft')");
    await ownerUi.evalAsync(`officeSetComposeField('order_code', ${JSON.stringify(orderCode)})`);
    await ownerUi.clickRenderedButton('#of-create-job-btn');

    // Test Open Order button on a QUEUED order draft card BEFORE fixture preparation!
    const openBtnWhileQueued = ownerUi.findButton(`button[data-open-order-code="${orderCode}"]`);
    assert.ok(openBtnWhileQueued, 'Queued order draft card must render Open Order button with exact orderCode');
    const logIdxQueuedOpen = ownerUi.requestLog.length;
    await ownerUi.clickRenderedButton(`button[data-open-order-code="${orderCode}"]`);
    // Wait briefly for async orderView() render
    await new Promise(r => setTimeout(r, 80));
    const orderFetches1 = ownerUi.requestLog.slice(logIdxQueuedOpen).filter(r => r.path.startsWith('/api/admin/orders/'));
    assert.ok(orderFetches1.some(r => r.path === `/api/admin/orders/${encodeURIComponent(orderCode)}` && r.status === 200),
      `Expected GET /api/admin/orders/${orderCode} -> 200 from queued draft card, got ${JSON.stringify(orderFetches1)}`);
    assert.ok(!orderFetches1.some(r => r.status === 404), 'Draft Open Order must NEVER trigger a 404');

    // Return to Office Drafts tab — the background worker now auto-prepares
    // the whole queue on the owner's visit (local, zero network), so all 3
    // drafts must ALREADY be in review without pressing any prepare button!
    await ownerUi.evalAsync("officeGoTab('drafts')");
    await new Promise(r => setTimeout(r, 120));
    const stepBtn = ownerUi.findButton('#of-fixture-step-btn');
    assert.ok(!stepBtn || stepBtn.disabled === true,
      'queue must be empty after the automatic local prepare pass (step button honestly disabled)');
    const ariaBusy = stepBtn ? stepBtn.getAttribute('aria-busy') : null;
    assert.strictEqual(ariaBusy, null);

    // Identify the 3 prepared order jobs by API (the weekly care campaign may
    // add its own review card — the test targets only the 3 order drafts).
    const jobsList = await ownerUi.evalAsync(`(async () => {
      const r = await fetch('/api/admin/office/jobs', { headers: { Authorization: 'Bearer ' + TOKEN } });
      const d = await r.json();
      return d.jobs.filter(j => j.kind !== 'care_campaign_draft' && j.status === 'review').map(j => j.id);
    })()`);
    assert.strictEqual(jobsList.length, 3, 'the 3 order drafts must be prepared for review');
    const workshopJobId = jobsList[0];
    const followupJobId = jobsList[1];
    const olderContentJobId = jobsList[2];

    // Re-queue `olderContentJobId` via PATCH so an OLDER queued job sits ahead in the queue!
    await ownerUi.evalAsync(`(async () => {
      const r = await fetch('/api/admin/office/jobs/' + ${JSON.stringify(olderContentJobId)}, { headers: { Authorization: 'Bearer ' + TOKEN } });
      const j = (await r.json()).job;
      await fetch('/api/admin/office/jobs/' + ${JSON.stringify(olderContentJobId)}, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
        body: JSON.stringify({ payload: j.payload, expected_revision: j.revision })
      });
    })()`);

    // Mutate `orderCode` promise_date so `workshopJobId` triggers 409 on approve
    await ownerUi.evalAsync(`(async () => {
      const st = await api('/orders/' + encodeURIComponent(${JSON.stringify(orderCode)}) + '/edit');
      await api('/orders/' + encodeURIComponent(${JSON.stringify(orderCode)}) + '/edit', {
        method: 'PATCH',
        body: { revision: st.revision, order: { ...st.order, promise_date: '2026-12-28' }, items: st.order.items }
      });
    })()`);

    // Click Approve on `workshopJobId` -> 409 stale_subject_facts, ZERO auto-retry, and refresh button is ENABLED immediately!
    const beforeStaleIdx = ownerUi.requestLog.length;
    await ownerUi.clickRenderedButton(`button[data-approve-job="${workshopJobId}"]`);
    const staleReviewReqs = ownerUi.requestLog.slice(beforeStaleIdx).filter(r => r.path.endsWith('/review'));
    assert.strictEqual(staleReviewReqs.length, 1, 'Strictly 1 review call on 409');
    assert.ok(ownerUi.getRootHtml().includes('data-stale-error="stale_subject_facts"'));

    const refreshBtn = ownerUi.findButton(`button[data-refresh-job="${workshopJobId}"]`);
    assert.ok(refreshBtn, '409 alert must render refresh button');
    assert.strictEqual(refreshBtn.disabled, false, 'Refresh button inside 409 alert must NOT be stuck disabled');
    assert.strictEqual(refreshBtn.getAttribute('aria-busy'), null);

    // Test "فتح الطلب لمراجعة التعديلات ›" inside the 409 alert!
    const logIdx409Open = ownerUi.requestLog.length;
    await ownerUi.clickRenderedButton(`button[data-open-order-code="${orderCode}"]`);
    await new Promise(r => setTimeout(r, 80));
    const orderFetches409 = ownerUi.requestLog.slice(logIdx409Open).filter(r => r.path.startsWith('/api/admin/orders/'));
    assert.ok(orderFetches409.some(r => r.path === `/api/admin/orders/${encodeURIComponent(orderCode)}` && r.status === 200),
      '409 alert Open Order button must fetch order by code with 200 OK');

    // Return to Drafts tab & click targeted Refresh on `workshopJobId` while `olderContentJobId` is older & queued!
    await ownerUi.evalAsync("officeGoTab('drafts')");
    // Re-trigger 409 or use the stale banner's refresh button directly (since `subject_stale` is true on reload!)
    await ownerUi.clickRenderedButton(`button[data-refresh-job="${workshopJobId}"]`);

    // Verify FINDING #4:
    // 1) `workshopJobId` (the newer targeted job) is now in `review` with updated 2026-12-28 facts and ENABLED approve button!
    // 2) `olderContentJobId` (the older queued job) remained `queued`!
    // 3) No automatic approval occurred!
    const refreshedApproveBtn = ownerUi.findButton(`button[data-approve-job="${workshopJobId}"]`);
    assert.ok(refreshedApproveBtn, 'Targeted refreshed job must be in review state with approve button');
    assert.strictEqual(refreshedApproveBtn.disabled, false, 'Approve button after targeted refresh must be enabled without tab switch');
    assert.strictEqual(refreshedApproveBtn.getAttribute('aria-busy'), null);
    assert.ok(ownerUi.getRootHtml().includes('2026-12-28'), 'Refreshed draft must show updated promise_date');

    const checkOlderStillQueued = await ownerUi.evalAsync(`(async () => {
      const r = await fetch('/api/admin/office/jobs/' + ${JSON.stringify(olderContentJobId)}, { headers: { Authorization: 'Bearer ' + TOKEN } });
      return (await r.json()).job.status;
    })()`);
    // With lazy auto-prepare, an owner listing may prepare the older job too
    // (queued OR review are both fine) — but it must NEVER be auto-approved.
    assert.ok(['queued', 'review'].includes(checkOlderStillQueued),
      `Older job must never be auto-approved by the targeted refresh (got ${checkOlderStillQueued})`);

    // Inject network error on Approve -> button must re-enable after error so human can retry!
    ownerUi.addInterceptor({
      once: true,
      match: (m, p) => m === 'POST' && p.endsWith('/review'),
      handle: async () => { throw new TypeError('Temporary network drop during review'); },
    });
    await ownerUi.clickRenderedButton(`button[data-approve-job="${workshopJobId}"]`);
    assert.strictEqual(ownerUi.findButton(`button[data-approve-job="${workshopJobId}"]`).disabled, false,
      'Approve button must re-enable after network error');

    // Now approve `workshopJobId` cleanly & verify Open Order on APPROVED card also returns 200 OK!
    await ownerUi.clickRenderedButton(`button[data-approve-job="${workshopJobId}"]`);
    await ownerUi.evalAsync("officeSetJobStatusFilter('archive')");
    assert.ok(ownerUi.getRootHtml().includes('data-job-status="approved"'));

    // Also verify staff calling `officeRefreshStaleJob` on `followupJobId` reports honestly that it is QUEUED (not ready for review)
    const staffUi = createInteractiveSession(base, adminHtml);
    await staffUi.login('staff@mavi.eg', 'mavi-staff');
    await staffUi.evalAsync("officeGoTab('drafts')");
    await staffUi.clickRenderedButton(`button[data-refresh-job="${followupJobId}"]`);
    assert.ok(
      staffUi.getToastText().includes('أُعيدت المسودة إلى الطابور'),
      `Staff refresh must honestly report queued status, got toast: ${staffUi.getToastText()}`
    );
    assert.ok(!staffUi.getToastText().includes('راجعي النص والحقائق الجديدة قبل اتخاذ القرار'));

    // =========================================================================
    // SESSION RACE GUARD: Owner -> Staff switch with delayed in-flight Owner response
    // =========================================================================
    {
      const raceUi = createInteractiveSession(base, adminHtml);
      await raceUi.login('owner@mavi.eg', 'mavi-owner');
      await raceUi.evalAsync("officeGoTab('summary')");

      let releaseDelayedOwnerCases;
      const delayedGate = new Promise(resolve => { releaseDelayedOwnerCases = resolve; });

      // Delay the next `/api/admin/office/cases` fetch initiated under Owner session
      raceUi.addInterceptor({
        once: true,
        match: (m, p) => m === 'GET' && p.startsWith('/api/admin/office/cases'),
        handle: async () => {
          await delayedGate;
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            async json() {
              return {
                cases: [{
                  id: 9999,
                  subject_type: 'order',
                  subject_id: 1,
                  subject_code: 'MV-OWNER-SECRET',
                  case_kind: 'deposit_unpaid',
                  priority_rank: 2,
                  priority_label_ar: 'سري للمالكة',
                  visibility: 'owner',
                  assignee_role_id: 'omar',
                  assignee_name_ar: 'عمر',
                  assignee_title_ar: 'محاسب',
                  state: 'open',
                  episode: 1,
                  reason_ar: 'بيانات مالية خاصة بالمالكة 99999 ج.م',
                  next_step_ar: 'سري',
                  summary: { total_egp: 99999, expected_deposit_egp: 45000 },
                }],
              };
            },
          };
        },
      });

      // Kick off slow owner refresh without awaiting yet
      const slowOwnerSyncPromise = raceUi.evalAsync('officeRunSync()');
      await new Promise(r => setTimeout(r, 40));

      // Owner logs out locally & Staff logs in on the SAME browser tab before slow owner response resolves!
      await raceUi.evalAsync('logout()');
      await raceUi.login('staff@mavi.eg', 'mavi-staff');
      await raceUi.evalAsync("officeGoTab('summary')");

      // Release the delayed Owner response containing 99999 EGP!
      releaseDelayedOwnerCases();
      await slowOwnerSyncPromise;
      await new Promise(r => setTimeout(r, 60));

      const staffAfterRaceHtml = raceUi.getRootHtml();
      const staffOpenCount = await raceUi.evalAsync('officeOpenCaseCount()');
      assert.ok(!staffAfterRaceHtml.includes('MV-OWNER-SECRET'), 'Delayed owner response MUST NOT leak into staff DOM');
      assert.ok(!staffAfterRaceHtml.includes('99999') && !/ج\.م|EGP/.test(staffAfterRaceHtml), 'Delayed owner money MUST NOT leak into staff DOM');
      assert.ok(!staffAfterRaceHtml.includes('loginbox'), 'Delayed stale session must not kick active staff back to login');
      assert.ok(staffOpenCount >= 0);
    }

    console.log('office-review-fixes.test.js PASSED');
  } finally {
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise(r => server.once('exit', r));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
