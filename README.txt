MAVI — REPORTS, ORDER COSTS AND ADMIN DEPOSIT RECEIPTS
PARTIAL SOURCE OVERLAY — ISOLATED STAGING ONLY — NOT DEPLOYED

للمالكة: اقرئي «دليل-التجربة.md». هذه ليست نسخة منشورة، ولا تحتوي قاعدة بيانات.
Do NOT deploy the rejected MAVI-Costs-Staging.zip: its fabric-stock/fixed-price
assumption was explicitly rejected. This overlay supersedes the prior
MAVI-Order-Costs-Staging.zip and adds the requested reports and receipt flow.

1. WHAT IS INCLUDED / BASELINE
This is a PARTIAL SOURCE OVERLAY, not a complete app. It includes the locally
tested smart-cart/alerts and order-cost changes, plus the owner reports and
receipt workflows. Its baseline is the f6c79a3 search/SEO source plus earlier
local cart, smart-alert and order-cost work. It has NOT been merged with or
compared to every newer live change. Compare and merge every included file into
the actual current source on a separate branch; do not blindly replace live
files. In particular, src/inventory.js and public/admin/deletions.js are now
included because stock-reservation deletion behavior and its warning changed.

The archive contains no database, uploaded customer files, .env, credentials,
private VAPID keys, node_modules or compiled dependencies. The existing app
must provide remaining sources/assets, package.json, package-lock.json and
locked dependencies (better-sqlite3, express, qrcode, web-push), with Node >=18
and Intl Africa/Cairo timezone data. tests-reference/ are references only and
must never run against live or customer-facing data.

2. NEW REPORTS — OWNER ONLY
GET /api/admin/money/report-hub?from=YYYY-MM-DD&to=YYYY-MM-DD returns one
transactionally consistent snapshot. The UI has overview, sales/design/colour/
channel, monthly comparison, order profitability, workshops, fabric purchase
comparison, detailed costs, payments, outstanding/overpaid, deposit follow-up,
production stages and late orders. Cross-check against /money/period and
/money/cost-detail. The owner-only guard is enforced server-side; staff may not
retrieve the report or receipt images.

Order sales/costs are based on order creation date and current status in Cairo;
cancelled and unpriced orders are excluded from those totals, with their
recorded costs disclosed. Payments use payment date and include cancelled,
unpriced, and older orders; overhead uses the recorded expense date. Outstanding
is the current balance on eligible orders created in the selected period, after
all payments to date; overpayments are separate. Refunds are not automatic.
The financial difference is an estimate using recorded costs, not finalized
accounting profit. Customer delivery is included in sales; actual delivery cost
must be recorded. Model revenue is item sales before order-level discounts and
delivery; shared order cost/profit is not allocated to individual models.

Period-scoped production status and deposits are returned too, but current
late-order and open-deposit follow-up lists deliberately cover ALL creation
dates and are labelled as exceptions in the UI. A closed/cancelled order is not
in those follow-up lists. Confirmed-deposit counts use creation, not confirmation
date. Fabric comparison uses recorded per-purchase metres/prices; groups using
names rather than references are approximate, and unnamed purchases can be
unrelated. Historical costs are not guessed or distributed into new purchases.
Workshop piece counts sum entries, so a piece with multiple operations can be
counted more than once. Weighted price-per-metre and the old tailoring-per-metre
indicator are not extra costs.

3. ADMIN RECEIPTS AND EXISTING PAYMENTS
Owner-only POST /api/admin/order-deposits/:code/receipt and
POST /api/admin/custom-requests/:id/receipt accept a JPEG/PNG/WebP data URL up
to 2 MiB and method wallet/instapay. The upload moves an existing quoted or
receipt_rejected record to receipt_pending; it does not confirm, record money,
create an order, or reserve stock. It rechecks state inside an immediate SQLite
transaction, records source admin/customer and an audit event, and cannot
overwrite pending proof. Old receipt_source is NULL (unknown), never guessed.
Owner receipt images are private, no-store and displayed using the admin token
when a separate store login has replaced the shared cookie.

A separate owner decision confirms/rejects. Online order confirmation performs
stock reservation, status transition and payment insertion or explicit link in
one transaction. Concurrent confirmations cannot duplicate this operation.
Existing payments are displayed in full. If ANY previous payments exist, the
owner must choose a distinct new transfer or link one previously recorded
payment whose amount is at least the required deposit. A different amount or
method requires an explicit acknowledgement. No existing amount or method is
rewritten. The UI sends the reviewed payment IDs; a changed list causes 409
rather than applying a stale decision. A linked approved deposit payment cannot
be deleted individually. Approval of an old custom-design request creates its
order, one payment and the link atomically. Real bank transfers are not queried:
a human choosing 'new transfer' for the same transfer can still double-count.
Multiple smaller payments cannot currently be linked together as one deposit;
review such cases before confirming rather than entering a duplicate.

The general manual-payment route now refuses new payments while an order's
deposit is not approved. Historical payments are preserved and may be linked at
approval. Manual external orders without an order_deposits record keep their
existing payment workflow; no deposit record is automatically invented for
them. Existing external API consumers that approve deposits with earlier
payments must be updated to send existing_payment_id (or null for an explicitly
distinct transfer), review_payment_ids and, for a mismatched amount/method,
confirmed_existing_payment=true. The updated owner UI does this.

Deleting an undelivered order releases any still-reserved finished stock in the
same transaction; deleting a delivered order does not invent a stock return.
The impact dialog distinguishes those cases. No raw-fabric inventory is added.
Existing old clients using /api/admin/order-items/:id/production still receive
410; update clients/integrations before a release. Deletions remain destructive,
owner-password protected and should be reviewed carefully.

4. SAFE MERGE / BACKUP / ROLLBACK — ENGINEER
Do not deploy this archive directly. First inspect and merge against the actual
current live revision in a separate branch. Preserve all later source changes,
host settings, uploads, secrets and existing VAPID keys. No real production
database was accessed or verified during these tests.

Before any approved live change, quiesce writes and take a consistent SQLite
backup using its online backup API / .backup: a plain file copy of an active
WAL database is not sufficient. Back up uploads and configuration securely.
Restore backups to an isolated environment and verify integrity_check and
foreign_key_check; investigate pre-existing inconsistencies before migration.
Never publish the backup or restore a local test database over production.

On first startup src/db.js adds nullable receipt_source and
confirmed_payment_id, additive performance indexes and the earlier order-cost
schema. Historical data is not intentionally repriced, reclassified or
backfilled with guessed receipt sources. Existing alert migrations can recreate
triggers. A synthetic old-schema migration and restart passed locally, but the
actual live schema/data may differ and MUST be tested on a protected isolated
copy first. Compare historical totals, quantities, payments, receipts, images,
notifications and old references before/after; test cancellations, stock,
permissions, cart, alerts, report dates and external clients.

Keep live DB_PATH, AUTO_SEED=0 and SHOW_OTP=0 unchanged; staging must have its
own separate DB_PATH. NEVER run seed, setup, reset or --force on live data.
Prepare and rehearse rollback. Code rollback alone is NOT data rollback: older
code may ignore newer costs, re-enable stock deductions or fail to understand
receipt/payment links. Stop writes and reconcile any new records with an
engineer; do not restore an old database over new orders.

5. LOCAL TESTS / LIMITATIONS
Reference tests create, modify and delete synthetic databases. In a disposable
complete clone with locked dependencies installed, copy tests-reference/*.test.js
under test/ and run sequentially (several tests reuse fixed ports):
    for f in test/*.test.js; do node "$f" || exit 1; done
Browser references need Playwright/Chromium and a separate seeded demo server on
port 3472. browser-order-costs-edges.py and browser-reports-receipts.py directly
modify the synthetic SQLite database designated by MAVI_BROWSER_DB; set it to
the same disposable DB as the demo server, inspect the scripts first, and NEVER
point them at a real database. Run browser scripts sequentially.

Local tests cover API 57/57, 23 JS test files, synthetic receipt/cost/alert
migration, separate approval, prior-payment linking and stale views, concurrent
submissions, stock rollback/deletion, lost responses, report reconciliation,
Cairo dates, Arabic/English, mobile/desktop, staff/customer privacy, cart and
notification links. They do not validate a live database, its unmerged source,
actual bank receipts, production deployment or real-device web push. Push needs
a supported device/browser, consent and the existing VAPID keys.

SHA256SUMS lists included files for transfer verification. There is no automatic
deployment or database restore operation in this archive.
