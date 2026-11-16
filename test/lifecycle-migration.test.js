'use strict';
// Synthetic migration from the previous reports/receipts schema. Verify every
// old column/value survives migration and restart; never infer old refunds or stages.
const {spawn,spawnSync}=require('child_process'),fs=require('fs'),path=require('path'),assert=require('assert'),Database=require('better-sqlite3');
const root=path.join(__dirname,'..'),dbPath=path.join(root,'data','lifecycle-migration.db'),port=3383,base=`http://127.0.0.1:${port}`;
for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true});
const env={...process.env,DB_PATH:dbPath,PORT:String(port),SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'};
const seed=spawnSync(process.execPath,['src/seed.js'],{cwd:root,env,encoding:'utf8'});assert.equal(seed.status,0,seed.stderr);
const d=new Database(dbPath);d.pragma('foreign_keys=ON');
const image=fs.readFileSync(path.join(root,'public/brand/icon-192.png'));
const order=Number(d.prepare("INSERT INTO orders(code,customer_id,channel,status,delivery_fee,discount,note,created_at) VALUES('MV-2401-999',1,'online','cancelled',50,5,'ملاحظة قديمة','2024-01-01 10:00:00')").run().lastInsertRowid);
const item=Number(d.prepare("INSERT INTO order_items(order_id,style_id,description,qty,colour,unit_price,unit_cost) VALUES(?,'DR-04','فستان قديم',2,'أسود',700,123.456)").run(order).lastInsertRowid);
d.prepare("INSERT INTO payments(order_id,amount,method,note,created_at) VALUES(?,400,'wallet','تحويل قديم','2024-01-03 10:00:00')").run(order);
d.prepare("INSERT INTO order_deposits(order_id,percent,payment_details,status,payment_method,receipt,receipt_type,receipt_source,confirmed_at) VALUES(?,40,'حساب قديم','approved','wallet',?,'image/png','admin','2024-01-03 10:00:00')").run(order,image);
d.prepare("INSERT INTO order_fabric_purchases(order_id,fabric_name,metres,price_per_metre,shipping_per_metre,note) VALUES(?,'خامة قديمة',3,90,5,'شراء قديم')").run(order);
d.prepare("INSERT INTO order_workshop_costs(order_id,order_item_id,tailor_id,tailor_name,quantity,unit_cost,note) VALUES(?,?,1,'ورشة قديمة',2,80,'اتفاق قديم')").run(order,item);
d.prepare("INSERT INTO order_other_costs(order_id,label,amount,note) VALUES(?,'تغليف قديم',30,'قديم')").run(order);
d.prepare("INSERT INTO events(entity,entity_id,action,actor,detail,created_at) VALUES('order','MV-2401-999','status:cancelled','user:1','{}','2024-01-04 12:00:00')").run();
// Remove exactly the columns/tables added by this feature, emulating the prior
// schema rather than inventing historical values for them.
d.pragma('foreign_keys=OFF');
d.exec(`DROP TABLE order_refunds; DROP TABLE order_code_aliases;
 ALTER TABLE orders DROP COLUMN cancelled_from_status;
 ALTER TABLE orders DROP COLUMN contact_name;
 ALTER TABLE orders DROP COLUMN contact_phone;
 ALTER TABLE orders DROP COLUMN contact_area;
 ALTER TABLE orders DROP COLUMN measurements_snapshot;
 ALTER TABLE order_deposits DROP COLUMN confirmed_amount;`);
const tables=['orders','order_items','customers','measurements','payments','order_deposits','order_fabric_purchases','order_workshop_costs','order_other_costs','events','stock_items','stock_reservations','stock_movements'];
const cols=Object.fromEntries(tables.map(t=>[t,d.pragma('table_info('+t+')').map(c=>c.name)]));
function readTable(db,t){const names=cols[t].map(s=>'"'+s.replace(/"/g,'""')+'"').join(',');return db.prepare(`SELECT ${names} FROM "${t}" ORDER BY rowid`).all();}
const before=Object.fromEntries(tables.map(t=>[t,readTable(d,t)]));d.close();
let server;
async function start(){server=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env,stdio:'ignore'});for(let i=0;i<80;i++){try{await fetch(base+'/healthz');return}catch{await new Promise(r=>setTimeout(r,100))}}throw Error('server did not start');}
async function stop(){if(!server)return;const s=server;server=null;await new Promise(resolve=>{s.once('exit',resolve);s.kill()});}
async function req(method,url,body,token){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});let json;try{json=await r.json()}catch{}return {status:r.status,json};}
function verify(){const db=new Database(dbPath,{readonly:true});try{
 for(const t of tables)assert.deepEqual(readTable(db,t),before[t],t+' changed during migration');
 assert.deepEqual(db.pragma('foreign_key_check'),[]);
 const o=db.prepare('SELECT cancelled_from_status,contact_name,contact_phone,contact_area,measurements_snapshot FROM orders WHERE id=?').get(order);
 assert.deepEqual(o,{cancelled_from_status:null,contact_name:null,contact_phone:null,contact_area:null,measurements_snapshot:null});
 assert.equal(db.prepare('SELECT confirmed_amount FROM order_deposits WHERE order_id=?').get(order).confirmed_amount,null);
 assert.equal(db.prepare('SELECT count(*) n FROM order_refunds').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM order_code_aliases').get().n,0);
 }finally{db.close()}}
(async()=>{try{
 await start();verify();await stop();await start();verify();
 const login=await req('POST','/api/admin/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'});assert.equal(login.status,200);const token=login.json.token;
 let r=await req('GET','/api/admin/orders/MV-2401-999',null,token);assert.equal(r.status,200);assert.equal(r.json.order.status,'cancelled');assert.equal(r.json.order.totals.gross_paid,400);assert.equal(r.json.order.totals.refunded,0);assert.equal(r.json.order.refunds.length,0);
 const cost=2*123.456+3*(90+5)+2*80+30;assert(Math.abs(r.json.order.totals.cost-cost)<1e-7);
 r=await req('GET','/api/admin/order-deposits/MV-2401-999',null,token);assert.equal(r.json.deposit.status,'approved');assert.equal(r.json.deposit.confirmed_amount,null);
 r=await req('POST','/api/admin/orders/MV-2401-999/reactivate',{},token);assert.equal(r.status,200);assert.equal(r.json.status,'new');assert.equal(r.json.previous_unknown,true);
 r=await req('GET','/api/admin/orders/MV-2401-999',null,token);assert.equal(r.json.order.status,'new');assert.equal(r.json.order.totals.paid,400);assert(Math.abs(r.json.order.totals.cost-cost)<1e-7);
 const db=new Database(dbPath,{readonly:true});assert.deepEqual(readTable(db,'payments'),before.payments);assert.deepEqual(readTable(db,'order_deposits'),before.order_deposits);assert.deepEqual(readTable(db,'order_fabric_purchases'),before.order_fabric_purchases);assert.deepEqual(readTable(db,'order_workshop_costs'),before.order_workshop_costs);assert.deepEqual(db.pragma('foreign_key_check'),[]);db.close();
 console.log('PASS: additive lifecycle migration and restart preserve legacy records, receipts, payments, costs, stock, audit and unknown prior stages');
}catch(e){console.error(e);process.exitCode=1}finally{await stop();for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true})}})();
