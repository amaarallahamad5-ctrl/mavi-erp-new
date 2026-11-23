'use strict';
// End-to-end isolated audit of:
// 1. Login, sessions, RBAC & realm isolation (Owner / Staff / Customer)
// 2. Orders, deposits, quotes, receipts, required-deposit rules, payment corrections & refunds
// 3. Stock reservations, order fabric/workshop/extra costs, general expenses & accounting math
// 4. Full persistence across real server process stops & restarts + live SQLite backup integrity
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-persist-audit-'));
const DB_PATH = path.join(TMP_DIR, 'isolated-audit.db');
const BACKUP_PATH = path.join(TMP_DIR, 'downloaded-backup.db');
const SAMPLE_PNG = 'data:image/png;base64,' + fs.readFileSync(path.join(ROOT, 'public', 'brand', 'icon-192.png')).toString('base64');

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

async function startIsolatedServer(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/bootstrap.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      DB_PATH,
      AUTO_SEED: '0',
      SHOW_OTP: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', chunk => { logs += chunk.toString(); });
  child.stderr.on('data', chunk => { logs += chunk.toString(); });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (child.exitCode !== null) {
      throw new Error(`Server exited early (${child.exitCode}):\n${logs}`);
    }
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return { child, base, getLogs: () => logs };
    } catch (_) {}
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill('SIGKILL');
  throw new Error(`Timed out waiting for server at ${base}:\n${logs}`);
}

async function stopServer(srv) {
  if (!srv || !srv.child || srv.child.exitCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { srv.child.kill('SIGKILL'); } catch (_) {}
    }, 5000);
    srv.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    srv.child.kill('SIGTERM');
  });
}

async function req(base, p, { method = 'GET', body, token, cookie, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (cookie) h['Cookie'] = cookie;
  const res = await fetch(base + p, {
    method,
    headers: h,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  const cookiePair = setCookie ? setCookie.split(';')[0] : null;
  const ct = res.headers.get('content-type') || '';
  let data = null;
  let buf = null;
  if (ct.includes('application/json')) {
    data = await res.json();
  } else {
    buf = Buffer.from(await res.arrayBuffer());
  }
  return { status: res.status, data, buf, cookie: cookiePair, headers: res.headers };
}

(async () => {
  let srv = null;
  try {
    // 1. Seed disposable DB, then replace users to verify bootstrap INITIAL_ADMIN_* too.
    const seedRes = spawnSync(process.execPath, ['src/seed.js'], {
      cwd: ROOT,
      env: { ...process.env, DB_PATH, AUTO_SEED: '0' },
      encoding: 'utf8',
    });
    assert.strictEqual(seedRes.status, 0, seedRes.stderr);

    // Clear seeded users so bootstrap.js creates the initial owner from env, then add a staff user cleanly.
    {
      const db = new Database(DB_PATH);
      db.prepare('DELETE FROM sessions').run();
      db.prepare('DELETE FROM users').run();
      db.close();
    }

    const port1 = await getFreePort();
    srv = await startIsolatedServer(port1, {
      INITIAL_ADMIN_EMAIL: 'owner-audit@mavi.eg',
      INITIAL_ADMIN_PASSWORD: 'OwnerStrongPassword!2026',
    });
    assert(srv.getLogs().includes('[bootstrap] Owner created'), 'bootstrap should create initial owner on empty users table');

    // Insert a staff user via auth helper using a short script against the same SQLite WAL DB
    const addStaff = spawnSync(process.execPath, ['-e', `
      process.env.DB_PATH = ${JSON.stringify(DB_PATH)};
      process.env.AUTO_SEED = '0';
      const A = require('./src/auth');
      const { run } = require('./src/db');
      run("INSERT INTO users(email,name,role,password_hash) VALUES(?,?,?,?)",
        'staff-audit@mavi.eg', 'موظفة الفحص', 'staff', A.hashPassword('StaffStrongPass!2026'));
    `], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(addStaff.status, 0, addStaff.stderr);

    // 2. Auth, RBAC & Realm Isolation
    const badLogin = await req(srv.base, '/api/admin/auth/login', {
      method: 'POST',
      body: { email: 'owner-audit@mavi.eg', password: 'wrong-password' },
    });
    assert.strictEqual(badLogin.status, 401);

    const ownerLogin = await req(srv.base, '/api/admin/auth/login', {
      method: 'POST',
      body: { email: 'owner-audit@mavi.eg', password: 'OwnerStrongPassword!2026' },
    });
    assert.strictEqual(ownerLogin.status, 200);
    assert.strictEqual(ownerLogin.data.user.role, 'owner');
    const ownerCookie = ownerLogin.cookie;
    const ownerToken = ownerLogin.data.token;
    assert(ownerCookie && ownerCookie.startsWith('mavi_admin_session='), 'admin HttpOnly cookie expected');

    const staffLogin = await req(srv.base, '/api/admin/auth/login', {
      method: 'POST',
      body: { email: 'staff-audit@mavi.eg', password: 'StaffStrongPass!2026' },
    });
    assert.strictEqual(staffLogin.status, 200);
    assert.strictEqual(staffLogin.data.user.role, 'staff');
    const staffToken = staffLogin.data.token;

    // Register duplicate seeded phone -> must return 409, then register fresh customer phone -> 200
    const dupReg = await req(srv.base, '/api/store/auth/register', {
      method: 'POST',
      body: { name: 'مكرر', phone: '01098765432', password: 'CustomerPass!2026' },
    });
    assert.strictEqual(dupReg.status, 409);

    const custReg = await req(srv.base, '/api/store/auth/register', {
      method: 'POST',
      body: { name: 'سارة عميلة الاختبار', phone: '01055443322', password: 'CustomerPass!2026' },
    });
    assert.strictEqual(custReg.status, 200, JSON.stringify(custReg.data));
    const custCookie = custReg.cookie;
    assert(custCookie && custCookie.startsWith('mavi_session='), 'store HttpOnly cookie expected');

    // Cross-realm checks: customer cookie cannot access admin; admin token cannot access store customer profile
    const custToAdmin = await req(srv.base, '/api/admin/me', { cookie: custCookie });
    assert.strictEqual(custToAdmin.status, 401);
    const adminToStore = await req(srv.base, '/api/store/orders', { token: ownerToken });
    assert.strictEqual(adminToStore.status, 401);

    // Staff RBAC checks: staff blocked from money, reports, expenses, deletions
    for (const restricted of ['/api/admin/money/summary', '/api/admin/money/expenses', '/api/admin/money/report-hub?from=2026-01-01&to=2026-12-31']) {
      const r = await req(srv.base, restricted, { token: staffToken });
      assert.strictEqual(r.status, 403, `staff should get 403 on ${restricted}`);
    }

    // Save customer measurements (including shoulder)
    const saveMeas = await req(srv.base, '/api/store/me/measurements', {
      method: 'PUT',
      cookie: custCookie,
      body: { waist: 78, hip: 102, bust: 94, shoulder: 40, length: 145, sleeve: 60, arm: 32 },
    });
    assert.strictEqual(saveMeas.status, 200);

    // 3A. Ready-stock ledger & movements + Manual external order check
    const createStock = await req(srv.base, '/api/admin/inventory/stock', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        style_id: '',
        new_name: 'عباية جاهزة للفحص',
        sale_price: 900,
        size: 'M',
        colour: 'أسود',
        qty: 5,
        buy_price: 300,
      },
    });
    assert.strictEqual(createStock.status, 201, JSON.stringify(createStock.data));
    const stockRow = (await req(srv.base, '/api/admin/stock', { cookie: ownerCookie })).data.stock
      .find(s => s.style_name === 'عباية جاهزة للفحص');
    assert(stockRow && stockRow.qty === 5);

    // Adjust stock quantity (5 -> 3) and verify movement history
    const patchStock = await req(srv.base, `/api/admin/inventory/stock/${stockRow.id}`, {
      method: 'PATCH',
      cookie: ownerCookie,
      body: { qty: 3, buy_price: 300, style_name: 'عباية جاهزة للفحص', sale_price: 900 },
    });
    assert.strictEqual(patchStock.status, 200, JSON.stringify(patchStock.data));
    const stockMovements = await req(srv.base, `/api/admin/inventory/stock/${stockRow.id}/movements`, { cookie: ownerCookie });
    assert.strictEqual(stockMovements.status, 200);
    assert(stockMovements.data.movements.some(m => m.delta === -2), 'stock movement delta -2 must be logged');

    // Storefront intentionally blocks ready-stock styles (made-to-measure only -> 400 bad_style)
    const blockedStoreStock = await req(srv.base, '/api/store/orders', {
      method: 'POST',
      cookie: custCookie,
      body: { style_id: stockRow.style_id, colour: 'أسود', size: 'M', qty: 1, delivery: false, fabric_choice: 'قماش العميلة' },
    });
    assert.strictEqual(blockedStoreStock.status, 400);

    // Manual external WhatsApp order with partial payment
    const manualOrder = await req(srv.base, '/api/admin/manual-orders', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        customer_name: 'عميلة واتساب خارجي',
        customer_phone: '01066778899',
        channel: 'whatsapp',
        custom_name: 'فستان سواريه يدوي',
        colour: 'كحلي',
        qty: 1,
        unit_price: 1200,
        paid: 500,
        payment_method: 'instapay',
        status: 'confirmed',
      },
    });
    assert.strictEqual(manualOrder.status, 201, JSON.stringify(manualOrder.data));

    // 3B. Customer storefront made-to-measure order + full deposit/payment/refund/cost lifecycle
    const catStyles = (await req(srv.base, '/api/store/catalogue')).data.styles;
    const madeStyle = catStyles.find(s => s.id === 'AB-07') || catStyles[0];
    assert(madeStyle, 'seeded made-to-measure style expected');
    const unitPrice = Number(madeStyle.price);
    const expectedSubtotal = unitPrice * 2;

    const placeMadeOrder = await req(srv.base, '/api/store/orders', {
      method: 'POST',
      cookie: custCookie,
      body: {
        style_id: madeStyle.id,
        colour: madeStyle.colours[0].name,
        length_cm: madeStyle.lengths[0],
        qty: 2,
        delivery: true,
        governorate: 'الجيزة',
        fabric_choice: madeStyle.fabrics?.[0] || 'قماش العميلة',
        note: 'طلب اختبار حفظ البيانات والعربون',
      },
    });
    assert.strictEqual(placeMadeOrder.status, 201, JSON.stringify(placeMadeOrder.data));
    const orderCode = placeMadeOrder.data.order.code;

    // Quote shipping (50 EGP) + deposit 50%
    const quoteRes = await req(srv.base, `/api/admin/order-deposits/${orderCode}/quote`, {
      method: 'POST',
      cookie: ownerCookie,
      body: { percent: 50, shipping_fee: 50, payment_details: 'InstaPay: mavi@instapay' },
    });
    assert.strictEqual(quoteRes.status, 200, JSON.stringify(quoteRes.data));

    // Owner changes required deposit explicitly to fixed 800 EGP
    const dmState1 = (await req(srv.base, `/api/admin/orders/${orderCode}/deposit-management`, { cookie: ownerCookie })).data;
    const changeReq = await req(srv.base, `/api/admin/orders/${orderCode}/deposit-requirement`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        revision: dmState1.revision,
        mode: 'fixed',
        value: 800,
        reason: 'اتفاق خاص مع العميلة على عربون ثابت',
        confirm_requirement: true,
        request_id: crypto.randomUUID(),
      },
    });
    assert.ok([200, 201].includes(changeReq.status), JSON.stringify(changeReq.data));
    assert.strictEqual(changeReq.data.requirement.amount, 800);

    // Customer stale receipt upload (without updated quote_revision after explicit rule change) -> must be guarded with 409!
    const staleReceipt = await req(srv.base, `/api/store/order-deposits/${orderCode}/receipt`, {
      method: 'POST',
      cookie: custCookie,
      body: { image: SAMPLE_PNG, method: 'instapay', note: 'محاولة بدون تحديث الصفحة' },
    });
    assert.strictEqual(staleReceipt.status, 409, 'explicit requirement change must guard stale receipt upload');

    // Customer refreshes order, reads latest quote_revision, and uploads deposit receipt -> 200
    const custFreshOrder = (await req(srv.base, `/api/store/orders/${orderCode}`, { cookie: custCookie })).data.order;
    const uploadReceipt = await req(srv.base, `/api/store/order-deposits/${orderCode}/receipt`, {
      method: 'POST',
      cookie: custCookie,
      body: {
        image: SAMPLE_PNG,
        method: 'instapay',
        note: 'تم تحويل 800 جنيه',
        quote_revision: custFreshOrder.deposit.quote_revision,
      },
    });
    assert.strictEqual(uploadReceipt.status, 200, JSON.stringify(uploadReceipt.data));

    // Owner approves deposit -> 800 EGP payment recorded
    const depBeforeApprove = (await req(srv.base, `/api/admin/order-deposits/${orderCode}`, { cookie: ownerCookie })).data.deposit;
    const dmBeforeApprove = (await req(srv.base, `/api/admin/orders/${orderCode}/deposit-management`, { cookie: ownerCookie })).data;
    const approveRes = await req(srv.base, `/api/admin/order-deposits/${orderCode}/decision`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        decision: 'approve',
        receipt_revision: depBeforeApprove.receipt_revision,
        existing_payment_id: null,
        review_payment_ids: dmBeforeApprove.payments.map(p => p.id),
        financial_revision: dmBeforeApprove.financial_revision,
      },
    });
    assert.strictEqual(approveRes.status, 200, JSON.stringify(approveRes.data));

    // Record a second payment of 650 EGP (mistaken entry), then correct it to 600 EGP
    const dmState2 = (await req(srv.base, `/api/admin/orders/${orderCode}/deposit-management`, { cookie: ownerCookie })).data;
    const payToken = crypto.randomUUID();
    const recPay = await req(srv.base, `/api/admin/orders/${orderCode}/payments`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        amount: 650,
        method: 'cash',
        note: 'دفعة عند البروفة',
        confirm_actual: true,
        request_id: payToken,
        management_revision: dmState2.revision,
      },
    });
    assert.strictEqual(recPay.status, 201, JSON.stringify(recPay.data));
    // Replay idempotency check with same request_id
    const recPayReplay = await req(srv.base, `/api/admin/orders/${orderCode}/payments`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        amount: 650,
        method: 'cash',
        note: 'دفعة عند البروفة',
        confirm_actual: true,
        request_id: payToken,
        management_revision: dmState2.revision,
      },
    });
    assert.ok([200, 201].includes(recPayReplay.status), 'idempotent payment retry must succeed without duplicating');

    const dmState3 = (await req(srv.base, `/api/admin/orders/${orderCode}/deposit-management`, { cookie: ownerCookie })).data;
    assert.strictEqual(dmState3.payments.length, 2);
    const secondPayment = dmState3.payments.find(p => p.method === 'cash');
    const corrPay = await req(srv.base, `/api/admin/orders/${orderCode}/payments/${secondPayment.id}/correct`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        amount: 600,
        reason: 'تصحيح خطأ كتابي من 650 إلى 600',
        confirm_clerical: true,
        financial_revision: dmState3.financial_revision,
        request_id: crypto.randomUUID(),
      },
    });
    assert.ok([200, 201].includes(corrPay.status), JSON.stringify(corrPay.data));

    // Record an actual refund of 100 EGP, plus a mistaken refund of 50 EGP that we void
    const todayCairo = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo' }).format(new Date());
    const ordBeforeRef = (await req(srv.base, `/api/admin/orders/${orderCode}`, { cookie: ownerCookie })).data.order;
    const ref1 = await req(srv.base, `/api/admin/orders/${orderCode}/refunds`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        amount: 100,
        method: 'wallet',
        refunded_on: todayCairo,
        note: 'رد فرق شحن للعميلة',
        confirm_actual: true,
        request_id: crypto.randomUUID(),
        financial_revision: ordBeforeRef.financial_revision,
      },
    });
    assert.strictEqual(ref1.status, 201, JSON.stringify(ref1.data));

    const ordBeforeRef2 = (await req(srv.base, `/api/admin/orders/${orderCode}`, { cookie: ownerCookie })).data.order;
    const ref2 = await req(srv.base, `/api/admin/orders/${orderCode}/refunds`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        amount: 50,
        method: 'cash',
        refunded_on: todayCairo,
        note: 'إدخال بالخطأ',
        confirm_actual: true,
        request_id: crypto.randomUUID(),
        financial_revision: ordBeforeRef2.financial_revision,
      },
    });
    assert.strictEqual(ref2.status, 201);
    const voidTarget = ref2.data.id || ref2.data.refund?.id;
    assert(voidTarget, 'refund id expected');
    const ordBeforeVoid = (await req(srv.base, `/api/admin/orders/${orderCode}`, { cookie: ownerCookie })).data.order;
    const voidRes = await req(srv.base, `/api/admin/orders/${orderCode}/refunds/${voidTarget}/void`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        reason: 'تم تسجيل المرتجع التاني بالخطأ',
        confirm_clerical: true,
        financial_revision: ordBeforeVoid.financial_revision,
      },
    });
    assert.strictEqual(voidRes.status, 200, JSON.stringify(voidRes.data));

    // Add fabric purchase (3m * (120 + 10) = 390 EGP), workshop cost, and extra order cost (45 EGP), plus general expense (250 EGP)
    const ordDetails = (await req(srv.base, `/api/admin/orders/${orderCode}`, { cookie: ownerCookie })).data.order;
    const madeItemId = ordDetails.items[0].id;
    const legacyItemCost = Number(ordDetails.items[0].unit_cost || 0) * Number(ordDetails.items[0].qty || 1);

    const addFabPurchase = await req(srv.base, `/api/admin/orders/${orderCode}/cost-purchases/fabric`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        fabric_id: '',
        fabric_name: 'كريب سعودي أسود',
        metres: 3,
        price_per_metre: 120,
        shipping_per_metre: 10,
        note: 'شراء خامة للأوردر',
        request_id: crypto.randomUUID(),
      },
    });
    assert.strictEqual(addFabPurchase.status, 201, JSON.stringify(addFabPurchase.data));

    const tailors = (await req(srv.base, '/api/admin/tailors', { cookie: ownerCookie })).data.tailors;
    const tailorId = tailors[0].id;
    const addWsCost = await req(srv.base, `/api/admin/orders/${orderCode}/cost-purchases/workshop`, {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        order_item_id: madeItemId,
        tailor_id: tailorId,
        unit_cost: 150, // 150 * qty(2) = 300 EGP
        note: 'تفصيل قطعتين',
        request_id: crypto.randomUUID(),
      },
    });
    assert.strictEqual(addWsCost.status, 201, JSON.stringify(addWsCost.data));

    const addExtraCost = await req(srv.base, `/api/admin/orders/${orderCode}/cost-purchases/other`, {
      method: 'POST',
      cookie: ownerCookie,
      body: { label: 'شحن مندوب فعلي وتغليف', amount: 45, note: 'بوليصة الجيزة', request_id: crypto.randomUUID() },
    });
    assert.strictEqual(addExtraCost.status, 201, JSON.stringify(addExtraCost.data));

    const addExpense = await req(srv.base, '/api/admin/money/expenses', {
      method: 'POST',
      cookie: ownerCookie,
      body: {
        category: 'إعلانات وتسويق',
        amount: '250.00',
        spent_on: todayCairo,
        note: 'حملة انستجرام تجريبية',
        request_id: crypto.randomUUID(),
      },
    });
    assert.strictEqual(addExpense.status, 201, JSON.stringify(addExpense.data));

    // Snapshot financial summary, report hub, VAPID key, and order totals BEFORE restart
    const expectedTotal = expectedSubtotal + 50;
    const expectedOrderCost = legacyItemCost + 390 + 300 + 45;
    const preOrder = (await req(srv.base, `/api/admin/orders/${orderCode}`, { cookie: ownerCookie })).data.order;
    assert.strictEqual(preOrder.totals.total, expectedTotal);
    assert.strictEqual(preOrder.totals.gross_paid, 1400); // 800 + 600
    assert.strictEqual(preOrder.totals.refunded, 100);    // 100 active (50 voided)
    assert.strictEqual(preOrder.totals.paid, 1300);       // 1400 - 100
    assert.strictEqual(preOrder.totals.due, expectedTotal - 1300);
    assert.strictEqual(preOrder.totals.cost, expectedOrderCost);
    assert.strictEqual(preOrder.totals.profit, expectedTotal - expectedOrderCost);

    const preSummary = (await req(srv.base, '/api/admin/money/summary', { cookie: ownerCookie })).data;
    const preHub = (await req(srv.base, `/api/admin/money/report-hub?from=2020-01-01&to=2030-12-31`, { cookie: ownerCookie })).data;
    const preVapid = (await req(srv.base, '/api/store/web-alerts/key')).data.publicKey;

    // 4. RESTART #1: Stop server completely and boot a fresh process on a new port pointing to same DB_PATH
    await stopServer(srv);
    const port2 = await getFreePort();
    srv = await startIsolatedServer(port2);

    // Verify existing sessions (Owner cookie, Staff token, Customer cookie) survive restart without re-login!
    const ownerMeAfter1 = await req(srv.base, '/api/admin/me', { cookie: ownerCookie });
    assert.strictEqual(ownerMeAfter1.status, 200);
    assert.strictEqual(ownerMeAfter1.data.user.email, 'owner-audit@mavi.eg');

    const staffMeAfter1 = await req(srv.base, '/api/admin/me', { token: staffToken });
    assert.strictEqual(staffMeAfter1.status, 200);
    assert.strictEqual(staffMeAfter1.data.user.role, 'staff');

    const custMeAfter1 = await req(srv.base, '/api/store/me', { cookie: custCookie });
    assert.strictEqual(custMeAfter1.status, 200);
    assert.strictEqual(custMeAfter1.data.profile.measurements.shoulder, 40);

    // Verify VAPID public key, receipt binary, stock reservation, order ledger, and reports match 100%
    const postVapid1 = (await req(srv.base, '/api/store/web-alerts/key')).data.publicKey;
    assert.strictEqual(postVapid1, preVapid, 'VAPID public key must persist across restarts');

    const receiptImg = await req(srv.base, `/api/admin/order-deposits/${orderCode}/receipt`, { cookie: ownerCookie });
    assert.strictEqual(receiptImg.status, 200);
    assert(receiptImg.buf && receiptImg.buf.length > 100, 'uploaded receipt image must survive restart');

    const stockAfterRestart1 = (await req(srv.base, '/api/admin/stock', { cookie: ownerCookie })).data.stock
      .find(s => s.id === stockRow.id);
    assert.strictEqual(stockAfterRestart1.qty, 3, 'reserved stock quantity must survive restart');

    const postOrder1 = (await req(srv.base, `/api/admin/orders/${orderCode}`, { cookie: ownerCookie })).data.order;
    assert.deepStrictEqual(postOrder1.totals, preOrder.totals, 'order financial totals must match identically after restart');

    const postSummary1 = (await req(srv.base, '/api/admin/money/summary', { cookie: ownerCookie })).data;
    assert.deepStrictEqual(postSummary1, preSummary, 'money summary must match identically after restart');

    const postHub1 = (await req(srv.base, `/api/admin/money/report-hub?from=2020-01-01&to=2030-12-31`, { cookie: ownerCookie })).data;
    assert.deepStrictEqual(postHub1.summary, preHub.summary, 'report hub summary must match identically after restart');

    // Advance order status via staff after restart #1, then do RESTART #2 and check backup integrity
    const advanceStatus = await req(srv.base, `/api/admin/orders/${orderCode}/status`, {
      method: 'PATCH',
      token: staffToken,
      body: { status: 'ready' },
    });
    assert.strictEqual(advanceStatus.status, 200);

    await stopServer(srv);
    const port3 = await getFreePort();
    srv = await startIsolatedServer(port3);

    const custOrderAfter2 = await req(srv.base, `/api/store/orders/${orderCode}`, { cookie: custCookie });
    assert.strictEqual(custOrderAfter2.status, 200);
    assert.strictEqual(custOrderAfter2.data.order.status, 'ready');
    assert.strictEqual(custOrderAfter2.data.order.paid, 1300);
    assert.strictEqual(custOrderAfter2.data.order.due, expectedTotal - 1300);

    // Download live online SQLite backup via /api/admin/system/backup and run integrity_check + foreign_key_check
    const backupRes = await req(srv.base, '/api/admin/system/backup', { cookie: ownerCookie });
    assert.strictEqual(backupRes.status, 200);
    assert(backupRes.buf && backupRes.buf.length > 4096, 'backup SQLite file expected');
    fs.writeFileSync(BACKUP_PATH, backupRes.buf);

    const bdb = new Database(BACKUP_PATH, { readonly: true });
    assert.strictEqual(bdb.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepStrictEqual(bdb.pragma('foreign_key_check'), []);
    const backedOrder = bdb.prepare('SELECT code, status FROM orders WHERE code = ?').get(orderCode);
    assert.strictEqual(backedOrder.status, 'ready');
    const changeCount = bdb.prepare('SELECT COUNT(*) AS n FROM deposit_change_log').get().n;
    assert(changeCount >= 2, 'deposit_change_log must retain requirement & payment correction audit rows');
    bdb.close();

    console.log('PASS: Auth/RBAC, orders/deposits/payments/refunds, stock/costs/accounting, 2x server restarts, and live backup integrity all verified.');
  } finally {
    await stopServer(srv);
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
