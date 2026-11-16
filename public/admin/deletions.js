async function prepareDelete(type,id){
 if(VIEW==='order'&&!mayDiscardOtherPurchases(null))return;
 try{
  const info=await api('/deletions/'+encodeURIComponent(type)+'/'+encodeURIComponent(id));
  const expense=type==='expense'&&info.expense;
  const warning=expense
   ? `<div class="ux-inline-note">${btAdminText('المبلغ','Amount')}: <b>${EGP(Number(expense.amount))} ${tr('currency_egp')}</b> · ${btAdminText('تاريخ المصروف','Expense date')}: <span dir="ltr">${safeCustom(expense.spent_on)}</span><br>${btAdminText('حذف هذا المصروف يزيله من الإجماليات ويزيد صافي الربح المحسوب بنفس المبلغ. لا يحدث أي رد أموال. يبقى حدث الحذف في السجل.','Deleting this expense removes it from totals and increases calculated net profit by the same amount. No money is returned. The deletion remains in the audit history.')}</div>`
   : `<div class="ux-inline-note">${tr('del_warning_before')}${Number(info.orders||0)}${tr('del_orders')}${Number(info.custom||0)}${tr('del_designs')}${Number(info.payments||0)}${tr('del_payments')}${tr('del_warning_after')}</div>`;
  $('modal').innerHTML=`<h3 style="color:#b63a46">${tr('del_title')}</h3><p class="hint">${tr('del_record')} <b>${safeCustom(info.name)}</b></p>${warning}${info.refunds?`<div class="ux-inline-note">${btAdminText('سيُحذف أيضًا سجل المرتجعات نهائيًا: ','Refund history will also be permanently deleted: ')}${Number(info.refunds)}. ${btAdminText('راجعيه قبل الحذف.','Review it before deleting.')}</div>`:''}${info.corrections?`<div class="ux-inline-note">${btAdminText('سيُحذف من عرض الأوردر أيضًا سجل التصحيحات: ','The order’s displayed correction history will also be deleted: ')}${Number(info.corrections)}. ${btAdminText('تبقى أحداث التدقيق العامة. راجعيها قبل الحذف.','General audit events remain. Review them before deleting.')}</div>`:''}${info.stock_to_restore||info.stock_delivered?`<div class="ux-inline-note">${info.stock_to_restore?btAdminText('ستُعاد للمخزون القطع المحجوزة للطلبات غير المسلّمة: ','Reserved pieces on undelivered orders returned to stock: ')+Number(info.stock_to_restore)+'. ':''}${info.stock_delivered?btAdminText('القطع المسلّمة لا تُعاد للمخزون تلقائيًا: ','Delivered pieces will not be returned to stock automatically: ')+Number(info.stock_delivered)+'.':''}</div>`:''}${info.blocked?`<p style="color:#b63a46">${safeCustom(MaviI18n.serverMessage(info.reason,STAGED_LANGUAGE))}</p><div class="row"><button class="btn" onclick="closeModal()">${tr('close')}</button></div>`:`<label>${tr('del_owner_password')}<input id="del-password" type="password" autocomplete="current-password"></label><label>${tr('del_confirmation')}<input id="del-confirm" autocomplete="off"></label><div id="del-error" style="color:#b63a46" role="alert"></div><div class="row"><button class="btn" onclick="closeModal()">${tr('cancel')}</button><button class="btn" style="color:#b63a46" id="del-submit">${tr('del_title')}</button></div>`}`;
  $('ovl').classList.add('on');
  if(!info.blocked)$('del-submit').onclick=()=>executeDelete(type,id,expense?expense.revision:null);
 }catch(e){toast(e.message)}
}
async function executeDelete(type,id,expenseRevision=null){
 const btn=$('del-submit');btn.disabled=true;
 try{
  const body={password:$('del-password').value,confirmation:$('del-confirm').value};
  if(type==='expense'&&expenseRevision!==null)body.expense_revision=expenseRevision;
  await api('/deletions/'+encodeURIComponent(type)+'/'+encodeURIComponent(id),{method:'POST',body});
  $('del-password').value='';closeModal();if(type==='order')VIEW='orders';toast(tr('del_done'));await render();
 }catch(e){$('del-error').textContent=e.message;btn.disabled=false}
}
