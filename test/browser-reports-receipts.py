# Run only against a fresh synthetic DB served at http://127.0.0.1:3472.
# Exercises owner workflows, no automatic approval, report tabs and staff privacy.
from pathlib import Path
from playwright.sync_api import sync_playwright
import base64, os, random, sqlite3

BASE=os.environ.get('MAVI_BROWSER_BASE','http://127.0.0.1:3472').rstrip('/')
assert os.environ.get('MAVI_BROWSER_DB'), 'Set MAVI_BROWSER_DB to the synthetic DB served on port 3472.'
DB=Path(os.environ['MAVI_BROWSER_DB']);assert DB.exists()
IMAGE=Path(__file__).resolve().parent.parent/'public'/'brand'/'icon-192.png'
DATA='data:image/png;base64,'+base64.b64encode(IMAGE.read_bytes()).decode()

def signin(page,email='owner@mavi.eg',password='mavi-owner'):
    page.goto(BASE+'/admin/',wait_until='domcontentloaded')
    page.locator('#lemail').fill(email);page.locator('#lpass').fill(password)
    page.locator('button[onclick="doLogin()"]').click();page.wait_for_function('()=>window.maviAppReady===true')

def call(page,path,body=None,method='GET'):
    return page.evaluate('async x=>await api(x.path,{method:x.method,body:x.body})',{'path':path,'method':method,'body':body})

def store(page,path,token,body=None,method='GET'):
    result=page.evaluate('''async x=>{let r=await fetch('/api/store'+x.path,{method:x.method,headers:{'content-type':'application/json',authorization:'Bearer '+x.token},body:x.body?JSON.stringify(x.body):undefined});return {status:r.status,data:await r.json()}}''',{'path':path,'token':token,'body':body,'method':method})
    assert result['status'] in (200,201),result
    return result['data']

def deposit(page,code):
    return call(page,'/order-deposits/'+code)['deposit']

def open_order(page,code):
    page.evaluate('code=>openOrder(code)',code)
    page.wait_for_function('code=>document.querySelector("main .head .code")?.textContent.trim()===code',arg=code)
    page.wait_for_selector('#purchase-fabric-rows',state='attached')

def upload_form(page,kind='order',key=None):
    selector=f'.admin-receipt[data-kind="{kind}"]'+(f'[data-key="{key}"]' if key is not None else '')
    return page.locator(selector)

def overflow(page,label):
    v=page.evaluate('({scroll:document.documentElement.scrollWidth,width:window.innerWidth})')
    assert v['scroll']<=v['width']+1,(label,v)

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
    context=browser.new_context(viewport={'width':390,'height':844})
    page=context.new_page();page.set_default_timeout(12000);errors=[]
    page.on('pageerror',lambda e:errors.append(str(e)))
    signin(page)
    # The customer login deliberately replaces the shared session cookie.
    # The admin still uses its own bearer token, including for private images.
    login=page.evaluate("""async()=>{const r=await fetch('/api/store/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:'01012345678',password:'mavi1234'})});return {status:r.status,data:await r.json()}}""")
    assert login['status']==200;customer=login['data']['token']
    style_id='RECEIPT'+str(random.randrange(100000,999999))
    call(page,'/catalogue/styles',{'id':style_id,'name':'فستان تجربة الإيصال','price':1200,'lead_days':10,'colours':['أسود'],'fabrics':['ساتان'],'active':True},'POST')
    def new_order():
        return store(page,'/orders',customer,{'style_id':style_id,'colour':'أسود','fabric_choice':'قماش العميلة','qty':1,'delivery':True,'governorate':'الجيزة'},'POST')['order']['code']
    def quote(code):
        call(page,'/order-deposits/'+code+'/quote',{'percent':50,'shipping_fee':125,'payment_details':'Instapay test'},'POST')

    code=new_order();quote(code);open_order(page,code)
    form=upload_form(page);assert form.count()==1
    form.locator('.admin-receipt-file').set_input_files(str(IMAGE))
    # A changed quote must be saved before upload; the stored offer is unchanged.
    page.locator('#od-percent').fill('60');form.locator('button',has_text='رفع الصورة للمراجعة').click()
    page.wait_for_function('()=>document.querySelector("#toast")?.textContent.includes("احفظي تعديل العرض")')
    assert deposit(page,code)['status']=='quoted' and deposit(page,code)['percent']==50
    page.locator('#od-percent').fill('50');form.locator('.admin-receipt-method').select_option('instapay')
    form.locator('button',has_text='رفع الصورة للمراجعة').click()
    page.wait_for_function('()=>document.querySelector("img[data-private-receipt]")?.naturalWidth>0')
    d=deposit(page,code);assert d['status']=='receipt_pending' and d['receipt_source']=='admin' and d['paid_to_date']==0
    assert 'رفعتها الإدارة' in page.locator('main').inner_text();assert page.locator('.private-receipt-zoom').is_enabled()
    page.locator('.private-receipt-zoom').click();assert 'الصورة وحدها لا تؤكد الدفع' in page.locator('#modal').inner_text()
    page.locator('#modal button[onclick="closeModal()"]').click()
    # Dismissing confirmation leaves the upload pending and does not pay.
    page.once('dialog',lambda dialog:dialog.dismiss())
    page.locator('button[onclick*="decideOrderDeposit"][onclick*="approve"]').click()
    assert deposit(page,code)['status']=='receipt_pending' and deposit(page,code)['paid_to_date']==0
    page.once('dialog',lambda dialog:dialog.accept())
    page.locator('button[onclick*="decideOrderDeposit"][onclick*="approve"]').click()
    page.wait_for_function('async c=>(await api("/order-deposits/"+c)).deposit.status==="approved"',arg=code)
    d=deposit(page,code);assert d['paid_to_date']==662.5 and d['confirmed_payment_id']

    # A previous identical transfer requires an explicit owner selection.
    prior=new_order();quote(prior)
    blocked=page.evaluate('''async code=>{const r=await fetch('/api/admin/orders/'+code+'/payments',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+TOKEN},body:JSON.stringify({amount:662.5,method:'wallet'})});return r.status}''',prior)
    assert blocked==409
    # Synthetic legacy payment: it existed before this release's guard.
    with sqlite3.connect(str(DB),timeout=10) as db:
        db.execute("INSERT INTO payments(order_id,amount,method,note) SELECT id,662.5,'wallet','دفعة مسجلة مسبقًا' FROM orders WHERE code=?",(prior,))
    open_order(page,prior);assert page.locator('button[onclick^="addPayment("]').count()==0
    form=upload_form(page);form.locator('.admin-receipt-file').set_input_files(str(IMAGE));form.locator('button',has_text='رفع الصورة للمراجعة').click()
    page.wait_for_selector('#od-existing-payment');assert page.locator('#od-existing-payment').input_value()==''
    page.locator('button[onclick*="decideOrderDeposit"][onclick*="approve"]').click()
    page.wait_for_function('()=>document.querySelector("#toast")?.textContent.includes("اختاري هل التحويل")')
    assert deposit(page,prior)['status']=='receipt_pending'
    match=deposit(page,prior)['matching_payments'][0]['id'];page.locator('#od-existing-payment').select_option(str(match))
    page.once('dialog',lambda dialog:dialog.accept());page.locator('button[onclick*="decideOrderDeposit"][onclick*="approve"]').click()
    page.wait_for_function('async c=>(await api("/order-deposits/"+c)).deposit.status==="approved"',arg=prior)
    assert deposit(page,prior)['paid_to_date']==662.5 and len(call(page,'/orders/'+prior)['order']['payments'])==1

    # A previous payment covering the whole order can include the deposit;
    # a different amount/method is explicitly highlighted before linking.
    full=new_order();quote(full)
    with sqlite3.connect(str(DB),timeout=10) as db:
        db.execute("INSERT INTO payments(order_id,amount,method,note) SELECT id,1325,'cash','إجمالي سابق' FROM orders WHERE code=?",(full,))
    open_order(page,full);form=upload_form(page);form.locator('.admin-receipt-file').set_input_files(str(IMAGE));form.locator('button',has_text='رفع الصورة للمراجعة').click()
    page.wait_for_selector('#od-existing-payment');fd=deposit(page,full);full_id=fd['linkable_payments'][0]['id']
    assert fd['matching_payments']==[] and 'مبلغ/طريقة مختلفة' in page.locator('#od-existing-payment').inner_text()
    page.locator('#od-existing-payment').select_option(str(full_id));confirmations=[]
    def accept_different(dialog): confirmations.append(dialog.message);dialog.accept()
    page.once('dialog',accept_different);page.locator('button[onclick*="decideOrderDeposit"][onclick*="approve"]').click()
    page.wait_for_function('async c=>(await api("/order-deposits/"+c)).deposit.status==="approved"',arg=full)
    assert confirmations and 'مبلغ الدفعة أو طريقتها مختلف' in confirmations[0] and deposit(page,full)['paid_to_date']==1325

    # If the network drops after commit, do not blindly submit the picture twice.
    uncertain=new_order();quote(uncertain);open_order(page,uncertain);form=upload_form(page)
    form.locator('.admin-receipt-file').set_input_files(str(IMAGE));commits=[]
    pattern='**/api/admin/order-deposits/'+uncertain+'/receipt'
    def lose_response(route):
        if route.request.method=='POST':
            response=route.fetch();commits.append(response.status);route.abort('failed')
        else:route.continue_()
    page.route(pattern,lose_response);form.locator('button',has_text='رفع الصورة للمراجعة').click()
    page.wait_for_function('()=>document.querySelector("#toast")?.textContent.includes("تعذر تأكيد الرفع")')
    page.unroute(pattern,lose_response);assert commits==[200] and deposit(page,uncertain)['status']=='receipt_pending'
    open_order(page,uncertain);page.wait_for_function('()=>document.querySelector("img[data-private-receipt]")?.naturalWidth>0')
    assert upload_form(page).count()==0
    # Rejection enables a fresh upload; leave this one pending for the report.
    page.locator('button',has_text='رفض الإيصال').first.click()
    page.wait_for_selector('.admin-receipt[data-kind="order"]');assert deposit(page,uncertain)['status']=='receipt_rejected'
    form=upload_form(page);form.locator('.admin-receipt-file').set_input_files(str(IMAGE));form.locator('button',has_text='رفع الصورة للمراجعة').click()
    page.wait_for_function('async c=>(await api("/order-deposits/"+c)).deposit.status==="receipt_pending"',arg=uncertain)
    assert deposit(page,uncertain)['paid_to_date']==0

    # Legacy single custom-design request: upload first; order and payment are
    # created only by a later confirmation.
    custom=store(page,'/custom-requests',customer,{'image':DATA,'governorate':'الجيزة','fabric_choice':'قماش العميلة','details':'تجربة تصميم'},'POST')['id']
    page.evaluate('id=>window.maviOpenCustomAdmin(id)',custom)
    page.wait_for_selector(f'[data-custom-alert-id="{custom}"][open]')
    section=page.locator(f'[data-custom-alert-id="{custom}"]')
    section.locator(f'#cq-price-{custom}').fill('2000');section.locator(f'#cq-shipping-{custom}').fill('100');section.locator(f'#cq-percent-{custom}').fill('40');section.locator(f'#cq-payment-{custom}').fill('Instapay test')
    with page.expect_response(lambda r:f'/api/admin/custom-requests/{custom}/quote' in r.url and r.request.method=='POST') as response:
        section.locator('button',has_text='حفظ السعر وإظهاره للعميلة').click()
    assert response.value.status==200
    page.wait_for_selector(f'[data-custom-alert-id="{custom}"][open] .admin-receipt[data-kind="custom"]')
    form=upload_form(page,'custom',custom);form.locator('.admin-receipt-file').set_input_files(str(IMAGE));form.locator('button',has_text='رفع الصورة للمراجعة').click()
    page.wait_for_function('id=>document.querySelector(`[data-custom-alert-id="${id}"][open] img[data-private-receipt]`)?.naturalWidth>0',arg=custom)
    row=next(x for x in call(page,'/custom-requests')['requests'] if x['id']==custom)
    assert row['status']=='receipt_pending' and row['receipt_source']=='admin'
    before=store(page,'/orders',customer)['orders'];assert not any(x.get('custom_request_id')==custom for x in before)
    section=page.locator(f'[data-custom-alert-id="{custom}"]');page.once('dialog',lambda dialog:dialog.dismiss())
    section.locator('button',has_text='تأكيد استلام العربون').click();assert next(x for x in call(page,'/custom-requests')['requests'] if x['id']==custom)['status']=='receipt_pending'
    page.once('dialog',lambda dialog:dialog.accept())
    with page.expect_response(lambda r:f'/api/admin/custom-requests/{custom}/decision' in r.url and r.request.method=='POST') as response:
        section.locator('button',has_text='تأكيد استلام العربون').click()
    created=response.value.json();assert response.value.status==200 and created['order_code']
    custom_order=created['order_code'];page.wait_for_function('c=>document.querySelector("main")?.textContent.includes(c)',arg=custom_order)
    assert call(page,'/orders/'+custom_order)['order']['totals']['paid']==840

    # Prepare one precisely costed order for the report UI.
    manual=call(page,'/manual-orders',{'customer_name':'عميلة تقرير تجربة','customer_phone':'010'+str(random.randrange(10000000,99999999)),'channel':'whatsapp','custom_name':'تصميم تقرير فريد','qty':2,'unit_price':1000,'paid':200,'shipping_fee':100,'governorate':'الجيزة','promise_date':'2001-01-01','status':'new'},'POST')['code']
    item=call(page,'/orders/'+manual)['order']['items'][0]['id'];base='/orders/'+manual+'/cost-purchases/'
    fabric_name='خامة '+str(random.randrange(100000,999999))+' <img src=x onerror=window.__rptXSS=1>'
    call(page,base+'fabric',{'fabric_name':fabric_name,'metres':3,'price_per_metre':100,'shipping_per_metre':10},'POST')
    call(page,base+'workshop',{'order_item_id':item,'tailor_id':1,'unit_cost':80},'POST')
    call(page,base+'other',{'label':'تغليف تقرير','amount':40},'POST')
    call(page,'/order-items/'+str(item)+'/cost-lines',{'lines':[{'label':'زرار','quantity':1,'unit_cost':20}]},'PUT')
    totals=call(page,'/orders/'+manual)['order']['totals'];assert totals['total']==2100 and totals['cost']==570 and totals['profit']==1530
    # Open follow-up items created before the selected report period must not disappear.
    past=call(page,'/manual-orders',{'customer_name':'عميلة قديمة تجربة','customer_phone':'010'+str(random.randrange(10000000,99999999)),'channel':'whatsapp','custom_name':'طلب متأخر قديم','qty':1,'unit_price':300,'paid':0,'promise_date':'1999-02-01','status':'new'},'POST')['code']
    old_deposit=new_order();quote(old_deposit);call(page,'/order-deposits/'+old_deposit+'/receipt',{'image':DATA,'method':'wallet'},'POST')
    with sqlite3.connect(str(DB),timeout=10) as db:
        db.execute("UPDATE orders SET created_at='1999-01-01 10:00:00' WHERE code IN (?,?)",(past,old_deposit))
    page.evaluate("go('rep')");page.wait_for_selector('#rep-from');page.locator('#rep-from').fill('2000-01-01');page.locator('#rep-to').fill('2100-01-01');page.locator('button[onclick="periodReport()"]').click()
    page.wait_for_function('(code)=>document.querySelector("#cost-detail-result")?.textContent.includes(code)',arg=manual)
    page.wait_for_function('()=>document.querySelector("#rh-status")?.textContent==="تم تحديث التقرير."')
    page.locator('[data-rh-button="sales"]').click();assert page.locator('[data-rh-button="sales"]').get_attribute('aria-selected')=='true'
    sales=page.locator('#rh-section-sales').inner_text();assert manual in sales and 'تصميم تقرير فريد' in sales and 'ربحية كل طلب' in sales
    assert '2,100' in sales and '570' in sales and '1,530' in sales
    page.locator('[data-rh-button="comparison"]').click();comparison=page.locator('#rh-section-comparison').inner_text()
    assert 'مقارنة الورش' in comparison and 'مقارنة مشتريات الخامات' in comparison and fabric_name in comparison and '330' in comparison
    assert page.evaluate('window.__rptXSS===undefined')
    page.locator('[data-rh-button="cost"]').click();cost=page.locator('#cost-detail-result').inner_text()
    assert manual in cost and '570' in cost and 'تفصيل المتر' in cost and 'تغليف تقرير' in cost
    page.locator('[data-rh-button="cash"]').click();cash=page.locator('#rh-section-cash').inner_text()
    assert 'متابعة العربون' in cash and uncertain in cash and old_deposit in cash and 'إيصال للمراجعة' in cash and manual in cash and '1,900' in cash
    assert 'كل الفترات' in cash
    page.locator('[data-rh-button="operations"]').click();ops=page.locator('#rh-section-operations').inner_text()
    assert 'مراحل الإنتاج' in ops and 'الطلبات المتأخرة' in ops and manual in ops and past in ops and 'لا يتقيد بفترة التقرير' in ops
    for width in [320,375,390,768,1280]:
        page.set_viewport_size({'width':width,'height':844})
        for tab in ['overview','sales','comparison','cost','cash','operations']:
            page.locator(f'[data-rh-button="{tab}"]').click();overflow(page,f'{tab} {width}')
    assert not errors,errors

    # English labels and a separate staff browser remain usable and private.
    english=browser.new_context(viewport={'width':390,'height':844});en=english.new_page();en.set_default_timeout(12000);en_errors=[];en.on('pageerror',lambda e:en_errors.append(str(e)))
    en.goto(BASE+'/admin/?preview_language=en',wait_until='domcontentloaded');en.fill('#lemail','owner@mavi.eg');en.fill('#lpass','mavi-owner');en.locator('button[onclick="doLogin()"]').click();en.wait_for_function('()=>window.maviAppReady===true');en.evaluate("go('rep')");en.wait_for_selector('#rh-results:not([hidden])')
    assert 'Overview' in en.locator('.rh-tabs').inner_text();en.locator('[data-rh-button="comparison"]').click();assert 'Workshop comparison' in en.locator('#rh-comparison').inner_text();overflow(en,'English reports');assert not en_errors,en_errors
    english.close()
    staff_context=browser.new_context(viewport={'width':390,'height':844});staff=staff_context.new_page();staff.set_default_timeout(12000);signin(staff,'staff@mavi.eg','mavi-staff')
    staff.evaluate('code=>openOrder(code)',uncertain);staff.wait_for_function('code=>document.querySelector("main")?.textContent.includes(code)',arg=uncertain)
    assert staff.locator('.admin-receipt').count()==0 and staff.locator('img[data-private-receipt]').count()==0
    staff.evaluate("go('rep')");staff.wait_for_selector('.locked');assert staff.locator('#rep-from').count()==0
    denied=staff.evaluate("async()=>{const r=await fetch('/api/admin/money/report-hub?from=2000-01-01&to=2100-01-01',{headers:{Authorization:'Bearer '+TOKEN}});return r.status}")
    assert denied==403
    staff_context.close();context.close();browser.close()
    print('PASS: browser report tabs and figures, owner image upload/review/confirmation, lost-response safety, existing-payment linking, custom requests, images across realm cookies, permissions and responsive layouts')
