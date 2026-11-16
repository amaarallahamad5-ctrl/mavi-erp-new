'use strict';
// Deterministic financial/operational report fixtures; never uses real data.
const {spawn,spawnSync}=require('child_process'),fs=require('fs'),path=require('path'),assert=require('assert');
const Database=require('better-sqlite3');
const root=path.join(__dirname,'..'),dbPath=path.join(root,'data','report-hub-test.db'),port=3376,base=`http://127.0.0.1:${port}`;
for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true});
const env={...process.env,DB_PATH:dbPath,PORT:String(port),SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'};
const seed=spawnSync(process.execPath,['src/seed.js'],{cwd:root,env,encoding:'utf8'});assert.equal(seed.status,0,seed.stderr);
const server=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env,stdio:'ignore'});
async function req(method,url,body,token){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});let json;try{json=await r.json()}catch{}return {status:r.status,json};}
function sql(statement,args=[],mode='run'){const d=new Database(dbPath);try{d.pragma('foreign_keys=ON');return d.prepare(statement)[mode](...args)}finally{d.close()}}
(async()=>{try{
 for(let i=0;i<60;i++){try{await fetch(base+'/healthz');break}catch{await new Promise(r=>setTimeout(r,100))}}
 const owner=(await req('POST','/api/admin/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'})).json.token;
 const staff=(await req('POST','/api/admin/auth/login',{email:'staff@mavi.eg',password:'mavi-staff'})).json.token;
 const customer=(await req('POST','/api/store/auth/login',{phone:'01012345678',password:'mavi1234'})).json.token;
 const make=async(name,phone,qty,price,paid,shipping=0,promise='')=>{
  const r=await req('POST','/api/admin/manual-orders',{customer_name:'عميلة '+name,customer_phone:phone,channel:'whatsapp',custom_name:name,qty,unit_price:price,paid,shipping_fee:shipping,governorate:shipping?'الجيزة':'',promise_date:promise,status:'new'},owner);
  assert.equal(r.status,201,JSON.stringify(r.json));return r.json.code;
 };
 const a=await make('فستان ألف','01088112233',2,1000,200,100,'2024-02-02');
 const b=await make('فستان باء','01088112234',1,600,0);
 const c=await make('ملغي','01088112235',1,500,50);
 const pending=await make('غير مسعّر','01088112236',1,400,100);
 const outside=await make('متأخر من فترة أقدم','01088112237',1,400,0,0,'2023-02-01');
 sql("UPDATE orders SET created_at='2023-01-01 10:00:00' WHERE code=?",[outside]);
 const order=async code=>(await req('GET','/api/admin/orders/'+code,null,owner)).json.order;
 const ai=(await order(a)).items[0].id,bi=(await order(b)).items[0].id,pi=(await order(pending)).items[0].id;
 const add=async(code,type,body)=>assert.equal((await req('POST',`/api/admin/orders/${code}/cost-purchases/${type}`,body,owner)).status,201);
 await add(a,'fabric',{fabric_name:'خامة A',metres:3,price_per_metre:100,shipping_per_metre:10});
 await add(a,'workshop',{order_item_id:ai,tailor_id:1,unit_cost:80});
 await add(a,'other',{label:'تغليف',amount:40});
 assert.equal((await req('PUT',`/api/admin/order-items/${ai}/cost-lines`,{lines:[{label:'زرار',quantity:1,unit_cost:20}]},owner)).status,200);
 await add(b,'fabric',{fabric_name:'خامة B',metres:1,price_per_metre:100,shipping_per_metre:0});
 await add(b,'workshop',{order_item_id:bi,tailor_id:2,unit_cost:50});
 await add(c,'other',{label:'ملغي',amount:60});await add(pending,'other',{label:'غير مسعر',amount:75});
 assert.equal((await req('POST',`/api/admin/orders/${b}/payments`,{amount:700,method:'cash'},owner)).status,201);
 assert.equal((await req('PATCH',`/api/admin/orders/${c}/status`,{status:'cancelled'},owner)).status,200);
 sql("UPDATE order_items SET status='custom_pending' WHERE id=?",[pi]);
 for(const [code,date] of [[a,'2024-01-31 22:30:00'],[b,'2024-03-05 10:00:00'],[c,'2024-02-05 10:00:00'],[pending,'2024-03-06 10:00:00']])
  sql('UPDATE orders SET created_at=? WHERE code=?',[date,code]);
 for(const [code,date] of [[a,'2024-02-02 10:00:00'],[b,'2024-03-05 10:00:00'],[c,'2024-03-10 10:00:00'],[pending,'2024-03-11 10:00:00']])
  sql('UPDATE payments SET created_at=? WHERE order_id=(SELECT id FROM orders WHERE code=?)',[date,code]);
 sql("INSERT INTO expenses(category,amount,spent_on) VALUES('إيجار',30,'2024-02-04'),('تسويق',70,'2024-03-04')");
 sql("INSERT INTO order_deposits(order_id,percent,status,payment_details,payment_method,receipt,receipt_type,receipt_source) SELECT id,40,'receipt_pending','تحويل','wallet',X'89504e470d0a1a0a','image/png','admin' FROM orders WHERE code=?",[a]);
 sql("INSERT INTO order_deposits(order_id,status) SELECT id,'needs_quote' FROM orders WHERE code=?",[pending]);
 sql("INSERT INTO order_deposits(order_id,percent,status,payment_details,payment_method,receipt,receipt_type) SELECT id,50,'receipt_pending','تحويل','wallet',X'89504e470d0a1a0a','image/png' FROM orders WHERE code=?",[outside]);
 sql("INSERT INTO custom_requests(customer_id,image,image_type,created_at,status,price,deposit_percent,shipping_fee) VALUES(1,X'89504e470d0a1a0a','image/png','2024-03-07 12:00:00','receipt_rejected',500,50,20)");
 sql("INSERT INTO custom_requests(customer_id,image,image_type,created_at,status,price,deposit_percent,shipping_fee) VALUES(1,X'89504e470d0a1a0a','image/png','2023-01-07 12:00:00','quoted',600,50,0)");
 const url='/api/admin/money/report-hub?from=2024-02-01&to=2024-03-31';
 assert.equal((await req('GET',url,null,staff)).status,403);assert.equal((await req('GET',url,null,customer)).status,401);assert.equal((await req('GET',url)).status,401);
 assert.equal((await req('GET','/api/admin/money/report-hub?from=2024-02-30&to=2024-03-31',null,owner)).status,400);
 assert.equal((await req('GET','/api/admin/money/report-hub?from=2024-04-01&to=2024-03-31',null,owner)).status,400);
 const r=await req('GET',url,null,owner);assert.equal(r.status,200,JSON.stringify(r.json));const x=r.json;
 assert.deepEqual({orders:x.summary.orders,sales:x.summary.sales,cost:x.summary.cost,before:x.summary.before_expenses,expenses:x.summary.expenses,net:x.summary.net_difference,cash:x.summary.collected_in_period,due:x.summary.outstanding_for_period_orders,over:x.summary.overpaid_for_period_orders,cancelled:x.summary.cancelled,unpriced:x.summary.unpriced},
  {orders:2,sales:2700,cost:720,before:1980,expenses:100,net:1880,cash:1050,due:1900,over:100,cancelled:1,unpriced:1});
 const period=(await req('GET','/api/admin/money/period?from=2024-02-01&to=2024-03-31',null,owner)).json;
 assert.equal(period.sales,x.summary.sales);assert.equal(period.cost,x.summary.cost);assert.equal(period.collected_in_period,x.summary.collected_in_period);assert.equal(period.profit,x.summary.net_difference);
 assert.equal(x.cost_detail.excluded.cancelled.recorded_cost,60);assert.equal(x.cost_detail.excluded.unpriced.recorded_cost,75);
 assert.equal(x.sales.designs.find(v=>v.name==='فستان ألف').quantity,2);assert.equal(x.sales.designs.find(v=>v.name==='فستان ألف').sales_before_adjustments,2000);
 assert.equal(x.sales.designs.find(v=>v.name==='فستان باء').sales_before_adjustments,600);assert(x.sales.designs.every(v=>!('profit' in v)&&!('cost' in v)));
 assert.equal(x.sales.channels[0].sales,2700);assert.equal(x.sales.orders.length,2);
 assert.equal(x.sales.months.find(m=>m.month==='2024-02').sales,2100);assert.equal(x.sales.months.find(m=>m.month==='2024-02').collected,200);
 assert.equal(x.sales.months.find(m=>m.month==='2024-03').sales,600);assert.equal(x.sales.months.find(m=>m.month==='2024-03').collected,850);
 assert.equal(x.workshops.total,210);assert.equal(x.workshops.rows.find(w=>w.id===1).quantity,2);assert.equal(x.workshops.rows.find(w=>w.id===1).cost,160);assert.equal(x.workshops.rows.find(w=>w.id===1).average_per_piece,80);assert.equal(x.workshops.rows.find(w=>w.id===2).cost,50);
 assert.equal(x.fabrics.total,430);assert.equal(x.fabrics.metres,4);assert.equal(x.fabrics.rows.find(f=>f.name==='خامة A').total,330);assert.equal(x.fabrics.rows.find(f=>f.name==='خامة A').average_per_metre,110);assert.equal(x.fabrics.rows.find(f=>f.name==='خامة A').shipping,30);assert.equal(x.fabrics.rows.find(f=>f.name==='خامة B').total,100);
 assert.equal(x.payments.rows.length,4);assert.equal(x.payments.methods.reduce((n,m)=>n+m.amount,0),1050);assert(x.payments.rows.some(p=>p.code===c&&p.status==='cancelled'));assert(x.payments.rows.some(p=>p.code===pending&&p.unpriced));
 assert.equal(x.balances.rows.length,1);assert.equal(x.balances.rows[0].code,a);assert.equal(x.balances.rows[0].due,1900);assert.equal(x.balances.overpaid,100);assert.equal(x.balances.overpaid_rows[0].code,b);
 assert.equal(x.deposits.counts.receipt_pending,1);assert.equal(x.deposits.counts.receipt_rejected,1);assert.equal(x.deposits.counts.needs_quote,1);
 assert.equal(x.deposits.rows.find(v=>v.code===a).amount,840);assert.equal(x.deposits.rows.find(v=>v.kind==='custom').amount,260);assert.equal(x.deposits.rows.find(v=>v.code===pending).amount,null);
 assert(!x.deposits.rows.some(v=>v.code===outside));assert(x.deposits.all_rows.some(v=>v.code===outside&&v.amount===200));assert(x.deposits.all_rows.some(v=>v.kind==='custom'&&v.amount===300));assert(x.deposits.all_counts.receipt_pending>=2);
 assert(x.operations.late.some(v=>v.code===a));assert(!x.operations.late.some(v=>v.code===c));assert.equal(x.operations.total_orders,4);
 assert(!x.operations.late.some(v=>v.code===outside));assert(x.operations.all_late.some(v=>v.code===outside));assert(!x.operations.all_late.some(v=>v.code===c));
 const jan=(await req('GET','/api/admin/money/report-hub?from=2024-01-31&to=2024-01-31',null,owner)).json;assert.equal(jan.summary.orders,0); // 22:30 UTC was 00:30 in Cairo on Feb 1
 console.log('PASS: report hub sales, workshop, costs, balance, deposits, operations, monthly cash, excluded records, Cairo dates and access control');
}catch(e){console.error(e);process.exitCode=1}finally{server.kill();for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true})}})();
