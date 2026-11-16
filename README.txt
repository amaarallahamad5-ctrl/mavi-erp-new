MAVI — ORDER CANCELLATION, ACTUAL REFUNDS AND ORDER EDITING
PARTIAL SOURCE OVERLAY FOR ISOLATED STAGING — NOT DEPLOYED

This archive supersedes MAVI-Reports-Receipts-Staging.zip for this work: it
includes that release's cart, alerts, order-specific costs, reports and admin
receipt changes as well as the order-lifecycle changes described below. It is
not a complete application and is NOT an instruction to deploy. The rejected
MAVI-Costs-Staging.zip (fabric stock/fixed prices) must not be used.

There is no database, customer upload, .env, production credential, private VAPID
key, node_modules or compiled dependency in the archive. Public demo-only login
values appear in the reference tests and guide. The existing full source,
package.json, package-lock.json and assets are required. Compare and merge every
included file with the actual current live source on a separate branch: the
local baseline has not been compared against every newer live change. Do not
blindly replace production files. The Arabic owner's guide is دليل-التجربة.md.

1. LIFECYCLE AND REAL MONEY
- Staff may cancel/reactivate; edit and refund recording/correction are
  owner-only. Cancellation is a status change, never a transfer or an assumed
  refund. It preserves payments, actual-refund history, costs and the order.
- Cancelled orders' sales, order-specific costs, payments, refunds, outstanding
  and overpayments are excluded from financial reports and totals. Operational
  status counts may still count cancelled orders. On reactivation the order's
  historical financial movements become included again in their original dates.
  Standalone general expenses have no order foreign key and cannot be reliably
  attributed or automatically excluded: reconcile such entries separately.
- A refund is recorded only after money has actually been returned. Amount,
  date, method and explicit confirmation are required. No bank transfer is
  made. The amount may not exceed the net paid amount. A request token permits
  an unchanged retry after a lost response, and a financial revision prevents
  stale edits. A void is only for a clerical entry error, requires a reason and
  confirmation, and keeps the old row/audit trail. A void is not a reverse
  money transfer. Individual payment deletion is blocked while active refunds
  exist so a historical refund cannot exceed the remaining payment ledger.
- Net paid = gross payments minus non-voided actual refunds. Due/overpayment is
  recalculated after price or quantity edits; payments are not altered. Report
  net receipts = included payments on their payment dates minus included actual
  refunds on their refund dates, so a period may be negative. Payment-method
  breakdowns are gross, not a second subtraction. This is not cash on hand or
  a complete accounting ledger. The profit/difference is still an estimate.
- Reactivation restores the recorded prior stage, including delivered. If the
  old stage is unknown it starts at new, subject to the stock-safety checks
  below. An approved deposit remains approved after a price increase/refund;
  the current calculated deposit shortfall and order balance are displayed,
  without waiting for another deposit to restore the stage. Historical
  confirmed_amount remains NULL if it was not actually captured at approval.

2. STOCK AND EDITING
- For undelivered orders, cancellation releases known active finished-stock
  reservations; reactivation reacquires the same items in one immediate SQLite
  transaction. Shortages or inconsistent reservations abort the entire change.
  A new unapproved order with no old reservation is checked for availability
  but remains unreserved until its separate deposit approval. A restored active
  legacy reservation is reused during approval, never deducted a second time.
- Delivered stock is never returned to inventory merely because its order is
  cancelled, reactivated or deleted. Cancel/reopen for financial purposes does
  not prove a physical return. Reconcile an actual physical return manually.
  Direct backward status changes from delivered are blocked to avoid inventing
  stock. An unknown prior stage with a finished-stock item blocks reactivation,
  even if the reservation is missing or marked released; the historical piece
  could have been delivered. Unknown-stage cancellation with an active stock
  reservation blocks order/customer/custom deletion. Manually review physical
  stock and history; do not guess or silently clear a reservation.
- The owner edit form changes order-specific contact/measurement snapshots,
  item descriptions, code, quantity, price, delivery, discount and other entered
  fields. It does not change the customer login/profile or catalogue name.
  New codes use ASCII letters/digits/hyphen/underscore, maximum 40 characters;
  previous codes are reserved aliases for the same authorized order. Deletion
  leaves tombstones so old links cannot later identify a different customer.
  Untouched older references are preserved. If historical references differ
  only in letter case, editing that reference or deletion is blocked pending
  reconciliation; a case-ambiguous lookup never guesses. Old order events are
  retained; historic events can be keyed by the old code, while newer lifecycle
  events include the order ID and code-change details.
- Quantity affects linked workshop cost per piece. Fabric purchases remain
  whole-order purchases: metres × (price per metre + shipping per metre).
  The per-metre indicator is NOT an additional cost. Recorded old item costs
  are not silently repriced when a stock variant is edited.
- A pending receipt blocks a price/quantity/shipping change until reviewed or
  rejected. Changing the amount of a quoted/rejected but unapproved deposit
  requires a fresh quote. Uploading a receipt still does not approve it: the
  owner must separately verify funds and approve. Existing-payment linking
  requires the explicit selection and snapshot described below.

3. RECEIPTS AND EXISTING PAYMENT LINKS
Owner upload submits a JPEG/PNG/WebP (maximum 2 MiB) for review; it does not
record payment or reserve stock. Confirmation is a separate owner action.
Existing payments require choosing one covering payment or a genuinely different
new transfer, and sending a reviewed payment-ID snapshot. A different amount or
method, or a recorded refund, requires explicit acknowledgement. Linking is
blocked when net payments after refunds do not cover the deposit. When refunds
exist, approval also checks financial_revision from the deposit GET. Multiple
small payments cannot be linked together as one deposit. The app cannot verify
whether a bank transfer is real or distinguish two transfers with the same
amount; the owner must check the bank. Old receipt uploader source and old
confirmed deposit amount are not guessed. Private receipt images require owner
authorization. Manual external orders do not acquire a deposit workflow merely
by being edited.

4. API / MIGRATION NOTES
Additive startup migrations introduce orders.cancelled_from_status,
contact_name/contact_phone/contact_area/measurements_snapshot,
order_deposits.confirmed_amount, order_refunds and order_code_aliases, including
indexes. Existing saved rows are not intentionally rewritten or repriced.

GET/PATCH /api/admin/orders/:code/edit are owner-only; PATCH requires the
revision returned by GET. POST /orders/:code/refunds requires amount, method,
refunded_on, request_id, financial_revision and confirm_actual:true. POST
/orders/:code/refunds/:id/void requires reason, financial_revision and
confirm_clerical:true. POST /orders/:code/reactivate uses the preserved stage
and transactional stock checks. Existing status PATCH may optionally include
expected_status, as the new cancel UI does. Clients must refresh on HTTP 409.
Old API integrations should be checked, especially if they approve deposits,
write statuses, delete orders/payments, or interpret report collected amounts.
The old production cost endpoint remains 410: order purchases replace it.

5. SAFE MERGE, BACKUP AND ROLLBACK
No production database or live site was touched or verified. Before ANY approved
live release: review and merge against the actual current source; quiesce writes;
take a consistent SQLite online backup/.backup (copying a live WAL main file is
not sufficient); securely back up uploads/configuration; restore a protected
isolated copy; run integrity_check/foreign_key_check and compare old orders,
payments, receipts, images, stock, costs, notifications and events before and
after migration. Investigate existing inconsistencies before enabling writes.
Never publish the backup or replace live data with a test database. Keep live
DB_PATH, AUTO_SEED=0, SHOW_OTP=0, VAPID keys and hosting configuration intact.
NEVER run seed/setup/reset/--force on live or customer-facing data.

Rehearse rollback. Code rollback alone is not data rollback: older code may
ignore refunds and aliases, misstate reports/balances, mishandle reopened stock or
receipt links. Stop writes and reconcile post-release records with an engineer;
do not overwrite new orders by restoring an old DB. Financial and physical
stock verification still requires a human. Real-device push remains untested.

6. TESTS
Reference tests create/modify/delete disposable synthetic databases; NEVER aim
at production. In a complete isolated clone, install the locked dependencies and
copy tests-reference/*.test.js to test/, then run sequentially because fixed
ports are used:
    for f in test/*.test.js; do node "$f" || exit 1; done
Browser tests need Playwright and Chromium and must use the SAME disposable DB
as a separate local server. Set MAVI_BROWSER_DB to that synthetic SQLite path and
MAVI_BROWSER_BASE to its URL; run tests-reference/browser-*.py sequentially.
Some browser scripts write SQLite directly. Review them before running.

Local coverage includes 25 JS suites (the original API checks: 57/57) and seven
browser suites across Arabic/English and mobile/desktop, including synthetic
migration/restart, price/quantity edits, legacy references, actual full/partial
refund records, retry/idempotency, clerical void, report dates/exclusions,
deposit shortfall, separate receipt approval, concurrent writes, stock shortages,
delivered stock, permissions and customer isolation. These do not validate the
actual live schema/data, real bank transfers, deployment, or real-device push.
SHA256SUMS contains per-file transfer checksums; the archive contains no deploy
or database-restore operation.
