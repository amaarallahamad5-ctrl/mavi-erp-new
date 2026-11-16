MAVI — ORDER COSTS + SMART CART / ALERTS
PARTIAL SOURCE OVERLAY — ISOLATED STAGING ONLY — NOT DEPLOYED

للمالكة: اقرئي أولًا «دليل-التجربة.md». الحزمة القديمة MAVI-Costs-Staging.zip
التي افترضت مخزون خامات وسعرًا ثابتًا ملغاة ولا تصلح للنشر كما هي.

1. WHAT THIS IS
This is a partial source overlay, NOT a complete application. It combines the
locally tested smart-cart/alerts overlay with the revised order-cost changes.
Its baseline is the f6c79a3 search/SEO source plus the earlier locally developed
cart and smart-alert work. It has NOT been compared/merged against every newer
change on the actual live server. Compare each included file against the real
current source; merge conflicts and any newer live work instead of blindly
replacing files. The package contains no database, uploads, environment file,
credentials, VAPID keys, node_modules, or compiled dependencies.

The existing application must provide its remaining files, package.json,
package-lock.json, and dependencies (including better-sqlite3, express, qrcode
and web-push). Verify Node >=18 with full Intl Africa/Cairo timezone data. The
reference tests are in tests-reference/ and are NOT automatically installed.

2. BEHAVIOUR AND COMPATIBILITY
- Purchases are per order: metres * (price per metre + shipping per metre), once
  per purchase, not again per order quantity. Several purchases and prices are
  supported; the fabric catalogue is optional, not a stock/pricing ledger.
- Workshop rate is attached to an order item and multiplied by its quantity.
  New whole-order extras are counted once. Existing per-piece manual lines and
  recorded item costs remain separate. The report reconciles old unknown costs
  instead of guessing a classification; never enter the same expense twice.
- Tailoring per metre is an indicator only, not another charge. Customer
  delivery in sales is not the real delivery expense unless separately recorded.
- Costs/reports remain owner-only. Operational staff can see needed fabric and
  workshop names without purchase or workshop amounts.
- Orders awaiting pricing and cancelled orders are excluded from profit totals;
  their recorded costs are disclosed separately. Recorded payments include
  those orders, and refunds are not automatic. There is no guessed style-level
  profit allocation. Order profit is before general expenses; the finance
  summary separately subtracts recorded general expenses.
- /api/admin/order-items/:id/production now returns 410: older clients using the
  old stock-deducting route must be updated. The report's style-level cost,
  profit and margin are null/unknown rather than invented. Verify any external
  integrations before considering release.
- If the response to a save is lost, the same unsaved UI row retries using the
  same request ID. After reopening or reloading the page, inspect the order
  before adding another row; a new row receives a new ID. Duplicate-workshop
  confirmation is a warning, not a hard prohibition on distinct jobs.
- The package includes the locally tested cart, alert centre and authenticated
  opaque-ID push code. Real-device push is not verified; it requires supported
  browsers, consent, per-device subscription and the existing VAPID keys.

3. SAFE MERGE AND BACKUP PLAN — ENGINEER
Do not deploy directly from this zip. First inspect and merge against the actual
current live revision in a separate branch. Preserve host settings and every
newer source change. Never replace production data, uploads, secrets or VAPID
keys with local test material. No real production database was accessed or
verified during these tests.

Before any approved live change, quiesce writes, create a consistent SQLite
backup using SQLite's online backup API / .backup (a plain copy of an active
WAL database is not sufficient), and back up uploads and configuration in a
secure location. Restore the backups to a separate isolated environment and
verify them. Run integrity_check and foreign_key_check on the copy; investigate
any existing problems before changing anything. Do not publish the backup.

Apply the merged version to an isolated, access-restricted staging copy first.
Use a properly protected and preferably de-identified data copy. Keep the live
DB_PATH, AUTO_SEED=0 and SHOW_OTP=0 settings unchanged; the staging instance
must have its own DB_PATH. NEVER run seed, setup, reset, or --force on live data.
The reference tests create, modify and delete disposable databases: NEVER run
those tests against a real database or customer-facing server.

On startup src/db.js performs additive schema work, including the purchase,
workshop and extra-cost tables, nullable item links and retry indexes. It retains
old item cost columns and old fabric columns. Existing alert migrations may
recreate triggers. Take the backup before first startup and test the actual
historical schema on a copy: unusual earlier schemas, inconsistent costs, orphan
references or duplicate legacy request IDs require investigation. The synthetic
migration tests cannot establish that a specific live database will migrate.

On staging compare old and new historical order totals, quantities, payment
amounts, old cost lines, customer details, images and notifications before and
after migration; compare order/report totals, cancelled/unpriced disclosures,
old workshop/fabric references, permissions, mixed carts and checkout. Verify
browser refresh, real-phone push and the current app/external integrations.
Investigate unexpected differences before any further change.

Prepare and rehearse rollback before releasing. A code rollback is NOT a full
data rollback: older code ignores new order-level expenses and may re-enable
stock deductions. If new writes have occurred, stop writes and reconcile/export
those new records with an engineer; do not simply restore an old database over
new orders or assume an old binary understands the new data.

4. LOCAL CHECKS AND REPRODUCIBILITY
Latest local checks on disposable seeded data: all 20 JS test files passed,
including the core API's 57/57, synthetic legacy migrations, mixed orders,
inactive/deleted/orphaned references, idempotency and permissions. Local browser
checks covered Arabic/English, 320–1280 widths, editing/deletion, lost-response
retry, duplicate confirmation, unsaved-change warning, excluded-cost display,
printing/board, staff privacy, cart, customer/admin alerts and old custom-photo
links. Tests are synthetic; actual production history, staging deployment and
real-phone push remain unverified.

To reproduce ONLY in a disposable complete clone, install the clone's locked
Node dependencies, copy/reference tests-reference/*.test.js under test/, and
run them sequentially (some reuse fixed ports):
    for f in test/*.test.js; do node "$f" || exit 1; done
The Python browser tests additionally need Playwright/Chromium and a separate
seeded local demo server on port 3472. browser-order-costs-edges.py directly
modifies ONLY its specifically named disposable data/cost-browser-latest.db;
inspect its header and source before running. Never aim the browser helpers at
production. Test failures or incompatible live changes block release.

SHA256SUMS lists included files for transfer verification. This archive is an
overlay and contains no automatic deployment or database restore operation.
