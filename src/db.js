'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'mavi.db');

function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.function('mavi_cairo_date', { deterministic:true }, require('./business-date').cairoDate);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -2048'); // 2 MiB page-cache target
  db.pragma('mmap_size = 0');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  return db;
}

const db = open();
// Additive migrations retain existing orders and customer data.
const hadDeliveryRequested = db.pragma('table_info(orders)').some(c=>c.name==='delivery_requested');
for (const [table, column, definition] of [
  ['orders','governorate','TEXT'], ['orders','delivery_requested','INTEGER NOT NULL DEFAULT 0'],
  ['orders','shipping_quoted','INTEGER NOT NULL DEFAULT 0'], ['orders','fabric_choice','TEXT'], ['orders','manual_entry','INTEGER NOT NULL DEFAULT 0'],
  // The prior stage and order-only contact/measurement overrides are nullable.
  // Existing customers and catalogue entries are never rewritten on migration.
  ['orders','cancelled_from_status','TEXT'], ['orders','contact_name','TEXT'], ['orders','contact_phone','TEXT'],
  ['orders','contact_area','TEXT'], ['orders','measurements_snapshot','TEXT'],
  ['custom_requests','governorate','TEXT'], ['custom_requests','fabric_choice','TEXT'],
  ['style_images','is_primary','INTEGER NOT NULL DEFAULT 0'],
  ['styles','sale_price','REAL'],
  ['fabric','shipping_per_metre','REAL NOT NULL DEFAULT 0'], ['fabric','details','TEXT'],
  ['tailors','address','TEXT'], ['tailors','notes','TEXT'],
  ['order_items','fabric_reserved_qty','INTEGER'],
  ['order_items','cost_material','REAL'], ['order_items','cost_tailoring','REAL'], ['order_items','cost_other_base','REAL'],
  ['order_items','description','TEXT'], ['order_items','fabric_choice','TEXT'], ['order_items','item_note','TEXT'],
  ['custom_requests','shipping_fee','REAL'], ['custom_requests','requested_colour','TEXT'], ['custom_requests','requested_fabric','TEXT'],
  // NULL means an older receipt whose uploader was not recorded; never guess it.
  ['custom_requests','receipt_source','TEXT'], ['order_deposits','receipt_source','TEXT'],
  ['order_deposits','confirmed_payment_id','INTEGER REFERENCES payments(id) ON DELETE SET NULL'],
  // Historical approved amounts are unknown unless they were captured when
  // approving; never infer them from a subsequently edited total.
  ['order_deposits','confirmed_amount','REAL'],
]) {
  if (!db.pragma('table_info('+table+')').some(c=>c.name===column))
    db.exec('ALTER TABLE '+table+' ADD COLUMN '+column+' '+definition);
}
if (!hadDeliveryRequested) db.exec('UPDATE orders SET delivery_requested=CASE WHEN delivery_fee>0 THEN 1 ELSE 0 END, shipping_quoted=1');

// Order-specific refunds record money actually returned, never an assumed refund.
// A request token makes a retry safe; cancellations leave all history in place.
db.exec(`CREATE TABLE IF NOT EXISTS order_refunds (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 amount REAL NOT NULL CHECK(amount>0), method TEXT NOT NULL, refunded_on TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '', request_id TEXT NOT NULL, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 voided_at TEXT, voided_by INTEGER REFERENCES users(id) ON DELETE SET NULL, void_reason TEXT,
 UNIQUE(order_id,request_id)
);
CREATE INDEX IF NOT EXISTS idx_order_refunds_order ON order_refunds(order_id);
CREATE INDEX IF NOT EXISTS idx_order_refunds_date ON order_refunds(refunded_on);
-- Old numbers remain reserved and resolve to the same order. Deleting an order
-- leaves tombstones so an old link cannot later resolve to a different person.
CREATE TABLE IF NOT EXISTS order_code_aliases (
 code TEXT PRIMARY KEY COLLATE NOCASE, order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_order_code_aliases_order ON order_code_aliases(order_id);`);

db.exec(`CREATE TABLE IF NOT EXISTS cart_checkout_requests (
 customer_id INTEGER NOT NULL REFERENCES customers(id), request_id TEXT NOT NULL,
 order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, PRIMARY KEY(customer_id,request_id))`);

// Separate, private drafts for custom pieces in the unified cart.
db.exec(`CREATE TABLE IF NOT EXISTS cart_custom_drafts (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 details TEXT NOT NULL DEFAULT '', date_needed TEXT, colour TEXT, fabric_type TEXT,
 fabric_choice TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
 order_item_id INTEGER REFERENCES order_items(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS cart_custom_images (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 draft_id INTEGER NOT NULL REFERENCES cart_custom_drafts(id) ON DELETE CASCADE,
 image BLOB NOT NULL, image_type TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cart_custom_owner ON cart_custom_drafts(customer_id,order_item_id);`);

db.exec(`CREATE TABLE IF NOT EXISTS order_fabric_purchases (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 fabric_id INTEGER REFERENCES fabric(id) ON DELETE SET NULL, fabric_name TEXT NOT NULL,
 metres REAL NOT NULL, price_per_metre REAL NOT NULL, shipping_per_metre REAL NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS order_workshop_costs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 tailor_id INTEGER REFERENCES tailors(id) ON DELETE SET NULL, tailor_name TEXT NOT NULL,
 quantity REAL NOT NULL, unit_cost REAL NOT NULL, note TEXT
);
CREATE TABLE IF NOT EXISTS order_other_costs (
 id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 label TEXT NOT NULL, amount REAL NOT NULL, note TEXT, request_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_order_other_costs_order ON order_other_costs(order_id);
CREATE INDEX IF NOT EXISTS idx_order_fabric_purchases_order ON order_fabric_purchases(order_id);
CREATE INDEX IF NOT EXISTS idx_order_workshop_costs_order ON order_workshop_costs(order_id);`);

// Every new workshop record points at an existing order line. Its quantity comes
// from that line, not from a second, independently entered metre/quantity field.
// The nullable column leaves any earlier, unlinked records unchanged.
for (const [table,column,definition] of [
  ['order_workshop_costs','order_item_id','INTEGER REFERENCES order_items(id) ON DELETE CASCADE'],
  ['order_workshop_costs','request_id','TEXT'],
  ['order_fabric_purchases','request_id','TEXT'],
  ['order_other_costs','request_id','TEXT'],
]) {
  if (!db.pragma('table_info('+table+')').some(c=>c.name===column))
    db.exec('ALTER TABLE '+table+' ADD COLUMN '+column+' '+definition);
}
// These additive indexes speed up order-level reports without rewriting data.
db.exec(`CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_item_cost_lines_item_id ON item_cost_lines(item_id);
CREATE INDEX IF NOT EXISTS idx_order_workshop_item ON order_workshop_costs(order_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fabric_purchase_request ON order_fabric_purchases(order_id, request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workshop_cost_request ON order_workshop_costs(order_id, request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_other_cost_request ON order_other_costs(order_id, request_id) WHERE request_id IS NOT NULL;`);

/* ---------- tiny helpers ---------- */
const get  = (sql, ...a) => db.prepare(sql).get(...a);
const all  = (sql, ...a) => db.prepare(sql).all(...a);
const run  = (sql, ...a) => db.prepare(sql).run(...a);

function setting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      key, String(value));
}

function audit(entity, entityId, action, actor, detail) {
  run('INSERT INTO events(entity,entity_id,action,actor,detail) VALUES(?,?,?,?,?)',
      entity, String(entityId), action, actor || null,
      detail ? JSON.stringify(detail) : null);
}

module.exports = { db, get, all, run, setting, setSetting, audit, DB_PATH };
