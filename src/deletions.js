'use strict';
// Explicit destructive operations; owner password, impact preview, one transaction.
const express=require('express'), {db,get,all,run,audit}=require('./db'), A=require('./auth'), publicCache=require('./public-cache');
const router=express.Router();router.use(A.requireOwner);
const fail=(r,n,m)=>r.status(n).json({message:m});
const physicallyDelivered=o=>o.status==='delivered'||(o.status==='cancelled'&&o.cancelled_from_status==='delivered');
const unknownPrior=o=>o.status==='cancelled'&&!['new','confirmed','cut','sewing','ready','delivered'].includes(o.cancelled_from_status);
const unknownStockReason='مرحلة الطلب الملغي القديمة وحجز المخزون غير واضحين؛ راجعيهما يدويًا قبل الحذف';
const codeConflictReason='رقم الأوردر القديم متعارض مع سجل آخر؛ راجعي الأرقام القديمة قبل تغييره أو حذف الأوردر';
function orderImpact(id){
 let o=get('SELECT id,code,status,cancelled_from_status FROM orders WHERE id=?',id);if(!o)return null;
 const reserved=get('SELECT COALESCE(SUM(r.qty),0) n FROM stock_reservations r JOIN order_items i ON i.id=r.order_item_id WHERE i.order_id=? AND r.released=0',id).n;
 const uncertain=unknownPrior(o)&&reserved>0,codeConflict=require('./domain').orderCodeConflict(o.code,o.id);
 return {name:o.code,orders:1,payments:get('SELECT count(*) n FROM payments WHERE order_id=?',id).n,refunds:get('SELECT count(*) n FROM order_refunds WHERE order_id=?',id).n,corrections:get('SELECT count(*) n FROM deposit_change_log WHERE order_id=? OR custom_id IN (SELECT request_id FROM custom_order_links WHERE order_id=?)',id,id).n,custom:get('SELECT count(*) n FROM custom_order_links WHERE order_id=?',id).n,
  stock_to_restore:physicallyDelivered(o)||uncertain?0:reserved,stock_delivered:physicallyDelivered(o)?reserved:0,stock_unknown:uncertain?reserved:0,blocked:uncertain||codeConflict,reason:uncertain?unknownStockReason:codeConflict?codeConflictReason:null};
}
function impact(type,id){
 if(type==='order')return orderImpact(id);
 if(type==='customer'){
  let c=get('SELECT id,name FROM customers WHERE id=?',id);if(!c)return null;
  const stock=get(`SELECT
   COALESCE(SUM(CASE WHEN o.status='delivered' OR (o.status='cancelled' AND (o.cancelled_from_status='delivered' OR o.cancelled_from_status IS NULL OR o.cancelled_from_status NOT IN ('new','confirmed','cut','sewing','ready','delivered'))) THEN 0 ELSE r.qty END),0) stock_to_restore,
   COALESCE(SUM(CASE WHEN o.status='delivered' OR (o.status='cancelled' AND o.cancelled_from_status='delivered') THEN r.qty ELSE 0 END),0) stock_delivered,
   COALESCE(SUM(CASE WHEN o.status='cancelled' AND (o.cancelled_from_status IS NULL OR o.cancelled_from_status NOT IN ('new','confirmed','cut','sewing','ready','delivered')) THEN r.qty ELSE 0 END),0) stock_unknown
   FROM stock_reservations r JOIN order_items i ON i.id=r.order_item_id JOIN orders o ON o.id=i.order_id WHERE r.released=0 AND o.customer_id=?`,id);
  const conflict=all('SELECT id,code FROM orders WHERE customer_id=?',id).some(o=>require('./domain').orderCodeConflict(o.code,o.id));
  return {name:c.name,orders:get('SELECT count(*) n FROM orders WHERE customer_id=?',id).n,custom:get('SELECT count(*) n FROM custom_requests WHERE customer_id=?',id).n,payments:get('SELECT count(*) n FROM payments p JOIN orders o ON p.order_id=o.id WHERE o.customer_id=?',id).n,refunds:get('SELECT count(*) n FROM order_refunds r JOIN orders o ON r.order_id=o.id WHERE o.customer_id=?',id).n,corrections:get('SELECT count(*) n FROM deposit_change_log h WHERE h.order_id IN (SELECT id FROM orders WHERE customer_id=?) OR h.custom_id IN (SELECT id FROM custom_requests WHERE customer_id=?)',id,id).n,...stock,blocked:stock.stock_unknown>0||conflict,reason:stock.stock_unknown>0?unknownStockReason:conflict?codeConflictReason:null};
 }
 if(type==='custom'){let x=get('SELECT id FROM custom_requests WHERE id=?',id);if(!x)return null;let o=get('SELECT order_id FROM custom_order_links WHERE request_id=?',id),related=o?orderImpact(o.order_id):null;return {name:'طلب تصميم خاص #'+id,orders:o?1:0,custom:1,payments:o?get('SELECT count(*) n FROM payments WHERE order_id=?',o.order_id).n:0,refunds:related?.refunds||0,corrections:related?.corrections||get('SELECT count(*) n FROM deposit_change_log WHERE custom_id=?',id).n,stock_to_restore:related?.stock_to_restore||0,stock_delivered:related?.stock_delivered||0,stock_unknown:related?.stock_unknown||0,blocked:related?.blocked||false,reason:related?.reason||null};}
 if(type==='style'){let x=get('SELECT id,name FROM styles WHERE id=?',id);if(!x||id==='CUSTOM-DESIGN')return null;let links=get('SELECT count(DISTINCT order_id) n FROM order_items WHERE style_id=?',id).n;let stock=get('SELECT count(*) n FROM stock_items WHERE style_id=?',id).n;return {name:x.name,blocked:links||stock,reason:'الموديل مرتبط بطلبات أو سجلات مخزون قديمة؛ احذفي السجلات المرتبطة أولًا أو اخفي الموديل بدلًا من حذفه.',orders:links};}
 if(type==='fabric'||type==='tailor'){
  const table=type==='fabric'?'fabric':'tailors',col=type==='fabric'?'fabric_id':'tailor_id',costTable=type==='fabric'?'order_fabric_purchases':'order_workshop_costs';
  const x=get(`SELECT id,name FROM ${table} WHERE id=?`,id);if(!x)return null;
  const n=get(`SELECT COUNT(*) n FROM (SELECT order_id FROM order_items WHERE ${col}=? UNION SELECT order_id FROM ${costTable} WHERE ${col}=?)`,id,id).n;
  return {name:x.name||'خامة بدون اسم',blocked:n,reason:'هذا السجل مرتبط بطلبات قديمة أو بنود تكلفة؛ لا يمكن حذفه حفاظًا على التاريخ.',orders:n};
 }
 if(type==='expense'){
  const x=get('SELECT id,category,amount,spent_on,note,revision FROM expenses WHERE id=?',id);
  return x?{name:x.category,expense:{amount:x.amount,spent_on:x.spent_on,revision:x.revision}}:null;
 }
 if(type==='payment'){
  const x=get('SELECT p.id,p.note,p.order_id,o.code FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.id=?',id);if(!x)return null;
  const linked=get("SELECT 1 ok FROM order_deposits WHERE confirmed_payment_id=? AND status='approved'",id);
  const hasRefund=get('SELECT 1 ok FROM order_refunds WHERE order_id=? AND voided_at IS NULL LIMIT 1',x.order_id);
  const corrected=get("SELECT 1 ok FROM deposit_change_log WHERE payment_id=? AND kind='paid_correction' LIMIT 1",id);
  const blocked=!!linked||!!hasRefund||!!corrected||['عربون مؤكد','عربون طلب خاص مؤكد'].includes(x.note);
  return {name:'دفعة الطلب '+x.code,payments:1,blocked,reason:corrected?'لا يمكن حذف دفعة صُحح مبلغها منفردة حفاظًا على سجل التصحيح.':hasRefund?'لا يمكن حذف دفعة منفردة بعد تسجيل مرتجع؛ راجعي سجل المرتجعات والدفعات لحماية الرصيد.':'دفعة العربون مرتبطة بتأكيد الطلب ولا يمكن حذفها منفردة. احذفي الطلب كاملًا إن لزم، بعد مراجعة الدفعات.'};
 }
 return null;
}
function deleteOrder(id,actor){
 const o=get('SELECT code,status,cancelled_from_status FROM orders WHERE id=?',id);if(!o)return;
 if(require('./domain').orderCodeConflict(o.code,id)){const e=Error(codeConflictReason);e.status=409;throw e;}
 if(unknownPrior(o)&&get('SELECT 1 ok FROM stock_reservations r JOIN order_items i ON i.id=r.order_item_id WHERE i.order_id=? AND r.released=0 LIMIT 1',id)){
  const e=Error(unknownStockReason);e.status=409;throw e;
 }
 require('./domain').rememberOrderCode(o.code);
 // Reserve the final reference too; ON DELETE SET NULL tombstones all aliases.
 run('INSERT OR IGNORE INTO order_code_aliases(code,order_id) VALUES(?,?)',o.code,id);
 // Unsold reserved stock belongs back in inventory; delivered pieces do not.
 // This runs in the same transaction as deletion and never touches fabric costs.
 if(!physicallyDelivered(o))require('./inventory').release(id,actor,'حذف الطلب قبل التسليم');
 const linked=all('SELECT request_id FROM custom_order_links WHERE order_id=?',id);
 run('DELETE FROM stock_reservations WHERE order_item_id IN (SELECT id FROM order_items WHERE order_id=?)',id);
 run('DELETE FROM custom_order_links WHERE order_id=?',id);for(const x of linked)run('DELETE FROM custom_requests WHERE id=?',x.request_id);
 run('DELETE FROM orders WHERE id=?',id);
}
function remove(type,id,actor){
 if(type==='order')return deleteOrder(id,actor);
 if(type==='custom'){let link=get('SELECT order_id FROM custom_order_links WHERE request_id=?',id);if(link)deleteOrder(link.order_id,actor);else run('DELETE FROM custom_requests WHERE id=?',id);return;}
 if(type==='customer'){let c=get('SELECT phone FROM customers WHERE id=?',id);for(const o of all('SELECT id FROM orders WHERE customer_id=?',id))deleteOrder(o.id,actor);run('DELETE FROM custom_requests WHERE customer_id=?',id);run("DELETE FROM sessions WHERE realm='store' AND subject_id=?",id);run('DELETE FROM otp_codes WHERE phone=?',c.phone);run('DELETE FROM customers WHERE id=?',id);publicCache.invalidateReviews();return;}
 if(type==='style'){let res=run('DELETE FROM styles WHERE id=?',id);publicCache.invalidateCatalogue();return res;}
 if(type==='fabric')return run('DELETE FROM fabric WHERE id=?',id);
 if(type==='tailor')return run('DELETE FROM tailors WHERE id=?',id);
 if(type==='expense')return run('DELETE FROM expenses WHERE id=?',id);
 if(type==='payment')return run('DELETE FROM payments WHERE id=?',id);
}
router.get('/:type/:id',(q,r)=>{const x=impact(q.params.type,q.params.id);if(!x)return fail(r,404,'السجل غير موجود أو لا يمكن حذفه');r.json(x)});
router.post('/:type/:id',(q,r)=>{
 const email=q.user.email,pass=String(q.body.password||'');if(A.adminThrottled(email))return fail(r,429,'محاولات كثيرة، انتظري قبل إعادة المحاولة');
 const u=get('SELECT password_hash FROM users WHERE id=? AND active=1',q.user.id);if(!u||!A.verifyPassword(pass,u.password_hash)){A.adminFailure(email);return fail(r,403,'كلمة مرور المالكة غير صحيحة')}A.adminClear(email);
 if(q.body.confirmation!=='حذف نهائي')return fail(r,400,'اكتبي حذف نهائي للتأكيد');
 try{let result;db.transaction(()=>{
  result=impact(q.params.type,q.params.id);if(!result){const e=Error('السجل غير موجود');e.status=404;throw e}
  if(result.blocked){const e=Error(result.reason);e.status=409;throw e}
  let expenseBefore=null;
  if(q.params.type==='expense'){
   expenseBefore=get('SELECT category,amount,spent_on,note,revision FROM expenses WHERE id=?',q.params.id);
   // New UI sends the version shown in its confirmation. Older API clients are
   // still supported, but a stale new confirmation cannot delete an edited row.
   if(q.body.expense_revision!==undefined){
    const revision=Number(q.body.expense_revision);
    if(!Number.isSafeInteger(revision)||revision<=0){const e=Error('راجعي بيانات المصروف قبل الحذف');e.status=400;throw e}
    if(revision!==Number(expenseBefore.revision)){const e=Error('المصروف اتغيّر بعد فتح نافذة الحذف؛ افتحيه وراجعيه من جديد');e.status=409;throw e}
   }
  }
  const actor=`user:${q.user.id}`;
  remove(q.params.type,q.params.id,actor);
  if(expenseBefore) audit('expense',q.params.id,'deleted',actor,{before:{...expenseBefore,note:expenseBefore.note||''}});
  audit('deletion',q.params.type,'permanent_delete',actor,{id:q.params.id,orders:result.orders||0,payments:result.payments||0,custom:result.custom||0});
 }).immediate();r.json({ok:true})}catch(e){return fail(r,e.status||500,e.status?e.message:'تعذر الحذف؛ راجعي السجلات المرتبطة')}
});
module.exports=router;
