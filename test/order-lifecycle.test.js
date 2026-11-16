'use strict';
// Synthetic end-to-end lifecycle, reporting and stock tests. Never uses real data.
const {spawn,spawnSync}=require('child_process');
const fs=require('fs'),path=require('path'),assert=require('assert'),Database=require('better-sqlite3');
const root=path.join(__dirname,'..'),dbPath=path.join(root,'data','lifecycle-test.db'),port=3382,base=`http://127.0.0.1:${port}`;
for(const suffix of ['','-wal','-shm'])fs.rmSync(dbPath+suffix,{force:true});
const env={...process.env,DB_PATH:dbPath,PORT:String(port),SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'};
const seed=spawnSync(process.execPath,['src/seed.js'],{cwd:root,env,encoding:'utf8'});assert.equal(seed.status,0,seed.stderr);
const server=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env,stdio:'ignore'});
async function req(method,url,body,token){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined||body===null?undefined:JSON.stringify(body)});let json;try{json=await r.json()}catch{}return {status:r.status,json};}
function sql(statement,args=[],mode='get'){const d=new Database(dbPath);try{d.pragma('foreign_keys=ON');return d.prepare(statement)[mode](...args)}finally{d.close()}}
const near=(a,b)=>assert(Math.abs(a-b)<1e-7,`${a} != ${b}`);
const A='/api/admin',S='/api/store';
(async()=>{try{
 for(let i=0;i<80;i++){try{await fetch(base+'/healthz');break}catch{await new Promise(r=>setTimeout(r,100))}}
 const owner=(await req('POST',A+'/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'})).json.token;
 const staff=(await req('POST',A+'/auth/login',{email:'staff@mavi.eg',password:'mavi-staff'})).json.token;
 const customer=(await req('POST',S+'/auth/login',{phone:'01012345678',password:'mavi1234'})).json.token;
 const other=(await req('POST',S+'/auth/login',{phone:'01123456789',password:'mavi1234'})).json.token;
 assert(owner&&staff&&customer&&other);
 const image='data:image/png;base64,'+fs.readFileSync(path.join(root,'public/brand/icon-192.png')).toString('base64');
 let counter=0;
 const manual=async(name='فستان تجربة',over={})=>{
  const r=await req('POST',A+'/manual-orders',{customer_name:'هبة سامي',customer_phone:'01012345678',confirm_existing:true,custom_name:name,channel:'whatsapp',status:'new',qty:1,unit_price:1000,paid:0,...over},owner);
  assert.equal(r.status,201,JSON.stringify(r.json));return r.json.code;
 };
 const online=async()=>{
  const r=await req('POST',S+'/orders',{style_id:'DR-04',colour:'أسود',length_cm:140,fabric_choice:'قماش العميلة',qty:1,delivery:false},customer);
  assert.equal(r.status,201,JSON.stringify(r.json));return r.json.order.code;
 };
 const order=async code=>{const r=await req('GET',A+'/orders/'+encodeURIComponent(code),null,owner);assert.equal(r.status,200,JSON.stringify(r.json));return r.json.order};
 const state=async code=>{const r=await req('GET',A+'/orders/'+encodeURIComponent(code)+'/edit',null,owner);assert.equal(r.status,200,JSON.stringify(r.json));return r.json};
 function body(s){const o=s.order;return {revision:s.revision,order:{code:o.code,channel:o.channel,promise_date:o.promise_date||'',governorate:o.governorate||'',delivery_requested:o.delivery_requested,delivery_fee:o.shipping_quoted?o.delivery_fee:'',discount:o.discount,note:o.note||'',fabric_choice:o.fabric_choice||'',contact:{...o.contact},measurements:{...o.measurements}},items:o.items.map(i=>({id:i.id,name:i.name,qty:i.qty,colour:i.colour||'',size:i.size||'',length_cm:i.length_cm,unit_price:i.unit_price,fabric_choice:i.fabric_choice||'',item_note:i.item_note||''}))};}
 const save=(code,b,token=owner)=>req('PATCH',A+'/orders/'+encodeURIComponent(code)+'/edit',b,token);
 const stage=(code,status,token=staff,expected)=>req('PATCH',A+'/orders/'+encodeURIComponent(code)+'/status',{status,...(expected?{expected_status:expected}:{})},token);
 const reactivate=(code,token=staff)=>req('POST',A+'/orders/'+encodeURIComponent(code)+'/reactivate',{},token);
 const quote=async(code,percent=50)=>{const x=await req('POST',A+'/order-deposits/'+code+'/quote',{percent,payment_details:'تجربة تحويل'},owner);assert.equal(x.status,200,JSON.stringify(x.json));};
 const upload=async code=>{const x=await req('POST',A+'/order-deposits/'+code+'/receipt',{image,method:'wallet'},owner);assert.equal(x.status,200,JSON.stringify(x.json));};
 const approve=async code=>{const x=await req('POST',A+'/order-deposits/'+code+'/decision',{decision:'approve'},owner);assert.equal(x.status,200,JSON.stringify(x.json));};
 const refund=async(code,amount,date='2024-02-04',extra={})=>{const o=await order(code);return req('POST',A+'/orders/'+code+'/refunds',{amount,method:'cash',refunded_on:date,note:'',request_id:'lifecycle-refund-'+(++counter),confirm_actual:true,financial_revision:o.financial_revision,...extra},owner)};

 // Order-only editing keeps customer account, catalogue, payments and linked costs.
 const original=await manual('فستان قديم',{qty:2,unit_price:1000,paid:400,shipping_fee:100,governorate:'الجيزة'});
 let o=await order(original),item=o.items[0].id,oid=o.id;
 const profile=sql('SELECT name,phone,area FROM customers WHERE id=?',[o.customer.id]);
 const measurements=sql('SELECT * FROM measurements WHERE customer_id=?',[o.customer.id]);
 const catalogue=sql('SELECT * FROM styles WHERE id=?',[o.items[0].style_id]);
 const payment=sql('SELECT * FROM payments WHERE order_id=?',[oid]);
 sql("UPDATE orders SET created_at='2024-01-05 10:00:00' WHERE id=?",[oid],'run');
 sql("UPDATE payments SET created_at='2024-01-06 10:00:00' WHERE id=?",[payment.id],'run');
 for(const [kind,value] of [['fabric',{fabric_name:'قماش اختبار',metres:2,price_per_metre:80,shipping_per_metre:10}],['workshop',{order_item_id:item,tailor_id:1,unit_cost:50}],['other',{label:'تغليف',amount:25}]])
  assert.equal((await req('POST',`${A}/orders/${original}/cost-purchases/${kind}`,value,owner)).status,201);
 o=await order(original);near(o.totals.cost,305);near(o.totals.total,2100);
 assert.equal((await req('GET',`${A}/orders/${original}/edit`,null,staff)).status,403);
 assert.equal((await req('GET',`${A}/orders/${original}/edit`,null,customer)).status,401);
 let s=await state(original),b=body(s);b.order.code='TEST-ORDER-2026';b.order.contact.name='اسم لهذا الأوردر';b.order.contact.phone='01099887766';b.order.contact.area='عنوان الطلب';b.order.measurements.bust=111;b.items[0].name='فستان ليل';b.items[0].qty=3;b.items[0].unit_price=900;
 assert.equal((await save(original,b,staff)).status,403);
 let r=await save(original,b);assert.equal(r.status,200,JSON.stringify(r.json));const code=r.json.code;assert.equal(code,'TEST-ORDER-2026');near(r.json.totals.total,2800);near(r.json.totals.paid,400);near(r.json.totals.due,2400);near(r.json.totals.cost,355);
 o=await order(code);assert.equal(o.items[0].style_name,'فستان ليل');assert.equal(o.customer.name,'اسم لهذا الأوردر');assert.equal(o.measurements.bust,111);
 assert.deepEqual(sql('SELECT name,phone,area FROM customers WHERE id=?',[o.customer.id]),profile);assert.deepEqual(sql('SELECT * FROM measurements WHERE customer_id=?',[o.customer.id]),measurements);assert.deepEqual(sql('SELECT * FROM styles WHERE id=?',[o.items[0].style_id]),catalogue);
 assert.deepEqual(sql('SELECT id,order_id,amount,method,note FROM payments WHERE id=?',[payment.id]),{id:payment.id,order_id:oid,amount:400,method:payment.method,note:payment.note});
 assert.equal((await order(original)).code,code);assert.equal((await req('GET',`${S}/orders/${original}`,null,customer)).json.order.code,code);assert.equal((await req('GET',`${S}/orders/${original}`,null,other)).status,404);
 assert.equal((await req('GET',`${A}/orders/${original}/cost-purchases`,null,owner)).json.purchases.length,1);
 assert.equal((await req('GET',`${A}/orders/${original}/cost-purchases`,null,owner)).json.workshops[0].quantity,3);

 // Independent revisions do not overwrite newer edits; invalid content is rejected.
 const one=body(await state(code)),two=JSON.parse(JSON.stringify(one));one.order.note='ملاحظة أولى';two.order.note='ملاحظة ثانية';
 const changes=await Promise.all([save(code,one),save(code,two)]);assert.deepEqual(changes.map(x=>x.status).sort(),[200,409]);
 b=body(await state(code));b.items[0].name='<img src=x onerror=alert(1)>';assert.equal((await save(code,b)).status,400);
 const otherCode=await manual('طلب آخر');b=body(await state(otherCode));b.order.code=original;assert.equal((await save(otherCode,b)).status,409);b.order.code=code;assert.equal((await save(otherCode,b)).status,409);

 // Unchanged old punctuation, unusually precise money, and out-of-range legacy
 // measurements survive unrelated edits; newly invalid values remain blocked.
 const legacy=await manual('قديم');const oldId=(await order(legacy)).id;
 sql("UPDATE customers SET name=? WHERE id=(SELECT customer_id FROM orders WHERE id=?)",["هبة & سارة",oldId],'run');
 sql("UPDATE orders SET note=?,delivery_fee=0.1234 WHERE id=?",["ملاحظة 'قديمة' & آمنة",oldId],'run');
 sql("UPDATE order_items SET unit_price=99.1234,item_note=? WHERE order_id=?",["قديم & جديد",oldId],'run');
 sql("UPDATE measurements SET arm=260 WHERE customer_id=(SELECT customer_id FROM orders WHERE id=?)",[oldId],'run');
 s=await state(legacy);b=body(s);b.items[0].name='اسم مصحح';r=await save(legacy,b);assert.equal(r.status,200,JSON.stringify(r.json));
 const saved=sql('SELECT note,delivery_fee FROM orders WHERE id=?',[oldId]);assert.equal(saved.note,"ملاحظة 'قديمة' & آمنة");near(saved.delivery_fee,0.1234);
 assert.equal(sql('SELECT item_note FROM order_items WHERE order_id=?',[oldId]).item_note,'قديم & جديد');assert.equal(sql('SELECT arm FROM measurements WHERE customer_id=?',[profile.id||o.customer.id]).arm,260);
 b=body(await state(legacy));b.order.note='<script>bad</script>';assert.equal((await save(legacy,b)).status,400);
 // Restore only this synthetic shared profile for the remaining test fixtures.
 sql("UPDATE customers SET name=? WHERE id=?",[profile.name,o.customer.id],'run');sql('UPDATE measurements SET arm=? WHERE customer_id=?',[measurements.arm,o.customer.id],'run');

 // Cancel without inventing a refund, then record a real partial refund. All
 // cancelled-order financial movements remain out of every report.
 assert.equal((await stage(code,'sewing')).status,200);
 const staleCancel=await stage(code,'cancelled',staff,'new');assert.equal(staleCancel.status,409);
 const cancelRace=await Promise.all([stage(code,'cancelled',staff,'sewing'),stage(code,'cancelled',staff,'sewing')]);assert.deepEqual(cancelRace.map(x=>x.status).sort(),[200,409]);
 o=await order(code);assert.equal(o.status,'cancelled');assert.equal(o.cancelled_from_status,'sewing');near(o.totals.paid,400);near(o.totals.refunded,0);assert.equal(o.payments.length,1);
 assert.equal((await stage(code,'ready')).status,409);assert.equal((await req('POST',`${A}/orders/${code}/payments`,{amount:10,method:'cash'},owner)).status,409);
 const jan=`?from=2024-01-01&to=2024-01-31`,feb=`?from=2024-02-01&to=2024-02-29`;
 let hub=(await req('GET',A+'/money/report-hub'+jan,null,owner)).json;
 assert.equal(hub.summary.sales,0);assert.equal(hub.summary.cost,0);assert.equal(hub.summary.collected_in_period,0);assert.equal(hub.payments.rows.length,0);assert.equal(hub.cost_detail.rows.length,0);assert(!('recorded_cost' in hub.cost_detail.excluded.cancelled));
 assert(!(await req('GET',A+'/money/outstanding',null,owner)).json.rows.some(x=>x.code===code));
 const rv=o.financial_revision,token='refund-retry-token-001';const draft={amount:120,method:'wallet',refunded_on:'2024-02-04',note:'رد جزء',request_id:token,confirm_actual:true,financial_revision:rv};
 assert.equal((await req('POST',`${A}/orders/${code}/refunds`,{...draft,confirm_actual:false},owner)).status,400);
 assert.equal((await req('POST',`${A}/orders/${code}/refunds`,draft,staff)).status,403);
 assert.equal((await req('POST',`${A}/orders/${code}/refunds`,{...draft,amount:401,request_id:'refund-too-large-01'},owner)).status,409);
 assert.equal((await req('POST',`${A}/orders/${code}/refunds`,{...draft,refunded_on:'2099-01-01',request_id:'refund-future-001'},owner)).status,400);
 const first=await req('POST',`${A}/orders/${code}/refunds`,draft,owner);assert.equal(first.status,201,JSON.stringify(first.json));
 const again=await req('POST',`${A}/orders/${code}/refunds`,draft,owner);assert.equal(again.status,200);assert(again.json.replay);assert.equal(again.json.id,first.json.id);
 assert.equal((await req('POST',`${A}/orders/${code}/refunds`,{...draft,note:'بيانات مختلفة'},owner)).status,409);
 o=await order(code);near(o.totals.paid,280);near(o.totals.refunded,120);assert.equal(o.refunds.length,1);
 hub=(await req('GET',A+'/money/report-hub'+feb,null,owner)).json;assert.equal(hub.summary.collected_in_period,0);assert.equal(hub.payments.refunds.length,0);
 assert((await req('GET',`${A}/deletions/payment/${payment.id}`,null,owner)).json.blocked);
 // A clerical correction is explicit, audited and keeps the voided record.
 const mistake=await refund(code,20);assert.equal(mistake.status,201);o=await order(code);
 const vp=`${A}/orders/${code}/refunds/${mistake.json.id}/void`,vb={reason:'سجل خطأ',confirm_clerical:true,financial_revision:o.financial_revision};
 assert.equal((await req('POST',vp,{...vb,confirm_clerical:false},owner)).status,400);
 assert.equal((await req('POST',vp,{...vb,financial_revision:rv},owner)).status,409);
 assert.equal((await req('POST',vp,vb,owner)).status,200);assert.equal((await req('POST',vp,vb,owner)).status,409);
 const replayVoided=await req('POST',`${A}/orders/${code}/refunds`,{amount:20,method:'cash',refunded_on:'2024-02-04',note:'',request_id:'lifecycle-refund-'+counter,confirm_actual:true,financial_revision:rv},owner);assert.equal(replayVoided.status,409);
 o=await order(code);assert(o.refunds.find(x=>x.id===mistake.json.id).voided_at);near(o.totals.paid,280);near(o.totals.refunded,120);
 r=await reactivate(code);assert.equal(r.status,200,JSON.stringify(r.json));assert.equal(r.json.status,'sewing');assert.equal((await reactivate(code)).status,409);
 hub=(await req('GET',A+'/money/report-hub'+jan,null,owner)).json;near(hub.summary.sales,2800);near(hub.summary.cost,355);near(hub.summary.gross_collected_in_period,400);near(hub.summary.refunded_in_period,0);near(hub.summary.collected_in_period,400);assert.equal(hub.balances.rows[0].due,2520);
 hub=(await req('GET',A+'/money/report-hub'+feb,null,owner)).json;near(hub.summary.gross_collected_in_period,0);near(hub.summary.refunded_in_period,120);near(hub.summary.collected_in_period,-120);assert.equal(hub.payments.refunds.length,1);assert.equal(hub.sales.months.find(x=>x.month==='2024-02').collected,-120);
 const febPeriod=(await req('GET',A+'/money/period'+feb,null,owner)).json;near(febPeriod.collected_in_period,-120);near(febPeriod.refunded_in_period,120);
 const staffView=(await req('GET',`${A}/orders/${code}`,null,staff)).json.order;assert(!('cost' in staffView.totals));assert(!('refunds' in staffView));
 const legacyCancelled=await manual('بدون مرحلة قديمة');sql("UPDATE orders SET status='cancelled',cancelled_from_status=NULL WHERE code=?",[legacyCancelled],'run');
 r=await reactivate(legacyCancelled);assert.equal(r.status,200);assert(r.json.previous_unknown);assert.equal(r.json.status,'new');
 // A full actual refund leaves zero net paid and is never inferred on cancel.
 const full=await manual('رد كامل',{unit_price:500,paid:500});assert.equal((await stage(full,'cancelled')).status,200);
 assert.equal((await order(full)).totals.refunded,0);assert.equal((await refund(full,500)).status,201);near((await order(full)).totals.paid,0);
 assert.equal((await refund(full,0.01)).status,409);assert.equal((await reactivate(full)).status,200);near((await order(full)).totals.due,500);

 // Previously confirmed deposit stays approved; a higher total and actual
 // refund increase the visible shortfall without blocking the previous stage.
 const depositOrder=await online();await quote(depositOrder);await upload(depositOrder);
 let dep=(await req('GET',A+'/order-deposits/'+depositOrder,null,owner)).json.deposit;assert.equal(dep.status,'receipt_pending');near(dep.paid_to_date,0);
 b=body(await state(depositOrder));b.items[0].unit_price=2000;assert.equal((await save(depositOrder,b)).status,409);
 b=body(await state(depositOrder));b.items[0].name='اسم مصحح فقط';assert.equal((await save(depositOrder,b)).status,200);
 await approve(depositOrder);dep=(await req('GET',A+'/order-deposits/'+depositOrder,null,owner)).json.deposit;assert.equal(dep.status,'approved');near(dep.confirmed_amount,625);near(dep.paid_to_date,625);
 assert.equal((await stage(depositOrder,'cut')).status,200);
 b=body(await state(depositOrder));b.items[0].unit_price=2000;assert.equal((await save(depositOrder,b)).status,200);
 assert.equal((await stage(depositOrder,'cancelled')).status,200);assert.equal((await refund(depositOrder,200)).status,201);
 r=await reactivate(depositOrder);assert.equal(r.status,200);assert.equal(r.json.status,'cut');assert(!r.json.needs_deposit_review);
 o=await order(depositOrder);near(o.totals.paid,425);near(o.totals.due,1575);
 const customerOrder=(await req('GET',S+'/orders/'+depositOrder,null,customer)).json.order;assert.equal(customerOrder.deposit.status,'approved');near(customerOrder.deposit.shortfall,575);near(customerOrder.due,1575);
 assert.equal((await stage(depositOrder,'sewing')).status,200); // no replacement-deposit gate

 // A quoted but not approved total change requires a fresh quote, and a known
 // legacy advanced stage is restored even if approval is still pending.
 const unapproved=await online();await quote(unapproved);b=body(await state(unapproved));b.items[0].unit_price=1500;r=await save(unapproved,b);assert.equal(r.status,200);assert(r.json.quote_needs_review);
 assert.equal((await req('GET',A+'/order-deposits/'+unapproved,null,owner)).json.deposit.status,'needs_quote');
 sql("UPDATE orders SET status='ready' WHERE code=?",[unapproved],'run');assert.equal((await stage(unapproved,'cancelled')).status,200);
 r=await reactivate(unapproved);assert.equal(r.status,200);assert.equal(r.json.status,'ready');assert(r.json.needs_deposit_review);

 // Existing-payment approval cannot link an amount already partly refunded as
 // if it still covered the deposit; a stale financial review cannot approve.
 const linkOrder=await online();await quote(linkOrder);
 sql("INSERT INTO payments(order_id,amount,method,note) SELECT id,625,'wallet','تحويل قديم' FROM orders WHERE code=?",[linkOrder],'run');await upload(linkOrder);
 dep=(await req('GET',A+'/order-deposits/'+linkOrder,null,owner)).json.deposit;const payId=dep.recorded_payments[0].id,oldRevision=dep.financial_revision;
 assert.equal((await refund(linkOrder,300)).status,201);
 let decision={decision:'approve',existing_payment_id:payId,review_payment_ids:[payId],confirmed_existing_payment:true,financial_revision:oldRevision};
 assert.equal((await req('POST',A+'/order-deposits/'+linkOrder+'/decision',decision,owner)).status,409);
 dep=(await req('GET',A+'/order-deposits/'+linkOrder,null,owner)).json.deposit;assert.equal(dep.linkable_payments.length,0);decision.financial_revision=dep.financial_revision;
 assert.equal((await req('POST',A+'/order-deposits/'+linkOrder+'/decision',decision,owner)).status,409);
 decision.existing_payment_id=null;r=await req('POST',A+'/order-deposits/'+linkOrder+'/decision',decision,owner);assert.equal(r.status,200,JSON.stringify(r.json));
 dep=(await req('GET',A+'/order-deposits/'+linkOrder,null,owner)).json.deposit;near(dep.confirmed_amount,625);near(dep.paid_to_date,950);assert.equal(dep.recorded_payments.length,2);

 // Stock: approve, cancel, shortage and retry. A two-variant failure rolls back
 // earlier deductions, status, reservation flags, movements and notifications.
 sql("INSERT INTO styles(id,name,type,price,cost,active) VALUES('LIFE-STOCK','مخزون تجريبي','stock',1000,40,1)",[],'run');
 for(const [size,colour,qty] of [['M','أسود',5],['L','أحمر',1],['M','أزرق',2]])sql("INSERT INTO stock_items(style_id,size,colour,qty,buy_price,sell_price) VALUES('LIFE-STOCK',?,?,?,40,1000)",[size,colour,qty],'run');
 const stock=await online(),stockId=(await order(stock)).id;
 sql("UPDATE order_items SET style_id='LIFE-STOCK',size='M',colour='أسود',qty=2,unit_price=1000 WHERE order_id=?",[stockId],'run');
 sql("INSERT INTO order_items(order_id,style_id,size,colour,qty,unit_price,unit_cost) VALUES(?,'LIFE-STOCK','L','أحمر',1,1000,40)",[stockId],'run');
 const quantity=(size,colour)=>sql("SELECT qty FROM stock_items WHERE style_id='LIFE-STOCK' AND size=? AND colour=?",[size,colour]).qty;
 await quote(stock);await upload(stock);await approve(stock);assert.equal(quantity('M','أسود'),3);assert.equal(quantity('L','أحمر'),0);
 assert.equal((await stage(stock,'sewing')).status,200);assert.equal((await stage(stock,'cancelled')).status,200);assert.equal(quantity('M','أسود'),5);assert.equal(quantity('L','أحمر'),1);
 sql("UPDATE stock_items SET qty=0 WHERE style_id='LIFE-STOCK' AND size='L' AND colour='أحمر'",[],'run');
 const movementBefore=sql('SELECT count(*) n FROM stock_movements').n,noticesBefore=sql('SELECT count(*) n FROM customer_notifications').n;
 r=await reactivate(stock);assert.equal(r.status,409,JSON.stringify(r.json));assert.equal(quantity('M','أسود'),5);assert.equal(quantity('L','أحمر'),0);assert.equal((await order(stock)).status,'cancelled');
 assert.equal(sql('SELECT count(*) n FROM stock_movements').n,movementBefore);assert.equal(sql('SELECT count(*) n FROM customer_notifications').n,noticesBefore);assert.equal(sql('SELECT count(*) n FROM stock_reservations r JOIN order_items i ON i.id=r.order_item_id WHERE i.order_id=? AND r.released=1',[stockId]).n,2);
 sql("UPDATE stock_items SET qty=1 WHERE style_id='LIFE-STOCK' AND size='L' AND colour='أحمر'",[],'run');r=await reactivate(stock);assert.equal(r.status,200);assert.equal(r.json.status,'sewing');assert.equal(r.json.stock_reserved,3);assert.equal(quantity('M','أسود'),3);assert.equal(quantity('L','أحمر'),0);assert.equal((await reactivate(stock)).status,409);assert.equal(quantity('M','أسود'),3);
 // Edits re-reserve atomically, including swapping variants, and never reprice cost.
 b=body(await state(stock));b.items[0].qty=6;const beforeBad=sql('SELECT count(*) n FROM stock_movements').n;assert.equal((await save(stock,b)).status,409);assert.equal(quantity('M','أسود'),3);assert.equal(sql('SELECT count(*) n FROM stock_movements').n,beforeBad);assert.equal((await order(stock)).items[0].qty,2);
 b=body(await state(stock));b.items[0].qty=4;assert.equal((await save(stock,b)).status,200);assert.equal(quantity('M','أسود'),1);
 b=body(await state(stock));b.items[0].colour='أزرق';assert.equal((await save(stock,b)).status,409);assert.equal(quantity('M','أسود'),1);assert.equal(quantity('M','أزرق'),2);
 sql("UPDATE stock_items SET qty=5 WHERE style_id='LIFE-STOCK' AND size='M' AND colour='أزرق'",[],'run');b=body(await state(stock));b.items[0].colour='أزرق';assert.equal((await save(stock,b)).status,200);assert.equal(quantity('M','أسود'),5);assert.equal(quantity('M','أزرق'),1);
 // Delivery is physically irreversible by a status change: accounting cancel
 // and reactivate are safe, but no inventory is automatically returned.
 assert.equal((await stage(stock,'delivered')).status,200);assert.equal((await stage(stock,'sewing')).status,409);
 assert.equal((await stage(stock,'cancelled')).status,200);assert.equal(quantity('M','أزرق'),1);assert.equal(quantity('L','أحمر'),0);
 b=body(await state(stock));b.items[0].qty=3;assert.equal((await save(stock,b)).status,409);
 let impact=(await req('GET',`${A}/deletions/order/${stockId}`,null,owner)).json;assert.equal(impact.stock_to_restore,0);assert.equal(impact.stock_delivered,5);
 r=await reactivate(stock);assert.equal(r.status,200);assert.equal(r.json.status,'delivered');assert.equal(quantity('M','أزرق'),1);assert.equal(quantity('L','أحمر'),0);
 assert.equal((await stage(stock,'cancelled')).status,200);impact=(await req('GET',`${A}/deletions/order/${stockId}`,null,owner)).json;assert.equal(impact.stock_to_restore,0);assert.equal(impact.stock_delivered,5);
 assert.equal((await req('POST',`${A}/deletions/order/${stockId}`,{password:'mavi-owner',confirmation:'حذف نهائي'},owner)).status,200);assert.equal(quantity('M','أزرق'),1);assert.equal(quantity('L','أحمر'),0);
 // A deleted order's final and previous numbers remain tombstoned.
 b=body(await state(otherCode));b.order.code=stock;assert.equal((await save(otherCode,b)).status,409);

 // A never-approved New stock order checks combined demand but remains
 // unreserved until separate receipt approval, preserving checkout policy.
 const pending=await online(),pid=(await order(pending)).id;
 sql("UPDATE order_items SET style_id='LIFE-STOCK',size='M',colour='أسود',qty=3,unit_price=1000 WHERE order_id=?",[pid],'run');
 sql("INSERT INTO order_items(order_id,style_id,size,colour,qty,unit_price,unit_cost) VALUES(?,'LIFE-STOCK','M','أسود',3,1000,40)",[pid],'run');
 assert.equal((await stage(pending,'cancelled')).status,200);assert.equal((await reactivate(pending)).status,409);assert.equal(quantity('M','أسود'),5);
 sql("UPDATE stock_items SET qty=6 WHERE style_id='LIFE-STOCK' AND size='M' AND colour='أسود'",[],'run');r=await reactivate(pending);assert.equal(r.status,200);assert.equal(r.json.status,'new');assert.equal(r.json.stock_unreserved,6);assert.equal(quantity('M','أسود'),6);
 await quote(pending);await upload(pending);await approve(pending);assert.equal(quantity('M','أسود'),0);
 assert.equal(sql('SELECT count(*) n FROM stock_reservations r JOIN order_items i ON i.id=r.order_item_id WHERE i.order_id=? AND r.released=0',[pid]).n,2);

 // Old approved stock with missing reservation history is not guessed.
 const missing=await online(),mid=(await order(missing)).id;
 sql("UPDATE order_items SET style_id='LIFE-STOCK',size='M',colour='أزرق',qty=1 WHERE order_id=?",[mid],'run');
 sql("UPDATE order_deposits SET status='approved' WHERE order_id=?",[mid],'run');sql("UPDATE orders SET status='cancelled',cancelled_from_status='sewing' WHERE id=?",[mid],'run');
 const mqty=quantity('M','أزرق');assert.equal((await reactivate(missing)).status,409);assert.equal(quantity('M','أزرق'),mqty);assert.equal((await order(missing)).status,'cancelled');

 // Reactivating an unapproved historical advanced order that DID have a
 // reservation reacquires it. Later approval reuses it, never deducts twice.
 const pre=await online(),preId=(await order(pre)).id;
 sql("UPDATE order_items SET style_id='LIFE-STOCK',size='M',colour='أزرق',qty=1 WHERE order_id=?",[preId],'run');
 const preItem=sql('SELECT id FROM order_items WHERE order_id=?',[preId]).id,blueId=sql("SELECT id FROM stock_items WHERE style_id='LIFE-STOCK' AND size='M' AND colour='أزرق'").id;
 sql('UPDATE stock_items SET qty=qty-1 WHERE id=?',[blueId],'run');sql('INSERT INTO stock_reservations(order_item_id,stock_id,qty,released) VALUES(?,?,1,0)',[preItem,blueId],'run');
 sql("UPDATE orders SET status='sewing' WHERE id=?",[preId],'run');assert.equal((await stage(pre,'cancelled')).status,200);assert.equal(quantity('M','أزرق'),mqty);
 r=await reactivate(pre);assert.equal(r.status,200);assert.equal(r.json.status,'sewing');assert(r.json.needs_deposit_review);assert.equal(quantity('M','أزرق'),mqty-1);
 await quote(pre);await upload(pre);await approve(pre);assert.equal(quantity('M','أزرق'),mqty-1);
 // An old cancelled record with an active reservation and unknown prior
 // stage could have been delivered. Neither reactivation nor deletion guesses.
 sql("UPDATE orders SET status='cancelled',cancelled_from_status=NULL WHERE id=?",[preId],'run');
 assert.equal((await reactivate(pre)).status,409);impact=(await req('GET',`${A}/deletions/order/${preId}`,null,owner)).json;assert(impact.blocked);assert.equal(impact.stock_unknown,1);assert.equal(impact.stock_to_restore,0);
 assert((await req('GET',`${A}/deletions/customer/${(await order(pre)).customer.id}`,null,owner)).json.blocked);
 assert.equal((await req('POST',`${A}/deletions/order/${preId}`,{password:'mavi-owner',confirmation:'حذف نهائي'},owner)).status,409);assert.equal(quantity('M','أزرق'),mqty-1);
 // Released or missing reservations do not prove an unknown-stage piece was
 // never delivered either; both also require manual review.
 const held=sql('SELECT r.* FROM stock_reservations r JOIN order_items i ON i.id=r.order_item_id WHERE i.order_id=?',[preId]);
 sql('UPDATE stock_reservations SET released=1 WHERE order_item_id=?',[held.order_item_id],'run');assert.equal((await reactivate(pre)).status,409);
 sql('DELETE FROM stock_reservations WHERE order_item_id=?',[held.order_item_id],'run');assert.equal((await reactivate(pre)).status,409);
 sql('INSERT INTO stock_reservations(order_item_id,stock_id,qty,released) VALUES(?,?,?,?)',[held.order_item_id,held.stock_id,held.qty,held.released],'run');assert.equal(quantity('M','أزرق'),mqty-1);

 // Two reactivations compete for the same returned stock: exactly one can win.
 sql("INSERT INTO styles(id,name,type,price,cost,active) VALUES('LIFE-RACE','مخزون السباق','stock',1000,40,1)",[],'run');
 sql("INSERT INTO stock_items(style_id,size,colour,qty,buy_price,sell_price) VALUES('LIFE-RACE','M','أسود',4,40,1000)",[],'run');
 const race=[];for(let k=0;k<2;k++){const c=await online(),id=(await order(c)).id;sql("UPDATE order_items SET style_id='LIFE-RACE',size='M',colour='أسود',qty=2,unit_price=1000 WHERE order_id=?",[id],'run');await quote(c);await upload(c);await approve(c);assert.equal((await stage(c,'cancelled')).status,200);race.push(c);}
 sql("UPDATE stock_items SET qty=2 WHERE style_id='LIFE-RACE'",[],'run');
 const raceResult=await Promise.all(race.map(c=>reactivate(c)));assert.deepEqual(raceResult.map(x=>x.status).sort(),[200,409]);assert.equal(sql("SELECT qty FROM stock_items WHERE style_id='LIFE-RACE'").qty,0);
 const a=await order(race[0]),z=await order(race[1]);assert.deepEqual([a.status,z.status].sort(),['cancelled','new']);
 // Very long manually chosen numeric references and corrupted legacy counters
 // must never overflow the automatic numbering loop or block new orders.
 const now=new Date(),ym=String(now.getFullYear()).slice(-2)+String(now.getMonth()+1).padStart(2,'0');
 b=body(await state(otherCode));b.order.code='MV-'+ym+'-'+('9'.repeat(30));assert.equal((await save(otherCode,b)).status,200);
 sql("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",['order_counter:'+ym,'1e+30'],'run');
 const numbered=await manual('طلب بعد رقم طويل');assert(/^MV-[0-9]{4}-[0-9]+$/.test(numbered));
 // Legacy case-only duplicate references are never resolved ambiguously.
 const lower=await manual('رقم أول'),upper=await manual('رقم ثان');
 sql("UPDATE orders SET code='Case-Ref' WHERE code=?",[lower],'run');sql("UPDATE orders SET code='case-ref' WHERE code=?",[upper],'run');
 const lowerId=(await order('Case-Ref')).id,upperId=(await order('case-ref')).id;
 assert.notEqual(lowerId,upperId);assert.equal((await req('GET',A+'/orders/CASE-REF',null,owner)).status,404);
 b=body(await state(numbered));b.order.code='CASE-REF';assert.equal((await save(numbered,b)).status,409);
 // We cannot safely create two case-insensitive aliases from these legacy
 // duplicates: neither changing nor deleting one silently steals the old URL.
 b=body(await state('Case-Ref'));b.order.code='A-NEW-CASE-REF';assert.equal((await save('Case-Ref',b)).status,409);
 assert((await req('GET',`${A}/deletions/order/${lowerId}`,null,owner)).json.blocked);
 assert.equal((await req('POST',`${A}/deletions/order/${lowerId}`,{password:'mavi-owner',confirmation:'حذف نهائي'},owner)).status,409);
 // Defensive handling for an already inconsistent legacy alias: exact alias
 // and exact current link resolve separately, but a mixed-case lookup is 404.
 sql("UPDATE orders SET code='RENAMED-CASE-REF' WHERE id=?",[lowerId],'run');
 sql("INSERT INTO order_code_aliases(code,order_id) VALUES('Case-Ref',?)",[lowerId],'run');
 assert.equal((await order('Case-Ref')).id,lowerId);assert.equal((await order('case-ref')).id,upperId);
 assert.equal((await req('GET',A+'/orders/CASE-REF',null,owner)).status,404);
 assert.equal((await req('POST',`${A}/deletions/order/${lowerId}`,{password:'mavi-owner',confirmation:'حذف نهائي'},owner)).status,200);
 assert.equal((await req('GET',A+'/orders/Case-Ref',null,owner)).status,404);assert.equal((await order('case-ref')).id,upperId);
 assert.equal((await req('GET',A+'/orders/CASE-REF',null,owner)).status,404);
 const fk=new Database(dbPath,{readonly:true});assert.deepEqual(fk.pragma('foreign_key_check'),[]);fk.close();
 console.log('PASS: lifecycle permissions, aliases, historical edits, stale revisions, real refunds, reporting dates, deposit shortfall, quote/receipt separation, stock rollback, delivered goods and concurrency');
}catch(e){console.error(e);process.exitCode=1}finally{server.kill();for(const suffix of ['','-wal','-shm'])fs.rmSync(dbPath+suffix,{force:true})}})();
