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
  // New submissions carry a random revision; NULL on historical images is unknown.
  ['custom_requests','receipt_revision','TEXT'], ['order_deposits','receipt_revision','TEXT'],
  ['order_deposits','confirmed_payment_id','INTEGER REFERENCES payments(id) ON DELETE SET NULL'],
  // Historical approved amounts are unknown unless they were captured when
  // approving; never infer them from a subsequently edited total.
  ['order_deposits','confirmed_amount','REAL'],
  // A version for optimistic edits; legacy expense values stay untouched.
  ['expenses','revision','INTEGER NOT NULL DEFAULT 1'],
  ['measurements','shoulder','INTEGER'],
]) {
  if (!db.pragma('table_info('+table+')').some(c=>c.name===column))
    db.exec('ALTER TABLE '+table+' ADD COLUMN '+column+' '+definition);
}
if (!hadDeliveryRequested) db.exec('UPDATE orders SET delivery_requested=CASE WHEN delivery_fee>0 THEN 1 ELSE 0 END, shipping_quoted=1');

// «قيد التوصيل» (delivering) is a customer-visible stage added after the first
// schema shipped a CHECK on orders.status. SQLite cannot alter a CHECK in
// place, so legacy databases rebuild the table once — every row, index and
// foreign-key link survives. The stored CREATE statement is reused verbatim
// with only the CHECK widened, so all columns and clauses stay exactly as the
// database shipped them. Fresh databases already create the wider CHECK.
try {
  const ordersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='orders'").get()?.sql || '';
  if (ordersSql && !ordersSql.includes("'delivering'")) {
    const widened = ordersSql
      .replace(/^CREATE TABLE\s+"?orders"?\s*\(/i, 'CREATE TABLE orders_status_migration (')
      .replace(/CHECK \(status IN \(('[^)]*?')\)\)/, (m, inner) => {
        const items = inner.split(',').map(s => s.trim());
        if (!items.includes("'delivering'")) items.splice(items.indexOf("'delivered'"), 0, "'delivering'");
        return `CHECK (status IN (${items.join(',')}))`;
      });
    if (widened !== ordersSql && widened.includes("'delivering'")) {
      const cols = db.pragma('table_info(orders)').map(c => c.name);
      // ALTER TABLE ... RENAME re-parses every trigger body. While `orders` is
      // temporarily absent, triggers that reference it would fail the rename,
      // so they are recreated from their stored SQL right after the swap.
      const orderTriggers = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger'").all()
        .filter(t => t.sql && /(^|[^a-z_])orders([^a-z_]|$)/i.test(t.sql));
      const quote = name => '"' + String(name).replace(/"/g, '""') + '"';
      const recreate = () => { for (const t of orderTriggers) db.exec(t.sql); };
      for (const t of orderTriggers) db.exec('DROP TRIGGER IF EXISTS ' + quote(t.name));
      db.exec('PRAGMA foreign_keys=OFF');
      try {
        db.exec('BEGIN IMMEDIATE');
        db.exec(widened);
        db.exec(`INSERT INTO orders_status_migration (${cols.join(',')}) SELECT ${cols.join(',')} FROM orders`);
        db.exec('DROP TABLE orders');
        db.exec('ALTER TABLE orders_status_migration RENAME TO orders');
        db.exec('CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id)');
        db.exec('COMMIT');
        db.prepare("INSERT INTO events(entity,entity_id,action,detail) VALUES('orders','status_check','migrated',?)")
          .run(JSON.stringify({ reason: 'delivering stage added' }));
        recreate();
      } catch (e) { try { db.exec('ROLLBACK'); } catch {} recreate(); throw e; }
      finally { db.exec('PRAGMA foreign_keys=ON'); }
    }
  }
} catch (e) { console.error('[migration] orders status check:', e.message); }


// A create token survives even if an expense is later deleted. Retrying a lost
// response cannot create another deduction or resurrect a deleted expense.
// This is additive: legacy expense rows and their amounts/dates are not rewritten.
db.exec(`CREATE TABLE IF NOT EXISTS expense_creation_requests (
 request_id TEXT PRIMARY KEY,
 expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
 category TEXT NOT NULL, amount REAL NOT NULL, spent_on TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_expenses_spent_on ON expenses(spent_on);`);

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

// Explicit deposit requirements are independent of money already received.
// Absence of a rule means the existing quoted percentage remains authoritative;
// migrations never manufacture a historical requirement or identify a payment.
// Immutable audit entries retain both amounts/rules and a human explanation.
db.exec(`CREATE TABLE IF NOT EXISTS order_deposit_rules (
 order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
 mode TEXT NOT NULL CHECK(mode IN ('fixed','percent')), value REAL NOT NULL CHECK(value>=0),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS custom_deposit_rules (
 request_id INTEGER PRIMARY KEY REFERENCES custom_requests(id) ON DELETE CASCADE,
 mode TEXT NOT NULL CHECK(mode IN ('fixed','percent')), value REAL NOT NULL CHECK(value>=0),
 revision INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL DEFAULT (datetime('now')),
 updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS deposit_change_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE,
 custom_id INTEGER REFERENCES custom_requests(id) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('paid_correction','required_change')),
 payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
 payment_ref INTEGER, old_amount REAL, new_amount REAL NOT NULL,
 old_rule TEXT, new_rule TEXT, reason TEXT NOT NULL,
 request_id TEXT NOT NULL, created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
 created_at TEXT NOT NULL DEFAULT (datetime('now')),
 CHECK ((order_id IS NOT NULL AND custom_id IS NULL) OR (order_id IS NULL AND custom_id IS NOT NULL)),
 UNIQUE(order_id,request_id), UNIQUE(custom_id,request_id)
);
CREATE INDEX IF NOT EXISTS idx_deposit_change_order ON deposit_change_log(order_id,id);
CREATE INDEX IF NOT EXISTS idx_deposit_change_custom ON deposit_change_log(custom_id,id);
CREATE INDEX IF NOT EXISTS idx_deposit_change_payment ON deposit_change_log(payment_id);
-- Idempotency for the redesigned explicit payment form. A deleted payment is
-- not recreated by retrying an old request token.
CREATE TABLE IF NOT EXISTS payment_record_requests (
 order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
 payment_id INTEGER REFERENCES payments(id) ON DELETE SET NULL,
 amount REAL NOT NULL, method TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(order_id,request_id)
);`);

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
// These additive indexes speed up order-level reports and catalogue/session lookups without rewriting data.
db.exec(`CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_payments_order_id ON payments(order_id);
CREATE INDEX IF NOT EXISTS idx_item_cost_lines_item_id ON item_cost_lines(item_id);
CREATE INDEX IF NOT EXISTS idx_order_workshop_item ON order_workshop_costs(order_item_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fabric_purchase_request ON order_fabric_purchases(order_id, request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workshop_cost_request ON order_workshop_costs(order_id, request_id) WHERE request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_order_other_cost_request ON order_other_costs(order_id, request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_style_images_style_primary ON style_images(style_id, is_primary DESC, id);
CREATE INDEX IF NOT EXISTS idx_styles_active_type ON styles(active, type, id);
CREATE INDEX IF NOT EXISTS idx_custom_requests_customer ON custom_requests(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_custom_request_images_req ON custom_request_images(request_id, id);
CREATE INDEX IF NOT EXISTS idx_sessions_realm_subject ON sessions(realm, subject_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_orders_created_at ON orders(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_reviews_status ON service_reviews(status, updated_at DESC);`);

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
