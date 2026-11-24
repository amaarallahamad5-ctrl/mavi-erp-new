# Browser regression on a disposable synthetic database only.
# Set MAVI_BROWSER_DB and MAVI_BROWSER_BASE to the running test server.
from pathlib import Path
from playwright.sync_api import sync_playwright
import os, random, sqlite3, time

BASE=os.environ.get('MAVI_BROWSER_BASE','http://127.0.0.1:3481').rstrip('/')
assert os.environ.get('MAVI_BROWSER_DB'), 'Set MAVI_BROWSER_DB to the running disposable database.'
DB=Path(os.environ['MAVI_BROWSER_DB']);assert DB.exists()
IMAGE=Path(__file__).resolve().parent.parent/'public'/'brand'/'icon-192.png'

def signin(page,email='owner@mavi.eg',password='mavi-owner',language='ar'):
    page.goto(BASE+'/admin/?preview_language='+language,wait_until='domcontentloaded')
    page.locator('#lemail').fill(email);page.locator('#lpass').fill(password)
    page.locator('button[onclick="doLogin()"]').click();page.wait_for_function('()=>window.maviAppReady===true')

def api(page,path,body=None,method='GET'):
    return page.evaluate('async x=>await api(x.path,{method:x.method,body:x.body})',{'path':path,'body':body,'method':method})

def raw(page,path,body=None,method='GET'):
    return page.evaluate('''async x=>{const r=await fetch('/api/admin'+x.path,{method:x.method,headers:{'content-type':'application/json',authorization:'Bearer '+TOKEN},body:x.body?JSON.stringify(x.body):undefined});return {status:r.status,data:await r.json()}}''',{'path':path,'body':body,'method':method})

def open_order(page,code,owner=True):
    page.evaluate('c=>openOrder(c)',code)
    page.wait_for_function('c=>document.querySelector("main .head .code")?.textContent.trim()===c',arg=code)
    if owner: page.wait_for_selector('#purchase-fabric-rows',state='attached')

def wait_js(page,fn,arg=None,timeout=12.0):
    deadline=time.monotonic()+timeout
    while not page.evaluate(fn,arg):
        if time.monotonic()>deadline: raise TimeoutError('Timed out waiting for: '+fn)
        time.sleep(0.05)

def wait_order(page,code,field,value):
    wait_js(page,'async x=>(await api("/orders/"+x.code)).order[x.field]===x.value',arg={'code':code,'field':field,'value':value})

def overflow(page,label):
    v=page.evaluate('({scroll:document.documentElement.scrollWidth,width:window.innerWidth})')
    assert v['scroll']<=v['width']+1,(label,v)

def accept(page): page.once('dialog',lambda dialog:dialog.accept())

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
    ctx=browser.new_context(viewport={'width':390,'height':844})
    page=ctx.new_page();page.set_default_timeout(12000);errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    signin(page)
    created=api(page,'/manual-orders',{'customer_name':'هبة سامي','customer_phone':'01012345678','confirm_existing':True,'custom_name':'فستان للمتصفح','qty':1,'unit_price':1000,'paid':600,'status':'new','channel':'whatsapp'},'POST')
    original=created['code'];item=api(page,'/orders/'+original)['order']['items'][0]['id']
    api(page,'/orders/'+original+'/cost-purchases/fabric',{'fabric_name':'خامة المتصفح','metres':1.5,'price_per_metre':100,'shipping_per_metre':10},'POST')
    api(page,'/orders/'+original+'/cost-purchases/workshop',{'order_item_id':item,'tailor_id':1,'unit_cost':50},'POST')
    open_order(page,original);overflow(page,'initial order')
    page.locator('button[onclick="openOrderEdit()"]').click();page.wait_for_selector('#oe-code')
    overflow(page,'edit modal')
    new='WEB-'+str(random.randrange(100000,999999))
    page.locator('#oe-code').fill(new);page.locator('#oe-item-name-'+str(item)).fill('فستان جديد للطلب')
    page.locator('#oe-item-qty-'+str(item)).fill('2');page.locator('#oe-item-price-'+str(item)).fill('200')
    accept(page);page.locator('#oe-save').click()
    page.wait_for_function('c=>document.querySelector("main .head .code")?.textContent.trim()===c',arg=new)
    page.wait_for_selector('button[onclick="openOrderEdit()"]');overflow(page,'edited order')
    result=api(page,'/orders/'+new)['order'];assert result['items'][0]['style_name']=='فستان جديد للطلب';assert result['totals']['paid']==600 and result['totals']['due']==-200 and result['totals']['cost']==265
    assert api(page,'/orders/'+original)['order']['code']==new
    assert 'مدفوع زيادة' in page.locator('main').inner_text() and '200' in page.locator('main').inner_text()
    # A dismissed cancellation must not change state; confirmation is explicit.
    page.once('dialog',lambda dialog:dialog.dismiss());page.locator('button[onclick^="cancelOrder"]').click()
    assert api(page,'/orders/'+new)['order']['status']=='new'
    accept(page);page.locator('button[onclick^="cancelOrder"]').click();page.wait_for_selector('button[onclick="reactivateOrder()"]')
    result=api(page,'/orders/'+new)['order'];assert result['status']=='cancelled' and result['totals']['refunded']==0
    assert 'لا توجد مرتجعات مسجلة' in page.locator('#order-refunds-panel').inner_text()
    # Show the confirmation is required, then simulate a dropped response after
    # commit. Retrying the unchanged form must not insert a second refund.
    page.locator('button[onclick="openRefundDialog()"]').click();page.wait_for_selector('#refund-submit')
    overflow(page,'refund modal')
    page.locator('#refund-submit').click();assert 'أكدي أن المبلغ أُعيد' in page.locator('#inv-error').inner_text()
    page.locator('#refund-amount').fill('120');page.locator('#refund-note').fill('تحويل تم بالفعل');page.locator('#refund-method').select_option('wallet');page.locator('#refund-confirm').check()
    commits=[];pattern='**/api/admin/orders/'+new+'/refunds'
    def lose_response(route):
        if route.request.method=='POST':
            response=route.fetch();commits.append(response.status);route.abort('failed')
        else:route.continue_()
    page.route(pattern,lose_response);page.locator('#refund-submit').click()
    page.wait_for_function('()=>document.querySelector("#inv-error")?.textContent.includes("النتيجة غير مؤكدة")')
    page.unroute(pattern,lose_response);assert commits==[201]
    page.locator('#refund-submit').click();page.wait_for_selector('#refund-submit',state='hidden')
    wait_js(page,'async c=>(await api("/orders/"+c)).order.totals.refunded===120',arg=new)
    page.wait_for_function('()=>document.querySelectorAll("#order-refunds-panel .refund-row").length===1')
    result=api(page,'/orders/'+new)['order'];assert result['totals']['paid']==480 and len(result['refunds'])==1
    # Another erroneous record can be corrected only with a reason and explicit
    # confirmation; the old row remains visible.
    page.locator('button[onclick="openRefundDialog()"]').click();page.locator('#refund-amount').fill('20');page.locator('#refund-confirm').check();page.locator('#refund-submit').click()
    wait_js(page,'async c=>(await api("/orders/"+c)).order.totals.refunded===140',arg=new)
    page.wait_for_function('()=>document.querySelectorAll("#order-refunds-panel .refund-row").length===2')
    page.locator('#order-refunds-panel .refund-row button').first.click()
    page.wait_for_selector('#refund-void-submit');page.locator('#refund-void-submit').click();assert 'أكدي أن الإدخال كان خطأ' in page.locator('#inv-error').inner_text()
    page.locator('#refund-void-reason').fill('خطأ في الإدخال');page.locator('#refund-void-confirm').check();page.locator('#refund-void-submit').click()
    wait_js(page,'async c=>(await api("/orders/"+c)).order.totals.refunded===120',arg=new)
    page.wait_for_selector('#order-refunds-panel .refund-row.is-void');assert 'إدخال ملغي لتصحيح خطأ' in page.locator('#order-refunds-panel').inner_text()
    accept(page);page.locator('button[onclick="reactivateOrder()"]').click();page.wait_for_selector('button[onclick^="cancelOrder"]')
    result=api(page,'/orders/'+new)['order'];assert result['status']=='new' and result['totals']['paid']==480 and result['totals']['due']==-80
    assert 'مدفوع زيادة' in page.locator('main').inner_text();overflow(page,'reactivated order')

    # Open reports: gross payments and actual refunds are separate; methods are
    # gross, and the order appears only after reactivation.
    page.evaluate("go('rep')");page.wait_for_selector('#rh-results:not([hidden])')
    page.locator('#rep-from').fill('2000-01-01');page.locator('#rep-to').fill('2099-12-31');page.locator('button[onclick="periodReport()"]').click()
    page.wait_for_function('()=>document.querySelector("#rh-range")?.textContent.includes("2000-01-01")')
    page.locator('#rh-tab-cash').click();cash=page.locator('#rh-cash').inner_text()
    assert 'إجمالي الدفعات' in cash and 'المرتجعات المسجلة' in cash and 'صافي المقبوضات' in cash and 'مرتجعات فعلية خلال الفترة' in cash and new in cash
    overflow(page,'reports cash')
    page.locator('#rh-tab-cost').click();assert 'خامة المتصفح' in page.locator('#cost-detail-result').inner_text()

    # An owner upload and owner approval remain distinct. Editing price after
    # approval and recording an actual refund shows the numerical shortfall.
    login=page.evaluate("""async()=>{let r=await fetch('/api/store/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:'01012345678',password:'mavi1234'})});return await r.json()}""")
    customer=login['token']
    made=page.evaluate('''async token=>{let r=await fetch('/api/store/orders',{method:'POST',headers:{'Content-Type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({style_id:'DR-04',colour:'أسود',length_cm:140,fabric_choice:'قماش العميلة',qty:1,delivery:false})});return await r.json()}''',customer)
    depcode=made['order']['code'];api(page,'/order-deposits/'+depcode+'/quote',{'percent':50,'payment_details':'تجربة تحويل'},'POST');open_order(page,depcode)
    form=page.locator('.admin-receipt[data-kind="order"]');form.locator('.admin-receipt-file').set_input_files(str(IMAGE));form.locator('button[onclick="uploadAdminReceipt(this)"]').click()
    wait_js(page,'async c=>(await api("/order-deposits/"+c)).deposit.status==="receipt_pending"',arg=depcode)
    dep=api(page,'/order-deposits/'+depcode)['deposit'];assert dep['paid_to_date']==0
    page.wait_for_selector('button[onclick*="decideOrderDeposit"][onclick*="approve"]');accept(page);page.locator('button[onclick*="decideOrderDeposit"][onclick*="approve"]').click()
    wait_js(page,'async c=>(await api("/order-deposits/"+c)).deposit.status==="approved"',arg=depcode)
    page.wait_for_selector('button[onclick*="decideOrderDeposit"][onclick*="approve"]',state='detached')
    assert api(page,'/order-deposits/'+depcode)['deposit']['paid_to_date']==625
    page.wait_for_selector('button[onclick="openOrderEdit()"]');page.locator('button[onclick="openOrderEdit()"]').click();page.wait_for_selector('#oe-code')
    depNew='WEB-DEP-'+str(random.randrange(100000,999999));depItem=api(page,'/orders/'+depcode)['order']['items'][0]['id']
    page.locator('#oe-code').fill(depNew);page.locator('#oe-item-price-'+str(depItem)).fill('2000');accept(page);page.locator('#oe-save').click()
    page.wait_for_function('c=>document.querySelector("main .head .code")?.textContent.trim()===c',arg=depNew)
    page.wait_for_selector('button[onclick^="cancelOrder"]');accept(page);page.locator('button[onclick^="cancelOrder"]').click();page.wait_for_selector('button[onclick="reactivateOrder()"]')
    page.locator('button[onclick="openRefundDialog()"]').click();page.wait_for_selector('#refund-amount');page.locator('#refund-amount').fill('200');page.locator('#refund-confirm').check();page.locator('#refund-submit').click()
    wait_js(page,'async c=>(await api("/orders/"+c)).order.totals.refunded===200',arg=depNew)
    page.wait_for_function('()=>document.querySelectorAll("#order-refunds-panel .refund-row").length===1')
    page.wait_for_selector('button[onclick="reactivateOrder()"]')
    accept(page);page.locator('button[onclick="reactivateOrder()"]').click();page.wait_for_selector('button[onclick^="cancelOrder"]')
    page.wait_for_function('()=>document.querySelector("main")?.textContent.includes("نقص العربون المحسوب")')
    text=page.locator('main').inner_text();assert '575' in text and '1,575' in text and '425' in text
    assert page.locator('button[onclick^="askOrderDeposit"]').count()==0
    overflow(page,'deposit shortfall')

    # Customer details resolve the OLD reference to the corrected one. Balances
    # and approved-deposit shortfall are visible, without asking for a full new deposit.
    store=ctx.new_page();store.on('pageerror',lambda e:errors.append(str(e)))
    store.goto(BASE+'/store/',wait_until='domcontentloaded')
    store.evaluate('token=>localStorage.setItem("mavi_store_token",token)',customer);store.reload(wait_until='domcontentloaded');store.wait_for_function('()=>window.maviAppReady===true')
    store.evaluate('c=>window.maviOpenOrderAlert(c)',depcode);store.wait_for_selector('.order-detail')
    assert depNew in store.locator('.order-detail').inner_text();assert '575' in store.locator('.order-detail').inner_text();assert '1,575' in store.locator('.order-detail').inner_text()
    overflow(store,'customer detail')

    # A delivered order can be excluded from reports without implying a physical return.
    delivered=api(page,'/manual-orders',{'customer_name':'هبة سامي','customer_phone':'01012345678','confirm_existing':True,'custom_name':'تم تسليمه','qty':1,'unit_price':500,'paid':0,'status':'delivered','channel':'whatsapp'},'POST')['code']
    open_order(page,delivered);messages=[]
    def capture(dialog):messages.append(dialog.message);dialog.accept()
    page.once('dialog',capture);page.locator('button[onclick^="cancelOrder"]').click();page.wait_for_selector('button[onclick="reactivateOrder()"]')
    assert messages and 'لن تُعاد القطع للمخزون تلقائيًا' in messages[0]
    accept(page);page.locator('button[onclick="reactivateOrder()"]').click();page.wait_for_selector('button[onclick^="cancelOrder"]')
    assert api(page,'/orders/'+delivered)['order']['status']=='delivered'

    # A synthetic old reference may contain quotes or markup. It must be text,
    # not executable markup or inline JavaScript, across admin, store, receipts,
    # print and historical-link handling. Only the disposable DB is modified.
    created_old=page.evaluate('''async token=>{let r=await fetch('/api/store/orders',{method:'POST',headers:{'Content-Type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({style_id:'DR-04',colour:'أسود',length_cm:140,fabric_choice:'قماش العميلة',qty:1,delivery:false})});return await r.json()}''',customer)['order']['code']
    weird='OLD-\'"<img src=x onerror=window.__maviXss=1>'
    with sqlite3.connect(str(DB)) as db: db.execute('UPDATE orders SET code=? WHERE code=?',(weird,created_old))
    page.evaluate("go('orders')");page.wait_for_selector('tr[data-code]')
    row=page.locator('tr[data-code]').filter(has_text=weird).first;row.click();open_order(page,weird)
    assert not page.evaluate('window.__maviXss||false')
    assert page.locator('button[onclick^="showOrderMessage"]').first.get_attribute('data-code')==weird
    # Print output escapes the reference too; the stub avoids a real dialog.
    page.evaluate('''()=>{window.__printHtml='';window.open=()=>({document:{write:s=>window.__printHtml=s,close(){}},print(){}})}''')
    page.locator('button[onclick^="printOrder"]').click();page.wait_for_function('()=>window.__printHtml.length>0')
    printed=page.evaluate('window.__printHtml');assert '&lt;img' in printed and '<img src=x' not in printed
    page.locator('#od-percent').fill('50');page.locator('#od-payment').fill('تجربة تحويل')
    page.locator('button[onclick^="quoteOrderDeposit"]').click()
    wait_js(page,'async c=>(await api("/order-deposits/"+encodeURIComponent(c))).deposit.status==="quoted"',arg=weird)
    store.evaluate("go('mine')");store.evaluate('loadOrders()')
    card=store.locator('.ocard').filter(has_text=weird).first;card.wait_for()
    card.locator('button[onclick^="window.maviOpenOrderAlert"]').click();store.wait_for_selector('.order-detail')
    assert weird in store.locator('.order-detail').inner_text() and not store.evaluate('window.__maviXss||false')
    store.locator('.order-detail input[type=file]').set_input_files(str(IMAGE));store.locator('button[onclick^="sendOrderReceipt"]').click()
    wait_js(page,'async c=>(await api("/order-deposits/"+encodeURIComponent(c))).deposit.status==="receipt_pending"',arg=weird)
    open_order(page,weird);page.wait_for_selector('button[onclick*="decideOrderDeposit"][onclick*="approve"]')
    accept(page);page.locator('button[onclick*="decideOrderDeposit"][onclick*="approve"]').click()
    wait_js(page,'async c=>(await api("/order-deposits/"+encodeURIComponent(c))).deposit.status==="approved"',arg=weird)
    open_order(page,weird);page.locator('.stepper .step[data-code]').nth(1).click();page.wait_for_selector('#msgta')
    assert weird in page.locator('#msgta').input_value() and not page.evaluate('window.__maviXss||false')
    page.locator('button[onclick="closeModal()"]').first.click()
    page.locator('button[onclick="openOrderEdit()"]').click();page.wait_for_selector('#oe-code');assert page.locator('#oe-code').input_value()==weird
    page.locator('#oe-note').fill('حفظ رقم قديم كما هو');page.locator('#oe-save').click();page.wait_for_selector('#oe-code',state='hidden')
    open_order(page,weird);page.locator('button[onclick="openOrderEdit()"]').click();page.wait_for_selector('#oe-code')
    safe_old='SAFE-OLD-'+str(random.randrange(100000,999999));page.locator('#oe-code').fill(safe_old);page.locator('#oe-save').click()
    page.wait_for_function('c=>document.querySelector("main .head .code")?.textContent.trim()===c',arg=safe_old)
    store.evaluate('c=>window.maviOpenOrderAlert(c)',weird);store.wait_for_function('c=>document.querySelector(".order-detail-code")?.textContent===c',arg=safe_old)
    assert not page.evaluate('window.__maviXss||false') and not store.evaluate('window.__maviXss||false')

    # A second open window changing payments invalidates the edit modal instead
    # of overwriting the newer state. English also translates the error.
    enctx=browser.new_context(viewport={'width':1024,'height':768});en=enctx.new_page();en.on('pageerror',lambda e:errors.append(str(e)));signin(en,language='en');open_order(en,new)
    en.locator('button[onclick="openOrderEdit()"]').click();en.wait_for_selector('#oe-code');en.locator('#oe-note').fill('Another note')
    assert raw(en,'/orders/'+new+'/payments',{'amount':1,'method':'cash'},'POST')['status']==201
    en.locator('#oe-save').click();en.wait_for_function('()=>document.querySelector("#inv-error")?.textContent.includes("order changed")')
    assert 'reopen' in en.locator('#inv-error').inner_text().lower();overflow(en,'English stale editor')
    en.locator('button[onclick="closeModal()"]').first.click();open_order(en,new)
    en.locator('button[onclick="openOrderEdit()"]').click();en.wait_for_selector('#oe-code');en.locator('#oe-item-qty-'+str(item)).fill('0')
    accept(en);en.locator('#oe-save').click();en.wait_for_function('()=>document.querySelector("#inv-error")?.textContent.includes("Quantity must")')
    en.locator('button[onclick="closeModal()"]').first.click()
    en.evaluate("go('rep')");en.wait_for_selector('#rh-results:not([hidden])');en.locator('#rh-tab-cash').click()
    assert 'Net receipts' in en.locator('#rh-cash').inner_text() and 'Actual refunds' in en.locator('#rh-cash').inner_text();overflow(en,'English reports')

    # Staff can cancel/reactivate, but never edit or inspect financial refunds.
    sc=browser.new_context(viewport={'width':390,'height':844});staff=sc.new_page();staff.on('pageerror',lambda e:errors.append(str(e)));signin(staff,'staff@mavi.eg','mavi-staff');open_order(staff,new,owner=False)
    assert staff.locator('button[onclick="openOrderEdit()"]').count()==0 and staff.locator('#order-refunds-panel').count()==0
    assert raw(staff,'/orders/'+new+'/edit')['status']==403
    assert not errors,errors
    print('PASS: mobile/desktop browser edit, retry-safe refunds, cancellation/reactivation, shortfall, reports, delivery, aliases, receipt separation, English and staff privacy')
    browser.close()
