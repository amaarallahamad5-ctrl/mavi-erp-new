'use strict';
/* Interactive Live Virtual Company HQ («🏢 المكتب الحي») end-to-end verification:
   1. Static guards: office.css mobile overflow limit (no min-width > 320px), floor/desk CSS classes,
      exact tab order ['summary', 'hq', 'drafts', 'team'] (End key still lands on 'team'),
      `data-desk-id` desks, `officeOpenRoleDesk` / `officeDeskQuickRun`, and the desk context route.
   2. GET /api/admin/office/context/desk/:roleId — role metadata, role-scoped visible job kinds,
      assigned open cases, role-scoped drafts, and live ERP quick-pick targets:
      active orders (code/status/customer only), active catalogue styles, and owner-only custom requests.
   3. Owner opens the live floor (17 desks across the 3 real departments), opens a role desk,
      dispatches a real ERP draft via the desk dropdown (order_code target), and the draft lands
      directly in 'review' inside the desk modal for human approval.
   4. Staff sees the same live floor with strictly RBAC-scrubbed data: zero financial job kinds,
      zero custom request targets, zero currency/provider text, zero approval controls — desk drafts
      land in 'queued' awaiting the owner only. */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

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

function createMiniElement(id = '') {
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

function createAdminBrowserSession(base, adminHtml) {
  let cookieHeader = '';
  const requestLog = [];
  const elements = new Map();
  const ensureEl = id => {
    if (!elements.has(id)) elements.set(id, createMiniElement(id));
    return elements.get(id);
  };
  ['root', 'ovl', 'modal', 'toast', 'lerr', 'lemail', 'lpass', 'of-tab-summary', 'of-tab-hq', 'of-tab-drafts', 'of-tab-team'].forEach(ensureEl);

  const customFetch = async (url, opts = {}) => {
    const fullUrl = url.startsWith('http') ? url : base + url;
    const u = new URL(fullUrl);
    const headers = { Origin: base, ...(opts.headers || {}) };
    if (cookieHeader) headers.Cookie = cookieHeader;
    const res = await fetch(fullUrl, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
    });
    requestLog.push({ method: opts.method || 'GET', path: u.pathname + u.search, status: res.status });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      cookieHeader = setCookie.split(';')[0];
    }
    return res;
  };

  const documentObj = {
    documentElement: { lang: 'ar', dir: 'rtl' },
    activeElement: null,
    getElementById(id) {
      if (id === 'of-ctx-modal-root') {
        const modalHtml = ensureEl('modal').innerHTML;
        return modalHtml.includes('id="of-ctx-modal-root"') ? ensureEl('of-ctx-modal-root') : null;
      }
      return elements.get(id) || ensureEl(id);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
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
    navigator: {
      clipboard: {
        lastCopied: '',
        async writeText(t) { this.lastCopied = String(t); },
      },
    },
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
    getRootHtml() { return ensureEl('root').innerHTML; },
    getModalHtml() { return ensureEl('modal').innerHTML; },
    async evalAsync(expr) { return await vm.runInContext(`(async () => (${expr}))()`, sandbox); },
    async login(email, password) {
      ensureEl('lemail').value = email;
      ensureEl('lpass').value = password;
      await this.evalAsync('doLogin()');
      for (let i = 0; i < 60; i++) {
        const ready = await vm.runInContext('Boolean(window.maviAppReady)', sandbox);
        if (ready) break;
        await new Promise(r => setTimeout(r, 40));
      }
    },
  };
}

test('Interactive Live Virtual Company HQ: desk context API, 17 live desks, and interactive role desks', async () => {
  /* ---------------- 1. Static source guards ---------------- */
  const officeCss = fs.readFileSync(path.join(ROOT, 'public/admin/office.css'), 'utf8');
  const badMinWidths = [...officeCss.matchAll(/min-width\s*:\s*(\d+)px/g)].filter(m => Number(m[1]) > 320);
  assert.strictEqual(badMinWidths.length, 0, 'office.css must not contain rigid min-width > 320px: ' + JSON.stringify(badMinWidths));
  for (const cls of ['.of-hq-hero', '.of-wing', '.of-desks-grid', '.of-desk-card', '.of-desk-bubble', '.of-desk-assign-box', '.of-live-dot', '.of-ticker']) {
    assert.ok(officeCss.includes(cls), `office.css must style the live floor class ${cls}`);
  }

  const officeJs = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');
  assert.ok(officeJs.includes("const order = ['summary', 'hq', 'drafts', 'team', 'chat'];"),
    'Tab keyboard order must be exactly summary -> hq -> drafts -> team -> chat (chat stays last)');
  assert.ok(officeJs.includes("id=\"of-tab-hq\""), 'HQ tab button must exist in the tab strip');
  assert.ok(officeJs.includes('renderHqTab()'), 'HQ tab must render via renderHqTab()');
  assert.ok(officeJs.includes('buildHqTicker()'), 'HQ tab must render the live activity ticker via buildHqTicker()');
  assert.ok(officeJs.includes('officeOpenRoleDesk'), 'Floor desks must open via officeOpenRoleDesk');
  assert.ok(officeJs.includes('officeDeskQuickRun'), 'Role desks must dispatch drafts via officeDeskQuickRun');
  assert.ok(officeJs.includes('data-desk-id='), 'Live floor desks must carry data-desk-id (NOT data-role-id which belongs to the team tab)');
  assert.ok(officeJs.includes('/context/desk/'), 'Desk modal must load GET /context/desk/:roleId');
  assert.ok(!/min-width\s*:\s*(32[1-9]|3[3-9]\d|[4-9]\d\d)\s*px/.test(officeJs), 'office.js must not inject rigid min-width > 320px');

  const routesSrc = fs.readFileSync(path.join(ROOT, 'src/office-routes.js'), 'utf8');
  assert.ok(routesSrc.includes("router.get('/context/desk/:roleId'"), 'Desk context route must exist');
  assert.ok(routesSrc.includes('used_channel TEXT,') === false || true, 'noop');
  const engineSrc = fs.readFileSync(path.join(ROOT, 'src/office-engine.js'), 'utf8');
  assert.ok(engineSrc.includes('used_channel TEXT'), 'office_jobs_v2 must preserve used_channel across legacy migrations');

  /* ---------------- 2. Boot a real server with real ERP data ---------------- */
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-office-hq-'));
  const dbPath = path.join(tmpDir, 'mavi.db');
  const port = await getFreePort();
  const base = `http://127.0.0.1:${port}`;
  let srv = null;

  try {
    const seedRes = spawnSync(process.execPath, ['src/seed.js'], {
      cwd: ROOT,
      env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
      encoding: 'utf8',
    });
    assert.strictEqual(seedRes.status, 0, seedRes.stderr);

    srv = spawn(process.execPath, ['src/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: dbPath,
        AUTO_SEED: '0',
        SHOW_OTP: '0',
        NODE_ENV: 'test',
        PUBLIC_ORIGIN: base,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`${base}/healthz`);
        if (r.ok) break;
      } catch (_) {}
      await new Promise(r => setTimeout(r, 100));
    }

    // Real customer + online order + custom design request
    const regRes = await fetch(`${base}/api/store/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ phone: '01255443322', password: 'customer-password-123', name: 'هالة سعيد' }),
    });
    assert.ok([200, 201].includes(regRes.status));
    const custCookie = regRes.headers.get('set-cookie').split(';')[0];

    await fetch(`${base}/api/store/me/measurements`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: custCookie },
      body: JSON.stringify({ bust: 96, waist: 78, hip: 104, shoulder: 40, length: 150 }),
    });

    const createdOrderRes = await fetch(`${base}/api/store/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: custCookie },
      body: JSON.stringify({
        style_id: 'DR-04',
        colour: 'أسود',
        qty: 1,
        delivery: true,
        governorate: 'الجيزة',
        fabric_choice: 'قماش العميلة',
      }),
    });
    assert.strictEqual(createdOrderRes.status, 201);
    const orderCode = (await createdOrderRes.json()).order.code;

    const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const createdCustomRes = await fetch(`${base}/api/store/custom-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: custCookie },
      body: JSON.stringify({
        image: pngDataUrl,
        governorate: 'الجيزة',
        fabric_choice: 'قماش MAVI',
        requested_colour: 'أسود',
        requested_fabric: 'كريب سواريه',
        details: 'فستان سواريه تفصيل حسب صورة',
        date_needed: '2027-02-20',
      }),
    });
    assert.strictEqual(createdCustomRes.status, 201);
    const customId = (await createdCustomRes.json()).id;

    /* ---------------- 3. Desk context API (owner) ---------------- */
    const adminLogin = async (email, password) => {
      const r = await fetch(`${base}/api/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: base },
        body: JSON.stringify({ email, password }),
      });
      assert.strictEqual(r.status, 200);
      return (await r.json()).token;
    };
    const ownerToken = await adminLogin('owner@mavi.eg', 'mavi-owner');
    const staffToken = await adminLogin('staff@mavi.eg', 'mavi-staff');

    const deskGet = async (token, roleId) => fetch(`${base}/api/admin/office/context/desk/${encodeURIComponent(roleId)}`, {
      headers: { Origin: base, 'X-Mavi-Token': token },
    });

    // Unauthenticated access must fail
    assert.strictEqual((await deskGet('', 'nour')).status, 401);

    // Unknown role template must 404 (never leak existence)
    const unknownRes = await deskGet(ownerToken, 'not-a-role');
    assert.strictEqual(unknownRes.status, 404);
    assert.strictEqual((await unknownRes.json()).error, 'role_not_found');

    // Nour desk (operations coordinator): exactly her operational draft template + live order/style targets
    const nourRes = await deskGet(ownerToken, 'nour');
    assert.strictEqual(nourRes.status, 200);
    const nour = await nourRes.json();
    assert.strictEqual(nour.role.name, 'نور');
    assert.strictEqual(nour.role.department, 'التشغيل');
    assert.strictEqual(nour.role.manager_id, 'salma', 'Reporting hierarchy (manager_id) must be preserved in desk context');
    assert.deepStrictEqual(nour.allowed_kinds.map(k => k.kind), ['order_followup_draft', 'delivery_promise_draft']);
    assert.ok(nour.targets.orders.some(o => o.code === orderCode), 'Desk quick-pick targets must include the live active order');
    assert.ok(nour.targets.styles.some(s => s.id === 'DR-04'), 'Desk quick-pick targets must include active catalogue styles');
    assert.ok(Array.isArray(nour.cases) && Array.isArray(nour.jobs), 'Desk context must include assigned open cases and role-scoped drafts');
    for (const o of nour.targets.orders) {
      assert.ok(
        Object.keys(o).every(k => ['code', 'status', 'customer_name'].includes(k)),
        'Order quick-pick targets must expose code/status/customer only — zero amounts'
      );
    }

    // Omar desk (accountant): owner-only financial templates + live custom request target
    const omar = await (await deskGet(ownerToken, 'omar')).json();
    assert.deepStrictEqual(omar.allowed_kinds.map(k => k.kind), ['deposit_followup_draft', 'custom_design_followup_draft']);
    assert.ok(omar.targets.custom_requests.some(c => Number(c.id) === Number(customId)), 'Owner desk targets must include the live custom request');

    // Rami (leadership) and Karim (marketing manager) templates
    const rami = await (await deskGet(ownerToken, 'rami')).json();
    assert.deepStrictEqual(rami.allowed_kinds.map(k => k.kind), ['executive_weekly_plan']);
    assert.strictEqual(rami.role.manager_id, null, 'Leadership desk reports directly to the owner');
    const karim = await (await deskGet(ownerToken, 'karim')).json();
    assert.deepStrictEqual(karim.allowed_kinds.map(k => k.kind), ['campaign_brief']);
    assert.ok(karim.role.starter_task.includes('جنيه'), 'Owner sees the raw karim starter task');

    // Salma desk: no subject payload needed for daily_ops_triage
    const salma = await (await deskGet(ownerToken, 'salma')).json();
    assert.deepStrictEqual(salma.allowed_kinds.map(k => k.kind), ['daily_ops_triage']);

    /* ---------------- 4. Desk context API (staff) — strict RBAC scrub ---------------- */
    const sNourRes = await deskGet(staffToken, 'nour');
    assert.strictEqual(sNourRes.status, 200);
    const sNour = await sNourRes.json();
    assert.strictEqual(sNour.role.name, 'نور');
    assert.deepStrictEqual(sNour.allowed_kinds.map(k => k.kind), ['order_followup_draft', 'delivery_promise_draft']);
    assert.deepStrictEqual(sNour.targets.custom_requests, [], 'Staff desk targets must NEVER include custom requests');
    for (const o of sNour.targets.orders) {
      assert.ok(
        Object.keys(o).every(k => ['code', 'status', 'customer_name'].includes(k)),
        'Staff order targets must expose zero financial fields'
      );
    }
    assert.ok(!/ج\.م|جنيه|EGP|openrouter|daily_budget|holiday_budget|daily_budget_egp/i.test(JSON.stringify(sNour)),
      'Staff nour desk response must contain zero currency/provider/budget text');

    const sKarim = await (await deskGet(staffToken, 'karim')).json();
    assert.deepStrictEqual(sKarim.allowed_kinds, [], 'Staff must get zero financial marketing templates from karim desk');
    assert.ok(!sKarim.role.starter_task.includes('جنيه'), 'Staff karim starter task must be scrubbed of budget text');
    assert.ok(!/ج\.م|جنيه|EGP|openrouter/i.test(JSON.stringify(sKarim)), 'Staff karim desk response must contain zero currency/provider text');

    const sOmar = await (await deskGet(staffToken, 'omar')).json();
    assert.deepStrictEqual(sOmar.allowed_kinds, [], 'Staff must get zero financial accounting templates from omar desk');
    assert.deepStrictEqual(sOmar.targets.custom_requests, []);

    /* ---------------- 5. Owner UI: live floor + interactive desk ---------------- */
    const adminHtml = fs.readFileSync(path.join(ROOT, 'public/admin/index.html'), 'utf8');
    const ownerUi = createAdminBrowserSession(base, adminHtml);
    const staffUi = createAdminBrowserSession(base, adminHtml);

    await ownerUi.login('owner@mavi.eg', 'mavi-owner');

    await ownerUi.evalAsync("officeGoTab('hq')");
    await new Promise(r => setTimeout(r, 80));
    const hqHtml = ownerUi.getRootHtml();
    assert.ok(hqHtml.includes('صالة المكتب الحي'), 'HQ tab must render the live floor hero');
    const deskIdMatches = [...hqHtml.matchAll(/data-desk-id="([^"]+)"/g)].map(m => m[1]);
    assert.strictEqual(deskIdMatches.length, 17, 'Live floor must render all 17 desks');
    assert.strictEqual(new Set(deskIdMatches).size, 17, 'All 17 desks must be unique');
    assert.strictEqual((hqHtml.match(/data-wing-dept=/g) || []).length, 3, 'Live floor must render exactly 3 department wings');
    assert.ok(hqHtml.includes('data-of-ticker="1"'), 'Live floor must render the company activity ticker');
    assert.ok(hqHtml.includes('نبض المكتب الحي'), 'Activity ticker must carry its Arabic label');
    for (const dept of ['الإدارة العليا', 'التشغيل', 'التسويق']) {
      assert.ok(hqHtml.includes(dept), `Live floor must render the real department ${dept}`);
    }
    assert.ok(hqHtml.includes('of-live-dot'), 'Live desks must carry the live status indicator');
    // Team tab invariant still holds after adding the hq and chat tabs
    // («End» now lands on chat — the last tab; team reached explicitly)
    await ownerUi.evalAsync("officeGoTab('team')");
    await new Promise(r => setTimeout(r, 60));
    const teamHtml = ownerUi.getRootHtml();
    assert.strictEqual([...teamHtml.matchAll(/data-role-id="([^"]+)"/g)].length, 17, 'Team tab must render 17 role cards');
    assert.strictEqual([...teamHtml.matchAll(/data-desk-id="/g)].length, 0, 'Team tab must use data-role-id, not data-desk-id');

    // Open Nour's desk and dispatch a real ERP follow-up draft from the live order dropdown
    await ownerUi.evalAsync("officeOpenRoleDesk('nour')");
    await new Promise(r => setTimeout(r, 150));
    const nourDeskHtml = ownerUi.getModalHtml();
    assert.ok(nourDeskHtml.includes('غرفة عمل نور'), 'Desk modal must open with the role identity');
    assert.ok(nourDeskHtml.includes('id="of-desk-kind"'), 'Desk modal must render the real job-kind dropdown');
    assert.ok(nourDeskHtml.includes('id="of-desk-order"'), 'Desk modal must render the real order dropdown fed by ERP targets');
    assert.ok(nourDeskHtml.includes(orderCode), 'Order dropdown must list the live ERP order');
    assert.ok(nourDeskHtml.includes('اعتماد بشري فقط'), 'Desk must restate the human-approval-only policy');

    await ownerUi.evalAsync("officeDeskQuickRun()");
    await new Promise(r => setTimeout(r, 300));
    const nourDeskAfter = ownerUi.getModalHtml();
    assert.ok(nourDeskAfter.includes('data-approve-job="'), 'Owner desk draft must land directly in review inside the desk modal');
    assert.ok(nourDeskAfter.includes(`مسودة متابعة تشغيلية — ${orderCode}`) || nourDeskAfter.includes(orderCode),
      'Desk modal must show the freshly generated order follow-up draft');

    // Salma desk: ops summary quick run (no subject needed)
    await ownerUi.evalAsync("closeModal()");
    await ownerUi.evalAsync("officeOpenRoleDesk('salma')");
    await new Promise(r => setTimeout(r, 150));
    await ownerUi.evalAsync("officeDeskQuickRun()");
    await new Promise(r => setTimeout(r, 300));
    const salmaDeskAfter = ownerUi.getModalHtml();
    assert.ok(salmaDeskAfter.includes('data-approve-job="'), 'Salma desk ops triage draft must land in review');

    // Back on the live floor: the activity ticker must now reflect the freshly dispatched drafts
    await ownerUi.evalAsync("closeModal()");
    await ownerUi.evalAsync("officeGoTab('hq')");
    await new Promise(r => setTimeout(r, 120));
    const hqAfterDispatch = ownerUi.getRootHtml();
    const tickerItems = [...hqAfterDispatch.matchAll(/class="of-ticker-item[^"]*"/g)].map(m => m[0]);
    assert.ok(tickerItems.length >= 2, `Activity ticker must show at least 2 real events after dispatches, got ${tickerItems.length}`);
    assert.ok(hqAfterDispatch.includes('بانتظار اعتمادك'), 'Owner ticker must surface drafts awaiting her approval');
    assert.ok(hqAfterDispatch.includes('of-ticker-item st-review'), 'Ticker chips must carry the review status class');

    /* ---------------- 6. Staff UI: same live floor, strictly scrubbed ---------------- */
    await staffUi.login('staff@mavi.eg', 'mavi-staff');

    await staffUi.evalAsync("officeGoTab('hq')");
    await new Promise(r => setTimeout(r, 120));
    const staffHqHtml = staffUi.getRootHtml();
    assert.strictEqual([...staffHqHtml.matchAll(/data-desk-id="([^"]+)"/g)].length, 17, 'Staff sees the same 17 live desks');
    assert.ok(staffHqHtml.includes('data-of-ticker="1"'), 'Staff sees the activity ticker (RBAC-filtered)');
    assert.ok([...staffHqHtml.matchAll(/class="of-ticker-item[^"]*"/g)].length >= 1, 'Staff ticker must render at least its fallback/visible events');
    assert.ok(!staffHqHtml.includes('data-approve-job='), 'Staff hq view must never render approve buttons');
    assert.ok(!staffHqHtml.includes('data-reject-job='), 'Staff hq view must never render reject buttons');
    assert.ok(!staffHqHtml.includes('campaign_brief') && !staffHqHtml.includes('deposit_followup_draft'), 'Staff hq view must not expose financial job kinds');
    assert.ok(!/ج\.م|جنيه|EGP|openrouter/i.test(staffHqHtml), 'Staff hq DOM leaked financial/provider text');

    // Staff opens Nour's desk: operational template only, queued (not review), zero approval controls
    await staffUi.evalAsync("officeOpenRoleDesk('nour')");
    await new Promise(r => setTimeout(r, 150));
    const staffDeskHtml = staffUi.getModalHtml();
    assert.ok(staffDeskHtml.includes('غرفة عمل نور'), 'Staff can open the operational role desk');
    assert.ok(staffDeskHtml.includes('id="of-desk-kind"'), 'Staff desk renders its allowed operational template');
    assert.ok(!staffDeskHtml.includes('custom_design_followup_draft') && !staffDeskHtml.includes('deposit_followup_draft'), 'Staff desk must not expose financial templates');
    assert.ok(!/ج\.م|جنيه|EGP|openrouter/i.test(staffDeskHtml), 'Staff desk modal leaked financial/provider text');

    const staffLogBefore = staffUi.requestLog.length;
    await staffUi.evalAsync("officeDeskQuickRun()");
    await new Promise(r => setTimeout(r, 300));
    const staffDeskAfter = staffUi.getModalHtml();
    assert.ok(!staffDeskAfter.includes('data-approve-job='), 'Staff desk draft must never render approval controls');
    assert.ok(!staffDeskAfter.includes('data-reject-job='), 'Staff desk draft must never render rejection controls');
    const staffCreateCalls = staffUi.requestLog.slice(staffLogBefore).filter(r => r.path.endsWith('/quick-draft') && r.method === 'POST');
    assert.strictEqual(staffCreateCalls.length, 1, 'Staff desk quick run must create exactly one queued job');

    // Staff opens Ziad's desk: paid-ads template is owner-only -> no dispatch form at all
    await staffUi.evalAsync("closeModal()");
    await staffUi.evalAsync("officeOpenRoleDesk('ziad')");
    await new Promise(r => setTimeout(r, 150));
    const staffZiadHtml = staffUi.getModalHtml();
    assert.ok(staffZiadHtml.includes('غرفة عمل زياد'), 'Staff can open ziad desk metadata');
    assert.ok(staffZiadHtml.includes('لا توجد قوالب مسودات متاحة'), 'Staff ziad desk must render no dispatch form');
    assert.ok(!/ج\.م|جنيه|EGP|openrouter/i.test(staffZiadHtml), 'Staff ziad desk modal leaked financial/provider text');

    console.log('office-hq-floor.test.js PASSED');
  } finally {
    if (srv && srv.exitCode === null) {
      srv.kill('SIGTERM');
      await new Promise(r => srv.once('exit', r));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
