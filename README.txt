MAVI unified cart, floating button and redesigned cart — draft release for staging
Based on deployed origin/main f6c79a3. Replaces earlier cart-only and discovery-only packages; includes those changes. This archive is a partial overlay, not a full site.

IMPORTANT: BACK UP THE LIVE DATABASE AND UPLOADS; VERIFY BACKUP/RESTORE. First test on an isolated copy of the production database and a staging server. Do not run seed/reset or restore anything over live data. This release makes additive SQLite migrations: new order item fields and tables for cart request idempotency, custom drafts and private images. Existing legacy custom requests and orders remain supported. Confirm writable DB and enough storage.

Before upload verify that each file in production has not changed since f6c79a3. If changed, merge rather than overwrite newer work. Overlay the included src/ and public/ files only; preserve all other files, DB, persistent uploads, env and secrets. Restart the existing service normally. Test the whole order/quote/payment journey in staging; deploy to production only after approval and a verified backup.

Customer: saved measurements apply to every item; standard and multiple custom designs can be added, edited and removed. Custom designs require login, each may have up to ten images, and price is pending until reviewed. Cart items are on the current device; custom images/drafts are stored privately on the server. Logging out clears the local cart; unsent drafts are not automatically deleted on logout. Images are never shipped in this archive.

Admin: one order; owner sets a unit price for each custom piece, then quotes shipping and one deposit. Deposit quote and manual payments are blocked while a custom item is unpriced. Test image privacy, all items, photos, per-item notes/colour/fabric, mixed totals, customer order view, quote/receipt/approval and old orders. Orders with unpriced custom pieces are excluded from financial totals until every design is priced; the dashboard and finance view show an exclusion count. Review reports carefully in staging before relying on them.

Local test evidence only: 57/57 existing API tests; mixed checkout, server pricing, retry idempotency, image access protection, admin pricing guard, receipt and deposit approval; Chromium mobile: one catalogue item plus two custom designs, editing and checkout; owner page: both design photos displayed. No live production deployment, staging copy test, or guarantee of Google indexing.

UI update: floating lower-left cart with live quantity badge; product and custom-design thumbnails, item controls, and clear subtotal/pending prices. Local Chromium checked widths 320, 360, 390, 768 and 1280 and English empty view.
