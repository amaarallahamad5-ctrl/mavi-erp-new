'use strict';
// Synthetic histories only: an inactive, deleted, or already-orphaned reference
// must not erase or silently re-price a recorded order cost.
const {spawn,spawnSync}=require('child_process');
const fs=require('fs'),path=require('path'),assert=require('assert');
const Database=require('better-sqlite3');
const root=path.join(__dirname,'..'),dbPath=path.join(root,'data','cost-references-test.db');
const port=3373,base=`http://127.0.0.1:${port}`;
for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true});
const env={...process.env,DB_PATH:dbPath,PORT:String(port),SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'};
const seed=spawnSync(process.execPath,['src/seed.js'],{cwd:root,env,encoding:'utf8'});assert.equal(seed.status,0,seed.stderr);
const server=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env,stdio:'ignore'});
async function req(method,url,body,token){
 const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
 let json;try{json=await r.json()}catch{}return {status:r.status,json};
}
function sql(statement,args=[],foreignKeys=true){
 const d=new Database(dbPath);try{d.pragma('foreign_keys = '+(foreignKeys?'ON':'OFF'));return d.prepare(statement).run(...args)}finally{d.close()}
}
(async()=>{try{
 for(let i=0;i<50;i++){try{await fetch(base+'/healthz');break}catch{await new Promise(r=>setTimeout(r,100))}}
 const token=(await req('POST','/api/admin/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'})).json.token;
 const made=await req('POST','/api/admin/manual-orders',{customer_name:'اختبار مرجع قديم',customer_phone:'01088889999',channel:'whatsapp',custom_name:'قطعة تجريبية',qty:2,unit_price:500,paid:0,status:'new'},token);
 assert.equal(made.status,201,JSON.stringify(made.json));
 const code=made.json.code,baseCost=`/api/admin/orders/${code}/cost-purchases`;
 const item=(await req('GET','/api/admin/orders/'+code,null,token)).json.order.items[0].id;
 const makeTailor=async name=>{const x=await req('POST','/api/admin/tailors',{name,rate_per_piece:0},token);assert.equal(x.status,201);return x.json.id};
 const inactive=await makeTailor('ورشة غير نشطة');
 const inactiveBody={order_item_id:item,tailor_id:inactive,unit_cost:90,note:'قبل التعطيل',request_id:'inactive-workshop-retry-01'};
 const old=await req('POST',baseCost+'/workshop',inactiveBody,token);assert.equal(old.status,201);
 sql('UPDATE tailors SET active=0 WHERE id=?',[inactive]);
 const retry=await req('POST',baseCost+'/workshop',inactiveBody,token);assert.equal(retry.status,200);assert.equal(retry.json.id,old.json.id);assert(retry.json.replay);
 assert.equal((await req('POST',baseCost+'/workshop',{order_item_id:item,tailor_id:inactive,unit_cost:90},token)).status,400);
 assert.equal((await req('PUT',baseCost+'/workshop/'+old.json.id,{order_item_id:item,tailor_id:inactive,unit_cost:100,note:'بعد التعطيل'},token)).status,200);
 let list=(await req('GET',baseCost,null,token)).json;
 assert.equal(list.workshops[0].tailor_name,'ورشة غير نشطة');assert.equal(list.workshops[0].current_tailor_active,0);assert.equal(list.workshops[0].quantity,2);

 const deleted=await makeTailor('ورشة محذوفة');
 const d=await req('POST',baseCost+'/workshop',{order_item_id:item,tailor_id:deleted,unit_cost:50},token);assert.equal(d.status,201);
 sql('DELETE FROM tailors WHERE id=?',[deleted]); // FK ON: snapshot is retained, ID is set null.
 list=(await req('GET',baseCost,null,token)).json;
 let previous=list.workshops.find(w=>w.id===d.json.id);assert.equal(previous.tailor_id,null);assert.equal(previous.tailor_name,'ورشة محذوفة');
 assert.equal((await req('PUT',baseCost+'/workshop/'+d.json.id,{order_item_id:item,tailor_id:'',unit_cost:60,note:'محفوظ بعد الحذف'},token)).status,200);
 assert.equal((await req('POST',baseCost+'/workshop',{order_item_id:item,tailor_id:'',unit_cost:60},token)).status,400);
 assert.equal((await req('PUT',baseCost+'/workshop/'+d.json.id,{order_item_id:item,tailor_id:inactive,unit_cost:60},token)).status,400);

 const orphanWorkshop=await makeTailor('ورشة مرجع مفقود');
 const ow=await req('POST',baseCost+'/workshop',{order_item_id:item,tailor_id:orphanWorkshop,unit_cost:30},token);assert.equal(ow.status,201);
 sql('DELETE FROM tailors WHERE id=?',[orphanWorkshop],false); // Simulate bad old data, not normal deletion.
 assert.equal((await req('PUT',baseCost+'/workshop/'+ow.json.id,{order_item_id:item,tailor_id:orphanWorkshop,unit_cost:30,note:'لا تغيري المرجع'},token)).status,200);
 list=(await req('GET',baseCost,null,token)).json;
 previous=list.workshops.find(w=>w.id===ow.json.id);assert.equal(previous.tailor_id,orphanWorkshop);assert.equal(previous.tailor_name,'ورشة مرجع مفقود');assert.equal(previous.current_tailor_name,null);

 const f=await req('POST','/api/admin/inventory/fabric',{name:'خامة مرجع مفقود'},token);assert.equal(f.status,201);
 const fabricBody={fabric_id:f.json.id,fabric_name:'خامة مرجع مفقود',metres:3,price_per_metre:10,shipping_per_metre:0,request_id:'orphan-fabric-retry-01'};
 const purchase=await req('POST',baseCost+'/fabric',fabricBody,token);assert.equal(purchase.status,201);
 sql('DELETE FROM fabric WHERE id=?',[f.json.id],false); // Simulate a pre-existing orphan.
 const fabricRetry=await req('POST',baseCost+'/fabric',fabricBody,token);assert.equal(fabricRetry.status,200);assert.equal(fabricRetry.json.id,purchase.json.id);
 assert.equal((await req('POST',baseCost+'/fabric',{...fabricBody,request_id:'different-fabric-retry-01'},token)).status,400);
 assert.equal((await req('PUT',baseCost+'/fabric/'+purchase.json.id,{...fabricBody,note:'الاسم محفوظ'},token)).status,200);
 list=(await req('GET',baseCost,null,token)).json;assert.equal(list.purchases[0].fabric_id,f.json.id);assert.equal(list.purchases[0].fabric_name,'خامة مرجع مفقود');
 assert.equal((await req('GET','/api/admin/orders/'+code,null,token)).json.order.totals.cost,410); // 200 + 120 + 60 + 30

 // An explicit relink repairs orphaned IDs without changing monetary history.
 assert.equal((await req('PUT',baseCost+'/workshop/'+ow.json.id,{order_item_id:item,tailor_id:1,unit_cost:30,note:'تم اختيار ورشة'},token)).status,200);
 assert.equal((await req('PUT',baseCost+'/fabric/'+purchase.json.id,{...fabricBody,fabric_id:1,note:'تم اختيار خامة'},token)).status,200);
 assert.equal((await req('GET','/api/admin/orders/'+code,null,token)).json.order.totals.cost,410);
 const check=new Database(dbPath,{readonly:true});assert.deepEqual(check.pragma('foreign_key_check'),[]);check.close();
 console.log('PASS: inactive/deleted/orphaned historical references, retry, preserved snapshots and explicit relinking');
}catch(e){console.error(e);process.exitCode=1}finally{server.kill();for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true})}})();
