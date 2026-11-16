# Synthetic demo data only. Never aim this test at a production server.
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
 b=p.chromium.launch(headless=True,args=['--no-sandbox'])
 for w in [320,360,390,768,1280]:
  pg=b.new_page(viewport={'width':w,'height':800});errors=[];pg.on('pageerror',lambda e:errors.append(str(e)))
  pg.goto('http://127.0.0.1:3472/store/',wait_until='domcontentloaded');pg.wait_for_selector('.pcard');pg.locator('[data-choice="no"]').click()
  pg.locator('.pcard').first.click();pg.get_by_role('button',name='أضيفي للسلة').click();pg.locator('.mavi-cart-float').click();pg.wait_for_timeout(200)
  assert pg.locator('.mcart-head').is_visible();assert pg.locator('.mcart-photo').count()==1
  overflow=pg.evaluate('document.documentElement.scrollWidth > document.documentElement.clientWidth');assert not overflow,(w,overflow)
  bnd=pg.locator('.mcart-item').bounding_box();assert bnd['x']>=0 and bnd['x']+bnd['width']<=w+1,(w,bnd)
  assert not errors,errors;pg.close();print('PASS',w)
 pg=b.new_page(viewport={'width':390,'height':800});pg.add_init_script("localStorage.setItem('mavi_language','en')");pg.goto('http://127.0.0.1:3472/store/',wait_until='domcontentloaded');pg.wait_for_selector('.pcard');pg.locator('[data-choice="no"]').click();pg.locator('.mavi-cart-float').click();assert 'Your shopping bag' in pg.locator('.mcart-head').inner_text();print('PASS English');b.close()
