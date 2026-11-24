'use strict';
const express=require('express'),{db,get,run,audit}=require('./db'),A=require('./auth'),D=require('./domain'),N=require('./notifications');
const router=express.Router();router.use(A.requireOwner);
const bad=(r,s,m)=>r.status(s).json({message:m});
const clean=(v,max)=>{let s=String(v||'').trim();return s.length<=max&&!/[<>&"'`\\]/.test(s)?s:null};
const number=(v,max)=>{if(v===undefined||v===null||String(v).trim()==='')return null;let n=Number(v);return Number.isFinite(n)&&n>=0&&n<=max?n:null};
router.post('/',(q,r)=>{
 const b=q.body||{},name=clean(b.customer_name,100),phone=clean(b.customer_phone,20),area=clean(b.area,200),gov=clean(b.governorate,80),note=clean(b.note,1000);
 const ship=b.shipping_fee===''||b.shipping_fee==null?null:number(b.shipping_fee,1e8),paid=b.paid===''||b.paid==null?0:number(b.paid,1e8);
 const statuses=['new','confirmed','cut','sewing','ready','delivering','delivered'];const channels=['whatsapp','facebook','instagram','walkin','other'];let status=String(b.status||'new'),channel=String(b.channel||'other'),date=String(b.promise_date||'').trim();
 // Multi-item order (multiple dresses per order). Legacy single-item fields are
 // still accepted and normalised into the same items list.
 const readItem=(it)=>{
  const p=number(it.unit_price,1e8),qty=number(it.qty,20);
  const colour=clean(it.colour,80),fabric=clean(it.fabric_choice,120),custom=clean(it.custom_name,100);
  let sid=String(it.style_id||'').trim();
  if(sid){const s=get("SELECT id,type FROM styles WHERE id=? AND active=1",sid);if(!s||s.type!=='made'||sid==='MANUAL-CUSTOM')return {err:'الموديل غير متاح'};}
  else if(!custom)return {err:'اختاري موديلًا أو اكتبي وصف التصميم لكل قطعة'};
  if(p===null||qty===null||!Number.isInteger(qty)||qty<1)return {err:'راجعي سعر وكمية كل قطعة (عدد صحيح ١ على الأقل)'};
  return {item:{sid,custom,colour,fabric,qty,price:p}};
 };
 let items;
 if(Array.isArray(b.items)){
  if(b.items.length<1||b.items.length>20)return bad(r,400,'أضيفي قطعة واحدة على الأقل و٢٠ قطعة كحد أقصى للأوردر');
  items=[];
  for(const raw of b.items){const res=readItem(raw||{});if(res.err)return bad(r,400,res.err);items.push(res.item);}
 }else{
  const colour=clean(b.colour,80),fabric=clean(b.fabric_choice,120),custom=clean(b.custom_name,100);
  const res=readItem({style_id:b.style_id,custom_name:custom,colour,fabric,qty:b.qty,unit_price:b.unit_price});
  if(res.err)return bad(r,400,res.err);
  items=[res.item];
 }
 if(!name||name.length<3||!/^01[0-9]{9}$/.test(phone||'')||[area,gov,note].some(x=>x===null)||paid===null||(!['',null,undefined].includes(b.shipping_fee)&&ship===null)||!statuses.includes(status)||!channels.includes(channel)||(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date)))return bad(r,400,'راجعي اسم العميلة ورقمها وبيانات القطع والمدفوع');
 const subtotal=items.reduce((s,i)=>s+i.price*i.qty,0);
 if(paid>subtotal+(ship||0))return bad(r,400,'المدفوع أكبر من إجمالي القطع والشحن');
 if(ship!==null&&ship>0&&!gov)return bad(r,400,'حددي المحافظة عند التوصيل');
 const headerFabric=items.map(i=>i.fabric).filter(Boolean)[0]||null;
 let m={};for(const k of ['bust','waist','hip','shoulder','length','sleeve','arm']){let v=b.measurements?.[k];if(v!==undefined&&v!==null&&String(v).trim()!==''){let n=number(v,250);if(n===null||n<20||!Number.isInteger(n))return bad(r,400,'المقاسات يجب أن تكون بين 20 و250 سم');m[k]=n}}
 const existing=get('SELECT id,name FROM customers WHERE phone=?',phone);
 if(existing&&!b.confirm_existing)return r.status(409).json({error:'customer_exists',message:'الرقم مسجل لعميلة موجودة. أكدي الاسم قبل إضافة الأوردر.',existing_name:existing.name});
 let result;
 try{result=db.transaction(()=>{
  let c=get('SELECT id,name FROM customers WHERE phone=?',phone),fresh=!c;
  if(c&&!b.confirm_existing){const e=Error('customer_exists');e.code='CUSTOMER_EXISTS';e.existing_name=c.name;throw e;}
  if(!c){const x=run('INSERT INTO customers(phone,name,area) VALUES(?,?,?)',phone,name,area||null);c={id:x.lastInsertRowid,name};}
  // Never silently overwrite the measurements of an existing account.
  if(fresh&&Object.keys(m).length)run('INSERT INTO measurements(customer_id,waist,hip,bust,shoulder,length,sleeve,arm) VALUES(?,?,?,?,?,?,?,?)',c.id,m.waist||null,m.hip||null,m.bust||null,m.shoulder||null,m.length||null,m.sleeve||null,m.arm||null);
  const customDesc=items.filter(i=>!i.sid&&i.custom).map(i=>i.custom);
  for(const d of customDesc)run("INSERT OR IGNORE INTO styles(id,name,type,price,cost,active) VALUES('MANUAL-CUSTOM','تصميم من خارج الكتالوج','made',0,0,0)");
  const code=D.nextOrderCode();const o=run('INSERT INTO orders(code,customer_id,channel,status,promise_date,delivery_fee,note,governorate,delivery_requested,shipping_quoted,fabric_choice,manual_entry) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)',code,c.id,channel,status,date||null,ship||0,note||null,gov||null,gov?1:0,ship!==null?1:0,headerFabric);
  for(const it of items){
   const sid=it.sid||'MANUAL-CUSTOM';
   run('INSERT INTO order_items(order_id,style_id,description,qty,colour,unit_price) VALUES(?,?,?,?,?,?)',o.lastInsertRowid,sid,it.sid?null:it.custom,it.qty,it.colour||null,it.price);
  }
  if(paid>0)run('INSERT INTO payments(order_id,amount,method,note) VALUES(?,?,?,?)',o.lastInsertRowid,paid,(['cash','instapay','wallet','other'].includes(b.payment_method)?b.payment_method:'cash'),'دفعة مسجلة لطلب خارجي');
  N.statusChanged({id:o.lastInsertRowid,customer_id:c.id,code},status);
  audit('order',code,'manual_created',`user:${q.user.id}`,{customer:c.id,channel,status,items:items.length});return {code,customer_created:fresh,existing_name:c.name,items_count:items.length};
 })()}catch(e){if(e.code==='CUSTOMER_EXISTS')return r.status(409).json({error:'customer_exists',message:'الرقم مسجل بالفعل؛ أكدي الاسم.',existing_name:e.existing_name});console.error('[manual order]',e.message);return bad(r,500,'لم يُحفظ الطلب؛ راجعي البيانات وحاولي مرة أخرى')}
 r.status(201).json(result);
});
router.patch('/:code/shipping',(q,r)=>{
 const o=D.orderByCode(q.params.code);
 if(!o||!o.manual_entry)return bad(r,404,'الأوردر الخارجي غير موجود');
 if(o.status==='cancelled')return bad(r,409,'لا يمكن تعديل شحن أوردر ملغي');
 const shipping=number(q.body.shipping_fee,1e8),gov=clean(q.body.governorate,80);
 if(shipping===null||gov===null||(!gov&&shipping>0))return bad(r,400,'حددي قيمة الشحن والمحافظة عند التوصيل');
 const result=db.transaction(()=>{
  const latest=get('SELECT * FROM orders WHERE id=?',o.id);if(latest.status==='cancelled')return {error:'لا يمكن تعديل شحن أوردر ملغي'};
  const deposit=get('SELECT status FROM order_deposits WHERE order_id=?',o.id);
  const changed=Number(latest.delivery_fee)!==shipping||!latest.shipping_quoted;
  if(changed&&deposit?.status==='receipt_pending')return {error:'راجعي الإيصال المنتظر قبل تعديل الشحن'};
  const currentTotal=D.orderTotals(o.id).total,rule=require('./deposit-rules').orderRule(o.id,currentTotal);
  if(changed&&rule.explicit&&rule.mode==='fixed'&&Number(rule.value)>currentTotal-Number(latest.delivery_fee)+shipping+0.005)
   return {error:'العربون الثابت أكبر من الإجمالي الجديد؛ عدّلي المطلوب بشكل منفصل أولًا'};
  run('UPDATE orders SET delivery_fee=?,governorate=?,delivery_requested=?,shipping_quoted=1 WHERE id=?',shipping,gov||null,gov?1:0,o.id);
  if(changed&&deposit&&['quoted','receipt_rejected'].includes(deposit.status))run("UPDATE order_deposits SET status='needs_quote' WHERE order_id=?",o.id);
  audit('order',o.code,'manual_shipping_updated',`user:${q.user.id}`,{shipping});return {ok:true};
 }).immediate();
 if(result.error)return bad(r,409,result.error);r.json(result);
});
module.exports=router;
