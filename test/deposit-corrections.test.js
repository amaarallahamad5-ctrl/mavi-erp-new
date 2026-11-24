'use strict';
// Disposable synthetic DB: never uses or changes a real database or transfers money.
const {spawn,spawnSync}=require('child_process'),fs=require('fs'),path=require('path'),assert=require('assert'),Database=require('better-sqlite3');
const root=path.join(__dirname,'..'),dbPath=path.join(root,'data','deposit-corrections-test.db'),port=3391,base=`http://127.0.0.1:${port}`;
for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true});
const env={...process.env,DB_PATH:dbPath,PORT:String(port),SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'};
const seed=spawnSync(process.execPath,['src/seed.js'],{cwd:root,env,encoding:'utf8'});assert.equal(seed.status,0,seed.stderr);
const server=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env,stdio:'ignore'});
async function req(method,url,body,token){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body==null?undefined:JSON.stringify(body)});let json;try{json=await r.json()}catch{}return {status:r.status,json};}
function sql(statement,args=[],method='get'){const d=new Database(dbPath);try{d.pragma('foreign_keys=ON');return d.prepare(statement)[method](...args)}finally{d.close()}}
const A='/api/admin',S='/api/store';const near=(a,b)=>assert(Math.abs(a-b)<1e-7,`${a} != ${b}`);let num=0;const token=()=>`correction-test-${++num}`;
(async()=>{try{
 for(let i=0;i<80;i++){try{await fetch(base+'/healthz');break}catch{await new Promise(r=>setTimeout(r,100))}}
 const owner=(await req('POST',A+'/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'})).json.token;
 const staff=(await req('POST',A+'/auth/login',{email:'staff@mavi.eg',password:'mavi-staff'})).json.token;
 const customer=(await req('POST',S+'/auth/login',{phone:'01012345678',password:'mavi1234'})).json.token;
 const other=(await req('POST',S+'/auth/login',{phone:'01123456789',password:'mavi1234'})).json.token;
 assert(owner&&staff&&customer&&other);
 const image='data:image/png;base64,'+fs.readFileSync(path.join(root,'public/brand/icon-192.png')).toString('base64');
 const state=async c=>{const x=await req('GET',`${A}/orders/${encodeURIComponent(c)}/deposit-management`,null,owner);assert.equal(x.status,200,JSON.stringify(x.json));return x.json;};
 const cust=async c=>(await req('GET',`${S}/orders/${encodeURIComponent(c)}`,null,customer)).json.order;
 const ruleBody=(s,mode,value,extra={})=>({revision:s.revision,mode,value,reason:'تصحيح الاتفاق مع العميلة',confirm_requirement:true,request_id:token(),...extra});
 const correctBody=(s,value,extra={})=>({financial_revision:s.financial_revision,amount:value,reason:'خطأ في إدخال المبلغ',confirm_clerical:true,request_id:token(),...extra});
 const manual=(await req('POST',A+'/manual-orders',{customer_name:'هبة سامي',customer_phone:'01012345678',confirm_existing:true,custom_name:'طلب مالي تجريبي',channel:'whatsapp',status:'new',qty:1,unit_price:1000,paid:600},owner));assert.equal(manual.status,201,JSON.stringify(manual.json));const code=manual.json.code,mp=`${A}/orders/${code}`;
 // «جديد» يبقى خارج الحسابات؛ هذا الاختبار عن تصحيح الدفعات فعلاً بعد دخول الأوردر دفتر الحسابات.
 assert.equal((await req('PATCH',mp+'/status',{status:'confirmed'},owner)).status,200);
 let st=await state(code),pid=st.payments[0].id;assert.equal(st.requirement.amount,null);assert.equal(st.totals.paid,600);
 sql("UPDATE payments SET created_at='2024-01-09 10:00:00' WHERE id=?",[pid],'run');st=await state(code);
 const correction=correctBody(st,450),cp=`${mp}/payments/${pid}/correct`;
 assert.equal((await req('GET',mp+'/deposit-management',null,staff)).status,403);
 assert.equal((await req('POST',cp,correction,staff)).status,403);
 assert.equal((await req('POST',cp,correction,customer)).status,401);
 assert.equal((await req('POST',cp,{...correction,reason:'<script>'},owner)).status,400);
 assert.equal((await req('POST',cp,{...correction,amount:450.123},owner)).status,400);
 assert.equal((await req('POST',cp,{...correction,confirm_clerical:false},owner)).status,400);
 let r=await req('POST',cp,correction,owner);assert.equal(r.status,201,JSON.stringify(r.json));near(r.json.totals.paid,450);near(r.json.totals.due,550);
 r=await req('POST',cp,correction,owner);assert.equal(r.status,200);assert(r.json.replay);
 assert.equal((await req('POST',cp,{...correction,amount:451},owner)).status,409);
 assert.equal((await req('POST',cp,correctBody({...st,financial_revision:'stale'},400),owner)).status,409);
 st=await state(code);assert.equal(st.history.length,1);assert.equal(st.history[0].old_amount,600);assert.equal(st.history[0].new_amount,450);assert.equal(st.history[0].reason,'خطأ في إدخال المبلغ');
 const oldPayment=sql('SELECT amount,method,created_at,note FROM payments WHERE id=?',[pid]);assert.equal(oldPayment.amount,450);assert.equal(oldPayment.created_at,'2024-01-09 10:00:00');
 const co=await cust(code);near(co.paid,450);near(co.due,550);assert.equal(co.deposit,null);
 assert.equal((await req('GET',`${S}/orders/${code}`,null,other)).status,404);
 let hub=(await req('GET',A+'/money/report-hub?from=2024-01-01&to=2024-01-31',null,owner)).json;
 let reportPayment=hub.payments.rows.find(x=>x.id===pid);assert(reportPayment&&reportPayment.corrected);near(reportPayment.amount,450);assert.equal(reportPayment.business_day,'2024-01-09');
 assert((await req('GET',A+'/deletions/payment/'+pid,null,owner)).json.blocked);
 // Existing real refunds stay intact; correction cannot reduce gross below them.
 const refund=await req('POST',mp+'/refunds',{amount:300,method:'cash',refunded_on:'2024-01-10',note:'',request_id:token(),confirm_actual:true,financial_revision:st.financial_revision},owner);assert.equal(refund.status,201,JSON.stringify(refund.json));
 st=await state(code);assert.equal((await req('POST',cp,correctBody(st,299),owner)).status,409);
 let rb=ruleBody(st,'fixed',400);r=await req('POST',mp+'/deposit-requirement',rb,owner);assert.equal(r.status,201,JSON.stringify(r.json));
 assert.equal((await req('POST',mp+'/deposit-requirement',rb,owner)).status,200);
 st=await state(code);near(st.totals.paid,150);near(st.requirement.amount,400);assert.equal(st.requirement.mode,'fixed');
 let c=await cust(code);near(c.paid,150);near(c.due,850);near(c.deposit.amount,400);near(c.deposit.shortfall,250);assert.equal(c.deposit.status,'recorded');
 assert.equal((await req('POST',mp+'/deposit-requirement',ruleBody(st,'fixed',1001),owner)).status,400);
 assert.equal((await req('POST',mp+'/deposit-requirement',ruleBody(st,'percent',101),owner)).status,400);
 // Independent tabs changing the rule cannot both succeed.
 const first=ruleBody(st,'percent',70),second=ruleBody(st,'fixed',350);
 const votes=await Promise.all([req('POST',mp+'/deposit-requirement',first,owner),req('POST',mp+'/deposit-requirement',second,owner)]);
 assert.deepEqual(votes.map(x=>x.status).sort(),[201,409]);st=await state(code);
 const winner=votes[0].status===201?first:second;
 assert.equal((await req('POST',mp+'/deposit-requirement',winner,owner)).status,200);
 assert.equal((await req('POST',mp+'/deposit-requirement',{...winner,value:33},owner)).status,409);
 // A fixed requirement cannot silently become larger than the total through
 // the legacy manual-shipping editor or the full order editor. A percentage
 // continues to track the edited total without altering the recorded payment.
 const m2=await req('POST',A+'/manual-orders',{customer_name:'هبة سامي',customer_phone:'01012345678',confirm_existing:true,custom_name:'اختبار الإجمالي',channel:'whatsapp',status:'new',qty:1,unit_price:1000,paid:0,shipping_fee:200,governorate:'الجيزة'},owner);assert.equal(m2.status,201);const mcode=m2.json.code,me=`${A}/orders/${mcode}`;
 let ms=await state(mcode);assert.equal((await req('POST',me+'/deposit-requirement',ruleBody(ms,'fixed',1100),owner)).status,201);
 assert.equal((await req('PATCH',`${A}/manual-orders/${mcode}/shipping`,{shipping_fee:0,governorate:'الجيزة'},owner)).status,409);near((await state(mcode)).totals.total,1200);
 assert.equal((await req('PATCH',`${A}/manual-orders/${mcode}/shipping`,{shipping_fee:150,governorate:'الجيزة'},owner)).status,200);ms=await state(mcode);near(ms.totals.total,1150);near(ms.requirement.amount,1100);
 const editBody=(s,price)=>({revision:s.revision,order:{code:s.order.code,channel:s.order.channel,promise_date:s.order.promise_date||'',governorate:s.order.governorate||'',delivery_requested:s.order.delivery_requested,delivery_fee:s.order.shipping_quoted?s.order.delivery_fee:'',discount:s.order.discount,note:s.order.note||'',fabric_choice:s.order.fabric_choice||'',contact:{...s.order.contact},measurements:{...s.order.measurements}},items:s.order.items.map(i=>({id:i.id,name:i.name,qty:i.qty,colour:i.colour||'',size:i.size||'',length_cm:i.length_cm,unit_price:price??i.unit_price,fabric_choice:i.fabric_choice||'',item_note:i.item_note||''}))});
 let edit=(await req('GET',me+'/edit',null,owner)).json;assert.equal((await req('PATCH',me+'/edit',editBody(edit,900),owner)).status,409);near((await state(mcode)).totals.total,1150);
 ms=await state(mcode);assert.equal((await req('POST',me+'/deposit-requirement',ruleBody(ms,'percent',40),owner)).status,201);
 edit=(await req('GET',me+'/edit',null,owner)).json;assert.equal((await req('PATCH',me+'/edit',editBody(edit,900),owner)).status,200);ms=await state(mcode);near(ms.totals.total,1050);near(ms.requirement.amount,420);near(ms.totals.paid,0);
 // A re-priced cart design must follow the same invariant after an edited
 // quote returns to needs_quote; it is not an escape hatch for a fixed rule.
 const draft=await req('POST',S+'/cart-custom',{details:'تفصيل اختبار',colour:'أسود',fabric_type:'ساتان',fabric_choice:'قماش العميلة'},customer);assert.equal(draft.status,201);
 assert.equal((await req('POST',S+'/cart-custom/'+draft.json.id+'/images',{image},customer)).status,201);
 const checkout=await req('POST',S+'/cart-checkout',{items:[{type:'custom',draft_id:draft.json.id,qty:1}],delivery:false,request_id:token()},customer);assert.equal(checkout.status,201,JSON.stringify(checkout.json));
 const cartcode=checkout.json.order.code,cartPath=`${A}/orders/${cartcode}`;const piece=(await req('GET',`${A}/cart-custom/orders/${cartcode}`,null,owner)).json.pieces[0].order_item_id;
 assert.equal((await req('POST',`${A}/cart-custom/items/${piece}/price`,{price:1000},owner)).status,200);
 assert.equal((await req('POST',`${A}/order-deposits/${cartcode}/quote`,{percent:50,payment_details:'حساب تجريبي'},owner)).status,200);
 let cartState=await state(cartcode);assert.equal((await req('POST',cartPath+'/deposit-requirement',ruleBody(cartState,'fixed',900),owner)).status,201);
 edit=(await req('GET',cartPath+'/edit',null,owner)).json;assert.equal((await req('PATCH',cartPath+'/edit',editBody(edit,1100),owner)).status,200);
 assert.equal((await req('POST',`${A}/cart-custom/items/${piece}/price`,{price:800},owner)).status,409);near((await state(cartcode)).totals.total,1100);
 assert.equal((await req('POST',`${A}/cart-custom/items/${piece}/price`,{price:950},owner)).status,200);near((await state(cartcode)).totals.total,950);
 // A normal order: requirement changes do not create payments; stale uploads/decisions are refused.
 const online=await req('POST',S+'/orders',{style_id:'DR-04',colour:'أسود',length_cm:140,fabric_choice:'قماش العميلة',qty:1,delivery:false},customer);assert.equal(online.status,201,JSON.stringify(online.json));const on=online.json.order.code,op=`${A}/order-deposits/${on}`,opm=`${A}/orders/${on}`;
 assert.equal((await req('POST',op+'/quote',{percent:50,payment_details:'حساب تجريبي'},owner)).status,200);
 const original=(await cust(on)).deposit;st=await state(on);const oldTotal=st.totals.total,reqValue=Math.min(400,oldTotal);
 rb=ruleBody(st,'fixed',reqValue);r=await req('POST',opm+'/deposit-requirement',rb,owner);assert.equal(r.status,201,JSON.stringify(r.json));
 let ad=(await req('GET',op,null,owner)).json.deposit;assert.equal(ad.amount,reqValue);assert.equal(ad.recorded_payments.length,0);
 const after=await cust(on);assert.equal(after.deposit.amount,reqValue);assert.equal(after.paid,0);
 assert.equal((await req('POST',`${S}/order-deposits/${on}/receipt`,{image,method:'wallet',quote_revision:original.quote_revision},customer)).status,409);
 assert.equal((await req('POST',`${S}/order-deposits/${on}/receipt`,{image,method:'wallet'},customer)).status,409);
 assert.equal((await req('POST',`${S}/order-deposits/${on}/receipt`,{image,method:'wallet',quote_revision:after.deposit.quote_revision},customer)).status,200);
 st=await state(on);assert.equal((await req('POST',opm+'/deposit-requirement',ruleBody(st,'fixed',100),owner)).status,409);
 ad=(await req('GET',op,null,owner)).json.deposit;assert.equal((await req('POST',op+'/decision',{decision:'approve'},owner)).status,409);
 assert.equal((await req('POST',op+'/decision',{decision:'approve',receipt_revision:'stale'},owner)).status,409);
 r=await req('POST',op+'/decision',{decision:'approve',receipt_revision:ad.receipt_revision},owner);assert.equal(r.status,200,JSON.stringify(r.json));
 ad=(await req('GET',op,null,owner)).json.deposit;near(ad.confirmed_amount,reqValue);const depositPayment=ad.confirmed_payment_id;
 st=await state(on);const cb=correctBody(st,reqValue-50);r=await req('POST',`${opm}/payments/${depositPayment}/correct`,cb,owner);assert.equal(r.status,201,JSON.stringify(r.json));
 c=await cust(on);near(c.paid,reqValue-50);near(c.deposit.amount,reqValue);near(c.deposit.shortfall,50);near(c.deposit.confirmed_amount,reqValue);near(c.deposit.linked_payment_amount,reqValue-50);
 ad=(await req('GET',op,null,owner)).json.deposit;near(ad.confirmed_amount,reqValue);assert.equal(ad.confirmed_payment_id,depositPayment);
 // A custom request without an order: same separate action and protected receipt.
 const custom=await req('POST',S+'/custom-requests',{image,governorate:'الجيزة',fabric_choice:'قماش العميلة'},customer);assert.equal(custom.status,201);const id=custom.json.id,kp=`${A}/custom-requests/${id}`;
 assert.equal((await req('POST',kp+'/quote',{price:1000,percent:50,shipping_fee:100,payment_details:'حساب تجريبي'},owner)).status,200);
 let k=(await req('GET',kp+'/deposit-requirement',null,owner)).json;near(k.requirement.amount,550);
 let rows=(await req('GET',S+'/custom-requests',null,customer)).json.requests;const prev=rows.find(x=>x.id===id);near(prev.deposit,550);
 rb=ruleBody(k,'fixed',320);assert.equal((await req('POST',kp+'/deposit-requirement',rb,owner)).status,201);
 const customAdmin=(await req('GET',A+'/custom-requests',null,owner)).json.requests.find(x=>x.id===id);assert.equal(customAdmin.deposit_history.length,1);assert.equal(customAdmin.deposit_history[0].reason,'تصحيح الاتفاق مع العميلة');
 rows=(await req('GET',S+'/custom-requests',null,customer)).json.requests;const fresh=rows.find(x=>x.id===id);near(fresh.deposit,320);assert(!('deposit_history' in fresh));
 assert.equal((await req('POST',`${S}/custom-requests/${id}/receipt`,{image,method:'wallet',quote_revision:prev.quote_revision},customer)).status,409);
 assert.equal((await req('POST',`${S}/custom-requests/${id}/receipt`,{image,method:'wallet',quote_revision:fresh.quote_revision},customer)).status,200);
 k=(await req('GET',kp+'/deposit-requirement',null,owner)).json;assert.equal((await req('POST',kp+'/deposit-requirement',ruleBody(k,'fixed',300),owner)).status,409);
 let adminRows=(await req('GET',A+'/custom-requests',null,owner)).json.requests,ka=adminRows.find(x=>x.id===id);
 assert.equal((await req('POST',kp+'/decision',{decision:'approve'},owner)).status,409);
 r=await req('POST',kp+'/decision',{decision:'approve',receipt_revision:ka.receipt_revision},owner);assert.equal(r.status,200,JSON.stringify(r.json));const kc=r.json.order_code;
 c=await cust(kc);near(c.paid,320);near(c.deposit.amount,320);assert.equal(c.deposit.requirement_mode,'fixed');
 st=await state(kc);assert(st.history.some(x=>x.custom_id===id&&x.reason==='تصحيح الاتفاق مع العميلة'));
 r=await req('POST',`${A}/orders/${kc}/payments/${st.payments[0].id}/correct`,correctBody(st,300),owner);assert.equal(r.status,201,JSON.stringify(r.json));
 c=await cust(kc);near(c.paid,300);near(c.deposit.amount,320);near(c.deposit.shortfall,20);
 // Exactly one payment row is retained; no fake transfer or refund was created.
 st=await state(kc);assert.equal(st.payments.length,1);assert.equal(st.totals.refunded,0);assert(st.history.some(x=>x.kind==='paid_correction'&&x.old_amount===320&&x.new_amount===300));
 const check=new Database(dbPath,{readonly:true});assert.deepEqual(check.pragma('foreign_key_check'),[]);assert.equal(check.pragma('integrity_check')[0].integrity_check,'ok');check.close();
 console.log('PASS: separate owner corrections/requirements, custom and manual orders, idempotency, stale receipts, audit, customer, reports and refund protection');
}catch(e){console.error(e);process.exitCode=1}finally{server.kill();for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true})}})();
