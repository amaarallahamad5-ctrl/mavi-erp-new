# Comprehensive browser check on a fresh disposable DB, never production.
from pathlib import Path
from playwright.sync_api import sync_playwright
import base64, os, random

BASE=os.environ.get('MAVI_BROWSER_BASE','http://127.0.0.1:3483').rstrip('/')
assert os.environ.get('MAVI_BROWSER_DB') and Path(os.environ['MAVI_BROWSER_DB']).exists(), 'Use a disposable seeded DB.'
IMAGE=Path(__file__).resolve().parent.parent/'public'/'brand'/'icon-192.png'
DATA='data:image/png;base64,'+base64.b64encode(IMAGE.read_bytes()).decode()

def signin(page,email='owner@mavi.eg',password='mavi-owner',language='ar'):
    page.goto(BASE+'/admin/?preview_language='+language,wait_until='domcontentloaded')
    page.fill('#lemail',email);page.fill('#lpass',password)
    page.locator('button[onclick="doLogin()"]').click();page.wait_for_function('()=>window.maviAppReady===true')

def api(page,path,body=None,method='GET'):
    return page.evaluate('async x=>await api(x.path,{method:x.method,body:x.body})',{'path':path,'method':method,'body':body})

def store(page,path,token,body=None,method='GET'):
    r=page.evaluate('''async x=>{let r=await fetch('/api/store'+x.path,{method:x.method,headers:{'content-type':'application/json',authorization:'Bearer '+x.token},body:x.body?JSON.stringify(x.body):undefined});return {status:r.status,data:await r.json()}}''',{'path':path,'token':token,'method':method,'body':body})
    assert r['status'] in (200,201),r
    return r['data']

def state(page,code):return api(page,'/orders/'+code+'/deposit-management')

def open_order(page,code,owner=True):
    page.evaluate('c=>openOrder(c)',code)
    page.wait_for_function('c=>document.querySelector("main .head .code")?.textContent.trim()===c',arg=code)
    if owner:page.wait_for_selector('#deposit-management')

def view(page,key):
    page.evaluate('k=>go(k)',key)
    page.wait_for_function('''k=>[...document.querySelectorAll('.admin-nav-link.on')].some(x=>x.getAttribute('onclick')==="go('"+k+"')")''',arg=key)
    if key=='rep':page.wait_for_selector('#rh-results:not([hidden])')
    assert 'تعذر عرض' not in page.locator('main').inner_text()

def overflow(page,label):
    v=page.evaluate('({scroll:document.documentElement.scrollWidth,width:innerWidth})')
    assert v['scroll']<=v['width']+1,(label,v)

def lose_once(page,pattern,button):
    commits=[]
    def lose(route):
        if route.request.method=='POST':
            response=route.fetch();commits.append(response.status);route.abort('failed')
        else:route.continue_()
    page.route(pattern,lose);page.locator(button).click()
    page.wait_for_function('()=>document.querySelector("#inv-error")?.textContent.includes("النتيجة غير مؤكدة")')
    page.unroute(pattern,lose);assert commits==[201],commits
    page.locator(button).click();page.wait_for_selector(button,state='hidden')

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
    ctx=browser.new_context(viewport={'width':390,'height':844});page=ctx.new_page();page.set_default_timeout(15000);errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    signin(page)
    assert page.locator('#admin-menu-toggle').is_visible();page.locator('#admin-menu-toggle').click()
    assert page.locator('#admin-menu-toggle').get_attribute('aria-expanded')=='true' and page.locator('#admin-nav-body').is_visible()
    page.keyboard.press('Escape');assert page.locator('#admin-menu-toggle').get_attribute('aria-expanded')=='false'
    page.wait_for_selector('.mavi-web-bell');page.locator('.mavi-web-bell').click();assert page.locator('.mavi-web-panel').is_visible();page.locator('.mavi-web-bell').click()
    created=api(page,'/manual-orders',{'customer_name':'هبة سامي','customer_phone':'01012345678','confirm_existing':True,'custom_name':'فستان تدقيق المتصفح','qty':1,'unit_price':1000,'paid':600,'status':'new','channel':'whatsapp'},'POST')
    code=created['code'];initial=state(page,code);pid=initial['payments'][0]['id']
    view(page,'orders');page.wait_for_selector('#orders-search');page.locator('#orders-search').fill(code)
    page.wait_for_function('()=>document.querySelectorAll("#order-list-rows tr[data-search]:not([hidden])").length===1')
    assert page.locator('#order-list-rows tr:not([hidden])').inner_text().find(code)>=0
    page.locator('#orders-search').fill('no-such-order-xyz');assert page.locator('#order-search-empty').is_visible()
    page.locator('#orders-search').fill(code);page.locator('#order-list-rows tr:not([hidden]) button').click()
    page.wait_for_selector('#deposit-management');assert code in page.locator('.head .code').inner_text()
    # Required amount and paid amount are independent, with mandatory consent.
    page.locator('#dm-open-required').click();page.wait_for_selector('#dm-rule-save');page.wait_for_function('()=>document.querySelector("#root").inert')
    page.locator('#dm-rule-save').focus();page.keyboard.press('Tab');assert page.evaluate('document.querySelector("#modal").contains(document.activeElement)')
    page.locator('#dm-rule-save').click();assert 'أكدي' in page.locator('#inv-error').inner_text()
    page.locator('#dm-rule-mode').select_option('fixed');page.locator('#dm-rule-value').fill('700');page.locator('#dm-rule-reason').fill('اتفاق جديد مع العميلة');page.locator('#dm-rule-confirm').check();page.locator('#dm-rule-save').click()
    page.wait_for_selector('#dm-rule-save',state='hidden');page.wait_for_function('()=>!document.querySelector("#root").inert')
    page.wait_for_selector('#dm-open-paid');s=state(page,code);assert s['requirement']['amount']==700 and s['totals']['paid']==600 and len(s['history'])==1
    page.locator('#dm-open-paid').click();page.wait_for_selector('#dm-paid-save')
    page.locator('#dm-paid-save').click();assert 'اختاري الدفعة' in page.locator('#inv-error').inner_text()
    page.locator('#dm-payment-choice').select_option(str(pid));page.locator('#dm-paid-amount').fill('500');page.locator('#dm-paid-reason').fill('تصحيح رقم أُدخل بالخطأ');page.locator('#dm-paid-confirm').check()
    lose_once(page,'**/api/admin/orders/'+code+'/payments/*/correct','#dm-paid-save')
    page.wait_for_selector('#dm-open-paid');s=state(page,code);assert s['totals']['paid']==500 and s['requirement']['amount']==700 and len(s['history'])==2
    page.locator('.dm-history-box summary').click();assert 'تصحيح رقم أُدخل بالخطأ' in page.locator('.dm-history-box').inner_text()
    assert '500' in page.locator('#deposit-management').inner_text() and '700' in page.locator('#deposit-management').inner_text()
    page.locator('button[onclick^="addPayment"]').click();page.wait_for_selector('#dm-new-save')
    page.locator('#dm-new-save').click();assert 'أكدي' in page.locator('#inv-error').inner_text()
    page.locator('#dm-new-amount').fill('150');page.locator('#dm-new-method').select_option('wallet');page.locator('#dm-new-note').fill('دفعة مستلمة فعلًا');page.locator('#dm-new-confirm').check()
    lose_once(page,'**/api/admin/orders/'+code+'/payments','#dm-new-save')
    page.wait_for_selector('#dm-open-paid');s=state(page,code);assert s['totals']['paid']==650 and len(s['payments'])==2 and len(s['history'])==2
    # Even a fully paid order can record a genuinely received overpayment, but
    # only after the explicit overpayment warning has been accepted.
    full=api(page,'/manual-orders',{'customer_name':'هبة سامي','customer_phone':'01012345678','confirm_existing':True,'custom_name':'دفعة زائدة','qty':1,'unit_price':1000,'paid':1000,'status':'new','channel':'whatsapp'},'POST')['code']
    open_order(page,full);page.locator('button[onclick^="addPayment"]').click();page.wait_for_selector('#dm-new-save');page.locator('#dm-new-amount').fill('20');page.locator('#dm-new-confirm').check()
    page.once('dialog',lambda d:d.dismiss());page.locator('#dm-new-save').click();assert state(page,full)['totals']['paid']==1000
    page.once('dialog',lambda d:d.accept());page.locator('#dm-new-save').click();page.wait_for_selector('#dm-new-save',state='hidden');page.wait_for_selector('#dm-open-paid');assert state(page,full)['totals']['paid']==1020
    # Unsaved cost rows are protected on same-view navigation, other navigation,
    # status changes, language changes and browser unload.
    open_order(page,code);page.locator('button[onclick="addPurchase(\'other\')"]').click();row=page.locator('#purchase-other-rows .purchase-row').last;row.locator('.p-label').fill('لا تمسحي الإدخال')
    assert page.evaluate('''()=>{const e=new Event('beforeunload',{cancelable:true});window.dispatchEvent(e);return e.defaultPrevented}''')
    page.once('dialog',lambda d:d.dismiss());page.evaluate("go('order')");assert row.locator('.p-label').input_value()=='لا تمسحي الإدخال'
    page.once('dialog',lambda d:d.dismiss());page.evaluate("go('orders')");assert row.locator('.p-label').input_value()=='لا تمسحي الإدخال'
    page.once('dialog',lambda d:d.dismiss());page.evaluate("setStatus(CURRENT,'confirmed')");assert state(page,code)['status']=='new'
    page.once('dialog',lambda d:d.dismiss());page.evaluate('switchLanguage()');assert page.evaluate('document.documentElement.lang')=='ar'
    row.locator('button[onclick="removePurchase(this)"]').click();assert not page.evaluate('hasUnsavedOtherPurchases()')
    # Pending ordinary receipts lock both actions and do not create a payment.
    customer=page.evaluate("""async()=>{let r=await fetch('/api/store/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone:'01012345678',password:'mavi1234'})});return (await r.json()).token}""")
    on=store(page,'/orders',customer,{'style_id':'DR-04','colour':'أسود','length_cm':140,'fabric_choice':'قماش العميلة','qty':1,'delivery':False},'POST')['order']['code']
    api(page,'/order-deposits/'+on+'/quote',{'percent':50,'payment_details':'حساب اختبار'},'POST')
    api(page,'/order-deposits/'+on+'/receipt',{'image':DATA,'method':'wallet'},'POST');open_order(page,on)
    assert page.locator('#dm-open-required').is_disabled() and page.locator('#dm-open-paid').is_disabled()
    assert 'إيصال قيد المراجعة' in page.locator('#deposit-management').inner_text() and state(page,on)['totals']['paid']==0
    # Standalone custom quote supports its own required-amount editor and shows
    # history before an order exists and while its receipt awaits review.
    custom=store(page,'/custom-requests',customer,{'image':DATA,'governorate':'الجيزة','fabric_choice':'قماش العميلة'},'POST')['id']
    api(page,'/custom-requests/'+str(custom)+'/quote',{'price':1000,'percent':50,'shipping_fee':100,'payment_details':'حساب اختبار'},'POST')
    view(page,'orders');entry=page.locator('[data-custom-alert-id="'+str(custom)+'"]');entry.locator('summary').first.click();entry.locator('button[onclick^="openCustomRequirement"]').click();page.wait_for_selector('#dm-rule-save')
    page.locator('#dm-rule-mode').select_option('fixed');page.locator('#dm-rule-value').fill('320');page.locator('#dm-rule-reason').fill('اتفاق التصميم الجديد');page.locator('#dm-rule-confirm').check();page.locator('#dm-rule-save').click()
    page.wait_for_selector('#dm-rule-save',state='hidden');page.wait_for_function('id=>document.querySelector(`[data-custom-alert-id="${id}"]`)?.open',arg=custom)
    entry=page.locator('[data-custom-alert-id="'+str(custom)+'"]');entry.locator('.dm-history-box summary').click();assert 'اتفاق التصميم الجديد' in entry.locator('.dm-history-box').inner_text()
    custom_state=api(page,'/custom-requests/'+str(custom)+'/deposit-requirement');assert custom_state['requirement']['amount']==320
    api(page,'/custom-requests/'+str(custom)+'/receipt',{'image':DATA,'method':'wallet','quote_revision':custom_state['quote_revision']},'POST')
    view(page,'orders');entry=page.locator('[data-custom-alert-id="'+str(custom)+'"]');entry.locator('summary').first.click();assert entry.locator('.dm-history-box').count()==1 and entry.locator('button[onclick^="openCustomRequirement"]').count()==0
    # Traverse every owner section at mobile, tablet and desktop without page overflow.
    for width in (320,768,1440):
        page.set_viewport_size({'width':width,'height':844})
        for key in ('dash','orders','board','styles','stock','cust','reviews','money','rep','system'):
            view(page,key);overflow(page,f'Arabic {key} {width}')
        page.evaluate("go('cust')");page.wait_for_selector('#customers-search');page.locator('#customers-search').fill('01012345678');assert page.locator('#customer-list-rows tr:not([hidden])').count()>=1
        page.locator('#customers-search').fill('no-customer-xyz');assert page.locator('#customer-search-empty').is_visible()
    # English labels, validation messages, RTL/LTR and owner access.
    enctx=browser.new_context(viewport={'width':390,'height':844});en=enctx.new_page();en.set_default_timeout(15000);en.on('pageerror',lambda e:errors.append(str(e)));signin(en,language='en')
    assert en.evaluate('document.documentElement.dir')=='ltr';open_order(en,code);assert 'Required deposit' in en.locator('#deposit-management').inner_text() and 'Correct recorded payment' in en.locator('#deposit-management').inner_text()
    en.locator('#dm-open-paid').click();en.locator('#dm-payment-choice').select_option(str(pid));en.locator('#dm-paid-amount').fill('480');en.locator('#dm-paid-confirm').check();en.locator('#dm-paid-save').click()
    en.wait_for_function('()=>document.querySelector("#inv-error")?.textContent.includes("Enter a clear reason")');en.keyboard.press('Escape');assert not en.locator('#ovl').evaluate("e=>e.classList.contains('on')")
    for width in (320,768,1440):
        en.set_viewport_size({'width':width,'height':844})
        for key in ('dash','orders','board','styles','stock','cust','reviews','money','rep','system'):
            view(en,key);overflow(en,f'English {key} {width}')
    # Staff cannot see financial management or call owner-only endpoints.
    staffctx=browser.new_context(viewport={'width':390,'height':844});staff=staffctx.new_page();staff.set_default_timeout(15000);staff.on('pageerror',lambda e:errors.append(str(e)));signin(staff,'staff@mavi.eg','mavi-staff');open_order(staff,code,owner=False)
    assert staff.locator('#deposit-management').count()==0 and staff.locator('#order-refunds-panel').count()==0
    denied=staff.evaluate('''async c=>{const r=await fetch('/api/admin/orders/'+c+'/deposit-management',{headers:{authorization:'Bearer '+TOKEN}});return r.status}''',code);assert denied==403
    assert staff.locator('.admin-nav-link[onclick="go(\'money\')"]').count()==0;overflow(staff,'staff')
    assert not errors,errors
    print('PASS: separate required/paid flows, retries, custom history, pending receipts, fully-paid overpayment, dirty protection, searches, menu/bell, accessibility, every admin section and staff privacy in Arabic/English at 320/768/1440')
    browser.close()
