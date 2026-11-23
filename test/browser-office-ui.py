# Real Chromium Playwright suite for Phase 1B Office UI on a disposable seeded DB.
# Covers desktop (1440x900) & mobile (390x844 + 320x568) viewports, horizontal overflow,
# Owner vs Staff views, consecutive button re-enabling without tab workarounds,
# Draft card Open Order links (HTTP 200 by order code), 409 stale order conflict without auto-reapproval,
# targeted draft refresh while an older job remains queued, double-click lock,
# keyboard navigation, and 401 session expiry.
from pathlib import Path
from playwright.sync_api import sync_playwright
import os

BASE = os.environ.get('MAVI_BROWSER_BASE', 'http://127.0.0.1:3483').rstrip('/')
assert os.environ.get('MAVI_BROWSER_DB') and Path(os.environ['MAVI_BROWSER_DB']).exists(), 'Use a disposable seeded DB.'
SHOT_DIR = os.environ.get('MAVI_OFFICE_SCREENSHOT_DIR', '').strip()
if SHOT_DIR:
    Path(SHOT_DIR).mkdir(parents=True, exist_ok=True)


def signin(page, email='owner@mavi.eg', password='mavi-owner'):
    page.goto(BASE + '/admin/', wait_until='domcontentloaded')
    page.fill('#lemail', email)
    page.fill('#lpass', password)
    page.locator('button[onclick="doLogin()"]').click()
    page.wait_for_function('() => window.maviAppReady === true')


def check_no_overflow(page, label):
    v = page.evaluate('({scroll: document.documentElement.scrollWidth, width: window.innerWidth})')
    assert v['scroll'] <= v['width'] + 1, f'Horizontal overflow on {label}: {v}'


def maybe_shot(page, name):
    if SHOT_DIR:
        page.screenshot(path=str(Path(SHOT_DIR) / name), full_page=True)


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, args=['--no-sandbox'])

    # 1. Owner Desktop (1440x900) & Mobile (390x844 + 320x568)
    ctx = browser.new_context(viewport={'width': 1440, 'height': 900})
    page = ctx.new_page()
    page.set_default_timeout(15000)
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))

    signin(page, 'owner@mavi.eg', 'mavi-owner')
    page.wait_for_selector('#of-dash-heading')
    check_no_overflow(page, 'owner-dash-desktop')
    maybe_shot(page, '01-owner-dashboard-desktop.png')

    # Create a manual order whose numeric DB id differs from its MV-* code
    created = page.evaluate('''async () => await api('/manual-orders', {
        method: 'POST',
        body: {
            customer_name: 'ندى شريف',
            customer_phone: '01012345678',
            confirm_existing: true,
            custom_name: 'فستان اختبار المكتب',
            qty: 1,
            unit_price: 1500,
            paid: 500,
            promise_date: '2026-11-20',
            status: 'confirmed',
            channel: 'whatsapp'
        }
    })''')
    code = created['code']

    # Open Office Summary view & verify sync button re-enables cleanly without switching tabs
    page.locator('button.admin-nav-link[onclick="go(\'office\')"]').click()
    page.wait_for_selector('#of-summary-title')
    page.locator('#of-sync-btn').click()
    page.wait_for_selector(f'button[data-open-subject-code="{code}"]')
    page.wait_for_selector('#of-sync-btn:not([disabled]):not([aria-busy])')
    check_no_overflow(page, 'owner-summary-desktop')
    maybe_shot(page, '02-owner-summary-desktop.png')

    # Open Order button on case card navigates to exact ERP order detail
    page.locator(f'button[data-open-subject-code="{code}"]').first.click()
    page.wait_for_function('c => document.querySelector("main .head .code")?.textContent.trim() === c', arg=code)

    # Return to Office -> Drafts tab & enqueue three drafts (1 older catalogue + 2 order drafts)
    page.locator('button.admin-nav-link[onclick="go(\'office\')"]').click()
    page.wait_for_selector('#of-tab-drafts')
    page.locator('#of-tab-drafts').click()
    page.wait_for_selector('#of-compose-title')
    assert 'اعتماد مسودة فقط — بدون إرسال أو صرف' in page.locator('#admin-main').inner_text()

    page.select_option('#of-kind-select', 'content_draft')
    page.locator('#of-create-job-btn').click()
    page.wait_for_function('() => document.querySelectorAll(".of-job-card").length >= 1')
    page.wait_for_selector('#of-create-job-btn:not([disabled]):not([aria-busy])')

    page.select_option('#of-kind-select', 'order_followup_draft')
    page.wait_for_selector('#of-order-code')
    page.fill('#of-order-code', code)
    page.locator('#of-create-job-btn').click()
    page.wait_for_function('() => document.querySelectorAll(".of-job-card").length >= 2')
    page.wait_for_selector('#of-create-job-btn:not([disabled]):not([aria-busy])')

    page.select_option('#of-kind-select', 'workshop_followup_draft')
    page.fill('#of-order-code', code)
    page.locator('#of-create-job-btn').click()
    page.wait_for_function('() => document.querySelectorAll(".of-job-card").length >= 3')
    page.wait_for_selector('#of-create-job-btn:not([disabled]):not([aria-busy])')

    # Click fixture-step THREE consecutive times WITHOUT switching tabs: button must re-enable after 1st & 2nd!
    page.locator('#of-fixture-step-btn').click()
    page.wait_for_function('() => document.querySelectorAll("[data-approve-job]").length >= 1')
    page.wait_for_selector('#of-fixture-step-btn:not([disabled]):not([aria-busy])')

    page.locator('#of-fixture-step-btn').click()
    page.wait_for_function('() => document.querySelectorAll("[data-approve-job]").length >= 2')
    page.wait_for_selector('#of-fixture-step-btn:not([disabled]):not([aria-busy])')

    page.locator('#of-fixture-step-btn').click()
    page.wait_for_function('() => document.querySelectorAll("[data-approve-job]").length >= 3')
    page.wait_for_selector('#of-fixture-step-btn[disabled]:not([aria-busy])')
    maybe_shot(page, '03-owner-drafts-review-desktop.png')

    # Draft card's "فتح الطلب ›" button MUST fetch by order code (HTTP 200) and open the matching order detail!
    with page.expect_response(lambda r: '/api/admin/orders/' in r.url and r.request.method == 'GET') as order_res_info:
        page.locator(f'.of-job-card button[data-open-order-code="{code}"]').first.click()
    assert order_res_info.value.status == 200, f'Expected 200 opening order from draft card, got {order_res_info.value.status}'
    page.wait_for_function('c => document.querySelector("main .head .code")?.textContent.trim() === c', arg=code)

    # Return to Drafts tab
    page.locator('button.admin-nav-link[onclick="go(\'office\')"]').click()
    page.wait_for_selector('#of-tab-drafts')
    page.locator('#of-tab-drafts').click()
    page.wait_for_selector('[data-approve-job]')

    # Jobs are ordered newest-first: [workshop_job, followup_job, older_content_job]
    job_ids = page.evaluate('() => [...document.querySelectorAll("[data-approve-job]")].map(b => b.dataset.approveJob)')
    stale_job_id, dbl_job_id, older_job_id = job_ids[0], job_ids[1], job_ids[2]

    # Put `older_job_id` back into `queued` state so we verify targeted refresh with an older queued job present!
    page.evaluate('''async (olderId) => {
        const j = (await api('/office/jobs/' + encodeURIComponent(olderId))).job;
        await api('/office/jobs/' + encodeURIComponent(olderId), {
            method: 'PATCH',
            body: { payload: j.payload, expected_revision: j.revision }
        });
    }''', older_job_id)

    # Mutate order while draft is open -> clicking approve yields 409 without automatic re-approval
    review_calls = []
    page.on('request', lambda req: review_calls.append(req.url) if req.method == 'POST' and req.url.endswith('/review') else None)

    page.evaluate('''async (orderCode) => {
        const st = await api('/orders/' + encodeURIComponent(orderCode) + '/edit');
        await api('/orders/' + encodeURIComponent(orderCode) + '/edit', {
            method: 'PATCH',
            body: { revision: st.revision, order: { ...st.order, promise_date: '2026-12-22' }, items: st.order.items }
        });
    }''', code)

    before_cnt = len(review_calls)
    page.locator(f'button[data-approve-job="{stale_job_id}"]').click()
    page.wait_for_selector('[data-stale-error="stale_subject_facts"]')
    assert len(review_calls) - before_cnt == 1, f'Expected strictly 1 review call on 409, got {len(review_calls) - before_cnt}'
    # Refresh button inside 409 alert must be enabled immediately without switching tabs!
    page.wait_for_selector(f'button[data-refresh-job="{stale_job_id}"]:not([disabled]):not([aria-busy])')
    maybe_shot(page, '04-owner-draft-409-stale-desktop.png')

    # Click refresh button on `stale_job_id` directly -> prepares `stale_job_id` while `older_job_id` stays `queued`!
    page.locator(f'button[data-refresh-job="{stale_job_id}"]').click()
    page.wait_for_selector(f'button[data-approve-job="{stale_job_id}"]:not([disabled]):not([aria-busy])')
    assert page.locator(f'[data-job-id="{older_job_id}"]').get_attribute('data-job-status') == 'queued', \
        'Older queued job must remain queued when refreshing a targeted newer job'

    # Refresh `dbl_job_id` as well & verify double-click prevention without any tab workaround
    page.locator(f'button[data-refresh-job="{dbl_job_id}"]').click()
    page.wait_for_selector(f'button[data-approve-job="{dbl_job_id}"]:not([disabled]):not([aria-busy])')
    before_dbl = len(review_calls)
    page.evaluate('''id => { officeDecideJob(id, 'approve'); officeDecideJob(id, 'approve'); }''', dbl_job_id)
    page.wait_for_function('id => document.querySelector(`[data-job-id="${id}"]`)?.dataset.jobStatus === "approved"', arg=dbl_job_id)
    assert len(review_calls) - before_dbl == 1, 'Double click must fire strictly 1 review request'

    # Keyboard tab switch to Team 17 + Mobile viewport checks (390x844 and 320x568)
    page.locator('#of-tab-summary').focus()
    page.keyboard.press('End')
    page.wait_for_selector('#of-team-title')
    assert page.locator('.of-role-card').count() == 17
    maybe_shot(page, '05-owner-team17-desktop.png')

    page.set_viewport_size({'width': 390, 'height': 844})
    for tab_id in ['#of-tab-summary', '#of-tab-drafts', '#of-tab-team']:
        page.locator(tab_id).click()
        check_no_overflow(page, f'owner-mobile-390-{tab_id}')
    maybe_shot(page, '06-owner-mobile-390.png')

    page.set_viewport_size({'width': 320, 'height': 568})
    for tab_id in ['#of-tab-summary', '#of-tab-drafts', '#of-tab-team']:
        page.locator(tab_id).click()
        check_no_overflow(page, f'owner-mobile-320-{tab_id}')

    # Session expiration (401): switch to summary first while valid, expire session, then click sync button
    page.locator('#of-tab-summary').click()
    page.wait_for_selector('#of-sync-btn:not([disabled])')
    page.evaluate('''async () => { await fetch('/api/admin/auth/logout', { method: 'POST', credentials: 'same-origin' }); }''')
    page.locator('#of-sync-btn').click()
    page.wait_for_selector('.loginbox')
    assert 'انتهت الجلسة' in page.locator('#lerr').inner_text()
    ctx.close()

    # 2. Staff Session (Mobile 390x844 & 320x568): zero financial figures, zero provider/approve buttons
    sctx = browser.new_context(viewport={'width': 390, 'height': 844})
    spage = sctx.new_page()
    spage.set_default_timeout(15000)
    spage.on('pageerror', lambda e: errors.append(str(e)))
    signin(spage, 'staff@mavi.eg', 'mavi-staff')
    spage.evaluate("() => go('office')")
    spage.wait_for_selector('#of-summary-title')
    for tab_id in ['#of-tab-summary', '#of-tab-drafts', '#of-tab-team']:
        spage.locator(tab_id).click()
        check_no_overflow(spage, f'staff-mobile-390-{tab_id}')
        txt = spage.locator('#admin-main').inner_text()
        assert 'ج.م' not in txt and 'جنيه' not in txt and 'EGP' not in txt, f'Staff leaked money in {tab_id}'
        assert spage.locator('[data-approve-job]').count() == 0
        assert spage.locator('#of-fixture-step-btn').count() == 0
    maybe_shot(spage, '07-staff-mobile-390.png')

    spage.set_viewport_size({'width': 320, 'height': 568})
    for tab_id in ['#of-tab-summary', '#of-tab-drafts', '#of-tab-team']:
        spage.locator(tab_id).click()
        check_no_overflow(spage, f'staff-mobile-320-{tab_id}')
    sctx.close()
    browser.close()

    assert not errors, f'Unexpected page errors: {errors}'
    print('browser-office-ui.py PASSED')
