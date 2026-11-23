'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-office-cases-'));
const dbPath = path.join(tmpDir, 'cases.db');
process.env.DB_PATH = dbPath;
process.env.AUTO_SEED = '0';

const { db, run } = require('../src/db');
const D = require('../src/domain');
const { makeActor } = require('../src/office-engine');
const { syncCases, listCases, getSubjectCaseHistory } = require('../src/office-cases');

try {
  const owner = makeActor('user:1', 'owner');
  const staff = makeActor('user:2', 'staff');

  // Insert synthetic style, customer, and order directly in isolated test DB
  run("INSERT INTO styles(id, name, type, price, cost, active, lead_days) VALUES('ST-MADE-1', 'فستان سهرة ملكي', 'made', 3000, 1400, 1, 7)");
  const custId = Number(run("INSERT INTO customers(phone, name, area) VALUES('01055556666', 'مريم عادل', 'المعادي')").lastInsertRowid);
  // Incomplete measurements initially (hip & length missing)
  run('INSERT INTO measurements(customer_id, bust, waist) VALUES(?,?,?)', custId, 92, 74);

  const code = D.nextOrderCode(new Date('2026-11-10T10:00:00Z'));
  const orderId = Number(run(
    "INSERT INTO orders(code, customer_id, channel, status, promise_date, delivery_requested, shipping_quoted, delivery_fee, governorate) VALUES(?,?,'online','new','2026-11-22',1,0,0,'القاهرة')",
    code, custId
  ).lastInsertRowid);
  run('INSERT INTO order_items(order_id, style_id, qty, unit_price, unit_cost) VALUES(?,?,?,?,?)', orderId, 'ST-MADE-1', 1, 3000, 1400);
  run("INSERT INTO order_deposits(order_id, status) VALUES(?, 'needs_quote')", orderId);

  // 1. Cairo midnight boundary check:
  // 2026-11-22T22:30:00Z is 2026-11-23 00:30 in Africa/Cairo -> promise_date 2026-11-22 is ALREADY LATE!
  const s1 = syncCases({ now: '2026-11-22T22:30:00Z' });
  assert.strictEqual(s1.cairo_date, '2026-11-23');
  assert.strictEqual(s1.opened, 3); // missing_measurements + late_delivery + needs_quote

  // Idempotent repeat at same state produces zero duplicate rows or events
  const s1Repeat = syncCases({ now: '2026-11-22T22:35:00Z' });
  assert.strictEqual(s1Repeat.opened, 0);
  assert.strictEqual(s1Repeat.reopened, 0);
  assert.strictEqual(s1Repeat.updated, 0);
  assert.strictEqual(s1Repeat.resolved, 0);

  // Staff sees ONLY staff-visible cases (missing_measurements, late_delivery), NEVER needs_quote
  const staffOpen1 = listCases(staff, { state: 'open' });
  assert.deepStrictEqual(
    staffOpen1.map(c => c.case_kind).sort(),
    ['late_delivery', 'missing_measurements']
  );
  // Ensure zero financial keys or currency words in staff cases
  const serializedStaff = JSON.stringify(staffOpen1);
  assert.ok(!/egp|total|paid|deposit|cost|profit|ج\.م|جنيه/i.test(serializedStaff), 'Staff case leaked financial terms: ' + serializedStaff);

  // Owner sees all 3 open cases
  const ownerOpen1 = listCases(owner, { state: 'open' });
  assert.strictEqual(ownerOpen1.length, 3);

  // 2. Context update while STILL open:
  // Quote shipping/deposit, complete measurements, move to 'cut' while still late (promise_date moved to 2026-11-21)
  run('UPDATE measurements SET hip = 102, length = 148 WHERE customer_id = ?', custId);
  run('UPDATE orders SET shipping_quoted = 1, delivery_fee = 70, status = ?, promise_date = ? WHERE id = ?', 'cut', '2026-11-21', orderId);
  run("UPDATE order_deposits SET status = 'quoted', percent = 50, payment_details = 'InstaPay' WHERE order_id = ?", orderId);

  const s2 = syncCases({ now: '2026-11-23T09:00:00Z' });
  // Resolved: missing_measurements + needs_quote (2)
  // Opened: workshop_unassigned + deposit_unpaid (2)
  // Updated in place (still episode 1!): late_delivery (status new->cut & promise_date 22->21)
  assert.strictEqual(s2.resolved, 2);
  assert.strictEqual(s2.opened, 2);
  assert.strictEqual(s2.updated, 1);

  const lateEp1 = listCases(owner, { state: 'open' }).find(c => c.case_kind === 'late_delivery');
  assert.strictEqual(lateEp1.episode, 1);
  assert.strictEqual(lateEp1.summary.order_status, 'cut');
  assert.strictEqual(lateEp1.summary.promise_date, '2026-11-21');

  // 3. Resolve late_delivery by extending promise_date to 2026-11-28 (5 days out -> neither late nor due_soon)
  // Also customer uploads receipt -> deposit_unpaid resolves and receipt_pending_review opens!
  run('UPDATE orders SET promise_date = ? WHERE id = ?', '2026-11-28', orderId);
  run("UPDATE order_deposits SET status = 'receipt_pending', receipt = X'89504E47', receipt_type = 'image/png', receipt_revision = 'rev-1' WHERE order_id = ?", orderId);

  const s3 = syncCases({ now: '2026-11-23T12:00:00Z' });
  assert.strictEqual(s3.resolved, 2); // late_delivery + deposit_unpaid
  assert.strictEqual(s3.opened, 1);   // receipt_pending_review

  const ownerOpen3 = listCases(owner, { state: 'open' });
  assert.ok(ownerOpen3.some(c => c.case_kind === 'receipt_pending_review'));
  assert.ok(!ownerOpen3.some(c => c.case_kind === 'deposit_unpaid'));
  assert.ok(!ownerOpen3.some(c => c.case_kind === 'late_delivery'));

  // 4. Re-occurrence opens a NEW episode (episode = 2) while preserving episode = 1 in history!
  // Advance clock to 2026-11-30: order still in 'cut' past the extended 2026-11-28 promise_date!
  const s4 = syncCases({ now: '2026-11-30T10:00:00Z' });
  assert.strictEqual(s4.reopened, 1);

  const history = getSubjectCaseHistory(owner, 'order', orderId);
  const lateEpisodes = history.episodes.filter(e => e.case_kind === 'late_delivery');
  assert.strictEqual(lateEpisodes.length, 2, 'Expected 2 distinct late_delivery episodes');
  assert.strictEqual(lateEpisodes[0].episode, 1);
  assert.strictEqual(lateEpisodes[0].state, 'resolved');
  assert.strictEqual(lateEpisodes[0].resolution_reason, 'condition_cleared');
  assert.strictEqual(lateEpisodes[1].episode, 2);
  assert.strictEqual(lateEpisodes[1].state, 'open');

  const lateEventTypes = history.events.filter(ev => ev.case_kind === 'late_delivery').map(ev => ev.event_type);
  assert.deepStrictEqual(lateEventTypes, ['opened', 'context_updated', 'resolved', 'reopened']);

  // Staff history for this order hides owner-only financial episodes & events completely
  const staffHistory = getSubjectCaseHistory(staff, 'order', orderId);
  assert.ok(staffHistory.episodes.every(e => e.visibility === 'staff'));
  assert.ok(!staffHistory.events.some(ev => ['needs_quote', 'deposit_unpaid', 'receipt_pending_review'].includes(ev.case_kind)));
  assert.throws(
    () => getSubjectCaseHistory(staff, 'custom_request', 1),
    err => err.status === 403
  );

  // 5. Delivering or cancelling the order closes all remaining open episodes with exact reason
  run("UPDATE orders SET status = 'cancelled' WHERE id = ?", orderId);
  const s5 = syncCases({ now: '2026-11-30T15:00:00Z' });
  assert.ok(s5.resolved >= 2);
  assert.strictEqual(listCases(owner, { state: 'open' }).length, 0);
  const finalHistory = getSubjectCaseHistory(owner, 'order', orderId);
  assert.strictEqual(
    finalHistory.episodes.find(e => e.case_kind === 'late_delivery' && e.episode === 2).resolution_reason,
    'order_cancelled'
  );

  console.log('office-cases.test.js PASSED');
} finally {
  try { db.close(); } catch (_) {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
