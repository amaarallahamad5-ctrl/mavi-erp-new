'use strict';
// Regression: dresses can be added while editing an order, draft («new»)
// orders stay out of every financial figure until confirmed, and the customer
// tracking gains an «out for delivery» stage before «delivered».
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), path = require('path'), assert = require('assert');
const Database = require('better-sqlite3');
const root=path.join(__dirname,'..'), dbPath=path.join(root,'data','edit-add-items-test.db');
const port=3396, base=`http://127.0.0.1:${port}`;
for(const suffix of ['','-wal','-shm'])fs.rmSync(dbPath+suffix,{force:true});
const env={...process.env,DB_PATH:dbPath,PORT:String(port),SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'};
const seed=spawnSync(process.execPath,['src/seed.js'],{cwd:root,env,encoding:'utf8'});
assert.equal(seed.status,0,seed.stderr);
const server=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env,stdio:'ignore'});
async function req(method,url,body,token){
  const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  let json;try{json=await response.json()}catch{}
  return {status:response.status,json};
}
const sql=(statement,...args)=>{const db=new Database(dbPath);try{return db.prepare(statement).get(...args)}finally{db.close()}};
const near=(a,b)=>assert(Math.abs(a-b)<1e-7,`${a} != ${b}`);
(async()=>{
 try{
  for(let i=0;i<50;i++){try{await fetch(base+'/healthz');break}catch{await new Promise(r=>setTimeout(r,100))}}
  const owner=(await req('POST','/api/admin/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'})).json.token;
  const customer=(await req('POST','/api/store/auth/login',{phone:'01012345678',password:'mavi1234'})).json.token;
  const madeStyle=sql("SELECT id,price FROM styles WHERE type='made' AND active=1 AND id!='CUSTOM-DESIGN' LIMIT 1");
  assert(madeStyle&&madeStyle.id,'seed must contain a made style');

  // --- 1) Add dresses while editing a «new» manual order ---------------
  const made=await req('POST','/api/admin/manual-orders',{customer_name:'سلمى أحمد',customer_phone:'01012345678',confirm_existing:true,channel:'whatsapp',custom_name:'فستان سواريه',qty:2,unit_price:1000,paid:0,status:'new'},owner);
  assert.equal(made.status,201,JSON.stringify(made.json));
  const code=made.json.code, me=`/api/admin/orders/${code}`;
  const before=(await req('GET',me+'/edit',null,owner)).json;
  assert.equal(before.order.items.length,1);

  const summaryBefore=(await req('GET','/api/admin/money/summary',null,owner)).json;
  const periodBefore=(await req('GET','/api/admin/money/period?from=2000-01-01&to=2100-01-01',null,owner)).json;
  const reportsBefore=(await req('GET','/api/admin/money/reports',null,owner)).json;
  const outstandingBefore=(await req('GET','/api/admin/money/outstanding',null,owner)).json;
  const edit=await req('PATCH',me+'/edit',{revision:before.revision,
    order:{...before.order,contact:{...before.order.contact},measurements:{...before.order.measurements},delivery_fee:'',promise_date:''},
    items:[...before.order.items.map(i=>({id:i.id,name:i.name,qty:i.qty,colour:i.colour||'',size:i.size||'',length_cm:i.length_cm,unit_price:i.unit_price,fabric_choice:i.fabric_choice||'',item_note:i.item_note||''})),
      {style_id:madeStyle.id,qty:1,unit_price:750,colour:'أزرق'},
      {custom_name:'فستان كوكتييل دانتيل',qty:2,unit_price:1200,fabric_choice:'ساتان'}]},owner);
  assert.equal(edit.status,200,JSON.stringify(edit.json));
  near(edit.json.totals.total,2000+750+2400);
  const after=(await req('GET',me+'/edit',null,owner)).json;
  assert.equal(after.order.items.length,3);
  assert.equal(after.order.items.filter(i=>i.style_id==='MANUAL-CUSTOM').length,2);
  const auditRow=sql("SELECT detail FROM events WHERE entity='order' AND entity_id=? AND action='details_edited' ORDER BY id DESC LIMIT 1",String(after.order.id));
  assert.equal(JSON.parse(auditRow.detail).items_added,2);

  // Invalid additions are rejected without any partial effect.
  const stockStyle=sql("SELECT id FROM styles WHERE type='stock' LIMIT 1");
  if(stockStyle){
   const bad=await req('PATCH',me+'/edit',{revision:after.revision,order:{...after.order,contact:{...after.order.contact},measurements:{...after.order.measurements},delivery_fee:'',promise_date:''},
     items:[...after.order.items.map(i=>({id:i.id,qty:i.qty,unit_price:i.unit_price})),{style_id:stockStyle.id,qty:1,unit_price:100}]},owner);
   assert.equal(bad.status,400);
  }
  const badUnknown=await req('PATCH',me+'/edit',{revision:after.revision,order:{...after.order,contact:{...after.order.contact},measurements:{...after.order.measurements},delivery_fee:'',promise_date:''},
    items:[...after.order.items.map(i=>({id:i.id,qty:i.qty,unit_price:i.unit_price})),{style_id:'NO-SUCH-STYLE',qty:1,unit_price:100}]},owner);
  assert.equal(badUnknown.status,400);
  const badEmpty=await req('PATCH',me+'/edit',{revision:after.revision,order:{...after.order,contact:{...after.order.contact},measurements:{...after.order.measurements},delivery_fee:'',promise_date:''},
    items:[...after.order.items.map(i=>({id:i.id,qty:i.qty,unit_price:i.unit_price})),{qty:1,unit_price:100}]},owner);
  assert.equal(badEmpty.status,400);
  assert.equal((await req('GET',me+'/edit',null,owner)).json.order.items.length,3);

  // --- 2) A «new» order is invisible to the finances --------------------
  const summaryAfterAdd=(await req('GET','/api/admin/money/summary',null,owner)).json;
  assert.equal(summaryAfterAdd.orders,summaryBefore.orders);
  near(summaryAfterAdd.revenue,summaryBefore.revenue);
  near(summaryAfterAdd.collected,summaryBefore.collected);
  const periodNew=(await req('GET',`/api/admin/money/period?from=2000-01-01&to=2100-01-01`,null,owner)).json;
  near(periodNew.sales,periodBefore.sales);
  near(periodNew.orders,periodBefore.orders);
  const outstandingNew=(await req('GET','/api/admin/money/outstanding',null,owner)).json;
  assert.equal(outstandingNew.rows.length,outstandingBefore.rows.length);
  assert(!outstandingNew.rows.some(r=>r.code===code),'outstanding must exclude new orders');
  const reportsNew=(await req('GET','/api/admin/money/reports',null,owner)).json;
  near((reportsNew.by_style.find(r=>r.style_id==='MANUAL-CUSTOM')||{revenue:0}).revenue,
       (reportsBefore.by_style.find(r=>r.style_id==='MANUAL-CUSTOM')||{revenue:0}).revenue);
  const costNew=(await req('GET','/api/admin/money/cost-detail?from=2000-01-01&to=2100-01-01',null,owner)).json;
  assert(costNew.excluded.new_orders.orders>=1,'cost detail counts the excluded new order');
  const hubNew=(await req('GET','/api/admin/money/report-hub?from=2000-01-01&to=2100-01-01',null,owner)).json;
  assert(hubNew.operations.statuses.some(s=>s.status==='new'&&s.count>=1),'operations still shows new orders');
  // A payment recorded while the order is still «new» is not collected money.
  const paidNew=(await req('GET','/api/admin/money/summary',null,owner)).json;
  const payOrder=await req('POST','/api/admin/manual-orders',{customer_name:'نور طارق',customer_phone:'01122334455',channel:'walkin',custom_name:'بدروم',qty:1,unit_price:900,paid:500,payment_method:'cash',status:'new'},owner);
  assert.equal(payOrder.status,201,JSON.stringify(payOrder.json));
  const withPaid=(await req('GET','/api/admin/money/summary',null,owner)).json;
  near(withPaid.collected,paidNew.collected);
  near(withPaid.revenue,paidNew.revenue);

  // Confirming moves the orders into the books.
  assert.equal((await req('PATCH',`/api/admin/orders/${code}/status`,{status:'confirmed'},owner)).status,200);
  assert.equal((await req('PATCH',`/api/admin/orders/${payOrder.json.code}/status`,{status:'confirmed'},owner)).status,200);
  const summaryConfirmed=(await req('GET','/api/admin/money/summary',null,owner)).json;
  near(summaryConfirmed.revenue,summaryBefore.revenue+2000+750+2400+900);
  near(summaryConfirmed.collected,summaryBefore.collected+500);
  const outstandingConfirmed=(await req('GET','/api/admin/money/outstanding',null,owner)).json;
  assert(outstandingConfirmed.rows.some(r=>r.code===code),'confirmed order becomes due');
  const hubConfirmed=(await req('GET','/api/admin/money/report-hub?from=2000-01-01&to=2100-01-01',null,owner)).json;
  assert(hubConfirmed.cost_detail.excluded.new_orders.orders===0,'no new-order exclusion remains');

  // --- 3) Customer tracking: «قيد التوصيل» before «اتسلّم» --------------
  assert.equal((await req('PATCH',`/api/admin/orders/${code}/status`,{status:'cut'},owner)).status,200);
  assert.equal((await req('PATCH',`/api/admin/orders/${code}/status`,{status:'sewing'},owner)).status,200);
  assert.equal((await req('PATCH',`/api/admin/orders/${code}/status`,{status:'ready'},owner)).status,200);
  assert.equal((await req('PATCH',`/api/admin/orders/${code}/status`,{status:'delivering'},owner)).status,200);
  let mine=(await req('GET','/api/store/orders',null,customer)).json.orders.find(o=>o.code===code);
  assert.equal(mine.status,'delivering');
  assert.equal(mine.statusLabel,'قيد التوصيل');
  assert.equal(mine.step,5);
  const notif=sql('SELECT message FROM customer_notifications WHERE order_id=? AND status=? ORDER BY id DESC LIMIT 1',after.order.id,'delivering');
  assert(notif&&notif.message.includes('طريقه'),'customer notification announces delivery');
  assert.equal((await req('PATCH',`/api/admin/orders/${code}/status`,{status:'delivered'},owner)).status,200);
  mine=(await req('GET','/api/store/orders',null,customer)).json.orders.find(o=>o.code===code);
  assert.equal(mine.step,6);
  assert.equal(mine.statusLabel,'اتسلّم');
  console.log('PASS: edit adds dresses, new orders stay out of the books until confirmed, delivery stage tracked');
 }catch(error){console.error(error);process.exitCode=1;}
 finally{server.kill();for(const suffix of ['','-wal','-shm'])fs.rmSync(dbPath+suffix,{force:true});}
})();
