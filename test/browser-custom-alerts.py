# Synthetic demo data only. Never aim this test at a production server.
from playwright.sync_api import sync_playwright
import os
BASE=os.environ.get("MAVI_BROWSER_BASE","http://127.0.0.1:3472").rstrip("/")
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox']);err=[]
 c=b.new_page(viewport={'width':390,'height':844});c.on('pageerror',lambda e:err.append(str(e)));c.goto(BASE+'/store/',wait_until='domcontentloaded');c.wait_for_selector('.pcard');c.locator('[data-choice="no"]').click();c.locator('button[onclick="go(\'data\')"]').first.click();c.locator('#phone').fill('01012345678');c.locator('#pass').fill('mavi1234');c.locator('button[onclick="login()"]').click();c.wait_for_timeout(600)
 data=c.evaluate("async()=>{let r=await fetch('/brand/icon-192.png');let blob=await r.blob();let image=await new Promise(res=>{let f=new FileReader();f.onload=()=>res(f.result);f.readAsDataURL(blob)});return await api('/custom-requests',{method:'POST',body:{image,details:'تفاصيل تجريبية',governorate:'الجيزة',fabric_choice:'قماش MAVI',requested_colour:'نبيتي',requested_fabric:'قطيفة'}})}")
 a=b.new_page(viewport={'width':390,'height':844});a.on('pageerror',lambda e:err.append(str(e)));a.goto(BASE+'/admin/',wait_until='domcontentloaded');a.locator('#lemail').fill('owner@mavi.eg');a.locator('#lpass').fill('mavi-owner');a.locator('button[onclick="doLogin()"]').click();a.wait_for_timeout(800);a.evaluate('window.maviAlertsRefresh()');a.wait_for_timeout(300);a.locator('.mavi-web-bell').click();entry=a.locator('.mavi-alert-entry').filter(has_text='تصميم خاص #'+str(data['id'])).first;entry.click();a.wait_for_timeout(400);assert a.locator('[data-custom-alert-id="'+str(data['id'])+'"]').evaluate('(e)=>e.open')
 a.evaluate("async n=>await api('/custom-requests/'+n+'/quote',{method:'POST',body:{price:800,percent:50,shipping_fee:20,payment_details:'Vodafone'}})",data['id'])
 c.evaluate('window.maviAlertsRefresh()');c.wait_for_timeout(500);c.locator('.mavi-web-bell').click();entry=c.locator('.mavi-alert-entry').filter(has_text='تصميم خاص #'+str(data['id'])).first;entry.click();c.wait_for_timeout(700);assert 'تفاصيل تجريبية' in c.locator('.order-detail').inner_text();assert c.locator('.order-detail img').first.evaluate('(e)=>e.naturalWidth')>0
 assert not err,err;print('PASS legacy custom notification links on admin and customer, private photo');b.close()
