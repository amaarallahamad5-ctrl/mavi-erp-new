'use strict';
// End-to-end regression: exact whole-order purchases, item-linked workshop rates,
// idempotency, historical data, reporting, permission and catalogue deletion safety.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs'), path = require('path'), assert = require('assert');
const Database = require('better-sqlite3');
const root=path.join(__dirname,'..'), dbPath=path.join(root,'data','purchase-cost-test.db');
const port=3359, base=`http://127.0.0.1:${port}`;
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
const sqlRun=(statement,...args)=>{const db=new Database(dbPath);try{return db.prepare(statement).run(...args)}finally{db.close()}};
const near=(a,b)=>assert(Math.abs(a-b)<1e-7,`${a} != ${b}`);
(async()=>{
 try{
  for(let i=0;i<50;i++){try{await fetch(base+'/healthz');break}catch{await new Promise(r=>setTimeout(r,100))}}
  const owner=(await req('POST','/api/admin/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'})).json.token;
  const staff=(await req('POST','/api/admin/auth/login',{email:'staff@mavi.eg',password:'mavi-staff'})).json.token;
  const customer=(await req('POST','/api/store/auth/login',{phone:'01012345678',password:'mavi1234'})).json.token;
  const other=(await req('POST','/api/store/auth/login',{phone:'01123456789',password:'mavi1234'})).json.token;

  // The old data are retained but are not displayed or updated as inventory.
  const legacyFabricBefore=sql('SELECT metres,cost_per_metre,reorder_level FROM fabric WHERE id=1');
  const empty=await req('POST','/api/admin/inventory/fabric',{},owner);assert.equal(empty.status,201);
  const f=await req('POST','/api/admin/inventory/fabric',{name:'حرير',details:'ناعم',metres:42,cost_per_metre:987},owner);assert.equal(f.status,201);
  assert.equal((await req('POST','/api/admin/inventory/fabric',{name:'ممنوع'},staff)).status,403);
  let refs=(await req('GET','/api/admin/fabric',null,owner)).json.fabric;
  assert.equal(refs.find(x=>x.id===empty.json.id).name,'');
  assert(!('metres' in refs.find(x=>x.id===f.json.id)));assert(!('cost_per_metre' in refs.find(x=>x.id===f.json.id)));
  assert.equal(sql('SELECT metres FROM fabric WHERE id=?',f.json.id).metres,0);
  const workshop=await req('POST','/api/admin/tailors',{name:'ورشة اختبار',rate_per_piece:80,address:'الجيزة'},owner);assert.equal(workshop.status,201);

  const make={customer_name:'هبة سامي',customer_phone:'01012345678',confirm_existing:true,governorate:'الجيزة',channel:'whatsapp',custom_name:'فستان',qty:2,unit_price:1000,shipping_fee:100,paid:0,status:'new'};
  const made=await req('POST','/api/admin/manual-orders',make,owner);assert.equal(made.status,201,JSON.stringify(made.json));
  const code=made.json.code,costs=`/api/admin/orders/${code}/cost-purchases`;
  let order=(await req('GET','/api/admin/orders/'+code,null,owner)).json.order;
  const item=order.items[0].id;
  assert.equal(order.totals.total,2100);assert.equal(order.totals.cost,0);
  const beforeSummary=(await req('GET','/api/admin/money/summary',null,owner)).json;
  const beforePeriod=(await req('GET','/api/admin/money/period?from=2000-01-01&to=2100-01-01',null,owner)).json;

  // Manual entries remain per piece; these are separate from whole-order purchases.
  assert.equal((await req('PUT',`/api/admin/order-items/${item}/cost-lines`,{lines:[{label:'سوستة',quantity:1,unit_cost:20}]},owner)).status,200);
  const a={fabric_id:f.json.id,fabric_name:'حرير',metres:2,price_per_metre:100,shipping_per_metre:10,request_id:'fabric-retry-token-01'};
  const p1=await req('POST',costs+'/fabric',a,owner);assert.equal(p1.status,201);
  const replay=await req('POST',costs+'/fabric',a,owner);assert.equal(replay.status,200);assert.equal(replay.json.id,p1.json.id);assert(replay.json.replay);
  assert.equal((await req('POST',costs+'/fabric',{...a,metres:4},owner)).status,409);
  const p2=await req('POST',costs+'/fabric',{...a,metres:1,price_per_metre:120,shipping_per_metre:5,request_id:'fabric-retry-token-02'},owner);assert.equal(p2.status,201);
  const p3=await req('POST',costs+'/fabric',{fabric_name:'دانتيل',metres:0.5,price_per_metre:50,shipping_per_metre:0,request_id:'fabric-retry-token-03'},owner);assert.equal(p3.status,201);
  const labour={order_item_id:item,tailor_id:workshop.json.id,unit_cost:90,quantity:999,request_id:'workshop-retry-token-01'};
  const w=await req('POST',costs+'/workshop',labour,owner);assert.equal(w.status,201);
  assert.equal((await req('POST',costs+'/workshop',labour,owner)).json.id,w.json.id);
  let list=(await req('GET',costs,null,owner)).json;
  assert.equal(list.purchases.length,3);assert.equal(list.purchases[2].fabric_id,null);assert.equal(list.workshops[0].quantity,2);
  order=(await req('GET','/api/admin/orders/'+code,null,owner)).json.order;
  assert.equal(order.totals.cost,590);assert.equal(order.totals.profit,1510);assert.deepEqual(order.items[0].workshop_names,['ورشة اختبار']);
  near((await req('GET','/api/admin/money/summary',null,owner)).json.cost-beforeSummary.cost,590);
  near((await req('GET','/api/admin/money/period?from=2000-01-01&to=2100-01-01',null,owner)).json.cost-beforePeriod.cost,590);

  const report=await req('GET','/api/admin/money/cost-detail?from=2000-01-01&to=2100-01-01',null,owner);
  assert.equal(report.status,200);let row=report.json.rows.find(x=>x.code===code);
  near(row.material,370);near(row.tailoring,180);near(row.manual,40);near(row.legacy_other,0);near(row.cost,590);near(row.sales,2100);near(row.profit,1510);near(row.metres,3.5);near(row.tailoring_per_metre,180/3.5);
  const byStyle=(await req('GET','/api/admin/money/reports',null,owner)).json.by_style.find(x=>x.style_id==='MANUAL-CUSTOM');
  assert.equal(byStyle.profit,null);assert.equal(byStyle.cost,null);assert.equal(byStyle.margin,null);assert.equal(byStyle.profit_available,false);
  assert.equal((await req('GET','/api/admin/money/cost-detail?from=2026-02-30&to=2026-03-10',null,owner)).status,400);
  assert.equal((await req('GET','/api/admin/money/period?from=2026-05-01&to=2026-04-01',null,owner)).status,400);

  // Staff can perform production but cannot inspect rates or total costs.
  const staffOrder=(await req('GET','/api/admin/orders/'+code,null,staff)).json.order;
  assert.deepEqual(staffOrder.items[0].workshop_names,['ورشة اختبار']);assert.equal(staffOrder.purchased_fabrics.length,3);
  assert(!JSON.stringify(staffOrder).includes('unit_cost'));assert(!JSON.stringify(staffOrder).includes('price_per_metre'));assert(!('cost' in staffOrder.totals));
  assert.equal((await req('GET',costs,null,staff)).status,403);
  assert.equal((await req('POST',costs+'/fabric',a,staff)).status,403);
  assert.equal((await req('GET','/api/admin/money/cost-detail?from=2000-01-01&to=2100-01-01',null,staff)).status,403);
  const mine=await req('GET','/api/store/orders/'+code,null,customer);assert.equal(mine.status,200);assert(!JSON.stringify(mine.json).includes('unit_cost'));
  assert.equal((await req('GET','/api/store/orders/'+code,null,other)).status,404);
  assert.equal((await req('GET',costs,null,customer)).status,401);

  // A workshop cannot refer to a different order's item, and an independent
  // arbitrary workshop quantity is never used for calculation.
  const second=await req('POST','/api/admin/manual-orders',{...make,custom_name:'قطعة ثانية',qty:1,unit_price:500,shipping_fee:0,paid:100},owner);assert.equal(second.status,201);
  const otherItem=(await req('GET','/api/admin/orders/'+second.json.code,null,owner)).json.order.items[0].id;
  assert.equal((await req('POST',costs+'/workshop',{order_item_id:otherItem,tailor_id:workshop.json.id,unit_cost:10},owner)).status,400);
  assert.equal((await req('POST',costs+'/fabric',{...a,shipping_per_metre:''},owner)).status,409); // Existing retry token: review saved entry first.
  assert.equal((await req('POST',costs+'/fabric',{...a,request_id:undefined,shipping_per_metre:''},owner)).status,400);
  assert.equal((await req('POST',costs+'/fabric',{...a,request_id:undefined,metres:-1},owner)).status,400);
  assert.equal((await req('POST',costs+'/fabric',{...a,request_id:undefined,price_per_metre:-1},owner)).status,400);
  assert.equal((await req('POST',costs+'/fabric',{...a,request_id:undefined,fabric_id:999999},owner)).status,400);
  assert.equal((await req('POST',costs+'/workshop',{...labour,request_id:undefined,order_item_id:item,unit_cost:''},owner)).status,400);

  // Even if order quantity changes in a future editor, workshop quantity follows
  // the item, while the fabric purchase is not multiplied again.
  sqlRun('UPDATE order_items SET qty=3 WHERE id=?',item);
  order=(await req('GET','/api/admin/orders/'+code,null,owner)).json.order;
  near(order.totals.cost,700);assert.equal((await req('GET',costs,null,owner)).json.workshops[0].quantity,3);
  sqlRun('UPDATE order_items SET qty=2 WHERE id=?',item);

  // Protected catalogue deletion, snapshot names and editing do not re-price history.
  assert.equal((await req('GET','/api/admin/deletions/fabric/'+f.json.id,null,owner)).json.blocked,1);
  assert.equal((await req('GET','/api/admin/deletions/tailor/'+workshop.json.id,null,owner)).json.blocked,1);
  assert.equal((await req('POST','/api/admin/deletions/fabric/'+f.json.id,{password:'mavi-owner',confirmation:'حذف نهائي'},owner)).status,409);
  assert.equal((await req('PATCH','/api/admin/inventory/fabric/'+f.json.id,{name:'حرير معدّل',metres:500},owner)).status,200);
  assert.equal((await req('PATCH','/api/admin/tailors/'+workshop.json.id,{name:'ورشة معدلة',rate_per_piece:999},owner)).status,200);
  const changedWorkshop=(await req('GET','/api/admin/tailors',null,owner)).json.tailors.find(t=>t.id===workshop.json.id);assert.equal(changedWorkshop.address,'الجيزة');
  list=(await req('GET',costs,null,owner)).json;assert.equal(list.purchases[0].fabric_name,'حرير');assert.equal(list.workshops[0].tailor_name,'ورشة اختبار');assert.equal(list.workshops[0].unit_cost,90);
  assert.equal((await req('PUT',costs+'/workshop/'+w.json.id,{order_item_id:item,tailor_id:workshop.json.id,unit_cost:95,note:'تعديل'},owner)).status,200);
  assert.equal((await req('GET',costs,null,owner)).json.workshops[0].tailor_name,'ورشة اختبار');
  assert.equal((await req('PUT',costs+'/fabric/'+p1.json.id,{...a,metres:3},owner)).status,200);
  assert.equal((await req('DELETE',costs+'/fabric/'+p2.json.id,null,owner)).status,200);
  order=(await req('GET','/api/admin/orders/'+code,null,owner)).json.order;near(order.totals.cost,585); // 330 + 25 + 190 + 40
  assert.equal((await req('DELETE',costs+'/fabric/'+p2.json.id,null,owner)).status,404);
  assert.deepEqual(sql('SELECT metres,cost_per_metre,reorder_level FROM fabric WHERE id=1'),legacyFabricBefore);
  assert.equal(sql('SELECT metres FROM fabric WHERE id=?',f.json.id).metres,0);
  assert.equal((await req('PATCH',`/api/admin/order-items/${item}/production`,{},owner)).status,410);

  // Unpriced cost remains visible separately, and its payment must not reduce
  // outstanding for the priced order set.
  const beforePending=(await req('GET','/api/admin/money/summary',null,owner)).json;
  sqlRun("UPDATE order_items SET status='custom_pending' WHERE id=?",otherItem);
  const pendingAfter=(await req('GET','/api/admin/money/summary',null,owner)).json;
  near(pendingAfter.outstanding,beforePending.outstanding-(500-100));
  const otherCost=`/api/admin/orders/${second.json.code}/cost-purchases/fabric`;
  assert.equal((await req('POST',otherCost,{metres:1,price_per_metre:75,shipping_per_metre:0},owner)).status,201);
  const excluded=(await req('GET','/api/admin/money/cost-detail?from=2000-01-01&to=2100-01-01',null,owner)).json.excluded;
  assert(excluded.unpriced.orders>=1);assert(excluded.unpriced.recorded_cost>=75);

  // Overpayments are shown separately instead of hiding another customer's debt.
  const third=await req('POST','/api/admin/manual-orders',{...make,custom_name:'قطعة ثالثة',qty:1,unit_price:500,shipping_fee:0,paid:0},owner);assert.equal(third.status,201);
  const beforeOver=(await req('GET','/api/admin/money/summary',null,owner)).json;
  assert.equal((await req('POST',`/api/admin/orders/${third.json.code}/payments`,{amount:600,method:'cash'},owner)).status,201);
  const afterOver=(await req('GET','/api/admin/money/summary',null,owner)).json;
  near(afterOver.outstanding,beforeOver.outstanding-500);near(afterOver.overpaid-beforeOver.overpaid,100);
  const dashboardOver=(await req('GET','/api/admin/dashboard',null,owner)).json;near(dashboardOver.money.outstanding,afterOver.outstanding);
  const periodOver=(await req('GET','/api/admin/money/period?from=2000-01-01&to=2100-01-01',null,owner)).json;assert(periodOver.overpaid_for_period_orders>=100);
  assert.equal((await req('POST',`/api/admin/orders/${third.json.code}/cost-purchases/fabric`,{metres:1,price_per_metre:60,shipping_per_metre:0},owner)).status,201);
  assert.equal((await req('PATCH',`/api/admin/orders/${third.json.code}/status`,{status:'cancelled'},owner)).status,200);
  const withCancelled=(await req('GET','/api/admin/money/cost-detail?from=2000-01-01&to=2100-01-01',null,owner)).json.excluded;
  assert(withCancelled.cancelled.orders>=1);assert(withCancelled.cancelled.recorded_cost>=60);

  // Cairo-local date boundaries (summer +3 / winter +2) use the same policy in both reports.
  sqlRun("UPDATE orders SET created_at='2026-07-01 21:30:00' WHERE code=?",code);
  let local=(await req('GET','/api/admin/money/cost-detail?from=2026-07-02&to=2026-07-02',null,owner)).json;
  assert(local.rows.some(x=>x.code===code));assert(!(await req('GET','/api/admin/money/cost-detail?from=2026-07-01&to=2026-07-01',null,owner)).json.rows.some(x=>x.code===code));
  let period=(await req('GET','/api/admin/money/period?from=2026-07-02&to=2026-07-02',null,owner)).json;
  assert(period.cost>=585);
  const dates=require('../src/business-date');assert.equal(dates.cairoDate('2026-12-01 22:30:00'),'2026-12-02');
  assert.equal((await req('POST',costs+'/other',{label:'تغليف',amount:12},owner)).status,201);
  assert.equal((await req('GET','/api/admin/deletions/order/'+order.id,null,owner)).status,200);
  assert.equal((await req('POST','/api/admin/deletions/order/'+order.id,{password:'mavi-owner',confirmation:'حذف نهائي'},owner)).status,200);
  assert.equal(sql('SELECT count(*) n FROM order_fabric_purchases WHERE order_id=?',order.id).n,0);
  assert.equal(sql('SELECT count(*) n FROM order_workshop_costs WHERE order_id=?',order.id).n,0);
  assert.equal(sql('SELECT count(*) n FROM order_other_costs WHERE order_id=?',order.id).n,0);
  console.log('PASS: order purchases, item-linked workshops, reports, local dates, idempotency, permissions, history and deletion safety');
 }catch(error){console.error(error);process.exitCode=1;}
 finally{server.kill();for(const suffix of ['','-wal','-shm'])fs.rmSync(dbPath+suffix,{force:true});}
})();
