# Local, seeded synthetic database only. Requires playwright + a local Chromium.
# Start the test app on http://127.0.0.1:3472 with DB_PATH set to a disposable DB.
from playwright.sync_api import sync_playwright
import os, random

BASE=os.environ.get('MAVI_BROWSER_BASE','http://127.0.0.1:3472').rstrip('/')

def sign_in(page,email,password):
    page.goto(BASE+'/admin/',wait_until='domcontentloaded')
    page.locator('#lemail').fill(email)
    page.locator('#lpass').fill(password)
    page.locator('button[onclick="doLogin()"]').click()
    page.wait_for_function('window.maviAppReady===true')

def overflow(page,label):
    dims=page.evaluate('({actual:document.documentElement.scrollWidth,screen:window.innerWidth})')
    assert dims['actual']<=dims['screen']+1,(label,dims)

def cost(page,code):
    return page.evaluate('async c=>(await api("/orders/"+c)).order.totals.cost',arg=code)

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
    ctx=browser.new_context(viewport={'width':320,'height':820})
    page=ctx.new_page();page.set_default_timeout(8000)
    errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
    sign_in(page,'owner@mavi.eg','mavi-owner')
    body={'customer_name':'عميلة تجربة المتصفح','customer_phone':'010'+str(random.randrange(10000000,99999999)),'channel':'whatsapp','custom_name':'فستان متصفح','qty':2,'unit_price':1000,'paid':0,'status':'new'}
    created=page.evaluate('async body=>await api("/manual-orders",{method:"POST",body})',body)
    code=created['code']
    order=page.evaluate('async code=>(await api("/orders/"+code)).order',arg=code); item_id=order['items'][0]['id']
    page.evaluate('(code)=>openOrder(code)',arg=code)
    page.wait_for_selector('#purchase-fabric-rows',state='attached')
    overflow(page,'order initial 320')

    # A purchase may be entered directly, without a fabric catalogue entry.
    page.locator("button[onclick=\"addPurchase('fabric')\"]").click()
    row=page.locator('#purchase-fabric-rows .purchase-row').last
    row.locator('.p-name').fill('قماش مباشر')
    row.locator('.p-qty').fill('3');row.locator('.p-price').fill('100')
    row.locator('button',has_text='حفظ البند').click()  # blank shipping must not silently become zero
    page.wait_for_timeout(150);assert cost(page,code)==0 and row.get_attribute('data-id')=='0'
    row.locator('.p-shipping').fill('10')
    assert '330' in row.locator('.p-total').inner_text()
    row.locator('button',has_text='حفظ البند').click()
    page.wait_for_function('document.querySelectorAll("#purchase-fabric-rows .purchase-row[data-id]:not([data-id=\\"0\\"])").length===1')
    assert cost(page,code)==330

    # Second independent purchase at a different rate, with a catalogue choice.
    page.locator("button[onclick=\"addPurchase('fabric')\"]").click()
    row=page.locator('#purchase-fabric-rows .purchase-row').last
    row.locator('.p-choice').select_option(index=1)
    row.locator('.p-qty').fill('1');row.locator('.p-price').fill('120');row.locator('.p-shipping').fill('5')
    assert '125' in row.locator('.p-total').inner_text()
    row.locator('button',has_text='حفظ البند').click()
    page.wait_for_function('document.querySelectorAll("#purchase-fabric-rows .purchase-row[data-id]:not([data-id=\\"0\\"])").length===2')
    assert cost(page,code)==455

    # Saving one edited row cannot silently discard unsaved changes in another.
    entries=page.locator('#purchase-fabric-rows .purchase-row')
    entries.nth(0).locator('.p-price').fill('101');entries.nth(1).locator('.p-price').fill('121')
    page.once('dialog',lambda dialog:dialog.dismiss())
    entries.nth(0).locator('button',has_text='حفظ البند').click()
    assert cost(page,code)==455 and entries.nth(1).locator('.p-price').input_value()=='121'
    page.evaluate('render()');page.wait_for_selector('#purchase-fabric-rows .purchase-row',state='attached');page.wait_for_timeout(200)

    # The workshop shows the order's existing count and has no quantity input.
    page.locator("button[onclick=\"addPurchase('workshop')\"]").click()
    row=page.locator('#purchase-workshop-rows .purchase-row').last
    assert row.locator('.p-qty').count()==0
    assert row.locator('.p-piece-count').inner_text()=='2'
    row.locator('.p-choice').select_option(index=1);row.locator('.p-price').fill('90')
    assert '180' in row.locator('.p-total').inner_text()
    row.locator('button',has_text='حفظ البند').click()
    page.wait_for_function('document.querySelectorAll("#purchase-workshop-rows .purchase-row[data-id]:not([data-id=\\"0\\"])").length===1')
    assert cost(page,code)==635

    # Additional item cost is per piece and adds to the order-level purchases.
    page.evaluate('id=>addCostRow(id)',item_id)
    line=page.locator(f'#costrows-{item_id} .costrow').last
    line.locator('.cl-name').fill('زرار');line.locator('.cl-qty').fill('1');line.locator('.cl-unit').fill('20')
    page.locator(f'button[onclick="saveCostLines({item_id})"]').click()
    page.wait_for_function('async c=>(await api("/orders/"+c)).order.totals.cost===675',arg=code)
    page.wait_for_selector('#purchase-workshop-rows .purchase-row',state='attached')
    page.locator("button[onclick=\"addPurchase('other')\"]").click()
    extra=page.locator('#purchase-other-rows .purchase-row').last
    extra.locator('.p-label').fill('توصيل العميلة الفعلي');extra.locator('.p-amount').fill('40')
    assert '40' in extra.locator('.p-total').inner_text()
    extra.locator('button',has_text='حفظ البند').click()
    page.wait_for_function('async c=>(await api("/orders/"+c)).order.totals.cost===715',arg=code)
    page.wait_for_timeout(150)
    overflow(page,'order with entries 320')

    # Saved workshop name appears on the operational board and on the print sheet.
    page.evaluate("go('board')");page.wait_for_selector('.kanban')
    board_card=page.locator('.kcard').filter(has_text=code)
    assert 'ورشة أم محمد' in board_card.inner_text()
    page.evaluate('(code)=>openOrder(code)',arg=code);page.wait_for_selector('#purchase-fabric-rows',state='attached')
    with page.expect_popup() as popped:
        page.locator('button',has_text='طباعة').first.click()
    printed=popped.value;printed.wait_for_load_state('domcontentloaded')
    assert 'ورشة أم محمد' in printed.content() and 'قماش مباشر' in printed.content()
    printed.close()

    # Reports reflect the saved totals and never allocate guessed profit to styles.
    page.evaluate("go('rep')");page.wait_for_selector('#rep-from')
    page.locator('#rep-from').fill('2000-01-01');page.locator('#rep-to').fill('2100-01-01')
    page.locator('button[onclick="periodReport()"]').click()
    page.wait_for_function('(code)=>document.querySelector("#cost-detail-result").textContent.includes(code)',arg=code)
    report=page.locator('#cost-detail-result').inner_text()
    assert '715' in report and 'تفصيل المتر' in report and 'قماش مباشر' in report and 'توصيل العميلة الفعلي' in report
    overflow(page,'report 320')

    # Definition-only fabric form accepts blank fields, and escapes markup.
    page.evaluate("go('stock')");page.wait_for_selector('#fabric-heading')
    page.locator('button[onclick="fabricEditor(0)"]').click()
    assert page.locator('#iv-name').get_attribute('required') is None
    assert page.locator('#iv-cost').count()==0 and page.locator('#iv-qty').count()==0
    page.locator('#iv-name').fill('حرير <img src=x onerror=window.__testxss=1>')
    page.locator('#iv-details').fill('تفاصيل اختيارية')
    page.locator('button[onclick="saveFabricInventory(0)"]').click()
    page.wait_for_function('document.querySelector("#fabric-rows")?.textContent.includes("تفاصيل اختيارية")')
    assert page.evaluate('window.__testxss===undefined')
    overflow(page,'fabric list 320')

    # Test each view at mobile/tablet/desktop widths; internal tables may scroll.
    for width in [320,375,390,768,1280]:
        page.set_viewport_size({'width':width,'height':844})
        page.evaluate('(code)=>openOrder(code)',arg=code);page.wait_for_selector('#purchase-fabric-rows',state='attached')
        overflow(page,f'order {width}')
        page.evaluate("go('stock')");page.wait_for_selector('#fabric-heading');overflow(page,f'fabric {width}')
        page.evaluate("go('rep')");page.wait_for_selector('#rep-from');overflow(page,f'report {width}')

    # English labels are provided for the new feature as well.
    english=browser.new_context(viewport={'width':390,'height':844})
    en=english.new_page();en.set_default_timeout(8000);en_errors=[];en.on('pageerror',lambda e:en_errors.append(str(e)))
    en.goto(BASE+'/admin/?preview_language=en',wait_until='domcontentloaded')
    en.locator('#lemail').fill('owner@mavi.eg');en.locator('#lpass').fill('mavi-owner');en.locator('button[onclick="doLogin()"]').click();en.wait_for_function('window.maviAppReady===true')
    en.evaluate('(code)=>openOrder(code)',arg=code);en.wait_for_selector('#purchase-fabric-rows',state='attached')
    assert 'Fabric purchases and workshop costs' in en.locator('main').inner_text()
    assert 'Pieces from the order' in en.locator('main').inner_text();overflow(en,'English order')
    en.evaluate("go('stock')");en.wait_for_selector('#fabric-heading');assert 'Fabric & workshops' in en.locator('main').inner_text()
    assert not en_errors,en_errors
    english.close()

    # Staff can view production names, not amounts or cost editors.
    sc=browser.new_context(viewport={'width':390,'height':844});staff=sc.new_page();staff.set_default_timeout(8000)
    sign_in(staff,'staff@mavi.eg','mavi-staff');staff.evaluate('(code)=>openOrder(code)',arg=code)
    staff.wait_for_function('document.querySelector("main")?.textContent.includes("قماش مباشر")')
    assert 'ورشة أم محمد' in staff.locator('main').inner_text()
    assert staff.locator('#purchase-fabric-rows').count()==0
    payload=staff.evaluate('async code=>(await api("/orders/"+code)).order',arg=code)
    assert 'cost' not in payload['totals'] and 'unit_cost' not in payload['items'][0]
    overflow(staff,'staff order')
    sc.close()
    assert not errors,errors
    print('PASS: browser order purchases, item-count workshop, reports, print/board, optional fabric, escaping, staff privacy and five widths in Arabic/English')
    ctx.close();browser.close()
