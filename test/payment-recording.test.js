'use strict';
// Run only on a seeded disposable database. No transfer is made by these tests.
const {spawn,spawnSync}=require('child_process');
const fs=require('fs'),path=require('path'),assert=require('assert'),Database=require('better-sqlite3');
const root=path.join(__dirname,'..'),dbPath=path.join(root,'data','payment-recording-test.db'),port=3392,base=`http://127.0.0.1:${port}`;
for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true});
const env={...process.env,DB_PATH:dbPath,PORT:String(port),SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'};
const seed=spawnSync(process.execPath,['src/seed.js'],{cwd:root,env,encoding:'utf8'});assert.equal(seed.status,0,seed.stderr);
const server=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env,stdio:'ignore'});
async function req(method,url,body,token){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body==null?undefined:JSON.stringify(body)});let json;try{json=await r.json()}catch{}return {status:r.status,json};}
function sql(statement,args=[],method='get'){const d=new Database(dbPath);try{d.pragma('foreign_keys=ON');return d.prepare(statement)[method](...args)}finally{d.close()}}
const A='/api/admin',S='/api/store';let serial=0;const tok=()=>`payment-test-${++serial}`;
(async()=>{try{
 let ready=false;for(let i=0;i<80;i++){try{const r=await fetch(base+'/healthz');if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}assert(ready,'server not ready');
 const owner=(await req('POST',A+'/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'})).json.token;
 const staff=(await req('POST',A+'/auth/login',{email:'staff@mavi.eg',password:'mavi-staff'})).json.token;
 const customer=(await req('POST',S+'/auth/login',{phone:'01012345678',password:'mavi1234'})).json.token;
 assert(owner&&staff&&customer);
 async function manual(name,paid=100){const r=await req('POST',A+'/manual-orders',{customer_name:'هبة سامي',customer_phone:'01012345678',confirm_existing:true,custom_name:name,channel:'whatsapp',status:'new',qty:1,unit_price:1000,paid},owner);assert.equal(r.status,201,JSON.stringify(r.json));return r.json.code;}
 async function state(c){const r=await req('GET',`${A}/orders/${encodeURIComponent(c)}/deposit-management`,null,owner);assert.equal(r.status,200,JSON.stringify(r.json));return r.json;}
 const b=(s,amount=75.25)=>({amount,method:'wallet',note:'تحويل تم استلامه',confirm_actual:true,request_id:tok(),management_revision:s.revision});
 const correct=(s,amount)=>({amount,reason:'تصحيح الرقم المسجل',confirm_clerical:true,request_id:tok(),financial_revision:s.financial_revision});
 const code=await manual('دفعات تجريبية'),url=`${A}/orders/${code}/payments`;let s=await state(code),first=b(s);
 assert.equal((await req('GET',`${A}/orders/${code}/deposit-management`,null,staff)).status,403);
 assert.equal((await req('POST',url,first,staff)).status,403);
 assert.equal((await req('POST',url,first,customer)).status,401);
 for(const bad of [{confirm_actual:false},{request_id:'short'},{request_id:12345678},{amount:true},{amount:[15]},{amount:'1.001'},{method:'wire'},{method:null},{note:{}},{note:'<script>'},{management_revision:'stale'}]){
  const r=await req('POST',url,{...first,...bad},owner);assert([400,409].includes(r.status),JSON.stringify({bad,r}));
 }
 assert.equal((await state(code)).payments.length,1);
 let r=await req('POST',url,first,owner);assert.equal(r.status,201,JSON.stringify(r.json));assert.equal(r.json.totals.paid,175.25);assert.equal(r.json.replay,false);
 r=await req('POST',url,first,owner);assert.equal(r.status,200);assert(r.json.replay);assert.equal((await state(code)).payments.length,2);
 assert.equal((await req('POST',url,{...first,amount:76},owner)).status,409);
 assert.equal((await req('POST',url,{...first,note:'ملاحظة مختلفة'},owner)).status,409);
 assert.equal((await req('POST',url,b({...s,revision:'old'},1),owner)).status,409);
 // Two identical simultaneous attempts produce one row; two distinct forms
 // using the same old financial snapshot cannot both succeed.
 s=await state(code);let same=b(s,33);let pair=await Promise.all([req('POST',url,same,owner),req('POST',url,same,owner)]);
 assert.deepEqual(pair.map(x=>x.status).sort(),[200,201]);assert.equal((await state(code)).payments.length,3);
 s=await state(code);let p1=b(s,11),p2=b(s,12);pair=await Promise.all([req('POST',url,p1,owner),req('POST',url,p2,owner)]);
 assert.deepEqual(pair.map(x=>x.status).sort(),[201,409]);
 s=await state(code);const payment=s.payments.find(x=>x.amount===100),before=s;
 // A changed-and-restored value still invalidates a form opened before the
 // intervening corrections, even though its displayed total is the same.
 assert.equal((await req('POST',url+'/'+payment.id+'/correct',correct(s,110),owner)).status,201);
 s=await state(code);assert.equal((await req('POST',url+'/'+payment.id+'/correct',correct(s,100),owner)).status,201);
 s=await state(code);assert.equal(s.totals.paid,before.totals.paid);assert.notEqual(s.financial_revision,before.financial_revision);
 assert.equal((await req('POST',url,b(before,19),owner)).status,409);
 assert.equal((await req('POST',url+'/'+payment.id+'/correct',correct(before,99),owner)).status,409);
 // Existing integrations without the new optional fields keep working.
 const legacyCode=await manual('واجهة قديمة',0),legacyUrl=`${A}/orders/${legacyCode}/payments`;
 r=await req('POST',legacyUrl,{amount:42,method:'cash',note:'دفع قديم'},owner);assert.equal(r.status,201,JSON.stringify(r.json));assert.equal((await state(legacyCode)).totals.paid,42);
 assert.equal(sql('SELECT COUNT(*) n FROM payment_record_requests WHERE order_id=(SELECT id FROM orders WHERE code=?)',[legacyCode]).n,0);
 // A payment deleted by the explicit owner deletion workflow leaves a token
 // tombstone. An old network retry cannot silently resurrect the deleted row.
 let ds=await state(legacyCode),delBody=b(ds,20);assert.equal((await req('POST',legacyUrl,delBody,owner)).status,201);
 ds=await state(legacyCode);const deletable=ds.payments.find(p=>p.amount===20);assert(deletable);
 assert.equal((await req('GET',A+'/deletions/payment/'+deletable.id,null,owner)).json.blocked,false);
 r=await req('POST',A+'/deletions/payment/'+deletable.id,{password:'mavi-owner',confirmation:'حذف نهائي'},owner);assert.equal(r.status,200,JSON.stringify(r.json));
 assert.equal((await req('POST',legacyUrl,delBody,owner)).status,409);assert.equal((await state(legacyCode)).totals.paid,42);
 ds=await state(legacyCode);assert.equal((await req('POST',legacyUrl,b(ds,20),owner)).status,201);assert.equal((await state(legacyCode)).totals.paid,62);
 // A pending receipt prevents both a new payment and a correction, while its
 // image/approval remains a separate, owner-controlled step.
 const online=(await req('POST',S+'/orders',{style_id:'DR-04',colour:'أسود',length_cm:140,fabric_choice:'قماش العميلة',qty:1,delivery:false},customer));assert.equal(online.status,201);const on=online.json.order.code,onUrl=`${A}/orders/${on}/payments`;
 sql("INSERT INTO payments(order_id,amount,method,note) VALUES((SELECT id FROM orders WHERE code=?),100,'wallet','دفعة تاريخية')",[on],'run');
 assert.equal((await req('POST',`${A}/order-deposits/${on}/quote`,{percent:50,payment_details:'حساب تجريبي'},owner)).status,200);
 const image='data:image/png;base64,'+fs.readFileSync(path.join(root,'public/brand/icon-192.png')).toString('base64');
 assert.equal((await req('POST',`${A}/order-deposits/${on}/receipt`,{image,method:'wallet'},owner)).status,200);
 let os=await state(on);assert.equal(os.deposit.status,'receipt_pending');
 assert.equal((await req('POST',onUrl,b(os,30),owner)).status,409);
 assert.equal((await req('POST',onUrl,{amount:30,method:'cash'},owner)).status,409);
 assert.equal((await req('POST',onUrl+'/'+os.payments[0].id+'/correct',correct(os,90),owner)).status,409);
 assert.equal((await state(on)).totals.paid,100);
 const db=new Database(dbPath,{readonly:true});assert.deepEqual(db.pragma('foreign_key_check'),[]);assert.equal(db.pragma('integrity_check')[0].integrity_check,'ok');db.close();
 console.log('PASS: new and legacy payment recording, validation, permissions, retries/deletion, concurrent forms, correction ABA and pending receipt');
}catch(e){console.error(e);process.exitCode=1}finally{server.kill();for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true})}})();
