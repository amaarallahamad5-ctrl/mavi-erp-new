# Synthetic data only. Start the test app at 127.0.0.1:3472 with DB_PATH set to
# data/cost-browser-latest.db. Never point this test at a real customer database.
from pathlib import Path
from playwright.sync_api import sync_playwright
import os, random, sqlite3

BASE='http://127.0.0.1:3472'
DB=Path(os.environ.get('MAVI_BROWSER_DB') or (Path(__file__).resolve().parent.parent/'data'/'cost-browser-latest.db'))
assert DB.exists(), 'Create and seed the disposable browser database first.'

def sql(query,args=(),foreign_keys=True):
    with sqlite3.connect(str(DB),timeout=10) as db:
        db.execute('PRAGMA foreign_keys='+('ON' if foreign_keys else 'OFF'))
        db.execute(query,args)

def sign_in(page):
    page.goto(BASE+'/admin/',wait_until='domcontentloaded')
    page.locator('#lemail').fill('owner@mavi.eg');page.locator('#lpass').fill('mavi-owner')
    page.locator('button[onclick="doLogin()"]').click();page.wait_for_function('window.maviAppReady===true')

def api(page,path,body=None,method='GET'):
    return page.evaluate('async x=>await api(x.path,{method:x.method,body:x.body})',{'path':path,'method':method,'body':body})

def new_order(page,name):
    body={'customer_name':'عميلة سيناريو الحواف','customer_phone':'010'+str(random.randrange(10000000,99999999)),
          'channel':'whatsapp','custom_name':name,'qty':2,'unit_price':500,'paid':0,'status':'new'}
    result=api(page,'/manual-orders',body,'POST');code=result['code']
    item=api(page,'/orders/'+code)['order']['items'][0]['id']
    return code,item

def order_cost(page,code):
    return api(page,'/orders/'+code)['order']['totals']['cost']

def open_order(page,code):
    page.evaluate('code=>openOrder(code)',code)
    page.wait_for_selector('#purchase-fabric-rows',state='attached')

def new_row(page,kind):
    page.locator(f"button[onclick=\"addPurchase('{kind}')\"]").click()
    return page.locator(f'#purchase-{kind}-rows .purchase-row[data-id="0"]')

def wait_saved(page,kind,count):
    page.wait_for_function('x=>document.querySelectorAll(`#purchase-${x.kind}-rows .purchase-row[data-id]:not([data-id="0"])`).length===x.count && !document.querySelector(`#purchase-${x.kind}-rows .purchase-row[data-id="0"]`)',arg={'kind':kind,'count':count})

def save_edited(page,row):
    selector=f'.purchase-row[data-type="{row.get_attribute("data-type")}"][data-id="{row.get_attribute("data-id")}"]'
    row.locator('button',has_text='حفظ البند').click()
    page.wait_for_function('x=>document.querySelector(x)?.dataset.dirty==="0"',arg=selector)

with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,args=['--no-sandbox'])
    ctx=browser.new_context(viewport={'width':390,'height':844});page=ctx.new_page();page.set_default_timeout(10000)
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    sign_in(page);code,item=new_order(page,'اختبار تعديل وتكرار');base='/orders/'+code+'/cost-purchases'
    open_order(page,code)

    # The server commits, but the browser loses the response. The same UI retry
    # must reuse its token and not add the purchase a second time.
    row=new_row(page,'fabric');row.locator('.p-name').fill('شراء بعد انقطاع')
    row.locator('.p-qty').fill('2');row.locator('.p-price').fill('25');row.locator('.p-shipping').fill('5')
    token=row.get_attribute('data-token');committed=[]
    pattern='**/api/admin/orders/*/cost-purchases/fabric'
    def lose_reply(route):
        if route.request.method=='POST':
            response=route.fetch();committed.append(response.status);route.abort('failed')
        else: route.continue_()
    page.route(pattern,lose_reply);row.locator('button',has_text='حفظ البند').click()
    page.wait_for_function('document.querySelector("#toast")?.textContent.includes("تعذر تأكيد الحفظ")')
    assert committed==[201] and order_cost(page,code)==60
    assert row.get_attribute('data-id')=='0' and row.get_attribute('data-token')==token
    page.unroute(pattern,lose_reply);row.locator('button',has_text='حفظ البند').click();wait_saved(page,'fabric',1)
    assert order_cost(page,code)==60 and len(api(page,base)['purchases'])==1

    # Edit a saved purchase, then protect unsaved per-item cost lines on refresh.
    row=page.locator('#purchase-fabric-rows .purchase-row').first;row.locator('.p-price').fill('30');save_edited(page,row)
    assert order_cost(page,code)==70
    page.evaluate('id=>addCostRow(id)',item);manual=page.locator(f'#costrows-{item} .costrow').last
    manual.locator('.cl-name').fill('تعديل لم يحفظ');manual.locator('.cl-unit').fill('7')
    row=page.locator('#purchase-fabric-rows .purchase-row').first;row.locator('.p-price').fill('31')
    page.once('dialog',lambda d:d.dismiss());row.locator('button',has_text='حفظ البند').click()
    assert order_cost(page,code)==70 and manual.locator('.cl-name').input_value()=='تعديل لم يحفظ'
    page.evaluate('render()');page.wait_for_function('document.querySelector("#purchase-fabric-rows .purchase-row")?.dataset.dirty==="0"')

    # A second workshop for the same item/worker asks whether it is genuinely a
    # separate job. Dismissing changes nothing; confirming adds it once.
    row=new_row(page,'workshop');row.locator('.p-choice').select_option(index=1);wid=int(row.locator('.p-choice').input_value());row.locator('.p-price').fill('80')
    row.locator('button',has_text='حفظ البند').click();wait_saved(page,'workshop',1);assert order_cost(page,code)==230
    row=new_row(page,'workshop');row.locator('.p-choice').select_option(str(wid));row.locator('.p-price').fill('10')
    dialogs=[]
    def dismiss_duplicate(d): dialogs.append(d.message);d.dismiss()
    page.once('dialog',dismiss_duplicate);row.locator('button',has_text='حفظ البند').click()
    assert dialogs and 'مسجلة لهذه القطعة' in dialogs[0] and order_cost(page,code)==230
    page.once('dialog',lambda d:d.accept());row.locator('button',has_text='حفظ البند').click();wait_saved(page,'workshop',2)
    assert order_cost(page,code)==250
    row=page.locator('#purchase-workshop-rows .purchase-row').first;row.locator('.p-price').fill('90');row.locator('.p-note').fill('تعديل محفوظ');save_edited(page,row)
    assert order_cost(page,code)==270

    # Whole-order extras can be edited and deleted; the confirmation matters.
    row=new_row(page,'other');row.locator('.p-label').fill('تغليف');row.locator('.p-amount').fill('50')
    row.locator('button',has_text='حفظ البند').click();wait_saved(page,'other',1);assert order_cost(page,code)==320
    row=page.locator('#purchase-other-rows .purchase-row').first;row.locator('.p-amount').fill('70');save_edited(page,row);assert order_cost(page,code)==340
    page.once('dialog',lambda d:d.dismiss());row.locator('button',has_text='حذف').click();assert order_cost(page,code)==340
    page.once('dialog',lambda d:d.accept());row.locator('button',has_text='حذف').click()
    page.wait_for_function('document.querySelectorAll("#purchase-other-rows .purchase-row").length===0');assert order_cost(page,code)==270

    # The reverse direction also warns: saving manual item costs cannot silently
    # discard a dirty purchase.
    row=page.locator('#purchase-fabric-rows .purchase-row').first;row.locator('.p-note').fill('خامة غير محفوظة')
    page.evaluate('id=>addCostRow(id)',item);manual=page.locator(f'#costrows-{item} .costrow').last
    manual.locator('.cl-name').fill('زرار');manual.locator('.cl-unit').fill('8')
    page.once('dialog',lambda d:d.dismiss());page.locator(f'button[onclick="saveCostLines({item})"]').click()
    assert row.locator('.p-note').input_value()=='خامة غير محفوظة' and api(page,f'/order-items/{item}/cost-lines')['lines']==[]
    page.evaluate('render()');page.wait_for_function('document.querySelector("#purchase-fabric-rows .purchase-row")?.dataset.dirty==="0"')

    # Simulate an old inactive workshop: retain the selected snapshot and allow
    # updates on this one entry, but do not offer it for new workshop costs.
    w=api(page,'/tailors',{'name':'ورشة قديمة غير نشطة','rate_per_piece':44},'POST')['id']
    old=api(page,base+'/workshop',{'order_item_id':item,'tailor_id':w,'unit_cost':44},'POST')['id']
    sql('UPDATE tailors SET active=0 WHERE id=?',(w,));open_order(page,code)
    row=page.locator(f'#purchase-workshop-rows .purchase-row[data-id="{old}"]')
    assert row.locator('.p-choice').input_value()==str(w) and 'غير نشطة' in row.locator('.p-choice').inner_text()
    row.locator('.p-note').fill('بعد التعطيل');row.locator('.p-price').fill('45');save_edited(page,row)
    current=next(x for x in api(page,base)['workshops'] if x['id']==old)
    assert current['tailor_id']==w and current['tailor_name']=='ورشة قديمة غير نشطة' and current['unit_cost']==45
    fresh=new_row(page,'workshop');assert fresh.locator(f'.p-choice option[value="{w}"]').count()==0;fresh.locator('button',has_text='حذف').click()

    # A legitimately deleted workshop has a NULL ID but still has its saved name.
    w2=api(page,'/tailors',{'name':'ورشة قديمة محذوفة','rate_per_piece':11},'POST')['id']
    deleted=api(page,base+'/workshop',{'order_item_id':item,'tailor_id':w2,'unit_cost':11},'POST')['id']
    sql('DELETE FROM tailors WHERE id=?',(w2,));open_order(page,code)
    row=page.locator(f'#purchase-workshop-rows .purchase-row[data-id="{deleted}"]')
    assert row.locator('.p-choice').input_value()=='' and 'ورشة قديمة محذوفة' in row.locator('.p-choice').inner_text()
    row.locator('.p-note').fill('الاسم محفوظ');row.locator('.p-price').fill('12');save_edited(page,row)
    current=next(x for x in api(page,base)['workshops'] if x['id']==deleted)
    assert current['tailor_id'] is None and current['tailor_name']=='ورشة قديمة محذوفة' and current['unit_cost']==12

    # Simulate corrupted legacy references with FK enforcement off. The UI must
    # show them rather than implicitly clear them; an explicit relink fixes them.
    f=api(page,'/inventory/fabric',{'name':'مرجع خامة قديم'},'POST')['id']
    old_f=api(page,base+'/fabric',{'fabric_id':f,'fabric_name':'مرجع خامة قديم','metres':1,'price_per_metre':20,'shipping_per_metre':0},'POST')['id']
    sql('DELETE FROM fabric WHERE id=?',(f,),False);open_order(page,code)
    row=page.locator(f'#purchase-fabric-rows .purchase-row[data-id="{old_f}"]')
    assert row.locator('.p-choice').input_value()==str(f) and 'غير متاح' in row.locator('.p-choice').inner_text()
    row.locator('.p-note').fill('مرجع قديم محفوظ');save_edited(page,row)
    assert next(x for x in api(page,base)['purchases'] if x['id']==old_f)['fabric_id']==f
    row.locator('.p-choice').select_option('1');save_edited(page,row)
    assert next(x for x in api(page,base)['purchases'] if x['id']==old_f)['fabric_id']==1

    w3=api(page,'/tailors',{'name':'مرجع ورشة قديم','rate_per_piece':15},'POST')['id']
    ow=api(page,base+'/workshop',{'order_item_id':item,'tailor_id':w3,'unit_cost':15},'POST')['id']
    sql('DELETE FROM tailors WHERE id=?',(w3,),False);open_order(page,code)
    row=page.locator(f'#purchase-workshop-rows .purchase-row[data-id="{ow}"]')
    assert row.locator('.p-choice').input_value()==str(w3) and 'غير متاح' in row.locator('.p-choice').inner_text()
    row.locator('.p-note').fill('ورشة قديمة محفوظة');save_edited(page,row)
    assert next(x for x in api(page,base)['workshops'] if x['id']==ow)['tailor_id']==w3
    row.locator('.p-choice').select_option(str(wid));row.locator('.p-price').fill('15');save_edited(page,row)
    assert next(x for x in api(page,base)['workshops'] if x['id']==ow)['tailor_id']==wid
    with sqlite3.connect(str(DB)) as db: assert db.execute('PRAGMA foreign_key_check').fetchall()==[]

    # Cancelled/unpriced cost is reported as excluded rather than silently
    # presented as part of profit. This status update touches the disposable DB.
    cancelled,_=new_order(page,'تكلفة ملغاة')
    api(page,'/orders/'+cancelled+'/cost-purchases/other',{'label':'تجربة ملغاة','amount':60},'POST')
    api(page,'/orders/'+cancelled+'/status',{'status':'cancelled'},'PATCH')
    pending,pending_item=new_order(page,'تكلفة غير مسعرة')
    api(page,'/orders/'+pending+'/cost-purchases/other',{'label':'تجربة غير مسعرة','amount':75},'POST')
    sql("UPDATE order_items SET status='custom_pending' WHERE id=?",(pending_item,))
    page.evaluate("go('rep')");page.wait_for_selector('#rep-from');page.locator('#rep-from').fill('2000-01-01');page.locator('#rep-to').fill('2100-01-01')
    page.locator('button[onclick="periodReport()"]').click()
    page.wait_for_function('document.querySelector("#cost-detail-result")?.textContent.includes("مستبعد من الإجماليات")')
    text=page.locator('#cost-detail-result').inner_text();assert 'طلب ملغي، تكلفة مسجلة' in text and 'طلب ينتظر التسعير، تكلفة مسجلة' in text and '60' in text and '75' in text
    page.evaluate("go('money')");page.wait_for_function('document.querySelector("main")?.textContent.includes("غير داخل في الربح أعلاه")')
    finance=page.locator('main').inner_text();assert '60' in finance and '75' in finance
    assert not errors,errors
    print('PASS: browser retry after lost response, edits, duplicate confirmation, dirty changes, inactive/deleted/orphan references and excluded-cost reports')
    ctx.close();browser.close()
