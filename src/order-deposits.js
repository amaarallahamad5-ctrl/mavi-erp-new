'use strict';
// Online/cart order deposits. Receipt upload and confirmation are separate:
// only the confirmation records a payment and reserves finished-stock items.
const express = require('express');
const {get,all,run,db,audit} = require('./db');
const A = require('./auth');
const D = require('./domain');
const {photo} = require('./custom-requests');
const I = require('./inventory');
const fail = (res,status,message) => res.status(status).json({message});
const problem = (status,message) => ({status,message});
const customer=express.Router(), admin=express.Router();
customer.use(A.requireCustomer);
admin.use(A.requireOwner);

function uploadReceipt(q,r,source){
 const pic=photo(q.body?.image), method=String(q.body?.method||'');
 if(!pic||!['instapay','wallet'].includes(method))
  return fail(r,400,'اختاري طريقة الدفع وصورة إيصال صحيحة حتى ٢ ميجابايت');
 const result=db.transaction(()=>{
  const o=D.orderByCode(q.params.code);
  if(!o||(source==='customer'&&o.customer_id!==q.user.id))return problem(404,'الطلب غير موجود');
  if(['cancelled','delivered'].includes(o.status))return problem(409,'لا يمكن رفع إيصال لطلب ملغي أو تم تسليمه');
  const d=get('SELECT status,percent FROM order_deposits WHERE order_id=?',o.id);
  if(!d||!['quoted','receipt_rejected'].includes(d.status)||!Number.isFinite(Number(d.percent))||Number(d.percent)<=0)
   return problem(409,'إرسال الإيصال غير متاح الآن؛ راجعي عرض العربون وحالة الطلب');
  // The transaction rechecks state after acquiring the write lock: neither an
  // admin nor customer upload may overwrite an already-pending receipt.
  const changed=run("UPDATE order_deposits SET receipt=?,receipt_type=?,payment_method=?,receipt_source=?,status='receipt_pending' WHERE order_id=? AND status IN ('quoted','receipt_rejected')",pic.data,pic.type,method,source,o.id);
  if(!changed.changes)return problem(409,'تغيّرت حالة الإيصال؛ افتحي الطلب وراجعيه');
  audit('order',o.code,source==='admin'?'deposit_receipt_admin':'deposit_receipt',`${source==='admin'?'user':'customer'}:${q.user.id}`);
  return {ok:true};
 }).immediate();
 if(result.status)return fail(r,result.status,result.message);
 r.json(result);
}
customer.post('/:code/receipt',(q,r)=>uploadReceipt(q,r,'customer'));
admin.post('/:code/receipt',(q,r)=>uploadReceipt(q,r,'admin'));

admin.get('/:code',(q,r)=>{
 const o=D.orderByCode(q.params.code);
 if(!o)return fail(r,404,'الطلب غير موجود');
 const d=get('SELECT percent,payment_details,status,payment_method,receipt_source,confirmed_payment_id,confirmed_amount,(receipt IS NOT NULL) has_receipt FROM order_deposits WHERE order_id=?',o.id);
 if(!d)return r.json({deposit:null});
 const totals=D.orderTotals(o.id),amount=d.percent==null?null:Math.round(totals.total*d.percent)/100;
 // Show all recorded payments: a previous full payment can already contain
 // the deposit, even if an old method was recorded differently. The owner
 // must decide; the server never identifies a bank transfer by amount alone.
 const recorded=all('SELECT id,amount,method,note,created_at FROM payments WHERE order_id=? ORDER BY id DESC',o.id);
 const matches=amount==null||!d.payment_method?[]:recorded.filter(p=>p.method===d.payment_method&&Math.abs(p.amount-amount)<0.005);
 const linkable=amount==null||amount<=0||(totals.refunded>0&&totals.paid+0.005<amount)?[]:recorded.filter(p=>p.amount+0.005>=amount);
 r.json({deposit:{...d,amount,paid_to_date:totals.paid,refunded:totals.refunded,financial_revision:require('./order-lifecycle').financialRevision(o.id),recorded_payments:recorded,matching_payments:matches,linkable_payments:linkable}});
});
admin.get('/:code/receipt',(q,r)=>{
 const o=D.orderByCode(q.params.code);
 const x=o&&get('SELECT receipt,receipt_type FROM order_deposits WHERE order_id=?',o.id);
 if(!x||!x.receipt)return r.sendStatus(404);
 r.set({'Content-Type':x.receipt_type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}).send(x.receipt);
});
admin.post('/:code/quote',(q,r)=>{
 const b=q.body||{}, p=Number(b.percent), details=String(b.payment_details||'').trim(), shipping=Number(b.shipping_fee);
 const result=db.transaction(()=>{
  const o=D.orderByCode(q.params.code);
  const d=o&&get('SELECT order_id,status,percent,payment_details FROM order_deposits WHERE order_id=?',o.id);
  if(!d)return problem(404,'الطلب أو العربون غير موجود');
  if(get("SELECT count(*) n FROM order_items WHERE order_id=? AND status='custom_pending'",o.id).n)
   return problem(409,'سعّري كل التصميمات الخاصة قبل إرسال عرض العربون');
  if(['cancelled','delivered'].includes(o.status))return problem(409,'لا يمكن تعديل عرض طلب ملغي أو تم تسليمه');
  if(!['needs_quote','quoted','receipt_rejected'].includes(d.status))return problem(409,'لا يمكن تغيير العرض في هذه المرحلة');
  if(o.delivery_requested&&(b.shipping_fee==null||b.shipping_fee===''||!Number.isFinite(shipping)||shipping<0||shipping>1e8))
   return problem(400,'حددي تكلفة التوصيل حسب المحافظة');
  if(!Number.isFinite(p)||p<=0||p>100||details.length<3||details.length>500)return problem(400,'حددي النسبة وبيانات التحويل');
  run('UPDATE orders SET delivery_fee=?,shipping_quoted=1 WHERE id=?',o.delivery_requested?shipping:0,o.id);
  run("UPDATE order_deposits SET percent=?,payment_details=?,status='quoted',receipt=NULL,receipt_type=NULL,payment_method=NULL,receipt_source=NULL WHERE order_id=?",p,details,o.id);
  if(d.status==='quoted'&&o.delivery_requested&&Number(o.delivery_fee)!==shipping&&Number(d.percent)===p&&d.payment_details===details)
   run("INSERT INTO web_alert_events(realm,subject_id,kind,order_id) VALUES('store',?,'deposit_quoted',?)",o.customer_id,o.id);
  audit('order',o.code,'deposit_quote',`user:${q.user.id}`,{percent:p});
  return {ok:true};
 }).immediate();
 if(result.status)return fail(r,result.status,result.message);
 r.json(result);
});
admin.post('/:code/decision',(q,r)=>{
 const decision=q.body?.decision;
 if(!['approve','reject'].includes(decision))return fail(r,400,'اختاري التأكيد أو الرفض');
 const state=decision==='approve'?'approved':'receipt_rejected';
 try{
  const result=db.transaction(()=>{
   const o=D.orderByCode(q.params.code);
   const d=o&&get('SELECT status,percent,payment_method,confirmed_payment_id,(receipt IS NOT NULL) has_receipt FROM order_deposits WHERE order_id=?',o.id);
   if(!d)return problem(404,'الطلب أو العربون غير موجود');
   if(['cancelled','delivered'].includes(o.status))return problem(409,'لا يمكن مراجعة عربون طلب ملغي أو تم تسليمه');
   if(d.status!=='receipt_pending'||!d.has_receipt)return problem(409,'لا يوجد إيصال صالح للمراجعة');
   if(state==='approved'&&(!Number.isFinite(Number(d.percent))||Number(d.percent)<=0||Number(d.percent)>100||!d.payment_method||d.confirmed_payment_id!=null))
    return problem(409,'بيانات العربون غير مكتملة أو مرتبطة بدفعة سابقة؛ راجعيها قبل التأكيد');
   let selected=null,amount=null;
   if(state==='approved'){
    const totals=D.orderTotals(o.id);
    amount=Math.round(totals.total*d.percent)/100;
    if(!Number.isFinite(amount)||amount<=0)return problem(409,'مبلغ العربون غير صالح؛ راجعي إجمالي الطلب والعرض');
    if(totals.refunded>0&&q.body?.financial_revision!==require('./order-lifecycle').financialRevision(o.id))
     return problem(409,'تغيّرت الدفعات أو المرتجعات؛ افتحي الطلب وراجعيها قبل التأكيد');
    const previous=all('SELECT id FROM payments WHERE order_id=? ORDER BY id',o.id);
    const hasChoice=Object.prototype.hasOwnProperty.call(q.body||{},'existing_payment_id');
    if(previous.length&&!hasChoice)return problem(409,'توجد دفعات مسجلة؛ افتحي الطلب وراجعيها واختاري ربط دفعة أو تسجيل تحويل جديد');
    // A new payment could have appeared in another tab since the owner opened
    // the form. Do not apply an old decision to a changed payment list.
    const snapshot=q.body?.review_payment_ids;
    if((previous.length||snapshot!==undefined)&&(!Array.isArray(snapshot)||snapshot.some(x=>!Number.isSafeInteger(x)||x<=0)||new Set(snapshot).size!==snapshot.length||JSON.stringify([...snapshot].sort((a,b)=>a-b))!==JSON.stringify(previous.map(x=>x.id))))
     return problem(409,'تغيّرت الدفعات أو لم تُراجع؛ افتحي الطلب من جديد قبل تأكيد العربون');
    const raw=q.body?.existing_payment_id;
    if(raw!==null&&raw!==undefined){
     const n=Number(raw);
     if(!Number.isSafeInteger(n)||n<=0)return problem(400,'اختاري دفعة صحيحة أو سجلي دفعة جديدة');
     selected=get('SELECT id,amount,method FROM payments WHERE id=? AND order_id=?',n,o.id);
     if(!selected||selected.amount+0.005<amount)
      return problem(409,'الدفعة المختارة غير موجودة أو أقل من العربون؛ راجعي الدفعات قبل التأكيد');
     if(totals.refunded>0&&totals.paid+0.005<amount)
      return problem(409,'صافي المدفوع بعد المرتجعات أقل من العربون؛ لا يمكن ربط دفعة قديمة كأنها تغطيه');
     if((totals.refunded>0||selected.method!==d.payment_method||Math.abs(selected.amount-amount)>=0.005)&&q.body?.confirmed_existing_payment!==true)
      return problem(409,'مبلغ الدفعة أو طريقتها مختلف أو يوجد مرتجع؛ أكدي صراحةً أنها تشمل العربون قبل ربطها');
    }
   }
   const updated=run("UPDATE order_deposits SET status=?,confirmed_at=CASE WHEN ?='approved' THEN datetime('now') ELSE NULL END WHERE order_id=? AND status='receipt_pending'",state,state,o.id);
   if(!updated.changes)return problem(409,'تغيّرت حالة الإيصال؛ افتحي الطلب وراجعيه');
   let paymentId=null;
   if(state==='approved'){
    I.reserve(o.id,`user:${q.user.id}`);
    paymentId=selected?selected.id:Number(run('INSERT INTO payments(order_id,amount,method,note) VALUES(?,?,?,?)',o.id,amount,d.payment_method,'عربون مؤكد').lastInsertRowid);
    run('UPDATE order_deposits SET confirmed_payment_id=?,confirmed_amount=? WHERE order_id=?',paymentId,amount,o.id);
   }
   audit('order',o.code,'deposit_'+state,`user:${q.user.id}`,state==='approved'?{payment_id:paymentId,used_existing:!!selected}:null);
   return {ok:true,used_existing:!!selected};
  }).immediate();
  if(result.status)return fail(r,result.status,result.message);
  r.json(result);
 }catch(e){
  // Reservation failures roll back the status, stock and payment together.
  const message=/[\u0600-\u06ff]/.test(e.message)?e.message:'تعذر تأكيد العربون؛ راجعي الطلب وحاولي مرة أخرى';
  return fail(r,409,message);
 }
});
module.exports={customer,admin};
