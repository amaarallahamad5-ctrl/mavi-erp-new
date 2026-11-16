'use strict';
// Two independently created legacy database shapes: unknown old item cost and
// previously classified snapshots. No real customer data or production DB used.
const {spawn}=require('child_process'),fs=require('fs'),path=require('path'),assert=require('assert'),crypto=require('crypto');
const Database=require('better-sqlite3');
const root=path.join(__dirname,'..');
function createOld(dbPath,classified){
  for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true});
  const db=new Database(dbPath);db.exec(fs.readFileSync(path.join(root,'src/schema.sql'),'utf8'));
  if(classified)db.exec('ALTER TABLE order_items ADD COLUMN cost_material REAL; ALTER TABLE order_items ADD COLUMN cost_tailoring REAL; ALTER TABLE order_items ADD COLUMN cost_other_base REAL');
  const salt='test-salt-001',hash=crypto.scryptSync('test-owner-password',salt,64).toString('hex');
  db.prepare('INSERT INTO users(email,name,role,password_hash) VALUES(?,?,?,?)').run('legacy@test.invalid','Owner','owner',`scrypt$${salt}$${hash}`);
  db.prepare('INSERT INTO customers(id,phone,name,area) VALUES(1,?,?,?)').run('01011112222','عميلة قديمة','الجيزة');
  db.prepare('INSERT INTO measurements(customer_id,waist,hip,bust) VALUES(1,70,100,90)').run();
  db.prepare("INSERT INTO styles(id,name,type,price,cost) VALUES('OLD','موديل قديم','made',1000,50)").run();
  db.prepare("INSERT INTO fabric(id,name,colour,metres,cost_per_metre,reorder_level) VALUES(1,'قماش قديم','أزرق',7.5,999,3)").run();
  db.prepare("INSERT INTO tailors(id,name,rate_per_piece) VALUES(1,'ورشة قديمة',333)").run();
  db.prepare("INSERT INTO orders(id,code,customer_id,channel,status,delivery_fee,discount,created_at) VALUES(1,'MV-2401-001',1,'whatsapp','sewing',40,10,'2024-01-15 12:00:00')").run();
  db.prepare("INSERT INTO order_items(id,order_id,style_id,qty,colour,unit_price,fabric_id,metres_used,tailor_id,unit_cost) VALUES(1,1,'OLD',2,'أزرق',1000,1,2,1,180)").run();
  if(classified)db.prepare('UPDATE order_items SET cost_material=100,cost_tailoring=60,cost_other_base=10 WHERE id=1').run();
  db.prepare("INSERT INTO item_cost_lines(item_id,label,quantity,unit_cost) VALUES(1,'إضافي قديم',1,10)").run();
  db.prepare("INSERT INTO payments(order_id,amount,method,note) VALUES(1,123,'cash','دفعة سابقة')").run();
  db.prepare("INSERT INTO customer_notifications(customer_id,order_id,status,message) VALUES(1,1,'confirmed','تنبيه قديم')").run();
  db.exec("CREATE TABLE web_alert_events(id INTEGER PRIMARY KEY AUTOINCREMENT,realm TEXT NOT NULL,subject_id INTEGER,kind TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')),dispatched INTEGER NOT NULL DEFAULT 0); INSERT INTO web_alert_events(realm,subject_id,kind,dispatched) VALUES('store',1,'order_update',1);");
  const prior={item:db.prepare('SELECT id,qty,fabric_id,metres_used,tailor_id,unit_cost FROM order_items WHERE id=1').get(),fabric:db.prepare('SELECT name,colour,metres,cost_per_metre,reorder_level FROM fabric WHERE id=1').get()};
  db.close();return prior;
}
async function testShape(classified,port){
 const dbPath=path.join(root,'data',`legacy-cost-${classified?'classified':'unknown'}.db`),base=`http://127.0.0.1:${port}`;
 const prior=createOld(dbPath,classified),env={...process.env,DB_PATH:dbPath,PORT:String(port),SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'};
 let server;
 const start=async()=>{server=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env,stdio:'ignore'});for(let i=0;i<50;i++){try{await fetch(base+'/healthz');return}catch{await new Promise(r=>setTimeout(r,100))}}throw Error('startup failed')};
 const stop=async()=>{if(!server)return;const s=server;server=null;await new Promise(resolve=>{s.once('exit',resolve);s.kill()})};
 async function req(method,url,body,token){const response=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});let json;try{json=await response.json()}catch{}return {status:response.status,json};}
 try{
  await start();const login=await req('POST','/api/admin/auth/login',{email:'legacy@test.invalid',password:'test-owner-password'});assert.equal(login.status,200);const token=login.json.token;
  let detail=await req('GET','/api/admin/orders/MV-2401-001',null,token);assert.equal(detail.status,200);assert.equal(detail.json.order.totals.cost,360);assert.equal(detail.json.order.totals.total,2030);assert.equal(detail.json.order.totals.paid,123);
  const saved=new Database(dbPath,{readonly:true});assert.deepEqual(saved.prepare('SELECT id,qty,fabric_id,metres_used,tailor_id,unit_cost FROM order_items WHERE id=1').get(),prior.item);assert.deepEqual(saved.prepare('SELECT name,colour,metres,cost_per_metre,reorder_level FROM fabric WHERE id=1').get(),prior.fabric);assert.equal(saved.prepare('SELECT count(*) n FROM customer_notifications').get().n,1);assert.equal(saved.prepare("SELECT count(*) n FROM web_alert_events WHERE kind='order_update'").get().n,1);assert.deepEqual(saved.pragma('foreign_key_check'),[]);saved.close();
  let report=await req('GET','/api/admin/money/cost-detail?from=2024-01-01&to=2024-01-31',null,token);assert.equal(report.status,200);let row=report.json.rows[0];assert.equal(row.cost,360);assert.equal(row.manual,20);assert.equal(row.legacy_material,classified?200:0);assert.equal(row.legacy_tailoring,classified?120:0);assert.equal(row.legacy_other,classified?20:340);assert.equal(row.material,0);assert.equal(row.tailoring_per_metre,null);
  // Replacing the manual line preserves every previous base component.
  const manual=await req('PUT','/api/admin/order-items/1/cost-lines',{lines:[{label:'إضافي قديم',quantity:1,unit_cost:20}]},token);assert.equal(manual.status,200);assert.equal(manual.json.unit_cost,190);
  detail=await req('GET','/api/admin/orders/MV-2401-001',null,token);assert.equal(detail.json.order.totals.cost,380);
  const purchase=await req('POST','/api/admin/orders/MV-2401-001/cost-purchases/fabric',{fabric_id:1,metres:2,price_per_metre:100,shipping_per_metre:5},token);assert.equal(purchase.status,201);assert.equal(purchase.json.totals.cost,590);
  report=await req('GET','/api/admin/money/cost-detail?from=2024-01-01&to=2024-01-31',null,token);row=report.json.rows[0];assert.equal(row.material,210);assert.equal(row.manual,40);assert.equal(row.cost,590);assert.equal(row.legacy_material,classified?200:0);assert.equal(row.legacy_tailoring,classified?120:0);assert.equal(row.legacy_other,classified?20:340);
  await stop();await start();
  const afterLogin=await req('POST','/api/admin/auth/login',{email:'legacy@test.invalid',password:'test-owner-password'});assert.equal(afterLogin.status,200);
  detail=await req('GET','/api/admin/orders/MV-2401-001',null,afterLogin.json.token);assert.equal(detail.json.order.totals.cost,590);assert.equal(detail.json.order.measurements.waist,70);
  const final=new Database(dbPath,{readonly:true});assert.deepEqual(final.prepare('SELECT name,colour,metres,cost_per_metre,reorder_level FROM fabric WHERE id=1').get(),prior.fabric);assert.equal(final.prepare('SELECT count(*) n FROM order_fabric_purchases').get().n,1);assert.deepEqual(final.pragma('foreign_key_check'),[]);final.close();
 }finally{await stop();for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true});}
}
async function testUnlinkedWorkshop(){
 const dbPath=path.join(root,'data','legacy-unlinked-workshop.db'),base='http://127.0.0.1:3368';createOld(dbPath,false);
 const old=new Database(dbPath);old.exec(`CREATE TABLE order_workshop_costs(id INTEGER PRIMARY KEY AUTOINCREMENT,order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,tailor_id INTEGER REFERENCES tailors(id) ON DELETE SET NULL,tailor_name TEXT NOT NULL,quantity REAL NOT NULL,unit_cost REAL NOT NULL,note TEXT); INSERT INTO order_workshop_costs(order_id,tailor_id,tailor_name,quantity,unit_cost,note) VALUES(1,1,'ورشة قديمة',2,50,'سجل محفوظ');`);old.close();
 const child=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env:{...process.env,DB_PATH:dbPath,PORT:'3368',SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'},stdio:'ignore'});
 async function req(method,url,body,token){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,json:await r.json()};}
 try{
  for(let i=0;i<50;i++){try{await fetch(base+'/healthz');break}catch{await new Promise(r=>setTimeout(r,100))}}
  const token=(await req('POST','/api/admin/auth/login',{email:'legacy@test.invalid',password:'test-owner-password'})).json.token;
  const detail=(await req('GET','/api/admin/orders/MV-2401-001',null,token)).json.order;assert.equal(detail.totals.cost,460);
  const path='/api/admin/orders/MV-2401-001/cost-purchases/workshop',list=(await req('GET','/api/admin/orders/MV-2401-001/cost-purchases',null,token)).json;
  assert.equal(list.workshops[0].legacy_quantity,1);assert.equal(list.workshops[0].quantity,2);assert.equal(list.workshops[0].note,'سجل محفوظ');
  assert.equal((await req('PUT',path+'/1',{order_item_id:1,tailor_id:1,unit_cost:50,note:'سجل محفوظ'},token)).status,200);
  const linked=(await req('GET','/api/admin/orders/MV-2401-001/cost-purchases',null,token)).json.workshops[0];assert.equal(linked.legacy_quantity,0);assert.equal(linked.quantity,2);
  assert.equal((await req('GET','/api/admin/orders/MV-2401-001',null,token)).json.order.totals.cost,460);
 }finally{await new Promise(resolve=>{child.once('exit',resolve);child.kill()});for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true});}
}
async function testInconsistentHistory(){
 const dbPath=path.join(root,'data','legacy-inconsistent.db'),base='http://127.0.0.1:3369';createOld(dbPath,true);
 const old=new Database(dbPath);old.prepare('UPDATE order_items SET unit_cost=5 WHERE id=1').run();old.close();
 const child=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env:{...process.env,DB_PATH:dbPath,PORT:'3369',SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'},stdio:'ignore'});
 async function req(method,url,body,token){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,json:await r.json()};}
 try{
  for(let i=0;i<50;i++){try{await fetch(base+'/healthz');break}catch{await new Promise(r=>setTimeout(r,100))}}
  const token=(await req('POST','/api/admin/auth/login',{email:'legacy@test.invalid',password:'test-owner-password'})).json.token;
  const same=await req('PUT','/api/admin/order-items/1/cost-lines',{lines:[{label:'إضافي قديم',quantity:1,unit_cost:10}]},token);assert.equal(same.status,200);assert.equal(same.json.unit_cost,5);
  const bad=await req('PUT','/api/admin/order-items/1/cost-lines',{lines:[]},token);assert.equal(bad.status,409);
  const state=await req('GET','/api/admin/order-items/1/cost-lines',null,token);assert.equal(state.json.unit_cost,5);assert.equal(state.json.lines.length,1);
  const blank=await req('PUT','/api/admin/order-items/1/cost-lines',{lines:[{label:'إضافي',quantity:1,unit_cost:''}]},token);assert.equal(blank.status,400);
  const changed=await req('PUT','/api/admin/order-items/1/cost-lines',{lines:[{label:'إضافي قديم',quantity:1,unit_cost:20}]},token);assert.equal(changed.status,200);assert.equal(changed.json.unit_cost,15);
  const row=(await req('GET','/api/admin/money/cost-detail?from=2024-01-01&to=2024-01-31',null,token)).json.rows[0];assert.equal(row.cost,30);assert(row.legacy_other<0);
 }finally{await new Promise(resolve=>{child.once('exit',resolve);child.kill()});for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true});}
}
(async()=>{try{await testShape(false,3366);await testShape(true,3367);await testUnlinkedWorkshop();await testInconsistentHistory();console.log('PASS: historical cost migration, classified/unknown/inconsistent history, restart, measurements, payments, alerts and no stock rewriting');}catch(e){console.error(e);process.exitCode=1}})();
