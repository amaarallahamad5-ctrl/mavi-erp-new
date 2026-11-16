'use strict';
// Owner-only, explicit corrections. These are bookkeeping changes, never money transfers.
const express=require('express');
const {db,get,all,run,audit}=require('./db');
const A=require('./auth'),D=require('./domain'),R=require('./deposit-rules');
const {financialRevision}=require('./order-lifecycle');
const router=express.Router();
class Problem extends Error{constructor(status,message){super(message);this.status=status;}}
const problem=(status,message)=>{throw new Problem(status,message)};
const fail=(res,e)=>res.status(e.status||500).json({message:e.status?e.message:'تعذر حفظ التعديل؛ راجعي البيانات وحاولي مرة أخرى'});
const actor=q=>`user:${q.user.id}`;
function amount(v,max=1e8){
 if(v===null||v===undefined||typeof v==='boolean'||typeof v==='object'||String(v).trim()==='')return null;
 const n=Number(v);return Number.isFinite(n)&&n>=0&&n<=max&&Math.abs(n*100-Math.round(n*100))<0.00001?Math.round(n*100)/100:null;
}
function reasonOf(v){
 if(typeof v!=='string')problem(400,'اكتبي سبب التعديل');
 const s=v.trim();
 if(s.length<3||s.length>300||/[<>&"'`\\\x00-\x1f]/.test(s))problem(400,'اكتبي سببًا واضحًا من ٣ إلى ٣٠٠ حرف بدون رموز غير صالحة');
 return s;
}
function tokenOf(v){if(typeof v!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(v))problem(400,'رمز العملية غير صالح؛ افتحي النموذج من جديد');return v;}
function find(code){const o=D.orderByCode(code);if(!o)problem(404,'الأوردر غير موجود');return o;}
function unpriced(id){return !!get("SELECT 1 ok FROM order_items WHERE order_id=? AND status='custom_pending' LIMIT 1",id);}
function historyForOrder(id){
 return all(`SELECT h.id,h.order_id,h.custom_id,h.kind,h.payment_ref,h.old_amount,h.new_amount,h.old_rule,h.new_rule,h.reason,h.created_at,u.name AS actor_name
  FROM deposit_change_log h LEFT JOIN users u ON u.id=h.created_by
  WHERE h.order_id=? OR h.custom_id IN (SELECT request_id FROM custom_order_links WHERE order_id=?)
  ORDER BY h.id DESC`,id,id);
}
function orderState(o){
 const totals=D.orderTotals(o.id);
 const d=get('SELECT status,percent,payment_details,payment_method,confirmed_payment_id,confirmed_amount,(receipt IS NOT NULL) has_receipt FROM order_deposits WHERE order_id=?',o.id)||null;
 const requirement=R.orderRule(o.id,totals.total,d),pending=unpriced(o.id),financial_revision=financialRevision(o.id);
 const state={code:o.code,status:o.status,totals:{total:totals.total,paid:totals.paid,gross_paid:totals.gross_paid,refunded:totals.refunded,due:totals.due},
  deposit:d,requirement,unpriced:pending,financial_revision};
 return {...state,revision:R.digest(state),payments:all('SELECT id,amount,method,note,created_at FROM payments WHERE order_id=? ORDER BY id DESC',o.id),history:historyForOrder(o.id)};
}
function customState(x){
 const requirement=R.customRule(x),total=x.price==null?null:Number(x.price)+Number(x.shipping_fee||0);
 const state={id:x.id,status:x.status,total,requirement,quote_revision:R.customQuoteRevision(x)};
 return {...state,revision:R.digest(state),history:all(`SELECT h.id,h.kind,h.old_amount,h.new_amount,h.old_rule,h.new_rule,h.reason,h.created_at,u.name AS actor_name FROM deposit_change_log h LEFT JOIN users u ON u.id=h.created_by WHERE h.custom_id=? ORDER BY h.id DESC`,x.id)};
}
function customById(id){
 if(!/^\d+$/.test(String(id)))problem(404,'الطلب غير موجود');
 const x=get('SELECT id,customer_id,status,price,deposit_percent,shipping_fee,payment_details,advice FROM custom_requests WHERE id=?',id);
 if(!x)problem(404,'الطلب غير موجود');return x;
}
function ruleInput(b,total,requiresPositive){
 const mode=String(b.mode||''),value=amount(b.value,mode==='percent'?100:1e8);
 if(!['fixed','percent'].includes(mode)||value===null||!Number.isFinite(total)||total<0)problem(400,'راجعي نوع وقيمة العربون المطلوب');
 const calculated=R.amountFor(total,mode,value);
 if(value>100&&mode==='percent'||mode==='fixed'&&value>total+0.005)problem(400,'المطلوب لا يزيد عن إجمالي الطلب أو ١٠٠٪');
 if(requiresPositive&&(!calculated||calculated<=0))problem(400,'حددي مبلغًا أكبر من صفر حتى يمكن مراجعة الإيصال');
 return {mode,value,calculated};
}
function replay(row,kind,reason,newAmount,paymentId,rule){
 if(!row)return false;
 if(row.kind!==kind||row.reason!==reason||(paymentId!==null&&row.payment_ref!==paymentId)||
   (kind==='paid_correction'&&row.new_amount!==newAmount)||(kind==='required_change'&&row.new_rule!==JSON.stringify(rule)))
  problem(409,'رمز العملية استُخدم ببيانات مختلفة؛ افتحي السجل وراجعيه');
 return true;
}
function sameRule(old,change){return old.mode===change.mode&&Number(old.value)===change.value;}
function notifyOrder(o,kind){run("INSERT INTO web_alert_events(realm,subject_id,kind,order_id) VALUES('store',?,?,?)",o.customer_id,kind,o.id);}

router.get('/orders/:code/deposit-management',A.requireOwner,(q,r)=>{try{r.json(db.transaction(()=>orderState(find(q.params.code)))());}catch(e){fail(r,e)}});
router.post('/orders/:code/payments/:paymentId/correct',A.requireOwner,(q,r)=>{
 try{
  const b=q.body||{},n=amount(b.amount),reason=reasonOf(b.reason),token=tokenOf(b.request_id),id=Number(q.params.paymentId);
  if(n===null||!Number.isSafeInteger(id)||id<=0||b.confirm_clerical!==true)problem(400,'راجعي المبلغ وأكدي أن الإدخال السابق كان خطأ');
  const result=db.transaction(()=>{
   const o=find(q.params.code),oldLog=get('SELECT * FROM deposit_change_log WHERE order_id=? AND request_id=?',o.id,token);
   if(replay(oldLog,'paid_correction',reason,n,id,null))return {ok:true,replay:true,id:oldLog.id,totals:D.orderTotals(o.id)};
   if(b.financial_revision!==financialRevision(o.id))problem(409,'تغيّرت الدفعات أو المرتجعات؛ افتحي الأوردر وراجعي السجل قبل التصحيح');
   const deposit=get('SELECT status FROM order_deposits WHERE order_id=?',o.id);
   if(deposit?.status==='receipt_pending')problem(409,'راجعي أو ارفضي الإيصال المنتظر أولًا قبل تصحيح أي دفعة');
   const p=get('SELECT id,amount,method,note,created_at FROM payments WHERE id=? AND order_id=?',id,o.id);
   if(!p)problem(404,'الدفعة غير موجودة في هذا الأوردر');
   if(!Number.isFinite(Number(p.amount)))problem(409,'قيمة الدفعة القديمة غير صالحة؛ يلزم مراجعة السجل يدويًا');
   if(Number(p.amount)===n)problem(400,'المبلغ الجديد يساوي المبلغ المسجل؛ لا يوجد تصحيح');
   const totals=D.orderTotals(o.id);
   if(totals.gross_paid-Number(p.amount)+n+0.005<totals.refunded)
    problem(409,'بعد التصحيح يصبح المدفوع أقل من المرتجعات الفعلية المسجلة؛ راجعي سجل المرتجعات أولًا');
   run('UPDATE payments SET amount=? WHERE id=? AND order_id=?',n,id,o.id);
   const saved=run(`INSERT INTO deposit_change_log(order_id,kind,payment_id,payment_ref,old_amount,new_amount,reason,request_id,created_by)
     VALUES(?,'paid_correction',?,?,?,?,?,?,?)`,o.id,id,id,p.amount,n,reason,token,q.user.id);
   audit('order',o.id,'payment_amount_corrected',actor(q),{payment_id:id,old_amount:p.amount,new_amount:n,reason,original_date:p.created_at});
   notifyOrder(o,'order_update');
   return {ok:true,replay:false,id:Number(saved.lastInsertRowid),totals:D.orderTotals(o.id)};
  }).immediate();r.status(result.replay?200:201).json(result);
 }catch(e){fail(r,e)}
});
router.post('/orders/:code/deposit-requirement',A.requireOwner,(q,r)=>{
 try{
  const b=q.body||{},reason=reasonOf(b.reason),token=tokenOf(b.request_id);
  if(b.confirm_requirement!==true)problem(400,'أكدي أن هذا يغيّر المطلوب فقط ولا يسجل دفعة');
  // Parse the rule before the transaction, but validate it against the current total inside it.
  const candidate={mode:String(b.mode||''),value:amount(b.value,String(b.mode)==='percent'?100:1e8)};
  if(!['fixed','percent'].includes(candidate.mode)||candidate.value===null)problem(400,'راجعي نوع وقيمة العربون المطلوب');
  const result=db.transaction(()=>{
   const o=find(q.params.code),oldLog=get('SELECT * FROM deposit_change_log WHERE order_id=? AND request_id=?',o.id,token);
   if(replay(oldLog,'required_change',reason,null,null,candidate))return {ok:true,replay:true,id:oldLog.id,requirement:orderState(o).requirement};
   const state=orderState(o);
   if(b.revision!==state.revision)problem(409,'تغيّرت بيانات الأوردر أو المدفوعات؛ افتحي النموذج وراجعيها من جديد');
   if(o.status==='cancelled')problem(409,'الأوردر ملغي؛ أعيدي تشغيله قبل تغيير العربون المطلوب');
   if(state.unpriced)problem(409,'سعّري جميع القطع قبل تغيير العربون المطلوب');
   if(state.deposit?.status==='receipt_pending')problem(409,'راجعي أو ارفضي الإيصال المنتظر أولًا؛ لن نغيّر المطلوب أثناء مراجعته');
   if(state.deposit&&state.deposit.status==='needs_quote')problem(409,'احفظي عرض السعر وبيانات التحويل أولًا');
   const c=ruleInput(b,state.totals.total,!!state.deposit&&state.deposit.status!=='approved');
   if(sameRule(state.requirement,c))problem(400,'القاعدة الجديدة هي نفسها المحفوظة');
   run(`INSERT INTO order_deposit_rules(order_id,mode,value,revision,updated_by) VALUES(?,?,?,1,?)
    ON CONFLICT(order_id) DO UPDATE SET mode=excluded.mode,value=excluded.value,revision=order_deposit_rules.revision+1,updated_by=excluded.updated_by,updated_at=datetime('now')`,o.id,c.mode,c.value,q.user.id);
   const saved=run(`INSERT INTO deposit_change_log(order_id,kind,old_amount,new_amount,old_rule,new_rule,reason,request_id,created_by)
    VALUES(?,'required_change',?,?,?,?,?,?,?)`,o.id,state.requirement.amount,c.calculated,JSON.stringify(state.requirement),JSON.stringify(candidate),reason,token,q.user.id);
   audit('order',o.id,'deposit_requirement_changed',actor(q),{old_amount:state.requirement.amount,new_amount:c.calculated,old_rule:state.requirement,new_rule:candidate,reason});
   notifyOrder(o,'deposit_update');
   return {ok:true,replay:false,id:Number(saved.lastInsertRowid),requirement:R.orderRule(o.id,state.totals.total,state.deposit)};
  }).immediate();r.status(result.replay?200:201).json(result);
 }catch(e){fail(r,e)}
});
router.get('/custom-requests/:id/deposit-requirement',A.requireOwner,(q,r)=>{try{r.json(db.transaction(()=>customState(customById(q.params.id)))());}catch(e){fail(r,e)}});
router.post('/custom-requests/:id/deposit-requirement',A.requireOwner,(q,r)=>{
 try{
  const b=q.body||{},reason=reasonOf(b.reason),token=tokenOf(b.request_id);
  if(b.confirm_requirement!==true)problem(400,'أكدي أن هذا يغيّر المطلوب فقط ولا يسجل دفعة');
  const candidate={mode:String(b.mode||''),value:amount(b.value,String(b.mode)==='percent'?100:1e8)};
  if(!['fixed','percent'].includes(candidate.mode)||candidate.value===null)problem(400,'راجعي نوع وقيمة العربون المطلوب');
  const result=db.transaction(()=>{
   const x=customById(q.params.id),oldLog=get('SELECT * FROM deposit_change_log WHERE custom_id=? AND request_id=?',x.id,token);
   if(replay(oldLog,'required_change',reason,null,null,candidate))return {ok:true,replay:true,id:oldLog.id,requirement:R.customRule(x)};
   const state=customState(x);
   if(b.revision!==state.revision)problem(409,'تغيّر العرض؛ افتحي النموذج وراجعيه من جديد');
   if(x.status==='receipt_pending')problem(409,'راجعي أو ارفضي الإيصال المنتظر أولًا؛ لن نغيّر المطلوب أثناء مراجعته');
   if(!['quoted','receipt_rejected'].includes(x.status))problem(409,'احفظي عرض السعر أولًا، أو عدلي المطلوب من الأوردر بعد تأكيده');
   const c=ruleInput(b,state.total,true);
   if(sameRule(state.requirement,c))problem(400,'القاعدة الجديدة هي نفسها المحفوظة');
   run(`INSERT INTO custom_deposit_rules(request_id,mode,value,revision,updated_by) VALUES(?,?,?,1,?)
    ON CONFLICT(request_id) DO UPDATE SET mode=excluded.mode,value=excluded.value,revision=custom_deposit_rules.revision+1,updated_by=excluded.updated_by,updated_at=datetime('now')`,x.id,c.mode,c.value,q.user.id);
   const saved=run(`INSERT INTO deposit_change_log(custom_id,kind,old_amount,new_amount,old_rule,new_rule,reason,request_id,created_by)
    VALUES(?,'required_change',?,?,?,?,?,?,?)`,x.id,state.requirement.amount,c.calculated,JSON.stringify(state.requirement),JSON.stringify(candidate),reason,token,q.user.id);
   audit('custom_request',x.id,'deposit_requirement_changed',actor(q),{old_amount:state.requirement.amount,new_amount:c.calculated,old_rule:state.requirement,new_rule:candidate,reason});
   run("INSERT INTO web_alert_events(realm,subject_id,kind,custom_id) VALUES('store',?,'custom_update',?)",x.customer_id,x.id);
   return {ok:true,replay:false,id:Number(saved.lastInsertRowid),requirement:R.customRule(x)};
  }).immediate();r.status(result.replay?200:201).json(result);
 }catch(e){fail(r,e)}
});
module.exports={router,orderState};
