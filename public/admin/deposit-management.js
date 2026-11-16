// Separate, auditable actions for a mistaken recorded payment and a changed
// requirement. Neither action moves money or silently changes the other.
let dmPaidState=null,dmRuleState=null,dmNewPaymentState=null;
const dm=(ar,en)=>btAdminText(ar,en);
const dmCash=n=>n===null||n===undefined?'—':`${EGP(n)} ${tr('currency_egp')}`;
function dmRuleText(rule){
 if(!rule?.mode)return dm('غير مسجل','Not recorded');
 return rule.mode==='fixed'?dm('مبلغ ثابت','Fixed amount')+' · '+dmCash(rule.value):dm('نسبة من الإجمالي','Percentage of total')+' · '+EGP(rule.value)+'%';
}
function dmHistory(rows){
 if(!rows?.length)return `<p class="dm-empty">${dm('لا توجد تعديلات مسجلة بعد.','No changes recorded yet.')}</p>`;
 return `<ol class="dm-history">${rows.map(h=>{
  let oldRule=null,newRule=null;try{oldRule=h.old_rule?JSON.parse(h.old_rule):null;newRule=h.new_rule?JSON.parse(h.new_rule):null}catch(_){}
  const title=h.kind==='paid_correction'?dm('تصحيح مدفوع مسجل','Recorded payment corrected'):dm('تغيير المطلوب','Requirement changed');
  return `<li><div class="dm-history-top"><strong>${title}${h.payment_ref?' · #'+Number(h.payment_ref):''}</strong><time dir="ltr">${safeCustom(h.created_at)}</time></div>
   <div class="dm-history-amount" dir="auto">${dm('من','From')} <b>${dmCash(h.old_amount)}</b> ${dm('إلى','to')} <b>${dmCash(h.new_amount)}</b></div>
   ${h.kind==='required_change'?`<p>${safeCustom(dmRuleText(oldRule))} ← ${safeCustom(dmRuleText(newRule))} · ${dm('القيم وقت التعديل','Amounts at the time of change')}</p>`:''}
   <p>${dm('السبب','Reason')}: ${safeCustom(h.reason)}${h.actor_name?' · '+safeCustom(h.actor_name):''}${h.custom_id?' · '+dm('في طلب التصميم قبل إنشاء الأوردر','On the design request before the order was created'):''}</p></li>`;
 }).join('')}</ol>`;
}
async function depositManagementBlock(o){
 const s=await api('/orders/'+encodeURIComponent(o.code)+'/deposit-management');
 const d=s.deposit,rule=s.requirement,pending=d?.status==='receipt_pending',noQuote=d?.status==='needs_quote';
 const ruleBlocked=o.status==='cancelled'||s.unpriced||pending||noQuote;
 const correctionBlocked=pending||!s.payments.length;
 const shortfall=rule.amount!=null?Math.max(0,Math.round((rule.amount-s.totals.paid)*100)/100):null;
 const rows=s.payments.map(p=>`<li class="dm-payment-row"><div><strong>${dmCash(p.amount)}</strong><span>#${Number(p.id)} · ${safeCustom(p.method)} · <time dir="ltr">${safeCustom(p.created_at)}</time>${d?.confirmed_payment_id===p.id?' · '+dm('مرتبطة بتأكيد العربون','Linked to deposit approval'):''}</span>${p.note?`<span>${safeCustom(p.note)}</span>`:''}</div><div class="dm-row-actions"><button class="btn sm" type="button" ${pending?'disabled':''} onclick="openPaidCorrection(${Number(p.id)})">${dm('تصحيح المبلغ','Correct amount')}</button><button class="btn sm danger" type="button" onclick="prepareDelete('payment',${Number(p.id)})">${tr('admin_delete')}</button></div></li>`).join('');
 return `<section class="card dm-panel" id="deposit-management"><div class="dm-heading"><div><span class="dm-kicker">${dm('ملخص الحساب','PAYMENT OVERVIEW')}</span><h2>${dm('العربون والمدفوعات','Deposit & payments')}</h2><p>${dm('المبلغ المطلوب والفلوس المستلمة حاجتان مختلفتان. اختاري الإجراء المناسب لكل حالة.','The amount required and money received are different. Choose the right action for each.')}</p></div><span class="dm-secure">${dm('للمالكة فقط','OWNER ONLY')}</span></div>
 <div class="dm-summary"><div class="dm-tile required"><span>${dm('العربون المطلوب','Required deposit')}</span><strong>${dmCash(rule.amount)}</strong><small>${safeCustom(dmRuleText(rule))}</small></div><div class="dm-tile paid"><span>${dm('صافي المدفوع','Net paid')}</span><strong>${dmCash(s.totals.paid)}</strong><small>${dm('إجمالي المدفوع ناقص المرتجعات','Gross paid minus refunds')}</small></div>${shortfall>0&&o.status!=='cancelled'?`<div class="dm-gap">${dm('الفرق عن المطلوب','Shortfall against required deposit')}: <b>${dmCash(shortfall)}</b></div>`:''}</div>
 <div class="dm-action-grid"><button class="btn" type="button" id="dm-open-required" onclick="openOrderRequirement()" ${ruleBlocked?'disabled':''}><span aria-hidden="true">✎</span> ${dm('تعديل العربون المطلوب','Change required deposit')}</button><button class="btn" type="button" id="dm-open-paid" onclick="openPaidCorrection()" ${correctionBlocked?'disabled':''}><span aria-hidden="true">↺</span> ${dm('تصحيح مدفوع مسجّل','Correct recorded payment')}</button></div>
 <p class="dm-explain">${dm('تعديل المطلوب لا يسجل دفعًا. تصحيح المدفوع لإصلاح رقم أُدخل بالخطأ فقط؛ لتسجيل مبلغ جديد أو مرتجع فعلي استخدمي زريهما المنفصلين. لا يتم تحويل أموال تلقائيًا.','Changing the requirement does not record payment. Correct recorded money only for an entry error; use separate actions for a new payment or actual refund. No money is transferred automatically.')}</p>
 ${o.status==='cancelled'?`<div class="dm-warning">${dm('الأوردر ملغي؛ هذه الأرقام محفوظة للمراجعة ومستبعدة من التقارير حتى إعادة التشغيل.','This order is cancelled. These archived amounts stay excluded from reports until reactivation.')}</div>`:''}
 ${pending?`<div class="dm-warning">${dm('يوجد إيصال قيد المراجعة. راجعيه أو ارفضيه أولًا قبل تعديل المطلوب أو تصحيح دفعة.','A receipt is pending. Review or reject it before changing the requirement or correcting a payment.')}</div>`:''}
 ${noQuote?`<div class="dm-warning">${dm('احفظي عرض السعر وبيانات التحويل أولًا لتحديد المطلوب.','Save the quote and payment details before setting a requirement.')}</div>`:''}
 ${s.unpriced?`<div class="dm-warning">${dm('سعّري جميع القطع قبل تعديل المطلوب.','Price all items before changing the requirement.')}</div>`:''}
 <div class="dm-list-head"><h3>${tr('od_recorded_payments')}</h3><span>${s.payments.length}</span></div><ul class="dm-payments">${rows||`<li class="dm-empty">${dm('لا توجد دفعات مسجلة.','No payments recorded.')}</li>`}</ul>
 <details class="dm-history-box"><summary>${dm('سجل تصحيحات المدفوع والمطلوب','Payment and requirement change history')} <span>${s.history.length}</span></summary>${dmHistory(s.history)}</details></section>`;
}
function dmUpdateSelected(){
 const state=dmPaidState,choice=Number($('dm-payment-choice')?.value),p=state?.payments.find(x=>x.id===choice),el=$('dm-paid-current');
 if(el)el.textContent=p?dm('الدفعة المختارة مسجلة حاليًا بمبلغ ','The selected payment is currently recorded as ')+dmCash(p.amount):dm('اختاري دفعة لمراجعة مبلغها.','Choose a payment to review its current amount.');
}
async function openPaidCorrection(preset=0){
 if(!mayDiscardOtherPurchases(null))return;
 try{
  const s=await api('/orders/'+encodeURIComponent(CURRENT)+'/deposit-management');
  if(s.deposit?.status==='receipt_pending')throw Error(dm('راجعي الإيصال المنتظر أولًا.','Review the pending receipt first.'));
  if(!s.payments.length)throw Error(dm('لا توجد دفعات مسجلة لتصحيحها.','There are no recorded payments to correct.'));
  dmPaidState={...s,token:oeToken()};
  const options=s.payments.map(p=>`<option value="${Number(p.id)}" ${Number(preset)===p.id?'selected':''}>#${Number(p.id)} · ${safeCustom(dmCash(p.amount))} · ${safeCustom(p.method)} · ${safeCustom(p.created_at)}${s.deposit?.confirmed_payment_id===p.id?' · '+dm('مرتبطة بالعربون','linked to deposit'):''}</option>`).join('');
  showInventoryModal(dm('تصحيح مبلغ مدفوع مسجّل','Correct a recorded payment'),dm('لإصلاح خطأ إدخال فقط، وليس لتسجيل دفعة جديدة أو رد أموال.','Only for a clerical entry error, not a new payment or a refund.'),
   `<div class="inv-form-note">${dm('سيتغير صافي المدفوع والمتبقي لدى العميلة والتقارير في تاريخ الدفعة الأصلي. سيبقى المبلغ السابق والسبب في السجل. لا يحدث تحويل.','Net paid, the customer balance and reports update on the original payment date. The previous amount and reason are retained. No money is transferred.')}</div>`+
   `<label class="inv-field inv-span">${dm('اختاري الدفعة التي أُدخلت خطأ','Select the incorrectly recorded payment')}<select id="dm-payment-choice" onchange="dmUpdateSelected()" required><option value="">${dm('اختاري الدفعة','Choose a payment')}</option>${options}</select></label>`+
   `<div class="inv-form-note" id="dm-paid-current" aria-live="polite"></div>`+
   inputInv('dm-paid-amount',dm('المبلغ الصحيح لهذه الدفعة','Correct amount for this payment'),'','number','required min="0" max="100000000" step="0.01" inputmode="decimal"')+
   inputInv('dm-paid-reason',dm('سبب التصحيح','Reason for correction'),'','text','required minlength="3" maxlength="300"',true)+
   `<label class="inv-span oe-check"><input id="dm-paid-confirm" type="checkbox">${dm('أؤكد أن الرقم القديم أُدخل بالخطأ، وأن الرقم الجديد هو ما استُلم فعلًا.','I confirm the old amount was entered incorrectly and the new amount is what was actually received.')}</label>`,
   `<button class="btn primary" id="dm-paid-save" type="button" onclick="savePaidCorrection()">${dm('حفظ تصحيح المدفوع','Save payment correction')}</button>`);
  dmUpdateSelected();
 }catch(e){toast(e.message)}
}
async function savePaidCorrection(){
 const id=Number($('dm-payment-choice').value);
 if(!dmPaidState?.payments.some(p=>p.id===id)||!$('dm-paid-confirm').checked){invError(Error(dm('اختاري الدفعة وأكدي أن الرقم القديم خطأ.','Select a payment and confirm the previous entry was wrong.')));return;}
 const button=$('dm-paid-save');button.disabled=true;
 try{await api('/orders/'+encodeURIComponent(dmPaidState.code)+'/payments/'+id+'/correct',{method:'POST',body:{amount:$('dm-paid-amount').value,reason:$('dm-paid-reason').value,confirm_clerical:true,financial_revision:dmPaidState.financial_revision,request_id:dmPaidState.token}});
  closeModal();toast(dm('تم تصحيح المدفوع مع حفظ الرقم السابق والسبب','Payment corrected; the previous amount and reason are retained'));await render();
 }catch(e){invError(e.status?e:Error(dm('النتيجة غير مؤكدة. راجعي السجل أو أعيدي المحاولة بنفس البيانات دون تغييرها.','Result unknown. Review the history, or retry with exactly the same details.')));button.disabled=false;}
}
function dmModeHelp(){
 const mode=$('dm-rule-mode')?.value,el=$('dm-rule-help'),input=$('dm-rule-value');if(!el||!input)return;
 el.textContent=mode==='percent'?dm('النسبة تُحسب من إجمالي الأوردر الحالي وتتغير إذا تغيّر الإجمالي.','The percentage follows the current order total and changes if that total changes.'):dm('المبلغ ثابت حتى تغيّريه صراحةً. إن أردتِ تخفيض الإجمالي لأقل من المطلوب، عدّلي المطلوب أولًا.','The amount stays fixed until explicitly changed. To reduce the order total below it, change the requirement first.');
 input.max=mode==='percent'?'100':'100000000';
}
function dmShowRequirement(s,kind){
 dmRuleState={...s,kind,token:oeToken()};
 const current=s.requirement||{},mode=current.mode||'fixed',total=kind==='order'?s.totals.total:s.total;
 showInventoryModal(dm('تعديل العربون المطلوب','Change required deposit'),dm('هذا الإجراء يغيّر المطلوب فقط ولا يسجل أو يصحح أي دفعة.','This changes only the requirement; it does not record or correct a payment.'),
  `<div class="inv-form-note">${dm('إجمالي الأوردر','Order total')}: <b>${dmCash(total)}</b> · ${dm('المطلوب الحالي','Current requirement')}: <b>${dmCash(current.amount)}</b>${kind==='order'?` · ${dm('صافي المدفوع','Net paid')}: <b>${dmCash(s.totals.paid)}</b>`:''}</div>`+
  `<label class="inv-field">${dm('طريقة تحديد المطلوب','Requirement type')}<select id="dm-rule-mode" onchange="dmModeHelp()"><option value="fixed" ${mode==='fixed'?'selected':''}>${dm('مبلغ ثابت بالجنيه','Fixed amount in EGP')}</option><option value="percent" ${mode==='percent'?'selected':''}>${dm('نسبة من الإجمالي','Percentage of total')}</option></select></label>`+
  inputInv('dm-rule-value',dm('القيمة الجديدة','New value'),current.value??'','number','required min="0" step="0.01" inputmode="decimal"')+
  `<div class="inv-form-note" id="dm-rule-help" aria-live="polite"></div>`+
  inputInv('dm-rule-reason',dm('سبب تغيير المطلوب','Reason for changing the requirement'),'','text','required minlength="3" maxlength="300"',true)+
  `<label class="inv-span oe-check"><input id="dm-rule-confirm" type="checkbox">${dm('أؤكد تغيير المطلوب فقط، وليس المدفوع؛ ولا يحدث تحويل تلقائي.','I confirm this changes only the requirement, not recorded payments; no transfer is made.')}</label>`,
  `<button class="btn primary" type="button" id="dm-rule-save" onclick="saveDepositRequirement()">${dm('حفظ المطلوب الجديد','Save new requirement')}</button>`);
 dmModeHelp();
}
async function openOrderRequirement(){
 if(!mayDiscardOtherPurchases(null))return;
 try{const s=await api('/orders/'+encodeURIComponent(CURRENT)+'/deposit-management');dmShowRequirement(s,'order')}catch(e){toast(e.message)}
}
async function openCustomRequirement(id){
 try{const s=await api('/custom-requests/'+Number(id)+'/deposit-requirement');dmShowRequirement(s,'custom')}catch(e){toast(e.message)}
}
async function saveDepositRequirement(){
 if(!$('dm-rule-confirm').checked){invError(Error(dm('أكدي أن التعديل يخص المطلوب فقط.','Confirm this changes the requirement only.')));return;}
 const button=$('dm-rule-save'),s=dmRuleState;button.disabled=true;
 const path=s.kind==='order'?'/orders/'+encodeURIComponent(s.code)+'/deposit-requirement':'/custom-requests/'+Number(s.id)+'/deposit-requirement';
 try{await api(path,{method:'POST',body:{revision:s.revision,mode:$('dm-rule-mode').value,value:$('dm-rule-value').value,reason:$('dm-rule-reason').value,confirm_requirement:true,request_id:s.token}});
  closeModal();toast(dm('تم تحديث المطلوب دون تسجيل دفعة','Requirement updated without recording a payment'));await render();
  if(s.kind==='custom'){const el=[...document.querySelectorAll('[data-custom-alert-id]')].find(x=>Number(x.dataset.customAlertId)===Number(s.id));if(el){el.open=true;el.scrollIntoView({block:'start'});}}
 }catch(e){invError(e.status?e:Error(dm('النتيجة غير مؤكدة. راجعي السجل أو أعيدي المحاولة بنفس البيانات دون تغييرها.','Result unknown. Review the history, or retry with exactly the same details.')));button.disabled=false;}
}
async function openNewPayment(code,defaultAmount){
 if(!mayDiscardOtherPurchases(null))return;
 try{
  const s=await api('/orders/'+encodeURIComponent(code)+'/deposit-management');dmNewPaymentState={...s,token:oeToken()};
  const methods=[['cash',dm('نقدًا','Cash')],['wallet',dm('محفظة','Mobile wallet')],['instapay','InstaPay'],['other',dm('أخرى','Other')]].map(([v,t])=>`<option value="${v}">${t}</option>`).join('');
  showInventoryModal(dm('تسجيل دفعة مستلمة','Record a received payment'),dm('سجلي فقط مبلغًا وصل بالفعل. لا ينفذ هذا الزر تحويلًا.','Record only money already received. This does not make a transfer.'),
   `<div class="inv-form-note">${dm('المتبقي حاليًا','Current balance due')}: <b>${dmCash(s.totals.due)}</b> · ${dm('صافي المدفوع','Net paid')}: <b>${dmCash(s.totals.paid)}</b></div>`+
   inputInv('dm-new-amount',dm('المبلغ المستلم الآن','Amount received'),'','number','required min="0.01" max="100000000" step="0.01" inputmode="decimal"')+
   `<label class="inv-field">${dm('طريقة الدفع','Payment method')}<select id="dm-new-method">${methods}</select></label>`+
   inputInv('dm-new-note',dm('ملاحظة أو مرجع (اختياري)','Note or reference (optional)'),'','text','maxlength="300"',true)+
   `<label class="inv-span oe-check"><input id="dm-new-confirm" type="checkbox">${dm('أؤكد أن هذا المبلغ وصل بالفعل، وأنه ليس دفعة مسجلة من قبل.','I confirm this money was received and is not a previously recorded payment.')}</label>`,
   `<button class="btn primary" type="button" id="dm-new-save" onclick="saveNewPayment()">${dm('تسجيل الدفعة المستلمة','Record received payment')}</button>`);
  // Suggest, but never silently record, the current remaining balance.
  if(Number(defaultAmount)>0&&Math.abs(Number(defaultAmount)-s.totals.due)<0.005)$('dm-new-amount').value=String(defaultAmount);
 }catch(e){toast(e.message)}
}
async function saveNewPayment(){
 if(!$('dm-new-confirm').checked){invError(Error(dm('أكدي أن المبلغ وصل بالفعل أولًا.','Confirm the money was received first.')));return;}
 const b=$('dm-new-save'),s=dmNewPaymentState,value=Number($('dm-new-amount').value);
 if(Number.isFinite(value)&&value>s.totals.due+0.005&&!confirm(dm('المبلغ أكبر من المتبقي وسيظهر كمدفوع زيادة. هل استلمتِه بالفعل؟','This amount exceeds the balance and will be shown as overpaid. Was it actually received?')))return;
 b.disabled=true;
 try{await api('/orders/'+encodeURIComponent(s.code)+'/payments',{method:'POST',body:{amount:$('dm-new-amount').value,method:$('dm-new-method').value,note:$('dm-new-note').value,confirm_actual:true,request_id:s.token,management_revision:s.revision}});
  closeModal();toast(dm('تم تسجيل الدفعة المستلمة','Received payment recorded'));await render();
 }catch(e){invError(e.status?e:Error(dm('النتيجة غير مؤكدة. راجعي سجل الدفع أو أعيدي المحاولة بنفس البيانات دون تغييرها.','Result unknown. Review payments or retry with exactly the same details.')));b.disabled=false;}
}
