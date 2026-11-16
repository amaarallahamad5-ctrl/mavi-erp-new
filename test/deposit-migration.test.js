'use strict';
// Emulate the immediately previous lifecycle schema on disposable synthetic
// data. Migration must not invent payment links, required rules, or history.
const {spawn,spawnSync}=require('child_process');
const fs=require('fs'),path=require('path'),assert=require('assert'),Database=require('better-sqlite3');
const root=path.join(__dirname,'..'),dbPath=path.join(root,'data','deposit-migration-test.db'),port=3393,base=`http://127.0.0.1:${port}`;
for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true});
const env={...process.env,DB_PATH:dbPath,PORT:String(port),SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'};
assert.equal(spawnSync(process.execPath,['src/seed.js'],{cwd:root,env,encoding:'utf8'}).status,0);
const image=fs.readFileSync(path.join(root,'public/brand/icon-192.png'));
const db=new Database(dbPath);db.pragma('foreign_keys=ON');
const insOrder=db.prepare("INSERT INTO orders(code,customer_id,channel,status,delivery_fee,discount,note,created_at) VALUES(?,1,'online','new',0,0,'بيانات تاريخية','2024-01-01 10:00:00')");
const pending=Number(insOrder.run('MIG-RECEIPT').lastInsertRowid),approved=Number(insOrder.run('MIG-APPROVED').lastInsertRowid);
const item=db.prepare("INSERT INTO order_items(order_id,style_id,qty,unit_price,unit_cost) VALUES(?,'DR-04',1,1000,123.45)");item.run(pending);item.run(approved);
const deposit=db.prepare("INSERT INTO order_deposits(order_id,percent,payment_details,status,payment_method,receipt,receipt_type,receipt_source,confirmed_at) VALUES(?,50,'حساب قديم',?,'wallet',?,'image/png',NULL,?)");
deposit.run(pending,'receipt_pending',image,null);deposit.run(approved,'approved',image,'2024-01-03 10:00:00');
db.prepare("INSERT INTO payments(order_id,amount,method,note,created_at) VALUES(?,500,'wallet','عربون مؤكد','2024-01-03 10:00:00')").run(approved);
const custom=Number(db.prepare("INSERT INTO custom_requests(customer_id,image,image_type,status,price,deposit_percent,payment_method,shipping_fee,receipt,receipt_type,receipt_source,payment_details) VALUES(1,?,'image/png','receipt_pending',800,50,'wallet',50,?,'image/png',NULL,'حساب قديم')").run(image,image).lastInsertRowid);
// Remove only the newly introduced structures and receipt revision columns.
db.pragma('foreign_keys=OFF');db.exec(`DROP TABLE payment_record_requests;DROP TABLE deposit_change_log;DROP TABLE order_deposit_rules;DROP TABLE custom_deposit_rules;
 ALTER TABLE order_deposits DROP COLUMN receipt_revision;ALTER TABLE custom_requests DROP COLUMN receipt_revision;`);
const tables=['orders','order_items','payments','order_deposits','custom_requests','order_refunds','events','order_fabric_purchases','order_workshop_costs','order_other_costs','stock_reservations','stock_movements'];
const cols=Object.fromEntries(tables.map(t=>[t,db.pragma('table_info('+t+')').map(x=>x.name)]));
function rows(conn,t){return conn.prepare('SELECT '+cols[t].map(c=>'"'+c.replace(/"/g,'""')+'"').join(',')+' FROM "'+t+'" ORDER BY rowid').all()}
const old=Object.fromEntries(tables.map(t=>[t,rows(db,t)]));db.close();
let server;
async function start(){server=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env,stdio:'ignore'});for(let i=0;i<80;i++){try{const r=await fetch(base+'/healthz');if(r.ok)return}catch{}await new Promise(r=>setTimeout(r,100))}throw Error('server not ready')}
async function stop(){if(!server)return;let s=server;server=null;await new Promise(resolve=>{s.once('exit',resolve);s.kill()})}
async function req(method,url,body,token){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body==null?undefined:JSON.stringify(body)});let json;try{json=await r.json()}catch{}return {status:r.status,json}}
function verify(){const d=new Database(dbPath,{readonly:true});try{
 for(const t of tables)assert.deepEqual(rows(d,t),old[t],`${t} changed during migration`);
 for(const t of ['payment_record_requests','deposit_change_log','order_deposit_rules','custom_deposit_rules'])assert.equal(d.prepare('SELECT count(*) n FROM '+t).get().n,0,t);
 assert.deepEqual(d.prepare('SELECT receipt_revision,receipt_source,confirmed_amount,confirmed_payment_id FROM order_deposits WHERE order_id=?').get(approved),{receipt_revision:null,receipt_source:null,confirmed_amount:null,confirmed_payment_id:null});
 assert.deepEqual(d.prepare('SELECT receipt_revision,receipt_source FROM custom_requests WHERE id=?').get(custom),{receipt_revision:null,receipt_source:null});
 assert.deepEqual(d.pragma('foreign_key_check'),[]);assert.equal(d.pragma('integrity_check')[0].integrity_check,'ok');
 }finally{d.close()}}
(async()=>{try{
 await start();verify();await stop();await start();verify();
 const owner=(await req('POST','/api/admin/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'})).json.token;assert(owner);
 let state=(await req('GET','/api/admin/orders/MIG-APPROVED/deposit-management',null,owner)).json;
 assert.equal(state.requirement.mode,'percent');assert.equal(state.requirement.value,50);assert.equal(state.requirement.explicit,false);assert.equal(state.history.length,0);assert.equal(state.deposit.confirmed_amount,null);
 // Legacy pending receipts have no invented revision, but remain reviewable.
 let r=await req('POST','/api/admin/order-deposits/MIG-RECEIPT/decision',{decision:'approve',existing_payment_id:null,review_payment_ids:[]},owner);assert.equal(r.status,200,JSON.stringify(r.json));
 r=await req('POST',`/api/admin/custom-requests/${custom}/decision`,{decision:'approve'},owner);assert.equal(r.status,200,JSON.stringify(r.json));assert(r.json.order_code);
 const d=new Database(dbPath,{readonly:true});assert.equal(d.prepare('SELECT count(*) n FROM payments WHERE order_id=?').get(pending).n,1);assert.equal(d.prepare('SELECT count(*) n FROM custom_order_links WHERE request_id=?').get(custom).n,1);assert.deepEqual(d.pragma('foreign_key_check'),[]);d.close();
 console.log('PASS: additive deposit migration/restart preserves old values and images, does not infer history, and allows legacy pending receipt review');
}catch(e){console.error(e);process.exitCode=1}finally{await stop();for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true})}})();
