'use strict';
/* End-to-end verification of direct Virtual Company integration across ERP workflows:
   1. Order Detail (`orderView()` + `GET /api/admin/office/context/order/:code` + `POST /api/admin/office/quick-draft`)
      - Opening `orderView()` renders `#of-order-ctx-section` with open follow-up cases WITHOUT draining pre-existing queued jobs.
      - Staff sees only non-financial quick-draft actions, enqueues into `'queued'` without running worker, and gets 403 on `deposit_followup_draft`.
      - Owner generates immediate `'review'` drafts (`auto_approved: false`, `network_calls: 0`), never sees WhatsApp link before approval, hits 409 `stale_subject_facts` if order changes before approval, refreshes manually, approves, and only then gets manual `wa.me` link + copy button.
   2. Catalogue Styles (`stylesView()` + `officeOpenStyleAssistant()` + `GET /api/admin/office/context/style/:styleId`)
      - Staff sees 5 non-financial marketing/SEO actions (no `campaign_brief` / `paid_ad_setup_draft`).
      - Owner sees all 7 catalogue actions, generates & approves inside `#of-ctx-modal-root` without closing the modal.
   3. Custom Design Requests (`ordersView()` + `customAdminView()` + `officeOpenCustomAssistant()` + `GET /api/admin/office/context/custom/:requestId`)
      - Staff receives 403 on `/api/admin/office/context/custom/:requestId`.
      - Owner opens custom assistant, generates Omar's quote/review draft, approves it, and receives manual `wa.me` link. */
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
  ['root', 'ovl', 'modal', 'toast', 'lerr', 'lemail', 'lpass', 'of-tab-summary', 'of-tab-drafts', 'of-tab-team'].forEach(ensureEl);

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
    },
  };
}

test('Direct in-ERP Virtual Company integration across Order Detail, Catalogue Styles, and Custom Design Requests', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-office-erp-int-'));
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

    // Register a real customer, place an online order, and submit a custom design request end-to-end
    const regRes = await fetch(`${base}/api/store/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ phone: '01277665544', password: 'customer-password-123', name: 'ندى حسن' }),
    });
    assert.ok([200, 201].includes(regRes.status));
    const custCookie = regRes.headers.get('set-cookie').split(';')[0];

    await fetch(`${base}/api/store/me/measurements`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: custCookie },
      body: JSON.stringify({ bust: 94, waist: 76, hip: 102, shoulder: 39, length: 148 }),
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
    const styleId = 'DR-04';
    const styleName = 'فستان كروازيه واسع — كريب';

    const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const createdCustomRes = await fetch(`${base}/api/store/custom-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base, Cookie: custCookie },
      body: JSON.stringify({
        image: pngDataUrl,
        governorate: 'الجيزة',
        fabric_choice: 'قماش MAVI',
        requested_colour: 'كحلي',
        requested_fabric: 'كريب ملكي',
        details: 'تفصيل سواريه بأكمام طويلة',
        date_needed: '2027-03-10',
      }),
    });
    assert.strictEqual(createdCustomRes.status, 201);
    const customId = (await createdCustomRes.json()).id;

    const adminHtml = fs.readFileSync(path.join(ROOT, 'public/admin/index.html'), 'utf8');
    const ownerUi = createAdminBrowserSession(base, adminHtml);
    const staffUi = createAdminBrowserSession(base, adminHtml);

    await ownerUi.login('owner@mavi.eg', 'mavi-owner');
    await staffUi.login('staff@mavi.eg', 'mavi-staff');

    // 1. Pre-enqueue a normal queued job and verify opening `orderView()` does NOT drain it!
    const preQueuedRes = await ownerUi.evalAsync(`fetch('/api/admin/office/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mavi-Token': TOKEN },
      body: JSON.stringify({
        kind: 'daily_ops_triage',
        payload: {},
        idempotency_key: 'pre-queued-invariant-1'
      })
    }).then(r => r.json())`);
    assert.strictEqual(preQueuedRes.job.status, 'queued');

    // Open Order Detail as Staff first: check RBAC isolation in `#of-order-ctx-section`
    await staffUi.evalAsync(`openOrder(${JSON.stringify(orderCode)})`);
    const staffOrderHtml = staffUi.getRootHtml();
    assert.ok(staffOrderHtml.includes('id="of-order-ctx-section"'), 'Staff orderView must render contextual Virtual Company panel');
    assert.ok(staffOrderHtml.includes('data-quick-kind="customer_reply_draft"'), 'Staff must see Basma customer reply quick draft');
    assert.ok(!staffOrderHtml.includes('data-quick-kind="deposit_followup_draft"'), 'Staff must NEVER see Omar financial deposit quick draft');

    // Staff clicks quick-draft -> lands in `queued` (no worker execution)
    const staffPayloadEnc = encodeURIComponent(JSON.stringify({ order_code: orderCode }));
    await staffUi.evalAsync(`officeQuickDraft('customer_reply_draft', ${JSON.stringify(staffPayloadEnc)})`);
    const staffAfterOrderHtml = staffUi.getRootHtml();
    assert.ok(staffAfterOrderHtml.includes('data-job-status="queued"'), 'Staff quick-draft must remain queued awaiting owner');

    // Staff attempting financial quick-draft or custom context via API -> 403 Forbidden
    const staffForbiddenDeposit = await staffUi.evalAsync(`fetch('/api/admin/office/quick-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mavi-Token': TOKEN },
      body: JSON.stringify({
        kind: 'deposit_followup_draft',
        payload: { order_code: ${JSON.stringify(orderCode)} },
        idempotency_key: 'staff-forbid-dep-1'
      })
    }).then(r => r.status)`);
    assert.strictEqual(staffForbiddenDeposit, 403);

    const staffForbiddenCustomCtx = await staffUi.evalAsync(`fetch('/api/admin/office/context/custom/' + ${customId}, {
      headers: { 'X-Mavi-Token': TOKEN }
    }).then(r => r.status)`);
    assert.strictEqual(staffForbiddenCustomCtx, 403);

    // 2. Open Order Detail as Owner: pre-queued job must STILL be queued!
    await ownerUi.evalAsync(`openOrder(${JSON.stringify(orderCode)})`);
    const preQueuedCheck = await ownerUi.evalAsync(`fetch('/api/admin/office/jobs/' + ${JSON.stringify(preQueuedRes.job.id)}, {
      headers: { 'X-Mavi-Token': TOKEN }
    }).then(r => r.json())`);
    assert.strictEqual(preQueuedCheck.job.status, 'queued', 'Opening orderView() must NEVER auto-drain pre-existing queued jobs');

    const ownerOrderHtml = ownerUi.getRootHtml();
    assert.ok(ownerOrderHtml.includes('id="of-order-ctx-section"'), 'Owner orderView must render contextual panel');
    assert.ok(ownerOrderHtml.includes('data-quick-kind="deposit_followup_draft"'), 'Owner must see Omar financial deposit quick draft');

    // Owner generates an immediate `order_followup_draft` inside `orderView()` -> lands in `review` (`auto_approved: false`)
    const ownerFollowupEnc = encodeURIComponent(JSON.stringify({ order_code: orderCode, focus: 'schedule' }));
    await ownerUi.evalAsync(`officeQuickDraft('order_followup_draft', ${JSON.stringify(ownerFollowupEnc)})`);
    const ownerReviewHtml = ownerUi.getRootHtml();
    const reviewIdMatch = ownerReviewHtml.match(/data-approve-job="([^"]+)"/);
    assert.ok(reviewIdMatch, 'Owner quick-draft inside orderView must render immediate review card with approve button');
    const orderDraftId = reviewIdMatch[1];
    assert.ok(!ownerReviewHtml.includes(`data-wa-approved-job="${orderDraftId}"`),
      'Manual WhatsApp link MUST NOT appear before human owner approval');

    // Mutate the order's promise_date while the draft is open in orderView, then try approving -> 409 stale_subject_facts!
    await ownerUi.evalAsync(`(async () => {
      const stRes = await fetch('/api/admin/orders/' + ${JSON.stringify(orderCode)} + '/edit', {
        headers: { 'X-Mavi-Token': TOKEN }
      });
      const st = await stRes.json();
      const pRes = await fetch('/api/admin/orders/' + ${JSON.stringify(orderCode)} + '/edit', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Mavi-Token': TOKEN },
        body: JSON.stringify({
          revision: st.revision,
          order: { ...st.order, promise_date: '2027-02-15' },
          items: st.order.items
        })
      });
      if (!pRes.ok) throw new Error('edit failed ' + pRes.status);
    })()`);

    await ownerUi.evalAsync(`officeDecideJob(${JSON.stringify(orderDraftId)}, 'approve')`);
    const staleHtml = ownerUi.getRootHtml();
    assert.ok(staleHtml.includes('data-stale-error='), 'Stale approval inside orderView must surface 409 alert without auto-approving');
    assert.ok(!staleHtml.includes(`data-wa-approved-job="${orderDraftId}"`), 'Stale draft must NOT become approved');

    // Refresh stale draft inside orderView, then approve -> manual WhatsApp link + copy button appear!
    await ownerUi.evalAsync(`officeRefreshStaleJob(${JSON.stringify(orderDraftId)})`);
    await ownerUi.evalAsync(`officeDecideJob(${JSON.stringify(orderDraftId)}, 'approve')`);
    const approvedOrderHtml = ownerUi.getRootHtml();
    assert.ok(approvedOrderHtml.includes(`data-copy-job="${orderDraftId}"`), 'Approved draft in orderView must show manual copy button');
    assert.ok(approvedOrderHtml.includes(`data-wa-approved-job="${orderDraftId}"`), 'Approved customer draft must show manual wa.me link');
    assert.ok(approvedOrderHtml.includes('https://wa.me/201277665544?text='), 'wa.me link must target normalized Egyptian phone');

    // 3. Catalogue Style Assistant (`stylesView()` + `officeOpenStyleAssistant`)
    await staffUi.evalAsync("go('styles')");
    assert.ok(staffUi.getRootHtml().includes('officeOpenStyleAssistant'), 'Catalogue style cards must render Marketing & SEO assistant button');
    await staffUi.evalAsync(`officeOpenStyleAssistant(${JSON.stringify(styleId)}, ${JSON.stringify(styleName)})`);
    const staffStyleModal = staffUi.getModalHtml();
    assert.ok(staffStyleModal.includes('data-quick-kind="seo_readiness_check"'), 'Staff style modal must include Nadine SEO check');
    assert.ok(!staffStyleModal.includes('data-quick-kind="campaign_brief"'), 'Staff style modal must NOT include Karim financial campaign brief');
    assert.ok(!staffStyleModal.includes('data-quick-kind="paid_ad_setup_draft"'), 'Staff style modal must NOT include Ziad paid ad setup');

    await ownerUi.evalAsync("go('styles')");
    await ownerUi.evalAsync(`officeOpenStyleAssistant(${JSON.stringify(styleId)}, ${JSON.stringify(styleName)})`);
    const ownerStyleModal1 = ownerUi.getModalHtml();
    assert.ok(ownerStyleModal1.includes('data-quick-kind="campaign_brief"'), 'Owner style modal must include Karim campaign brief');
    assert.ok(ownerStyleModal1.includes('data-quick-kind="paid_ad_setup_draft"'), 'Owner style modal must include Ziad paid ad setup');

    const seoEnc = encodeURIComponent(JSON.stringify({ product_id: styleId }));
    await ownerUi.evalAsync(`officeQuickDraft('seo_readiness_check', ${JSON.stringify(seoEnc)})`);
    const ownerStyleModal2 = ownerUi.getModalHtml();
    assert.ok(ownerUi.elements.get('ovl').classList.contains('on'), 'Style assistant modal must remain open during quick-draft');
    const styleApproveMatch = ownerStyleModal2.match(/data-approve-job="([^"]+)"/);
    assert.ok(styleApproveMatch, 'Owner style modal must display prepared SEO draft for review');
    await ownerUi.evalAsync(`officeDecideJob(${JSON.stringify(styleApproveMatch[1])}, 'approve')`);
    assert.ok(ownerUi.getModalHtml().includes(`data-copy-job="${styleApproveMatch[1]}"`),
      'Owner can approve and copy style SEO draft directly inside the modal');
    await ownerUi.evalAsync('closeModal()');

    // 4. Custom Design Request Assistant (`ordersView()` + `customAdminView()` + `officeOpenCustomAssistant`)
    await ownerUi.evalAsync("go('orders')");
    assert.ok(ownerUi.getRootHtml().includes(`data-custom-id="${customId}"`),
      'Owner customAdminView must render Omar custom quote draft button');
    await ownerUi.evalAsync(`officeOpenCustomAssistant(${customId}, '01277665544')`);
    const customEnc = encodeURIComponent(JSON.stringify({ request_id: customId }));
    await ownerUi.evalAsync(`officeQuickDraft('custom_design_followup_draft', ${JSON.stringify(customEnc)})`);
    const customModalReview = ownerUi.getModalHtml();
    const customJobMatch = customModalReview.match(/data-approve-job="([^"]+)"/);
    assert.ok(customJobMatch, 'Custom request modal must render Omar draft for owner review');
    await ownerUi.evalAsync(`officeDecideJob(${JSON.stringify(customJobMatch[1])}, 'approve')`);
    const customModalApproved = ownerUi.getModalHtml();
    assert.ok(customModalApproved.includes(`data-wa-approved-job="${customJobMatch[1]}"`),
      'Approved custom design draft must expose manual wa.me link for the customer');
    await ownerUi.evalAsync('closeModal()');

    // 5. Kanban Board, Finance/Reports, and System/Backups Ops Assistants (`officeOpenOpsAssistant`)
    await staffUi.evalAsync("go('board')");
    assert.ok(staffUi.getRootHtml().includes("officeOpenOpsAssistant('board')"), 'Board view must render Salma daily ops button');
    await staffUi.evalAsync("officeOpenOpsAssistant('board')");
    assert.ok(staffUi.getModalHtml().includes('data-quick-kind="daily_ops_triage"'), 'Staff board modal must expose Salma daily_ops_triage');

    const staffForbidFinance = await staffUi.evalAsync(`fetch('/api/admin/office/context/ops/finance', {
      headers: { 'X-Mavi-Token': TOKEN }
    }).then(r => r.status)`);
    assert.strictEqual(staffForbidFinance, 403, 'Staff must get 403 on finance ops context');

    const staffForbidSystem = await staffUi.evalAsync(`fetch('/api/admin/office/context/ops/system', {
      headers: { 'X-Mavi-Token': TOKEN }
    }).then(r => r.status)`);
    assert.strictEqual(staffForbidSystem, 403, 'Staff must get 403 on system ops context');

    await ownerUi.evalAsync("go('money')");
    assert.ok(ownerUi.getRootHtml().includes("officeOpenOpsAssistant('finance')"), 'Finance view must render Rami & Farah assistant button');
    await ownerUi.evalAsync("officeOpenOpsAssistant('finance')");
    const finEnc = encodeURIComponent(JSON.stringify({ holiday_budget_egp: 100 }));
    await ownerUi.evalAsync(`officeQuickDraft('executive_weekly_plan', ${JSON.stringify(finEnc)})`);
    const finApprove = ownerUi.getModalHtml().match(/data-approve-job="([^"]+)"/);
    assert.ok(finApprove, 'Owner finance modal must render Rami executive weekly plan for review');
    await ownerUi.evalAsync(`officeDecideJob(${JSON.stringify(finApprove[1])}, 'approve')`);
    assert.ok(ownerUi.getModalHtml().includes(`data-copy-job="${finApprove[1]}"`));
    await ownerUi.evalAsync('closeModal()');

    await ownerUi.evalAsync("go('system')");
    assert.ok(ownerUi.getRootHtml().includes("officeOpenOpsAssistant('system')"), 'System view must render Youssef & Tarek audit button');
    await ownerUi.evalAsync("officeOpenOpsAssistant('system')");
    const sysEnc = encodeURIComponent(JSON.stringify({}));
    await ownerUi.evalAsync(`officeQuickDraft('erp_data_health_report', ${JSON.stringify(sysEnc)})`);
    const sysReviewMatch = ownerUi.getModalHtml().match(/data-approve-job="([^"]+)"/);
    assert.ok(sysReviewMatch, 'System modal must render Youssef data health report for review');
    const sysJobId = sysReviewMatch[1];

    // 6. Manual execution stamp rejected before approval (409), Owner manual text edit, re-approval, and manual execution stamp!
    const prematureMarkUsed = await ownerUi.evalAsync(`fetch('/api/admin/office/jobs/' + ${JSON.stringify(sysJobId)} + '/mark-used', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mavi-Token': TOKEN },
      body: JSON.stringify({ channel: 'internal' })
    }).then(r => r.status)`);
    assert.strictEqual(prematureMarkUsed, 409, 'mark-used MUST reject unapproved drafts with 409');

    const staffForbidEdit = await staffUi.evalAsync(`fetch('/api/admin/office/jobs/' + ${JSON.stringify(sysJobId)} + '/edit-text', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Mavi-Token': TOKEN },
      body: JSON.stringify({ text: 'محاولة تعديل غير مصرحة', expected_revision: 3, expected_result_hash: 'abc' })
    }).then(r => r.status)`);
    assert.strictEqual(staffForbidEdit, 403, 'Staff must get 403 on edit-text');

    await ownerUi.evalAsync(`officeStartEditJob(${JSON.stringify(sysJobId)})`);
    const customEditedText = 'تقرير سلامة البيانات المعدل يدوياً من المالكة — جاهز للاعتماد والتنفيذ اليدوي';
    await ownerUi.evalAsync(`officeUpdateEditDraftText(${JSON.stringify(customEditedText)})`);
    await ownerUi.evalAsync(`officeSaveEditJob(${JSON.stringify(sysJobId)})`);
    const editedModalHtml = ownerUi.getModalHtml();
    assert.ok(editedModalHtml.includes(customEditedText), 'Saved manual edit must update displayed draft text');
    assert.ok(editedModalHtml.includes('معدّلة يدويًا'), 'Human-edited badge must appear');
    assert.ok(editedModalHtml.includes(`data-approve-job="${sysJobId}"`), 'Edited draft must require explicit owner approval');

    await ownerUi.evalAsync(`officeDecideJob(${JSON.stringify(sysJobId)}, 'approve')`);
    await ownerUi.evalAsync(`officeMarkJobUsed(${JSON.stringify(sysJobId)}, 'internal')`);
    const stampedModalHtml = ownerUi.getModalHtml();
    assert.ok(stampedModalHtml.includes(`data-manual-exec="${sysJobId}"`), 'Manual execution stamp must render to prevent duplicate outreach');
    await ownerUi.evalAsync('closeModal()');

    // 7. Quick Order Assistant from Orders Table (`officeOpenOrderAssistant`) + Go-Live Readiness (`officeShowReadinessModal`)
    await ownerUi.evalAsync("go('orders')");
    assert.ok(ownerUi.getRootHtml().includes('officeOpenOrderAssistant'), 'Orders table must render quick drafts button per active order');
    await ownerUi.evalAsync(`officeOpenOrderAssistant(${JSON.stringify(orderCode)}, '01277665544')`);
    assert.ok(ownerUi.getModalHtml().includes(orderCode), 'Quick order modal must load order context without leaving orders view');
    await ownerUi.evalAsync('closeModal()');

    const staffForbidReadiness = await staffUi.evalAsync(`fetch('/api/admin/office/readiness', {
      headers: { 'X-Mavi-Token': TOKEN }
    }).then(r => r.status)`);
    assert.strictEqual(staffForbidReadiness, 403, 'Staff must get 403 on /readiness');

    await ownerUi.evalAsync('officeShowReadinessModal()');
    const readinessModal = ownerUi.getModalHtml();
    assert.ok(readinessModal.includes('data-readiness-check="sqlite_wal"'), 'Readiness modal must verify SQLite WAL');
    assert.ok(readinessModal.includes('data-readiness-check="team_17_roles"'), 'Readiness modal must verify 17 roles & 18 job kinds');
    assert.ok(readinessModal.includes('data-readiness-check="passwords_hardened"'), 'Readiness modal must surface default password pre-launch warning');
    await ownerUi.evalAsync('closeModal()');

    // Verify outbound guard remained untouched (zero external AI/ad/WhatsApp API calls)
    const statusRes = await ownerUi.evalAsync(`fetch('/api/admin/office/status', {
      headers: { 'X-Mavi-Token': TOKEN }
    }).then(r => r.json())`);
    assert.strictEqual(statusRes.worker.network_calls, 0, 'Zero external API calls allowed');
    assert.strictEqual(statusRes.worker.external_execution_enabled, false, 'External execution remains strictly disabled');
  } finally {
    if (srv && srv.exitCode === null) {
      srv.kill('SIGTERM');
      await new Promise(r => srv.once('exit', r));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Sandbox preview auto-admin intercepts both / and /store/ before store-search-pages unless ?shop=1', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-preview-intercept-'));
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
    assert.strictEqual(seedRes.status, 0);
    // Run with NODE_ENV unset (sandbox preview mode) + MAVI_PREVIEW_AUTO_ADMIN=1
    const cleanEnv = { ...process.env, PORT: String(port), DB_PATH: dbPath, AUTO_SEED: '0', MAVI_PREVIEW_AUTO_ADMIN: '1' };
    delete cleanEnv.NODE_ENV;
    delete cleanEnv.PUBLIC_ORIGIN;
    srv = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: cleanEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(`${base}/healthz`); if (r.ok) break; } catch (_) {}
      await new Promise(r => setTimeout(r, 100));
    }
    const rRoot = await fetch(`${base}/`, { redirect: 'manual' });
    assert.strictEqual(rRoot.status, 302);
    assert.strictEqual(rRoot.headers.get('location'), '/admin/?view=office&preview_demo=owner');

    const rStore = await fetch(`${base}/store/`, { redirect: 'manual' });
    assert.strictEqual(rStore.status, 302, 'GET /store/ without ?shop=1 must redirect to admin in preview mode');
    assert.strictEqual(rStore.headers.get('location'), '/admin/?view=office&preview_demo=owner');

    const rShopExplicit = await fetch(`${base}/store/?shop=1`, { redirect: 'manual' });
    assert.strictEqual(rShopExplicit.status, 200, 'Explicit /store/?shop=1 must render customer storefront with return bar');
    const shopHtml = await rShopExplicit.text();
    assert.ok(shopHtml.includes('/admin/?view=office&preview_demo=owner'), 'Explicit storefront must include return-to-admin preview bar');
  } finally {
    if (srv && srv.exitCode === null) {
      srv.kill('SIGTERM');
      await new Promise(r => srv.once('exit', r));
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
