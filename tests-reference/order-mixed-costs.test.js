'use strict';
// A cart with several different designs: fabric is charged once per purchase,
// while each workshop rate uses only the quantity of its chosen order item.
const {spawn,spawnSync}=require('child_process'),fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.join(__dirname,'..'),db=path.join(root,'data','mixed-cost-test.db'),port=3372,base=`http://127.0.0.1:${port}`;
for(const x of ['','-wal','-shm'])fs.rmSync(db+x,{force:true});const env={...process.env,DB_PATH:db,PORT:String(port),SHOW_OTP:'0',AUTO_SEED:'0',NODE_ENV:'test'};
const seed=spawnSync(process.execPath,['src/seed.js'],{cwd:root,env,encoding:'utf8'});assert.equal(seed.status,0,seed.stderr);
const server=spawn(process.execPath,['src/bootstrap.js'],{cwd:root,env,stdio:'ignore'});
async function req(method,url,body,token){let r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,json:await r.json()};}
(async()=>{try{
 for(let i=0;i<50;i++){try{await fetch(base+'/healthz');break}catch{await new Promise(r=>setTimeout(r,100))}}
 const customer=(await req('POST','/api/store/auth/login',{phone:'01012345678',password:'mavi1234'})).json.token;
 const owner=(await req('POST','/api/admin/auth/login',{email:'owner@mavi.eg',password:'mavi-owner'})).json.token;
 const staff=(await req('POST','/api/admin/auth/login',{email:'staff@mavi.eg',password:'mavi-staff'})).json.token;
 const catalog=(await req('GET','/api/store/catalogue')).json.styles.filter(s=>s.type==='made'&&s.colours.length&&s.lengths.length);
 const items=catalog.slice(0,2).map((s,i)=>({style_id:s.id,colour:s.colours[0].name,length_cm:s.lengths[0],qty:i+1,fabric_choice:'قماش العميلة'}));
 const cart=await req('POST','/api/store/cart-checkout',{items,delivery:true,governorate:'الجيزة',request_id:'mixed-cost-cart-123456789'},customer);assert.equal(cart.status,201);
 const code=cart.json.order.code,baseCost=`/api/admin/orders/${code}/cost-purchases`;
 let order=(await req('GET','/api/admin/orders/'+code,null,owner)).json.order;assert.equal(order.items.length,2);assert.equal(order.items[0].qty,1);assert.equal(order.items[1].qty,2);
 const first=order.items[0].id,second=order.items[1].id;
 assert.equal((await req('POST',baseCost+'/fabric',{fabric_name:'حرير',metres:4,price_per_metre:100,shipping_per_metre:10},owner)).status,201);
 assert.equal((await req('POST',baseCost+'/fabric',{fabric_name:'حرير',metres:1.5,price_per_metre:150,shipping_per_metre:5},owner)).status,201);
 const w1=await req('POST',baseCost+'/workshop',{order_item_id:first,tailor_id:1,unit_cost:80},owner);assert.equal(w1.status,201);
 const w2=await req('POST',baseCost+'/workshop',{order_item_id:second,tailor_id:2,unit_cost:90},owner);assert.equal(w2.status,201);
 assert.equal((await req('PUT',`/api/admin/order-items/${second}/cost-lines`,{lines:[{label:'زرار',quantity:1,unit_cost:10}]},owner)).status,200);
 const extraBody={label:'توصيل العميلة الفعلي',amount:35,request_id:'whole-order-cost-01'};
 const extra=await req('POST',baseCost+'/other',extraBody,owner);assert.equal(extra.status,201);
 assert.equal((await req('POST',baseCost+'/other',extraBody,owner)).status,200);
 assert.equal((await req('POST',baseCost+'/other',{...extraBody,amount:36},owner)).status,409);
 assert.equal((await req('POST',baseCost+'/other',{label:'',amount:35},owner)).status,400);
 assert.equal((await req('POST',baseCost+'/other',extraBody,staff)).status,403);
 assert.equal((await req('PUT',baseCost+'/other/'+extra.json.id,{label:'توصيل العميلة الفعلي',amount:40},owner)).status,200);
 order=(await req('GET','/api/admin/orders/'+code,null,owner)).json.order;assert.equal(order.totals.cost,992.5);
 const staffOrder=(await req('GET','/api/admin/orders/'+code,null,staff)).json.order;assert.equal(staffOrder.items[0].workshop_names.length,1);assert.equal(staffOrder.items[1].workshop_names.length,1);assert(!JSON.stringify(staffOrder).includes('unit_cost'));
 const report=(await req('GET','/api/admin/money/cost-detail?from=2000-01-01&to=2100-01-01',null,owner)).json.rows.find(x=>x.code===code);
 assert.equal(report.material,672.5);assert.equal(report.tailoring,260);assert.equal(report.order_other,40);assert.equal(report.manual,20);assert.equal(report.cost,992.5);assert(Math.abs(report.tailoring_per_metre-260/5.5)<1e-9);
 assert.equal((await req('DELETE',baseCost+'/workshop/'+w1.json.id,null,owner)).status,200);
 order=(await req('GET','/api/admin/orders/'+code,null,owner)).json.order;assert.equal(order.totals.cost,912.5);assert.equal(order.items[0].workshop_names.length,0);
 assert.equal((await req('DELETE',baseCost+'/other/'+extra.json.id,null,owner)).status,200);assert.equal((await req('GET','/api/admin/orders/'+code,null,owner)).json.order.totals.cost,872.5);
 const mine=await req('GET','/api/store/orders/'+code,null,customer);assert(!JSON.stringify(mine.json).includes('unit_cost'));
 console.log('PASS: mixed cart, multiple purchase prices, item-specific workshops and no repeat multiplication');
}catch(e){console.error(e);process.exitCode=1}finally{server.kill();for(const x of ['','-wal','-shm'])fs.rmSync(db+x,{force:true})}})();
