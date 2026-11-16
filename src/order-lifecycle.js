'use strict';
// Order-level corrections and actual refunds. Nothing here creates a bank
// transfer. All financial mutations are owner-only and transactionally checked.
const express=require('express');
const crypto=require('crypto');
const {db,get,all,run,audit}=require('./db');
const {cairoDate,validDate}=require('./business-date');
const D=require('./domain');
const A=require('./auth');
const I=require('./inventory');
const Notifications=require('./notifications');
const router=express.Router();

class RequestError extends Error{constructor(status,message){super(message);this.status=status;}}
const problem=(status,message)=>{throw new RequestError(status,message)};
const fail=(res,e)=>res.status(e.status||500).json({message:e.status?e.message:'تعذر حفظ العملية؛ راجعي البيانات وحاولي مرة أخرى'});
const safeText=(value,max,allowNewlines=false)=>{
 if(value===undefined||value===null||typeof value==='object')return null;
 const s=String(value).trim();
 // Several older screens use these records; do not introduce markup or inline
 // script into them. Ordinary Arabic, numbers and punctuation are allowed.
 if(s.length>max||/[<>&"'`\\\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)||(!allowNewlines&&/[\r\n]/.test(s)))return null;
 return s;
};
const cash=(value,max=1e8)=>{
 if(value===undefined||value===null||typeof value==='boolean'||typeof value==='object'||String(value).trim()==='')return null;
 const n=Number(value);if(!Number.isFinite(n)||n<0||n>max||Math.abs(n*100-Math.round(n*100))>0.00001)return null;
 return Math.round(n*100)/100;
};
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actor=q=>`user:${q.user.id}`;
const measurements=['bust','waist','hip','length','sleeve','arm'];
function financialRevision(orderId){
 // Include the immutable correction sequence as well as current values: if a
 // payment was corrected away and then back to the same amount, an old form
 // still needs to be reviewed against the intervening correction history.
 return digest({payments:all('SELECT id,amount,method,note,created_at FROM payments WHERE order_id=? ORDER BY id',orderId),
  refunds:all('SELECT id,amount,method,refunded_on,note,voided_at,void_reason FROM order_refunds WHERE order_id=? ORDER BY id',orderId),
  last_correction:get("SELECT COALESCE(MAX(id),0) n FROM deposit_change_log WHERE order_id=? AND kind='paid_correction'",orderId).n});
}
function editState(o){
 const contact=D.orderContact(o)||{name:'',phone:'',area:''};
 const m=D.orderMeasurements(o)||{};
 const items=all(`SELECT i.id,i.style_id,i.description,i.qty,i.colour,i.size,i.length_cm,i.unit_price,i.unit_cost,
                         i.fabric_choice,i.item_note,i.status,s.type AS style_type,
                         COALESCE(NULLIF(i.description,''),s.name) AS name
                  FROM order_items i JOIN styles s ON s.id=i.style_id WHERE i.order_id=? ORDER BY i.id`,o.id);
 const deposit=get('SELECT status,percent,payment_details,payment_method,confirmed_payment_id,confirmed_amount,(receipt IS NOT NULL) has_receipt FROM order_deposits WHERE order_id=?',o.id)||null;
 return {
  order:{id:o.id,code:o.code,status:o.status,channel:o.channel,promise_date:o.promise_date,
    governorate:o.governorate,delivery_requested:!!o.delivery_requested,shipping_quoted:!!o.shipping_quoted,
    delivery_fee:o.delivery_fee,discount:o.discount,note:o.note,fabric_choice:o.fabric_choice,manual_entry:!!o.manual_entry,
    contact:{name:contact.name||'',phone:contact.phone||'',area:contact.area||''},
    measurements:Object.fromEntries(measurements.map(k=>[k,m[k]??null])),items,deposit,
    deposit_rule:require('./deposit-rules').orderRule(o.id,D.orderTotals(o.id).total,deposit),totals:D.orderTotals(o.id)},
  financial_revision:financialRevision(o.id),
 };
}
function editRevision(o){return digest(editState(o));}
function find(code){const o=D.orderByCode(code);if(!o)problem(404,'الأوردر غير موجود');return o;}
function textOrError(value,max,label,allowNewlines=false,required=false,legacy=undefined){
 // Prior data may contain punctuation or exceed today's limits. Preserve it
 // byte-for-byte when untouched; validate any newly entered value strictly.
 if(legacy!==undefined&&typeof value!=='object'&&String(value??'')===String(legacy??''))return String(legacy??'');
 const v=safeText(value??'',max,allowNewlines);
 if(v===null||(required&&!v))problem(400,'راجعي '+label+'؛ النص غير صالح أو طويل');return v;
}
function validateCode(value){
 const code=String(value??'').trim().toUpperCase();
 if(!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code))problem(400,'رقم الأوردر يقبل حروفًا إنجليزية وأرقامًا وشرطة أو _ فقط، حتى ٤٠ حرفًا');
 return code;
}
function assertAvailableCode(code,orderId){
 if(D.orderCodeConflict(code,orderId))problem(409,'رقم الأوردر مستخدم أو محفوظ لأوردر آخر؛ اختاري رقمًا مختلفًا');
}

router.get('/orders/:code/edit',A.requireOwner,(q,r)=>{
 try{const o=find(q.params.code),state=editState(o);r.json({...state,revision:digest(state)});}catch(e){fail(r,e)}
});
router.patch('/orders/:code/edit',A.requireOwner,(q,r)=>{
 try{
  const body=q.body||{};
  const result=db.transaction(()=>{
   const o=find(q.params.code),state=editState(o),current=state.order;
   if(typeof body.revision!=='string'||body.revision!==digest(state))problem(409,'تغيّرت بيانات الأوردر منذ فتح التعديل؛ افتحيه من جديد وراجعيها');
   if(!body.order||typeof body.order!=='object'||!Array.isArray(body.items))problem(400,'راجعي بيانات الأوردر والقطع');
   const b=body.order;
   // Old references may contain historical punctuation or exceed today's
   // format. Keep them verbatim when untouched; validate any new reference.
   const code=typeof b.code==='string'&&b.code===o.code?o.code:validateCode(b.code),contact=b.contact||{};
   assertAvailableCode(code,o.id);
   const name=textOrError(contact.name,100,'اسم العميلة',false,true,current.contact.name);
   if(name.length<2&&name!==current.contact.name)problem(400,'اسم العميلة قصير');
   const phoneInput=textOrError(contact.phone,20,'رقم الهاتف',false,true,current.contact.phone);
   const phone=phoneInput===current.contact.phone?phoneInput:phoneInput.replace(/\s/g,'');
   if(phone!==current.contact.phone&&!/^01[0-9]{9}$/.test(phone))problem(400,'رقم الهاتف يجب أن يبدأ بـ 01 ويكون ١١ رقمًا');
   const area=textOrError(contact.area,200,'المنطقة',false,false,current.contact.area);
   const governorate=textOrError(b.governorate,80,'المحافظة',false,false,o.governorate||'');
   const note=textOrError(b.note,1000,'ملاحظات الأوردر',true,false,o.note||'');
   const fabric=textOrError(b.fabric_choice,120,'خامة الأوردر',false,false,o.fabric_choice||'');
   const channel=String(b.channel||'');
   if(!['whatsapp','facebook','instagram','online','walkin','other'].includes(channel)&&channel!==o.channel)problem(400,'قناة الأوردر غير صالحة');
   const date=String(b.promise_date||'').trim();if(date&&!validDate(date))problem(400,'موعد التسليم غير صالح');
   if(typeof b.delivery_requested!=='boolean')problem(400,'راجعي طريقة الاستلام');
   let deliveryFee,quoted;
   if(b.delivery_fee===null||b.delivery_fee===undefined||String(b.delivery_fee).trim()===''){
    if(o.shipping_quoted&&Number(o.delivery_fee)!==0)problem(400,'اكتبي تكلفة الشحن، أو صفرًا إذا كان مجانيًا');
    deliveryFee=Number(o.delivery_fee);quoted=!!o.shipping_quoted;
   }else{
    deliveryFee=cash(b.delivery_fee);if(deliveryFee===null&&Number(b.delivery_fee)===Number(o.delivery_fee))deliveryFee=Number(o.delivery_fee);
    if(deliveryFee===null)problem(400,'قيمة الشحن غير صالحة');quoted=true;
   }
   let discount=cash(b.discount);if(discount===null&&Number(b.discount)===Number(o.discount))discount=Number(o.discount);
   if(discount===null)problem(400,'قيمة الخصم غير صالحة');
   if(b.delivery_requested&&!governorate&&(b.delivery_requested!==!!o.delivery_requested||governorate!==(o.governorate||'')))problem(400,'اكتبي المحافظة عند التوصيل');
   if(!b.delivery_requested&&deliveryFee>0&&(b.delivery_requested!==!!o.delivery_requested||deliveryFee!==Number(o.delivery_fee)))problem(400,'قيمة الشحن تحتاج اختيار التوصيل والمحافظة');

   const ids=new Set();
   if(body.items.length!==current.items.length)problem(400,'تعديل الأوردر لا يضيف أو يحذف قطعًا؛ راجعي القطع الموجودة');
   const changedItems=[];
   for(const input of body.items){
    const id=Number(input?.id),old=current.items.find(x=>x.id===id);
    if(!old||ids.has(id))problem(400,'بيانات إحدى القطع غير صالحة');ids.add(id);
    const itemName=textOrError(input.name,120,'اسم القطعة',false,true,old.name);
    const colour=textOrError(input.colour,80,'لون القطعة',false,false,old.colour||'');
    const size=textOrError(input.size,40,'مقاس القطعة',false,false,old.size||'');
    const itemFabric=textOrError(input.fabric_choice,120,'خامة القطعة',false,false,old.fabric_choice||'');
    const itemNote=textOrError(input.item_note,500,'ملاحظات القطعة',true,false,old.item_note||'');
    const qty=Number(input.qty);if((!Number.isSafeInteger(qty)||qty<1||qty>1000)&&qty!==old.qty)problem(400,'عدد القطع يجب أن يكون عددًا صحيحًا من ١ إلى ١٠٠٠');
    let length=null;if(input.length_cm!==null&&input.length_cm!==undefined&&String(input.length_cm).trim()!==''){
      length=Number(input.length_cm);if((!Number.isSafeInteger(length)||length<1||length>250)&&length!==old.length_cm)problem(400,'طول القطعة غير صالح');
    }
    let price=cash(input.unit_price);if(price===null&&Number(input.unit_price)===Number(old.unit_price))price=Number(old.unit_price);
    if(price===null)problem(400,'سعر القطعة غير صالح');
    if(old.status==='custom_pending'&&price!==old.unit_price)problem(409,'سعّري التصميم الخاص من قسم مراجعة التصميم أولًا');
    changedItems.push({old,name:itemName,qty,
      colour:colour===String(old.colour??'')?old.colour:colour||null,
      size:size===String(old.size??'')?old.size:size||null,
      length_cm:length,unit_price:price,
      fabric_choice:itemFabric===String(old.fabric_choice??'')?old.fabric_choice:itemFabric||null,
      item_note:itemNote===String(old.item_note??'')?old.item_note:itemNote||null});
   }
   const subtotal=changedItems.reduce((s,x)=>s+x.qty*x.unit_price,0);
   const mm=b.measurements;if(!mm||typeof mm!=='object'||Array.isArray(mm))problem(400,'راجعي المقاسات');
   const m={};for(const k of measurements){
    const value=mm[k];if(value===null||value===undefined||String(value).trim()===''){m[k]=null;continue;}
    const n=Number(value);if((!Number.isInteger(n)||n<20||n>250)&&n!==current.measurements[k])problem(400,'المقاسات المعدلة يجب أن تكون بين ٢٠ و٢٥٠ سم');m[k]=n;
   }
   const financialChanged=changedItems.some(x=>x.qty!==x.old.qty||x.unit_price!==x.old.unit_price)||
    discount!==Number(o.discount)||deliveryFee!==Number(o.delivery_fee)||quoted!==!!o.shipping_quoted;
   if(financialChanged&&discount>subtotal+deliveryFee+0.005)problem(400,'الخصم أكبر من إجمالي الأوردر');
   const deposit=current.deposit;
   if(financialChanged&&deposit?.status==='receipt_pending')problem(409,'راجعي أو ارفضي الإيصال المنتظر قبل تعديل السعر أو العدد أو الشحن؛ لا نغيّر قيمة الإيصال أثناء مراجعته');
   const newTotal=subtotal-discount+deliveryFee,rule=current.deposit_rule;
   if(financialChanged&&rule.explicit&&rule.mode==='fixed'&&Number(rule.value)>newTotal+0.005)
    problem(409,'العربون الثابت أكبر من الإجمالي الجديد؛ عدّلي المطلوب بشكل منفصل أولًا');
   // Reservation changes and all other edits succeed or roll back together.
   I.adjustEditedItems(o,changedItems,actor(q));
   if(code.toUpperCase()!==o.code.toUpperCase()){
    // A pre-existing case-only duplicate cannot safely retain two aliases in
    // the NOCASE index; require manual reconciliation rather than lose a link.
    if(D.orderCodeConflict(o.code,o.id))problem(409,'رقم الأوردر القديم متعارض مع سجل آخر؛ راجعي الأرقام القديمة قبل تغييره أو حذف الأوردر');
    run('INSERT OR IGNORE INTO order_code_aliases(code,order_id) VALUES(?,?)',o.code,o.id);
    D.rememberOrderCode(o.code);D.rememberOrderCode(code);
   }
   const cn=name!==current.contact.name?name:o.contact_name;
   const cp=phone!==current.contact.phone?phone:o.contact_phone;
   const ca=area!==current.contact.area?area:o.contact_area;
   const measureChanged=measurements.some(k=>(current.measurements[k]??null)!==m[k]);
   run(`UPDATE orders SET code=?,channel=?,promise_date=?,governorate=?,delivery_requested=?,shipping_quoted=?,delivery_fee=?,discount=?,note=?,fabric_choice=?,contact_name=?,contact_phone=?,contact_area=?,measurements_snapshot=?,updated_at=datetime('now') WHERE id=?`,
     code,channel,date===String(o.promise_date??'')?o.promise_date:date||null,
     governorate===String(o.governorate??'')?o.governorate:governorate||null,
     b.delivery_requested?1:0,quoted?1:0,deliveryFee,discount,
     note===String(o.note??'')?o.note:note||null,
     fabric===String(o.fabric_choice??'')?o.fabric_choice:fabric||null,
     cn,cp,ca,measureChanged?JSON.stringify(m):o.measurements_snapshot,o.id);
   for(const x of changedItems){
    const description=x.name!==x.old.name?x.name:x.old.description;
    run('UPDATE order_items SET description=?,qty=?,colour=?,size=?,length_cm=?,unit_price=?,fabric_choice=?,item_note=? WHERE id=? AND order_id=?',
      description,x.qty,x.colour,x.size,x.length_cm,x.unit_price,x.fabric_choice,x.item_note,x.old.id,o.id);
   }
   let quoteNeedsReview=false;
   if(financialChanged&&deposit&&['quoted','receipt_rejected'].includes(deposit.status)){
    // Keep old proof until the owner explicitly saves a fresh quote. It is not
    // silently accepted for a new amount.
    run("UPDATE order_deposits SET status='needs_quote' WHERE order_id=?",o.id);quoteNeedsReview=true;
   }
   const totals=D.orderTotals(o.id);
   audit('order',o.id,'details_edited',actor(q),{old_code:o.code,code,financial_changed:financialChanged,
      total_before:current.totals.total,total_after:totals.total,item_ids:changedItems.map(x=>x.old.id),quote_needs_review:quoteNeedsReview});
   return {ok:true,code,totals,quote_needs_review:quoteNeedsReview};
  }).immediate();
  r.json(result);
 }catch(e){if(!e.status&&/[\u0600-\u06ff]/.test(e.message))e.status=409;fail(r,e)}
});

// Reactivation restores the stored previous stage. Unknown legacy stages start
// as new. Any unapproved deposit is flagged for review but must never erase a
// known previous stage; actual refunds and increases are reflected in totals.
router.post('/orders/:code/reactivate',A.requireStaff,(q,r)=>{
 try{
  const result=db.transaction(()=>{
   const o=find(q.params.code);if(o.status!=='cancelled')problem(409,'الأوردر ليس ملغيًا؛ افتحيه وراجعي حالته');
   let stage=o.cancelled_from_status,unknown=!D.INTERNAL_STATUSES.includes(stage)||stage==='cancelled';
   if(unknown)stage='new';
   const dep=get('SELECT status FROM order_deposits WHERE order_id=?',o.id);
   const needsReview=!!dep&&dep.status!=='approved';
   // Delivered pieces have already left inventory. Do not acquire new stock
   // for them; flag contradictory legacy release history for manual review.
   let stock;
   if(stage==='delivered'){
    if(get('SELECT 1 ok FROM stock_reservations r JOIN order_items i ON i.id=r.order_item_id WHERE i.order_id=? AND r.released=1 LIMIT 1',o.id))
     problem(409,'سجل مخزون الطلب المسلّم غير متسق؛ راجعيه يدويًا قبل إعادة التشغيل');
    stock={restored:0,unreserved:0};
   }else stock=I.restore(o.id,actor(q),stage,unknown);
   run("UPDATE orders SET status=?,cancelled_from_status=COALESCE(cancelled_from_status,?),updated_at=datetime('now') WHERE id=? AND status='cancelled'",stage,stage,o.id);
   Notifications.statusChanged(o,stage);
   audit('order',o.id,'reactivated',actor(q),{from:'cancelled',to:stage,previous_unknown:unknown,stock_restored:stock.restored,stock_unreserved:stock.unreserved});
   return {ok:true,code:o.code,status:stage,previous_unknown:unknown,needs_deposit_review:needsReview,stock_reserved:stock.restored,stock_unreserved:stock.unreserved};
  }).immediate();
  r.json(result);
 }catch(e){if(!e.status&&/[\u0600-\u06ff]/.test(e.message))e.status=409;fail(r,e)}
});

router.post('/orders/:code/refunds',A.requireOwner,(q,r)=>{
 try{
  const b=q.body||{},amount=cash(b.amount),method=String(b.method||''),date=String(b.refunded_on||''),token=String(b.request_id||'');
  const note=textOrError(b.note,500,'ملاحظة المرتجع',true);
  if(amount===null||amount<=0||!['cash','wallet','instapay','other'].includes(method)||!validDate(date)||date>cairoDate(new Date().toISOString())||!/^[A-Za-z0-9_-]{8,100}$/.test(token)||b.confirm_actual!==true)
    problem(400,'راجعي مبلغ المرتجع وطريقته وتاريخه وأكدي أنه أُعيد بالفعل');
  const result=db.transaction(()=>{
   const o=find(q.params.code),old=get('SELECT * FROM order_refunds WHERE order_id=? AND request_id=?',o.id,token);
   if(old){
    if(old.amount!==amount||old.method!==method||old.refunded_on!==date||old.note!==note)problem(409,'رمز هذه العملية استُخدم ببيانات مختلفة؛ افتحي الأوردر وراجعي المرتجعات');
    if(old.voided_at)problem(409,'تم تصحيح هذا الإدخال من قبل؛ افتحي الأوردر وراجعي المرتجعات');
    return {ok:true,id:old.id,replay:true,totals:D.orderTotals(o.id)};
   }
   if(typeof b.financial_revision!=='string'||b.financial_revision!==financialRevision(o.id))problem(409,'تغيّرت الدفعات أو المرتجعات؛ افتحي الأوردر وراجعي السجل قبل التسجيل');
   const totals=D.orderTotals(o.id);
   if(amount>totals.paid+0.005)problem(409,'المرتجع أكبر من صافي المدفوع المسجل؛ راجعي الدفعات أولًا');
   const id=Number(run('INSERT INTO order_refunds(order_id,amount,method,refunded_on,note,request_id,created_by) VALUES(?,?,?,?,?,?,?)',o.id,amount,method,date,note,token,q.user.id).lastInsertRowid);
   audit('order',o.id,'refund_recorded',actor(q),{refund_id:id,amount,method,refunded_on:date});
   return {ok:true,id,replay:false,totals:D.orderTotals(o.id)};
  }).immediate();
  r.status(result.replay?200:201).json(result);
 }catch(e){fail(r,e)}
});
router.post('/orders/:code/refunds/:id/void',A.requireOwner,(q,r)=>{
 try{
  const id=Number(q.params.id),reason=textOrError(q.body?.reason,300,'سبب تصحيح السجل',true,true);
  if(!Number.isSafeInteger(id)||id<=0||reason.length<3||q.body?.confirm_clerical!==true)problem(400,'اكتبي سبب تصحيح السجل وأكدي أنه إدخال خاطئ');
  const result=db.transaction(()=>{
   const o=find(q.params.code),old=get('SELECT * FROM order_refunds WHERE id=? AND order_id=?',id,o.id);
   if(!old)problem(404,'سجل المرتجع غير موجود');
   if(old.voided_at)problem(409,'تم إلغاء تسجيل هذا المرتجع من قبل؛ افتحي الأوردر وراجعي السجل');
   if(q.body?.financial_revision!==financialRevision(o.id))problem(409,'تغيّرت الدفعات أو المرتجعات؛ افتحي الأوردر وراجعي السجل');
   run("UPDATE order_refunds SET voided_at=datetime('now'),voided_by=?,void_reason=? WHERE id=? AND voided_at IS NULL",q.user.id,reason,id);
   audit('order',o.id,'refund_record_voided',actor(q),{refund_id:id,reason});
   return {ok:true,totals:D.orderTotals(o.id)};
  }).immediate();r.json(result);
 }catch(e){fail(r,e)}
});

module.exports={router,financialRevision};
