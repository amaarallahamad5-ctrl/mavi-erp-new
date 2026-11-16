'use strict';
// Emulates the prior schema in a fresh synthetic database, never real data.
// Receipt source and linked-payment columns are additive and never guessed.
const {spawn,spawnSync}=require('child_process'),fs=require('fs'),path=require('path'),assert=require('assert');
const Database=require('better-sqlite3');
const root=path.join(__dirname,'..'),dbPath=path.join(root,'data','receipt-legacy-test.db'),port=3377,base=`http://127.0.0.1:${port}`;
for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true});
const env={...process.env,DB_PATH:dbPath,PORT:String(port),SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'};
const seed=spawnSync(process.execPath,['src/seed.js'],{cwd:root,env,encoding:'utf8'});assert.equal(seed.status,0,seed.stderr);
const image=fs.readFileSync(path.join(root,'public/brand/icon-192.png')),imageData='data:image/png;base64,'+image.toString('base64');
const db=new Database(dbPath);db.pragma('foreign_keys=OFF');
const orders=db.prepare("SELECT id,code,customer_id FROM orders WHERE status IN ('ready','sewing','confirmed','new','cut') ORDER BY id DESC LIMIT 2").all();assert.equal(orders.length,2);
const [pending,approved]=orders;
db.prepare("INSERT INTO order_deposits(order_id,percent,payment_details,status,payment_method,receipt,receipt_type) VALUES(?,40,'تحويل قديم','receipt_pending','wallet',?,'image/png')").run(pending.id,image);
db.prepare("INSERT INTO order_deposits(order_id,percent,payment_details,status,payment_method,receipt,receipt_type,confirmed_at) VALUES(?,50,'تحويل سابق','approved','instapay',?,'image/png','2024-01-02 03:04:05')").run(approved.id,image);
const pay=db.prepare("INSERT INTO payments(order_id,amount,method,note,created_at) VALUES(?,42,'instapay','عربون مؤكد','2024-01-02 03:04:05')").run(approved.id).lastInsertRowid;
const custom=db.prepare("INSERT INTO custom_requests(customer_id,image,image_type,status,price,deposit_percent,payment_method,shipping_fee,receipt,receipt_type) VALUES(?,?,'image/png','receipt_pending',1000,50,'wallet',75,?,'image/png')").run(pending.customer_id,image,image).lastInsertRowid;
db.exec('ALTER TABLE order_deposits DROP COLUMN confirmed_payment_id; ALTER TABLE order_deposits DROP COLUMN receipt_source; ALTER TABLE custom_requests DROP COLUMN receipt_source');
const old={
 pending:db.prepare('SELECT percent,payment_details,status,payment_method,hex(receipt) receipt,receipt_type FROM order_deposits WHERE order_id=?').get(pending.id),
 approved:db.prepare('SELECT percent,payment_details,status,payment_method,confirmed_at,hex(receipt) receipt FROM order_deposits WHERE order_id=?').get(approved.id),
 custom:db.prepare('SELECT status,price,deposit_percent,payment_method,shipping_fee,hex(receipt) receipt,hex(image) image FROM custom_requests WHERE id=?').get(custom),
 payments:db.prepare('SELECT id,order_id,amount,method,note,created_at FROM payments ORDER BY id').all(),
 items:db.prepare('SELECT id,order_id,qty,unit_price,unit_cost FROM order_items ORDER BY id').all(),
 notifications:db.prepare('SELECT COUNT(*) n FROM customer_notifications').get().n,
};db.close();
let server;
async function start(){server=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env,stdio:'ignore'});for(let i=0;i<60;i++){try{await fetch(base+'/healthz');return}catch{await new Promise(r=>setTimeout(r,100))}}throw Error('server startup failed');}
async function stop(){if(!server)return;const s=server;server=null;await new Promise(resolve=>{s.once('exit',resolve);s.kill()});}
async function req(method,url,body,token){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});let json;try{json=await r.json()}catch{}return {status:r.status,json};}
function verifyOld(){
 const x=new Database(dbPath,{readonly:true});
 assert.deepEqual(x.prepare('SELECT percent,payment_details,status,payment_method,hex(receipt) receipt,receipt_type FROM order_deposits WHERE order_id=?').get(pending.id),old.pending);
 assert.deepEqual(x.prepare('SELECT percent,payment_details,status,payment_method,confirmed_at,hex(receipt) receipt FROM order_deposits WHERE order_id=?').get(approved.id),old.approved);
 assert.deepEqual(x.prepare('SELECT status,price,deposit_percent,payment_method,shipping_fee,hex(receipt) receipt,hex(image) image FROM custom_requests WHERE id=?').get(custom),old.custom);
 assert.deepEqual(x.prepare('SELECT id,order_id,amount,method,note,created_at FROM payments ORDER BY id').all(),old.payments);
 assert.deepEqual(x.prepare('SELECT id,order_id,qty,unit_price,unit_cost FROM order_items ORDER BY id').all(),old.items);
 assert.equal(x.prepare('SELECT COUNT(*) n FROM customer_notifications').get().n,old.notifications);
 assert.deepEqual(x.pragma('foreign_key_check'),[]);x.close();
}
(async()=>{try{
 await start();verifyOld();
 let owner=(await req('POST','/api/admin/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'})).json.token;
 let d=(await req('GET','/api/admin/order-deposits/'+pending.code,null,owner)).json.deposit;
 assert.equal(d.status,'receipt_pending');assert.equal(d.receipt_source,null);assert.equal(d.confirmed_payment_id,null);
 d=(await req('GET','/api/admin/order-deposits/'+approved.code,null,owner)).json.deposit;
 assert.equal(d.status,'approved');assert.equal(d.receipt_source,null);assert.equal(d.confirmed_payment_id,null);
 assert.equal((await req('GET','/api/admin/deletions/payment/'+pay,null,owner)).json.blocked,true);
 let row=(await req('GET','/api/admin/custom-requests',null,owner)).json.requests.find(x=>x.id===Number(custom));assert.equal(row.receipt_source,null);assert.equal(row.status,'receipt_pending');
 await stop();await start();verifyOld();
 owner=(await req('POST','/api/admin/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'})).json.token;
 const dp='/api/admin/order-deposits/'+pending.code;
 assert.equal((await req('POST',dp+'/decision',{decision:'reject'},owner)).status,200);
 assert.equal((await req('POST',dp+'/receipt',{image:imageData,method:'wallet'},owner)).status,200);
 d=(await req('GET',dp,null,owner)).json.deposit;assert.equal(d.receipt_source,'admin');assert.equal(d.status,'receipt_pending');
 const choice=d.matching_payments.length?d.matching_payments[0].id:null;
 assert.equal((await req('POST',dp+'/decision',{decision:'approve',existing_payment_id:choice,review_payment_ids:d.recorded_payments.map(p=>p.id)},owner)).status,200);
 d=(await req('GET',dp,null,owner)).json.deposit;assert.equal(d.status,'approved');assert(d.confirmed_payment_id);
 const cp='/api/admin/custom-requests/'+custom;
 assert.equal((await req('POST',cp+'/decision',{decision:'reject'},owner)).status,200);
 assert.equal((await req('POST',cp+'/receipt',{image:imageData,method:'instapay'},owner)).status,200);
 const confirmed=await req('POST',cp+'/decision',{decision:'approve'},owner);assert.equal(confirmed.status,200);assert(confirmed.json.order_code);
 const x=new Database(dbPath,{readonly:true});assert.deepEqual(x.pragma('foreign_key_check'),[]);assert.equal(x.prepare('SELECT COUNT(*) n FROM custom_order_links WHERE request_id=?').get(custom).n,1);x.close();
 console.log('PASS: additive old receipt migration, no guessed source, payments/costs/images/notifications preserved, restart and subsequent review');
}catch(e){console.error(e);process.exitCode=1}finally{await stop();for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true})}})();
