# MAVI — deposit correction and redesigned administration

**Lightweight source snapshot for isolated review only; not deployed.** It contains the administration code, earlier order lifecycle, costs, reports, receipts and alerts work, plus this feature. Four large public colour-preview binaries are not included: before testing colour preview, run `node scripts/restore-colour-assets.js` to download the exact pinned assets with SHA-256 verification. Until then, this bundle is not fully self-contained. See `اقرئي-أولاً-النسخة-الخفيفة.md`. It is not an instruction or authorization to deploy. The current live source and database have not been exhaustively compared with this local baseline; review and merge deliberately, rather than replacing live files with this archive.

The archive contains no SQLite database, customer uploads, `.env`, production credentials, private VAPID key, `node_modules`, or saved sessions. Demo passwords appear in `src/seed.js` and reference tests only. `SHA256SUMS-PACKAGE` checks the lightweight files. `SHA256SUMS` additionally checks the four public binary assets after restoration.

## What changed

- The owner can **correct one existing recorded payment** with a reason and explicit clerical-error confirmation. The original row's `amount` is updated; its original date/method are retained. The previous/new amounts, reason, actor and request token are recorded in `deposit_change_log` and a general audit event. Reports use the corrected amount on the original payment date and mark the row as corrected. This does not send or return money. A correction cannot make gross payments lower than actual active refunds, and a corrected payment cannot be deleted individually.
- The owner can separately change the **required** deposit to a fixed amount or a percentage of the order's current total. It never changes or records a payment. Fixed requirements cannot exceed the total; lowering a price, quantity or shipping below a fixed requirement is blocked until the requirement is changed. Percentage requirements follow the total. A quote awaiting proof requires a positive deposit; a zero requirement is possible only where no pending approval is required.
- The same required-deposit operation is available on quoted, unapproved standalone custom requests. The custom change history is visible before approval and follows the linked order after approval. For approved designs, subsequent changes are made on the order. No historical payment linkage, source, or confirmed amount is guessed. An approved deposit's `confirmed_amount` is a historical confirmation snapshot, not a current requirement or necessarily the entire amount of its linked payment.
- A pending receipt blocks required-deposit changes and payment corrections. Receipt image uploads and approval remain separate. Quote/receipt revisions protect changed terms and image review; clients using old APIs are accepted while no explicit new rule or protected correction requires the new version, but must refresh after those new changes. Existing-payment linking still requires explicit selection and review.
- A new explicit received-payment form requires confirmation, method, and a request token. It protects against stale management state and safe retries even after individual deletion. Overpayment requires an additional UI confirmation. The legacy payment endpoint accepts its older no-token request format for compatibility; legacy integrations must be assessed before any release.
- Financial revisions include the correction sequence as well as the current payment/refund contents, so an amount changed away and back does not make an old form valid again. Duplicate tokens with changed data conflict. Database changes are checked inside immediate SQLite transactions.
- The administration's navigation, dashboard, tables, searches, dialogs, status controls and responsive presentation were updated for Arabic RTL and English LTR, preserving existing sections. Unsaved order costs are guarded on navigation and browser unload. Owner-only APIs, customer privacy and the existing receipt/refund lifecycle remain guarded server-side.

Cancellation continues to exclude that order's sales, order costs, payments, refunds and balances from reports until reactivation, without sending money or returning physically delivered stock. Refunds are actual recorded outflows by their own date; net paid is gross payments minus non-voided refunds. General unlinked expenses are not automatically attributable to cancelled orders. Profit remains an estimate based on recorded costs.

## Isolated local review

Use Node 20 (Node 18+ is supported by the package) and Python Playwright/Chromium for browser tests. `better-sqlite3` may need the usual platform-native build tools. The commands below deliberately create a new **demo-only** database; run them only in a private throwaway directory, never with real/customer-facing data.

```sh
npm ci
mkdir -p data
DB_PATH="$PWD/data/review.db" AUTO_SEED=0 SHOW_OTP=0 NODE_ENV=test node src/seed.js
DB_PATH="$PWD/data/review.db" AUTO_SEED=0 SHOW_OTP=0 NODE_ENV=test PORT=3482 node src/bootstrap.js
```

Open `http://127.0.0.1:3482/admin/` on the same computer. Demo owner: `owner@mavi.eg` / `mavi-owner`; demo staff: `staff@mavi.eg` / `mavi-staff`. This seed provides general synthetic examples; the special `DEMO-*` records described in the owner's guide are created in the separately hosted live preview and are not included in the archive. Demo credentials are public: keep the fixture private and never put actual customer data in it. Stop the local server when finished.

The owner's walkthrough is `دليل-مراجعة-الإدارة-والعربون.md`.

## Regression tests

The tests create, modify and remove synthetic databases. Never point them at a real database. Run the JS files **sequentially** because some use fixed ports:

```sh
for f in test/*.test.js; do node "$f" || exit 1; done
python3 test/run-browser-suite.py
```

The browser runner requires the Python `playwright` package, installed Chromium and its OS libraries. It creates a separate temporary seeded SQLite fixture/server for each browser test and deletes the fixtures afterward. Individual browser scripts can alternatively be run with `MAVI_BROWSER_DB` and `MAVI_BROWSER_BASE` pointing to the **same** disposable fixture; several scripts write directly to that DB. Review the scripts first. The reference run passed 28 JS test files, including 57/57 API checks, and 8 browser test files, including Arabic/English views at 320, 768 and 1440 pixels. It covers separate actions, idempotency after lost replies/deletion, concurrent revisions, correction ABA, quote/receipt protection, legacy migration/restart, reports, refunds, cost guards, role privacy, and standalone design history. It does not validate actual live records, actual transfers, deployment, or real-device push.

## API and migration notes for review

Additive startup migration creates `order_deposit_rules`, `custom_deposit_rules`, `deposit_change_log`, `payment_record_requests`, and receipt-revision columns on `order_deposits` and `custom_requests`. The schema does not invent a new rule for old manual orders, nor a payment link or approval snapshot for historical receipts. Existing nonexplicit quotes continue to use their recorded percentage. The historical lifecycle migration already contains nullable `order_deposits.confirmed_amount`.

Owner-only endpoints include:

- `GET /api/admin/orders/:code/deposit-management`: current payment/refund state, requirement, history and revision tokens.
- `POST /api/admin/orders/:code/payments/:paymentId/correct`: `amount`, `reason`, `confirm_clerical:true`, `financial_revision`, `request_id`.
- `POST /api/admin/orders/:code/deposit-requirement`: `mode`, `value`, `reason`, `confirm_requirement:true`, `revision`, `request_id`.
- `GET/POST /api/admin/custom-requests/:id/deposit-requirement`: separate pre-order requirement and history.
- `POST /api/admin/orders/:code/payments`: new form adds `confirm_actual:true`, `request_id` and `management_revision` to amount/method/note; old no-token requests remain supported.

A 409 should lead to reopening and reviewing current state; an uncertain transport result must not be retried as a new operation until the ledger has been checked. An unchanged retry using the original token is idempotent. Payment tokens retain a tombstone if the created payment is later individually deleted. Complete order/customer deletion deliberately removes the order's displayed correction history after an explicit impact warning; generic audit events remain.

## Before any separately approved release

Do not operate on production during this review. First compare and merge with the **actual current** live source and configuration, review all older integrations and mixed-version clients, and test with writes stopped on an isolated, access-controlled copy. Take and restore a consistent SQLite online backup (`.backup` or equivalent); copying only a live WAL main file is not a consistent backup. Compare pre/post migration orders, balances, payments, refunds, receipts/images, historical timestamps, stock and event history; run `PRAGMA integrity_check` and `PRAGMA foreign_key_check`. Never ship a test database to production, expose backups, change existing VAPID secrets, or run `seed`, `reset`, or `--force` on actual data. Keep real host settings such as `AUTO_SEED=0`, `SHOW_OTP=0` and the correct live `DB_PATH` under the host owner's control.

Rehearse rollback with writes stopped. Rolling back code alone is **not** a data rollback: older code may ignore required rules, correction history, actual refunds or aliases and could misstate balances/reports or mishandle stock. Preserve and reconcile new transactions with an engineer instead of overwriting later customer data with an old backup. Push on real devices and real transfer verification remain separate human checks.
