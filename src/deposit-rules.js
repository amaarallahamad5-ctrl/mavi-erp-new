'use strict';
// One calculation for admin, customer, reports and receipt confirmation.
// A separate rule never alters any payment, receipt or original quote snapshot.
const crypto=require('crypto');
const {get}=require('./db');
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const amountFor=(total,mode,value)=>{
 if(total===null||total===undefined||!Number.isFinite(Number(total))||value===null||value===undefined||!Number.isFinite(Number(value)))return null;
 return mode==='fixed'?Number(value):mode==='percent'?Math.round(Number(total)*Number(value))/100:null;
};
function orderRule(orderId,total,deposit){
 const rule=get('SELECT mode,value,revision FROM order_deposit_rules WHERE order_id=?',orderId);
 const d=deposit===undefined?get('SELECT percent FROM order_deposits WHERE order_id=?',orderId):deposit;
 const mode=rule?.mode||(d?.percent!=null?'percent':null),value=rule?rule.value:(d?.percent??null);
 return {mode,value,amount:amountFor(total,mode,value),explicit:!!rule,revision:rule?.revision||0};
}
function customRule(x){
 const rule=get('SELECT mode,value,revision FROM custom_deposit_rules WHERE request_id=?',x.id);
 const mode=rule?.mode||(x.deposit_percent!=null?'percent':null),value=rule?rule.value:(x.deposit_percent??null);
 const total=x.price==null?null:Number(x.price)+Number(x.shipping_fee||0);
 return {mode,value,amount:amountFor(total,mode,value),explicit:!!rule,revision:rule?.revision||0};
}
// Versions describe what the customer/owner saw before choosing a receipt.
// Changed-away-and-back explicit rules still have monotonically increasing revisions.
function orderQuoteRevision(o,d,total){
 return digest({id:o.id,status:o.status,total,percent:d?.percent??null,payment_details:d?.payment_details??'',
   deposit_status:d?.status??null,rule:orderRule(o.id,total,d)});
}
function customQuoteRevision(x){
 return digest({id:x.id,status:x.status,price:x.price??null,shipping:x.shipping_fee??null,
  percent:x.deposit_percent??null,payment_details:x.payment_details??'',advice:x.advice??'',rule:customRule(x)});
}
module.exports={digest,amountFor,orderRule,customRule,orderQuoteRevision,customQuoteRevision};
