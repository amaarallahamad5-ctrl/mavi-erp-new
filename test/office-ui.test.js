'use strict';
/* End-to-end interactive UI verification for Phase 1B (`/admin/` Office UI):
   - Owner vs Staff views («ملخص يومك», Draft Approvals, 17 Responsibility Templates)
   - Priority ordering, reason, assignee role, and "Open Order" / "Open Custom Request" navigation
   - Stale order modification while draft is open -> 409 conflict without automatic re-approval
   - Double-click decision lock (single HTTP review call)
   - Session expiration (401) -> clean return to login screen with Arabic notice
   - Zero financial / provider / approval controls leaked into Staff DOM
   - Keyboard navigation & mobile CSS overflow guards */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const vm = require('vm');

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
  let delayNextReviewMs = 0;

  const elements = new Map();
  const ensureEl = id => {
    if (!elements.has(id)) elements.set(id, createMiniElement(id));
    return elements.get(id);
  };
  ['root', 'ovl', 'modal', 'toast', 'lerr', 'lemail', 'lpass', 'of-tab-summary', 'of-tab-drafts'].forEach(ensureEl);

  // Track dynamic approve/reject buttons inside rendered HTML so double-click disabling can be inspected
  const dynamicApproveButtons = new Map();

  const customFetch = async (url, opts = {}) => {
    const fullUrl = url.startsWith('http') ? url : base + url;
    const u = new URL(fullUrl);
    requestLog.push({ method: opts.method || 'GET', path: u.pathname + u.search });

    if (delayNextReviewMs > 0 && u.pathname.endsWith('/review')) {
      const wait = delayNextReviewMs;
      delayNextReviewMs = 0;
      await new Promise(r => setTimeout(r, wait));
    }

    const headers = { Origin: base, ...(opts.headers || {}) };
    if (cookieHeader) headers.Cookie = cookieHeader;
    const res = await fetch(fullUrl, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
    });
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
      return elements.get(id) || ensureEl(id);
    },
    querySelector(sel) {
      if (sel === '.app aside' || sel === '.app aside.menu-open') return null;
      return null;
    },
    querySelectorAll(sel) {
      const m = sel.match(/\[data-approve-job="([^"]+)"\]/);
      if (m) {
        const jobId = m[1];
        if (!dynamicApproveButtons.has(jobId)) dynamicApproveButtons.set(jobId, createMiniElement('approve-' + jobId));
        return [dynamicApproveButtons.get(jobId)];
      }
      return [];
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

  // Extract inline main script from public/admin/index.html (excluding boot() auto-fire so we control login deterministically)
  const inlineMatches = [...adminHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  const mainInline = inlineMatches[0][1].replace(/\nboot\(\);\s*$/, '\n');
  vm.runInContext(mainInline, sandbox, { filename: 'public/admin/index.html#inline' });

  return {
    sandbox,
    elements,
    requestLog,
    dynamicApproveButtons,
    setDelayNextReviewMs(ms) { delayNextReviewMs = ms; },
    getCookie() { return cookieHeader; },
    getRootHtml() { return ensureEl('root').innerHTML; },
    async waitReady() {
      for (let i = 0; i < 60; i++) {
        const ready = await vm.runInContext('Boolean(window.maviAppReady)', sandbox);
        if (ready) break;
        await new Promise(r => setTimeout(r, 40));
      }
    },
    async evalAsync(expr) { return await vm.runInContext(`(async () => (${expr}))()`, sandbox); },
  };
}

(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-office-ui-'));
  const dbPath = path.join(tmpDir, 'office-ui.db');
  let server = null;

  try {
    // 0. Static mobile CSS guard: ensure office.css has no rigid min-width > 320px that causes horizontal overflow on mobile
    const officeCss = fs.readFileSync(path.join(ROOT, 'public/admin/office.css'), 'utf8');
    const badMinWidths = [...officeCss.matchAll(/min-width\s*:\s*(\d+)px/g)].filter(m => Number(m[1]) > 320);
    assert.strictEqual(badMinWidths.length, 0, 'office.css must not contain rigid min-width > 320px: ' + JSON.stringify(badMinWidths));

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
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(base + '/healthz'); if (r.ok) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 100));
    }

    // Create a customer + online order so we have deterministic operational & deposit cases as well
    const regRes = await fetch(base + '/api/store/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ phone: '01288990011', password: 'customer-password-123', name: 'سلمى طارق' }),
    });
    assert.ok([200, 201].includes(regRes.status));
    const custCookie = regRes.headers.get('set-cookie').split(';')[0];
    await fetch(base + '/api/store/me/measurements', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: custCookie },
      body: JSON.stringify({ bust: 94, waist: 76, hip: 102, shoulder: 39, length: 148 }),
    });
    const createdOrderRes = await fetch(base + '/api/store/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: custCookie },
      body: JSON.stringify({
        style_id: 'DR-04',
        colour: 'أسود',
        qty: 1,
        delivery: true,
        governorate: 'القاهرة',
        fabric_choice: 'قماش العميلة',
      }),
    });
    assert.strictEqual(createdOrderRes.status, 201);
    const targetOrderCode = (await createdOrderRes.json()).order.code;

    const adminHtml = await (await fetch(base + '/admin/')).text();

    // =========================================================
    // 1. OWNER SESSION: Daily Summary, Order Open Link, Team 17, Draft Review, 409 Stale Guard, Double-Click Lock
    // =========================================================
    const ownerBrowser = createAdminBrowserSession(base, adminHtml);
    ownerBrowser.elements.get('lemail').value = 'owner@mavi.eg';
    ownerBrowser.elements.get('lpass').value = 'mavi-owner';
    await ownerBrowser.evalAsync('doLogin()');
    await ownerBrowser.waitReady();

    // Dashboard renders «ملخص يومك» alongside existing ERP KPIs & recent orders
    const dashHtml = ownerBrowser.getRootHtml();
    assert.ok(dashHtml.includes('ملخص يومك'), 'Dashboard must embed «ملخص يومك»');
    assert.ok(dashHtml.includes('المسؤول:'), 'Daily summary cards must display responsible role: ' + dashHtml.slice(dashHtml.indexOf('<main')));
    assert.ok(dashHtml.includes('فتح الطلب ›'), 'Daily summary cards must display Open Order button');

    // Verify priority sort order in «ملخص يومك»
    await ownerBrowser.evalAsync("officeGoTab('summary')");
    await new Promise(r => setTimeout(r, 40));
    const summaryHtml = ownerBrowser.getRootHtml();
    assert.ok(summaryHtml.includes('ملخص يومك — حالات المتابعة النشطة'));
    const prioRanks = [...summaryHtml.matchAll(/class="of-case-card prio-(\d+)"/g)].map(m => Number(m[1]));
    assert.ok(prioRanks.length >= 1, 'Expected at least 1 active follow-up case');
    for (let i = 1; i < prioRanks.length; i++) {
      assert.ok(prioRanks[i] >= prioRanks[i - 1], `Cases must be sorted by priority rank ascending, got ${prioRanks.join(',')}`);
    }

    // Verify clicking "فتح الطلب" navigates directly into the ERP order detail view for that order!
    await ownerBrowser.evalAsync(`officeOpenSubject('order', 0, ${JSON.stringify(targetOrderCode)})`);
    await new Promise(r => setTimeout(r, 60));
    const orderDetailHtml = ownerBrowser.getRootHtml();
    assert.strictEqual(await ownerBrowser.evalAsync('VIEW'), 'order');
    assert.ok(orderDetailHtml.includes(targetOrderCode), 'Open Order button must load the exact ERP order detail screen');

    // Simplicity shape (owner decision): End lands on the DRAFTS tab (the last
    // tab) — the roles tab and the live-floor tab are gone entirely.
    await ownerBrowser.evalAsync("officeGoTab('summary')");
    await new Promise(r => setTimeout(r, 40));
    await ownerBrowser.evalAsync("officeTabsKeydown({ key: 'End', preventDefault(){} })");
    await new Promise(r => setTimeout(r, 120));
    const draftsTabHtml = ownerBrowser.getRootHtml();
    assert.ok(draftsTabHtml.includes('مسودات جاهزة لقرارك'), 'End key must land on the drafts tab (the last tab)');
    assert.ok(!draftsTabHtml.includes('أدوار الفريق') && !draftsTabHtml.includes('صالة المكتب الحي'), 'no roles / live-floor tab may exist');

    // Navigate to Drafts tab, enqueue two operational drafts, and prepare fixture outputs
    await ownerBrowser.evalAsync("officeSwitchTab('drafts')");
    await new Promise(r => setTimeout(r, 40));
    await ownerBrowser.evalAsync(`officeSetComposeField('kind', 'order_followup_draft')`);
    await ownerBrowser.evalAsync(`officeSetComposeField('order_code', ${JSON.stringify(targetOrderCode)})`);
    await ownerBrowser.evalAsync(`officeSetComposeField('focus', 'schedule')`);
    await ownerBrowser.evalAsync('officeSubmitCompose()');

    await ownerBrowser.evalAsync(`officeSetComposeField('kind', 'workshop_followup_draft')`);
    await ownerBrowser.evalAsync(`officeSetComposeField('order_code', ${JSON.stringify(targetOrderCode)})`);
    await ownerBrowser.evalAsync('officeSubmitCompose()');

    // Run fixture step twice to prepare both drafts for review
    await ownerBrowser.evalAsync('officeRunFixtureStep()');
    await ownerBrowser.evalAsync('officeRunFixtureStep()');

    const draftsHtml = ownerBrowser.getRootHtml();
    // Exact mandatory copy check (the clear decision-request card):
    assert.ok(
      draftsHtml.includes('القرار المطلوب منك'),
      'Draft review screen must explicitly display the «القرار المطلوب منك» decision card'
    );
    assert.ok(
      draftsHtml.includes('✅ اعتماد — المسودة تبقى جاهزة للاستخدام'),
      'Draft review screen must show the human-readable approve button'
    );
    assert.ok(draftsHtml.includes('النسخة #'), 'Draft card must display revision before decision');
    assert.ok(draftsHtml.includes('بصمة النص:'), 'Draft card must display output hash before decision');
    assert.ok(draftsHtml.includes('الحقائق المستخدمة وقت توليد المسودة:'), 'Draft card must display used facts before decision');
    assert.ok(
      draftsHtml.includes('محلية — من بيانات النظام'),
      'Fixture drafts must be clearly marked as prepared from real system data (the AI era is fully retired)'
    );

    const jobIds = [...draftsHtml.matchAll(/data-approve-job="([^"]+)"/g)].map(m => m[1]);
    // The weekly care campaign may add its own review card — the two order
    // drafts under test are the remaining ones, identified via the API.
    const jobsNow = (await (await fetch(`${base}/api/admin/office/jobs`, { headers: { Cookie: ownerBrowser.getCookie() } })).json()).jobs;
    const orderDraftIds = jobsNow.filter(j => j.kind !== 'care_campaign_draft' && j.status === 'review').map(j => j.id);
    assert.strictEqual(orderDraftIds.length, 2, 'Expected 2 reviewable order drafts');
    // Deterministic: the 409/refresh/approve scenario runs on the CUSTOMER-facing
    // follow-up (schedule focus); the workshop checklist takes the double-click test.
    const staleTestJobId = jobsNow.find(j => j.kind === 'order_followup_draft' && j.status === 'review').id;
    const doubleClickJobId = orderDraftIds.find(id => id !== staleTestJobId);

    // ---------------------------------------------------------
    // SCENARIO A: Order changes WHILE draft is open in the UI -> 409 conflict, ZERO automatic re-approval!
    // ---------------------------------------------------------
    const editGetRes = await fetch(`${base}/api/admin/orders/${encodeURIComponent(targetOrderCode)}/edit`, {
      headers: { Origin: base, Cookie: ownerBrowser.getCookie() },
    });
    assert.strictEqual(editGetRes.status, 200);
    const editState = await editGetRes.json();
    const editPatchRes = await fetch(`${base}/api/admin/orders/${encodeURIComponent(targetOrderCode)}/edit`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: ownerBrowser.getCookie() },
      body: JSON.stringify({
        revision: editState.revision,
        order: { ...editState.order, promise_date: '2026-12-24' },
        items: editState.order.items,
      }),
    });
    assert.strictEqual(editPatchRes.status, 200);

    const logBeforeStaleClick = ownerBrowser.requestLog.length;
    await ownerBrowser.evalAsync(`officeDecideJob(${JSON.stringify(staleTestJobId)}, 'approve')`);
    const staleCalls = ownerBrowser.requestLog.slice(logBeforeStaleClick).filter(r => r.path.endsWith('/review'));
    assert.strictEqual(staleCalls.length, 1, 'UI must NEVER automatically retry approval after a 409 response');

    const after409Html = ownerBrowser.getRootHtml();
    assert.ok(after409Html.includes('data-stale-error="stale_subject_facts"'), 'UI must surface explicit stale_subject_facts alert');
    assert.ok(after409Html.includes('لم يتم إعادة الاعتماد تلقائيًا'), 'UI must state clearly that automatic re-approval did not happen');
    assert.ok(after409Html.includes('تحديث المسودة للمراجعة من جديد'), 'UI must prompt owner to refresh and re-review');

    // Manual refresh prepares updated draft in 'review' state (NOT auto-approved!)
    await ownerBrowser.evalAsync(`officeRefreshStaleJob(${JSON.stringify(staleTestJobId)})`);
    const refreshedHtml = ownerBrowser.getRootHtml();
    assert.ok(refreshedHtml.includes('2026-12-24'), 'Refreshed draft must reflect updated promise_date');
    assert.ok(refreshedHtml.includes(`data-approve-job="${staleTestJobId}"`), 'Refreshed draft must remain in review awaiting human decision');

    // Now owner explicitly approves the refreshed draft -> succeeds cleanly!
    await ownerBrowser.evalAsync(`officeDecideJob(${JSON.stringify(staleTestJobId)}, 'approve')`);
    await ownerBrowser.evalAsync("officeSetJobStatusFilter('archive')");
    assert.ok(ownerBrowser.getRootHtml().includes('مسودة معتمدة (محفوظة فقط)'));

    // The owner's RESULTS view: every approved draft lands in «النتائج المعتمدة»
    // with its final text and copy action — she can come back and see it herself.
    await ownerBrowser.evalAsync("officeGoTab('approved')");
    const approvedTabHtml = ownerBrowser.getRootHtml();
    assert.ok(approvedTabHtml.includes('النتائج المعتمدة'), 'approved-results tab must render with its title');
    assert.ok(approvedTabHtml.includes(`data-copy-job="${staleTestJobId}"`), 'approved tab must show the copy action on the approved draft');
    assert.ok(approvedTabHtml.includes('آخر تحديث:'), 'approved cards must show when she decided them');
    await ownerBrowser.evalAsync("officeGoTab('drafts')");

    // Follow-up report: the approved tab summarizes what ACTUALLY happened
    assert.ok(approvedTabHtml.includes('المتابعة الفعلية — ما تم على أرض الواقع'), 'approved tab must carry the follow-up report strip');
    assert.ok(approvedTabHtml.includes('رسايل جاهزة للإرسال'), 'ready-to-send counter must surface in the report');

    // Ready-to-send endpoint: approved customer-facing drafts surface with order code + phone (owner-only)
    const rtsRes = await fetch(`${base}/api/admin/office/ready-to-send`, { headers: { Cookie: ownerBrowser.getCookie() } });
    assert.strictEqual(rtsRes.status, 200);
    const rts = await rtsRes.json();
    const rtsItem = (rts.items || []).find(i => i.id === staleTestJobId);
    assert.ok(rtsItem, 'the approved order follow-up must appear in ready-to-send');
    assert.strictEqual(rtsItem.order_code, targetOrderCode, 'ready-to-send must resolve the real order code');
    assert.ok(typeof rtsItem.phone === 'string' && rtsItem.phone.length > 0, 'ready-to-send must carry the customer phone for manual WhatsApp send');
    assert.ok(rtsItem.text.includes('أهلًا') && rtsItem.text.includes('فريق MAVI'), 'the follow-up text must be a real send-ready message: ' + rtsItem.text.slice(0, 80));
    assert.ok(rtsItem.text.includes(targetOrderCode), 'the message must be grounded in the real order code');
    const rtsNoAuth = await fetch(`${base}/api/admin/office/ready-to-send`);
    assert.strictEqual(rtsNoAuth.status, 401, 'ready-to-send must never answer without an owner session');

    // ---------------------------------------------------------
    // SCENARIO B: Double-click prevention on review decision
    // ---------------------------------------------------------
    // First refresh `doubleClickJobId` too since targetOrderCode's promise_date changed above
    await ownerBrowser.evalAsync(`officeRefreshStaleJob(${JSON.stringify(doubleClickJobId)})`);
    ownerBrowser.setDelayNextReviewMs(90);
    const logBeforeDouble = ownerBrowser.requestLog.length;
    await Promise.all([
      ownerBrowser.evalAsync(`officeDecideJob(${JSON.stringify(doubleClickJobId)}, 'approve')`),
      ownerBrowser.evalAsync(`officeDecideJob(${JSON.stringify(doubleClickJobId)}, 'approve')`),
    ]);
    const doubleReviewCalls = ownerBrowser.requestLog.slice(logBeforeDouble).filter(r => r.path.endsWith('/review'));
    assert.strictEqual(doubleReviewCalls.length, 1, 'Double-clicking approve must send strictly 1 HTTP review request');
    assert.strictEqual(ownerBrowser.dynamicApproveButtons.get(doubleClickJobId).getAttribute('aria-busy'), 'true');
    assert.ok(!ownerBrowser.getRootHtml().includes('aria-busy="true"'), 'Rendered DOM after request completion must release aria-busy lock');

    // Verify Owner Daily Cycle + Unified Audit Log modal
    await ownerBrowser.evalAsync('officeRunDailyCycle()');
    const afterCycleHtml = ownerBrowser.getRootHtml();
    assert.ok(afterCycleHtml.includes('of-daily-cycle-btn'), 'Owner view must render daily cycle button');
    await ownerBrowser.evalAsync('officeShowAuditLog()');
    const auditModalHtml = ownerBrowser.elements.get('modal').innerHTML;
    assert.ok(auditModalHtml.includes('سجل القرارات والمراجعات'), 'Audit modal must render unified Arabic title');
    assert.ok(auditModalHtml.includes('اعتماد المسودة من المالكة'), 'Audit modal must display translated approval event');

    // =========================================================
    // 2. STAFF SESSION: Follow-up & operational only — ZERO money, ZERO provider controls, ZERO approve buttons
    // =========================================================
    const staffBrowser = createAdminBrowserSession(base, adminHtml);
    staffBrowser.elements.get('lemail').value = 'staff@mavi.eg';
    staffBrowser.elements.get('lpass').value = 'mavi-staff';
    await staffBrowser.evalAsync('doLogin()');
    await staffBrowser.waitReady();

    for (const tab of ['summary', 'drafts', 'approved']) {
      await staffBrowser.evalAsync(`officeGoTab(${JSON.stringify(tab)})`);
      await new Promise(r => setTimeout(r, 120));
      const html = staffBrowser.getRootHtml();
      assert.ok(!html.includes('data-approve-job='), `Staff ${tab} view must never render approve buttons`);
      assert.ok(!html.includes('data-reject-job='), `Staff ${tab} view must never render reject buttons`);
      assert.ok(!html.includes('of-fixture-step-btn'), `Staff ${tab} view must never render worker/provider controls`);
      assert.ok(!html.includes('of-daily-cycle-btn') && !html.includes('of-audit-log-btn'), `Staff ${tab} view must never render owner cycle or audit controls`);
      assert.ok(!html.includes('data-owner-finance='), `Staff ${tab} view must never render owner finance rows`);
      assert.ok(!html.includes('campaign_brief') && !html.includes('deposit_followup_draft'), `Staff ${tab} view must not expose financial job kinds`);
      assert.ok(!/ج\.م|جنيه|EGP|openrouter/i.test(html), `Staff ${tab} DOM leaked financial/provider text`);
      const rtsStaff = await fetch(`${base}/api/admin/office/ready-to-send`, { headers: { Cookie: staffBrowser.getCookie() } });
      assert.strictEqual(rtsStaff.status, 403, 'staff must never read the ready-to-send list');
    }

    // =========================================================
    // 3. SESSION EXPIRATION (401): Clean transition back to login screen with clear message
    // =========================================================
    // Revoke sessions on the server by calling logout directly with owner cookie, then trigger an office action in ownerBrowser
    await fetch(base + '/api/admin/auth/logout', {
      method: 'POST',
      headers: { Origin: base, Cookie: ownerBrowser.getCookie() },
    });
    await ownerBrowser.evalAsync('officeRunSync()');
    const loginHtmlAfterExpire = ownerBrowser.getRootHtml();
    assert.ok(loginHtmlAfterExpire.includes('loginbox'), '401 during interaction must return cleanly to login screen');
    assert.strictEqual(
      ownerBrowser.elements.get('lerr').textContent,
      'انتهت الجلسة — سجّلي الدخول مرة أخرى للمتابعة.'
    );

    console.log('office-ui.test.js PASSED');
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
