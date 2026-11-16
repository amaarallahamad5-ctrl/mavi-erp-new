'use strict';
// Disposable synthetic database only. Admin upload must not itself approve,
// record money, reserve stock, overwrite another receipt, or leak images.
const {spawn,spawnSync}=require('child_process'),fs=require('fs'),path=require('path'),assert=require('assert');
const Database=require('better-sqlite3');
const root=path.join(__dirname,'..'),dbPath=path.join(root,'data','admin-receipt-test.db'),port=3375,base=`http://127.0.0.1:${port}`;
for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true});
const env={...process.env,DB_PATH:dbPath,PORT:String(port),SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'};
const seed=spawnSync(process.execPath,['src/seed.js'],{cwd:root,env,encoding:'utf8'});assert.equal(seed.status,0,seed.stderr);
const server=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env,stdio:'ignore'});
async function req(method,url,body,token){const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});const bytes=Buffer.from(await r.arrayBuffer());let json;try{json=JSON.parse(bytes.toString())}catch{}return {status:r.status,json,bytes,headers:r.headers};}
function sql(statement,args=[],kind='get'){const d=new Database(dbPath);try{d.pragma('foreign_keys=ON');return d.prepare(statement)[kind](...args)}finally{d.close()}}
(async()=>{try{
 for(let i=0;i<60;i++){try{await fetch(base+'/healthz');break}catch{await new Promise(r=>setTimeout(r,100))}}
 const owner=(await req('POST','/api/admin/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'})).json.token;
 const staff=(await req('POST','/api/admin/auth/login',{email:'staff@mavi.eg',password:'mavi-staff'})).json.token;
 const customer=(await req('POST','/api/store/auth/login',{phone:'01012345678',password:'mavi1234'})).json.token;
 const other=(await req('POST','/api/store/auth/login',{phone:'01123456789',password:'mavi1234'})).json.token;
 const style={id:'ADMIN-RECEIPT-TEST',name:'فستان اختبار',price:1200,lead_days:10,colours:['أسود'],fabrics:['ساتان'],active:true};
 assert.equal((await req('POST','/api/admin/catalogue/styles',style,owner)).status,200);
 const image='data:image/png;base64,'+fs.readFileSync(path.join(root,'public/brand/icon-192.png')).toString('base64');
 const large='data:image/png;base64,'+Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(210000)]).toString('base64');
 const tooLarge='data:image/png;base64,'+Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(2*1024*1024)]).toString('base64');
 const make=async()=>{const v=await req('POST','/api/store/orders',{style_id:style.id,colour:'أسود',fabric_choice:'قماش العميلة',qty:1,delivery:true,governorate:'الجيزة'},customer);assert.equal(v.status,201,JSON.stringify(v.json));return v.json.order.code};
 const quote=async code=>assert.equal((await req('POST',`/api/admin/order-deposits/${code}/quote`,{percent:50,shipping_fee:125,payment_details:'Instapay test'},owner)).status,200);
 const code=await make(),ap=`/api/admin/order-deposits/${code}`;
 assert.equal((await req('POST',ap+'/receipt',{image,method:'wallet'},staff)).status,403);
 assert.equal((await req('POST',ap+'/receipt',{image,method:'wallet'},customer)).status,401);
 assert.equal((await req('POST',ap+'/receipt',{image,method:'wallet'},owner)).status,409); // no quote yet
 await quote(code);
 assert.equal((await req('POST',ap+'/receipt',{image:'data:image/png;base64,SGVsbG8=',method:'wallet'},owner)).status,400);
 assert.equal((await req('POST',ap+'/receipt',{image:tooLarge,method:'wallet'},owner)).status,400);
 assert.equal((await req('POST',ap+'/receipt',{image:large,method:'wallet'},owner)).status,200); // >200 KB JSON works
 let d=(await req('GET',ap,null,owner)).json.deposit;assert.equal(d.status,'receipt_pending');assert.equal(d.receipt_source,'admin');assert.equal(d.amount,662.5);assert.equal(d.paid_to_date,0);
 assert.equal((await req('GET',ap+'/receipt',null,staff)).status,403);assert.equal((await req('GET',ap+'/receipt')).status,401);
 const binary=await req('GET',ap+'/receipt',null,owner);assert.equal(binary.status,200);assert.equal(binary.headers.get('content-type'),'image/png');assert(binary.headers.get('cache-control').includes('no-store'));
 assert.equal((await req('GET','/api/store/orders/'+code,null,other)).status,404);
 assert.equal((await req('GET','/api/store/orders/'+code,null,customer)).json.order.deposit.status,'receipt_pending');
 assert.equal((await req('POST',`/api/store/order-deposits/${code}/receipt`,{image,method:'wallet'},customer)).status,409);
 assert.equal((await req('POST',ap+'/receipt',{image,method:'wallet'},owner)).status,409); // no overwriting pending proof
 assert.equal((await req('PATCH',`/api/admin/orders/${code}/status`,{status:'sewing'},staff)).status,409);
 assert.equal((await req('POST',ap+'/decision',{decision:'approve'},staff)).status,403);
 assert.equal(sql('SELECT count(*) n FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.code=?',[code]).n,0);
 const parallel=await Promise.all([req('POST',ap+'/decision',{decision:'approve'},owner),req('POST',ap+'/decision',{decision:'approve'},owner)]);
 assert.deepEqual(parallel.map(x=>x.status).sort(),[200,409]);
 assert.equal((await req('GET','/api/admin/orders/'+code,null,owner)).json.order.totals.paid,662.5);
 assert.equal((await req('GET',ap,null,owner)).json.deposit.confirmed_amount,662.5);
 assert.equal(sql('SELECT count(*) n FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.code=?',[code]).n,1);
 assert.equal((await req('PATCH',`/api/admin/orders/${code}/status`,{status:'sewing'},staff)).status,200);
 assert.equal((await req('POST',ap+'/receipt',{image,method:'wallet'},owner)).status,409);
 const events=(await req('GET','/api/store/web-alerts',null,customer)).json.alerts;
 assert(events.some(e=>e.kind==='deposit_approved'&&e.order_code===code));
 assert.equal(sql("SELECT count(*) n FROM events WHERE entity='order' AND entity_id=? AND action='deposit_receipt_admin' AND actor LIKE 'user:%'",[code]).n,1);

 // If this transfer was already recorded manually, explicitly link that
 // exact existing payment. Never auto-guess and never count it twice.
 const prior=await make();await quote(prior);const pp=`/api/admin/order-deposits/${prior}`;
 assert.equal((await req('POST',`/api/admin/orders/${prior}/payments`,{amount:662.5,method:'wallet',note:'تحويل وصل مسبقًا'},owner)).status,409); // no new payment before confirmation
 // Emulate a payment from the prior release, not a new manual payment.
 sql("INSERT INTO payments(order_id,amount,method,note) SELECT id,662.5,'wallet','تحويل وصل مسبقًا' FROM orders WHERE code=?",[prior],'run');
 assert.equal((await req('POST',pp+'/receipt',{image,method:'wallet'},owner)).status,200);
 assert.equal((await req('POST',`/api/admin/orders/${prior}/payments`,{amount:1,method:'cash'},owner)).status,409);
 d=(await req('GET',pp,null,owner)).json.deposit;assert.equal(d.matching_payments.length,1);assert.equal(d.paid_to_date,662.5);
 assert.equal((await req('POST',pp+'/decision',{decision:'approve'},owner)).status,409); // choose explicitly
 const reviewed=d.recorded_payments.map(p=>p.id);
 assert.equal((await req('POST',pp+'/decision',{decision:'approve',existing_payment_id:999999,review_payment_ids:reviewed},owner)).status,409);
 assert.equal((await req('POST',pp+'/decision',{decision:'approve',existing_payment_id:d.matching_payments[0].id,review_payment_ids:[]},owner)).status,409); // stale view
 const reused=await req('POST',pp+'/decision',{decision:'approve',existing_payment_id:d.matching_payments[0].id,review_payment_ids:reviewed},owner);assert.equal(reused.status,200);assert(reused.json.used_existing);
 assert.equal((await req('GET','/api/admin/orders/'+prior,null,owner)).json.order.totals.paid,662.5);
 assert.equal((await req('GET',pp,null,owner)).json.deposit.confirmed_amount,662.5);
 assert.equal(sql('SELECT count(*) n FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.code=?',[prior]).n,1);
 assert((await req('GET','/api/admin/deletions/payment/'+d.matching_payments[0].id,null,owner)).json.blocked);
 assert.equal((await req('POST','/api/admin/deletions/payment/'+d.matching_payments[0].id,{password:'mavi-owner',confirmation:'حذف نهائي'},owner)).status,409);
 // A genuinely separate same-value transfer can still be explicitly recorded.
 const separate=await make();await quote(separate);const sep=`/api/admin/order-deposits/${separate}`;
 sql("INSERT INTO payments(order_id,amount,method,note) SELECT id,662.5,'wallet','تحويل آخر' FROM orders WHERE code=?",[separate],'run');
 assert.equal((await req('POST',sep+'/receipt',{image,method:'wallet'},owner)).status,200);
 assert.equal((await req('POST',sep+'/decision',{decision:'approve'},owner)).status,409);
 const sepSnapshot=(await req('GET',sep,null,owner)).json.deposit.recorded_payments.map(p=>p.id);
 assert.equal((await req('POST',sep+'/decision',{decision:'approve',existing_payment_id:null,review_payment_ids:sepSnapshot},owner)).status,200);
 assert.equal((await req('GET','/api/admin/orders/'+separate,null,owner)).json.order.totals.paid,1325);
 // An older full payment can cover the deposit, even if the method differs,
 // but a deliberate extra acknowledgement is required and nothing is added.
 const full=await make();await quote(full);const fp=`/api/admin/order-deposits/${full}`;
 sql("INSERT INTO payments(order_id,amount,method,note) SELECT id,1325,'cash','إجمالي سابق' FROM orders WHERE code=?",[full],'run');
 assert.equal((await req('POST',fp+'/receipt',{image,method:'wallet'},owner)).status,200);
 const fd=(await req('GET',fp,null,owner)).json.deposit,ids=fd.recorded_payments.map(p=>p.id),fullId=fd.linkable_payments[0].id;
 assert.equal(fd.matching_payments.length,0);assert.equal(fd.linkable_payments.length,1);
 assert.equal((await req('POST',fp+'/decision',{decision:'approve',existing_payment_id:fullId,review_payment_ids:ids},owner)).status,409);
 assert.equal((await req('POST',fp+'/decision',{decision:'approve',existing_payment_id:fullId,review_payment_ids:ids,confirmed_existing_payment:true},owner)).status,200);
 assert.equal((await req('GET','/api/admin/orders/'+full,null,owner)).json.order.totals.paid,1325);
 // A payment smaller than the deposit cannot be misrepresented as covering it.
 const partial=await make();await quote(partial);const pt=`/api/admin/order-deposits/${partial}`;
 sql("INSERT INTO payments(order_id,amount,method) SELECT id,100,'wallet' FROM orders WHERE code=?",[partial],'run');
 assert.equal((await req('POST',pt+'/receipt',{image,method:'wallet'},owner)).status,200);
 const pd=(await req('GET',pt,null,owner)).json.deposit,partialId=pd.recorded_payments[0].id;
 assert.equal(pd.linkable_payments.length,0);
 assert.equal((await req('POST',pt+'/decision',{decision:'approve',existing_payment_id:partialId,review_payment_ids:[partialId],confirmed_existing_payment:true},owner)).status,409);
 assert.equal((await req('POST',pt+'/decision',{decision:'approve',existing_payment_id:null,review_payment_ids:[partialId]},owner)).status,200);
 assert.equal((await req('GET','/api/admin/orders/'+partial,null,owner)).json.order.totals.paid,762.5);
 // Even a previously empty view is stale if a legacy/external payment arrives.
 const stale=await make();await quote(stale);const st=`/api/admin/order-deposits/${stale}`;
 assert.equal((await req('POST',st+'/receipt',{image,method:'wallet'},owner)).status,200);
 assert.equal((await req('GET',st,null,owner)).json.deposit.recorded_payments.length,0);
 sql("INSERT INTO payments(order_id,amount,method) SELECT id,662.5,'wallet' FROM orders WHERE code=?",[stale],'run');
 assert.equal((await req('POST',st+'/decision',{decision:'approve',existing_payment_id:null,review_payment_ids:[]},owner)).status,409);
 assert.equal((await req('GET',st,null,owner)).json.deposit.status,'receipt_pending');
 // Competing customer and admin uploads cannot overwrite each other.
 const race=await make();await quote(race);const rp=`/api/admin/order-deposits/${race}`;
 const uploads=await Promise.all([req('POST',rp+'/receipt',{image,method:'wallet'},owner),req('POST',`/api/store/order-deposits/${race}/receipt`,{image,method:'instapay'},customer)]);
 assert.deepEqual(uploads.map(x=>x.status).sort(),[200,409]);
 d=(await req('GET',rp,null,owner)).json.deposit;assert(['customer','admin'].includes(d.receipt_source));assert.equal(d.paid_to_date,0);

 // Simulate a stock-based legacy order. Failure to reserve rolls back both the
 // approval and payment; after stock is restored it may be confirmed once.
 const stockCode=await make();await quote(stockCode);const sp=`/api/admin/order-deposits/${stockCode}`;
 sql("INSERT INTO styles(id,name,type,price,cost,active) VALUES('ADMIN-OLD-STOCK','مخزون قديم','stock',1200,50,1)",[],'run');
 sql("INSERT INTO stock_items(style_id,size,colour,qty,buy_price,sell_price) VALUES('ADMIN-OLD-STOCK','M','أسود',0,50,1200)",[],'run');
 sql("UPDATE order_items SET style_id='ADMIN-OLD-STOCK',size='M',colour='أسود',qty=1 WHERE order_id=(SELECT id FROM orders WHERE code=?)",[stockCode],'run');
 assert.equal((await req('POST',sp+'/receipt',{image,method:'instapay'},owner)).status,200);
 assert.equal((await req('POST',sp+'/decision',{decision:'approve'},owner)).status,409);
 assert.equal((await req('GET',sp,null,owner)).json.deposit.status,'receipt_pending');
 assert.equal(sql('SELECT count(*) n FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.code=?',[stockCode]).n,0);
 sql("UPDATE stock_items SET qty=1 WHERE style_id='ADMIN-OLD-STOCK'",[],'run');
 assert.equal((await req('POST',sp+'/decision',{decision:'approve'},owner)).status,200);
 assert.equal(sql("SELECT qty FROM stock_items WHERE style_id='ADMIN-OLD-STOCK'").qty,0);
 // Deleting an undelivered approved order returns its reserved stock in the
 // same transaction; deleting delivered goods must never invent a return.
 const stockId=(await req('GET','/api/admin/orders/'+stockCode,null,owner)).json.order.id;
 assert.equal((await req('GET','/api/admin/deletions/order/'+stockId,null,owner)).json.stock_to_restore,1);
 assert.equal((await req('POST','/api/admin/deletions/order/'+stockId,{password:'mavi-owner',confirmation:'حذف نهائي'},owner)).status,200);
 assert.equal(sql("SELECT qty FROM stock_items WHERE style_id='ADMIN-OLD-STOCK'").qty,1);
 assert.equal(sql("SELECT COUNT(*) n FROM stock_movements WHERE reason='حذف الطلب قبل التسليم'").n,1);
 const delivered=await make();await quote(delivered);const dp=`/api/admin/order-deposits/${delivered}`;
 sql("UPDATE order_items SET style_id='ADMIN-OLD-STOCK',size='M',colour='أسود',qty=1 WHERE order_id=(SELECT id FROM orders WHERE code=?)",[delivered],'run');
 assert.equal((await req('POST',dp+'/receipt',{image,method:'instapay'},owner)).status,200);
 assert.equal((await req('POST',dp+'/decision',{decision:'approve'},owner)).status,200);
 assert.equal((await req('PATCH',`/api/admin/orders/${delivered}/status`,{status:'delivered'},staff)).status,200);
 const deliveredId=(await req('GET','/api/admin/orders/'+delivered,null,owner)).json.order.id;
 let impact=(await req('GET','/api/admin/deletions/order/'+deliveredId,null,owner)).json;assert.equal(impact.stock_to_restore,0);assert.equal(impact.stock_delivered,1);
 assert.equal((await req('POST','/api/admin/deletions/order/'+deliveredId,{password:'mavi-owner',confirmation:'حذف نهائي'},owner)).status,200);
 assert.equal(sql("SELECT qty FROM stock_items WHERE style_id='ADMIN-OLD-STOCK'").qty,0);

 // Custom-design request has no order until a separate owner confirmation.
 const custom=await req('POST','/api/store/custom-requests',{image,governorate:'الجيزة',fabric_choice:'قماش العميلة'},customer);assert.equal(custom.status,201);const id=custom.json.id,cp=`/api/admin/custom-requests/${id}`;
 assert.equal((await req('POST',cp+'/receipt',{image,method:'wallet'},owner)).status,409);
 assert.equal((await req('POST',cp+'/quote',{price:2000,percent:40,shipping_fee:100,payment_details:'Instapay test'},owner)).status,200);
 assert.equal((await req('POST',cp+'/receipt',{image,method:'wallet'},staff)).status,403);
 assert.equal((await req('POST',cp+'/receipt',{image:large,method:'wallet'},owner)).status,200);
 let row=(await req('GET','/api/admin/custom-requests',null,owner)).json.requests.find(x=>x.id===id);assert.equal(row.status,'receipt_pending');assert.equal(row.receipt_source,'admin');
 assert.equal(sql('SELECT count(*) n FROM custom_order_links WHERE request_id=?',[id]).n,0);
 assert.equal((await req('POST',`/api/store/custom-requests/${id}/receipt`,{image,method:'wallet'},customer)).status,409);
 assert.equal((await req('GET',cp+'/receipt',null,staff)).status,403);
 const votes=await Promise.all([req('POST',cp+'/decision',{decision:'approve'},owner),req('POST',cp+'/decision',{decision:'approve'},owner)]);assert.deepEqual(votes.map(x=>x.status).sort(),[200,409]);
 const approved=votes.find(x=>x.status===200).json;assert(approved.order_code);
 const made=(await req('GET','/api/admin/orders/'+approved.order_code,null,owner)).json.order;assert.equal(made.totals.paid,840);assert.equal(made.status,'confirmed');
 assert.equal(sql('SELECT count(*) n FROM custom_order_links WHERE request_id=?',[id]).n,1);
 assert.equal((await req('POST',cp+'/receipt',{image,method:'wallet'},owner)).status,409);
 assert.equal(sql("SELECT count(*) n FROM events WHERE entity='custom_request' AND entity_id=? AND action='receipt_submitted_admin'",[String(id)]).n,1);
 const check=new Database(dbPath,{readonly:true});assert.deepEqual(check.pragma('foreign_key_check'),[]);check.close();
 console.log('PASS: owner upload + separate confirmation, existing-payment linking, stock rollback, concurrency, privacy, alerts and legacy custom orders');
}catch(e){console.error(e);process.exitCode=1}finally{server.kill();for(const s of ['','-wal','-shm'])fs.rmSync(dbPath+s,{force:true})}})();
