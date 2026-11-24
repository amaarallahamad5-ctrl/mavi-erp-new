// Owner corrections and real refund records; cancelling never moves money.
let orderEditState=null, orderRefundState=null, orderRefundVoidState=null;
let OE_STYLE_OPTIONS='';
const oeText=(ar,en)=>btAdminText(ar,en);
const oeField=(id,label,value='',type='text',attr='',wide=false)=>inputInv(id,label,value??'',type,attr,wide);
const oeOption=(value,label,current)=>`<option value="${safeCustom(value)}" ${String(value)===String(current)?'selected':''}>${safeCustom(label)}</option>`;

async function cancelOrder(stage){
 if(!mayDiscardOtherPurchases(null))return;
 const deliveredNote=stage==='delivered'?oeText('\nالطلب مسلّم؛ لن تُعاد القطع للمخزون تلقائيًا. راجعي أي مرتجع فعلي يدويًا.','\nThe order was delivered; goods will not be returned to stock automatically. Review any physical return manually.'):'';
 if(!confirm(oeText('إلغاء الأوردر يستبعد مبيعاته وتكاليفه ودفعاته من التقارير ويحفظ سجله. لا يعيد أي أموال تلقائيًا؛ يمكنك تسجيل المبلغ المرتجع بعد رده فعلًا. هل تريدين الإلغاء؟','Cancelling excludes this order from financial reports but preserves its history. It does not return money; record any refund only after it has actually been sent. Cancel the order?')+deliveredNote))return;
 const code=CURRENT;
 try{await api('/orders/'+encodeURIComponent(code)+'/status',{method:'PATCH',body:{status:'cancelled',expected_status:stage}});toast(oeText('تم إلغاء الأوردر واستبعاد أرقامه','Order cancelled and excluded from reports'));await render();}
 catch(e){toast(e.status?e.message:oeText('النتيجة غير مؤكدة؛ افتحي الأوردر وراجعي حالته قبل المحاولة.','Result unknown; reopen the order and check its status before retrying.'));}
}
async function reactivateOrder(){
 if(!mayDiscardOtherPurchases(null))return;
 if(!confirm(oeText('إعادة التشغيل ترجّع المرحلة السابقة إن كانت مسجلة، وتعيد حجز المخزون إذا كان متاحًا. يظهر الباقي بعد خصم أي مرتجع فعلي. متابعة؟','Restore the previous recorded stage and re-reserve available stock? Amounts actually refunded reduce the net paid balance.')))return;
 const code=CURRENT;
 try{const result=await api('/orders/'+encodeURIComponent(code)+'/reactivate',{method:'POST',body:{}});CURRENT=result.code;await render();
  const stockNote=result.stock_unreserved?oeText('\nتم التحقق من توفر القطع، لكنها غير محجوزة حتى تأكيد العربون.','\nAvailability was checked, but these items are not reserved until the deposit is confirmed.'):'';
  if(result.previous_unknown)alert(oeText('تمت الإعادة إلى «جديد» لأن المرحلة السابقة غير مسجلة. راجعي الرصيد والعربون.','Reopened as New because the previous stage was not recorded. Review the balance and deposit.')+stockNote);
  else if(result.needs_deposit_review)alert(oeText('تمت الإعادة إلى المرحلة السابقة. العربون غير مؤكد؛ راجعيه والرصيد، لكن لم تتغير المرحلة بسبب ذلك.','Restored to its previous stage. The deposit is unconfirmed; review it and the balance, but the stage was not changed because of it.')+stockNote);
  else toast(oeText('تمت إعادة تشغيل الأوردر','Order reactivated'));
 }catch(e){toast(e.status?e.message:oeText('النتيجة غير مؤكدة؛ افتحي الأوردر وراجعي حالته قبل المحاولة.','Result unknown; reopen the order and check its status before retrying.'));}
}

function orderRefundsPanel(o){
 const list=o.refunds||[],t=o.totals;
 const rows=list.map(x=>`<div class="refund-row ${x.voided_at?'is-void':''}"><div><b>${EGP(x.amount)} ${tr('currency_egp')}</b> · ${safeCustom(x.method)} · <span dir="ltr">${safeCustom(x.refunded_on)}</span>${x.note?`<div class="ux-help">${safeCustom(x.note)}</div>`:''}${x.voided_at?`<div class="ux-help">${oeText('إدخال ملغي لتصحيح خطأ','Voided as an entry error')}: ${safeCustom(x.void_reason||'—')}</div>`:''}</div>${!x.voided_at?`<button type="button" class="btn sm" onclick="openRefundVoid(${Number(x.id)})">${oeText('تصحيح إدخال خطأ','Correct entry error')}</button>`:''}</div>`).join('');
 const note=o.status==='cancelled'?oeText('الطلب ملغي وأرقامه مستبعدة من التقارير. هذا سجل محفوظ، والإلغاء لا يرد الفلوس تلقائيًا.','This cancelled order is excluded from reports. Its history is retained; cancellation does not send a refund.'):
   oeText('سجلي فقط المبلغ الذي رُدّ فعليًا. صافي المدفوع = الدفعات − المرتجعات.','Record only money actually returned. Net paid = payments minus refunds.');
 return `<section class="card ux-panel" id="order-refunds-panel"><div class="ux-head"><div><h2>${oeText('المرتجعات وسجل الدفع','Refund history')}</h2><p class="ux-help">${note}</p></div></div>
 <div class="ux-inline-note">${oeText('إجمالي الدفعات','Gross payments')}: <b>${EGP(t.gross_paid)} ${tr('currency_egp')}</b> · ${oeText('المردود فعليًا','Actually refunded')}: <b>${EGP(t.refunded)} ${tr('currency_egp')}</b> · ${oeText('صافي المدفوع','Net paid')}: <b>${EGP(t.paid)} ${tr('currency_egp')}</b></div>
 ${rows||`<p class="ux-help">${oeText('لا توجد مرتجعات مسجلة.','No refunds recorded.')}</p>`}
 ${t.paid>0?`<div class="ux-actions"><button type="button" class="btn" onclick="openRefundDialog()">＋ ${oeText('تسجيل مبلغ تم رده','Record an actual refund')}</button></div>`:''}</section>`;
}
function oeToday(){const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`;}
function oeToken(){if(crypto.randomUUID)return crypto.randomUUID();const bytes=new Uint8Array(16);crypto.getRandomValues(bytes);return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');}
async function openRefundDialog(){
 if(!mayDiscardOtherPurchases(null))return;
 try{
  const {order:o}=await api('/orders/'+encodeURIComponent(CURRENT));
  if(o.totals.paid<=0){toast(oeText('لا يوجد صافي مدفوع يمكن تسجيل رده.','There is no net paid balance to refund.'));return;}
  orderRefundState={code:o.code,revision:o.financial_revision,token:oeToken()};
  const methods=oeOption('cash',oeText('نقدًا','Cash'),'cash')+oeOption('wallet',oeText('محفظة','Mobile wallet'),'cash')+oeOption('instapay','InstaPay','cash')+oeOption('other',oeText('أخرى','Other'),'cash');
  showInventoryModal(oeText('تسجيل مبلغ تم رده','Record an actual refund'),
    oeText('هذا تسجيل محاسبي فقط ولا يحوّل الأموال. راجعي السجل حتى لا تسجلي المرتجع مرتين.','This records a transaction; it does not send money. Review the history to avoid duplicate entries.'),
    `<div class="inv-form-note">${oeText('أقصى مبلغ يمكن تسجيله الآن هو صافي المدفوع','Maximum recordable amount is the net paid balance')}: <b>${EGP(o.totals.paid)} ${tr('currency_egp')}</b></div>`+
    oeField('refund-amount',oeText('المبلغ الذي رُد بالفعل','Amount actually returned'),'','number',`required min="0.01" max="${Number(o.totals.paid)}" step="0.01"`)+
    `<label class="inv-field">${oeText('طريقة الرد','Refund method')}<select id="refund-method">${methods}</select></label>`+
    oeField('refund-date',oeText('تاريخ الرد','Date returned'),oeToday(),'date',`required max="${oeToday()}"`)+
    oeField('refund-note',oeText('ملاحظة أو رقم التحويل (اختياري)','Note or transfer reference (optional)'),'','text','maxlength="500"',true)+
    `<label class="inv-span oe-check"><input id="refund-confirm" type="checkbox"> ${oeText('أؤكد أني أعدت هذا المبلغ بالفعل للعميلة.','I confirm this money has actually been returned to the customer.')}</label>`,
    `<button class="btn primary" id="refund-submit" onclick="saveActualRefund()">${oeText('تسجيل المرتجع','Record refund')}</button>`);
 }catch(e){toast(e.message)}
}
async function saveActualRefund(){
 if(!$('refund-confirm').checked){invError(new Error(oeText('أكدي أن المبلغ أُعيد فعلًا أولًا.','Confirm the money was actually returned first.')));return;}
 const b=$('refund-submit');b.disabled=true;
 try{await api('/orders/'+encodeURIComponent(orderRefundState.code)+'/refunds',{method:'POST',body:{amount:$('refund-amount').value,method:$('refund-method').value,refunded_on:$('refund-date').value,note:$('refund-note').value,confirm_actual:true,request_id:orderRefundState.token,financial_revision:orderRefundState.revision}});
  closeModal();toast(oeText('تم تسجيل المرتجع الفعلي','Actual refund recorded'));await render();
 }catch(e){invError(e.status?e:new Error(oeText('النتيجة غير مؤكدة. افتحي الأوردر وراجعي السجل، أو أعيدي المحاولة دون تغيير البيانات.','Result unknown. Reopen the order and review the history, or retry without changing the details.')));b.disabled=false;}
}
async function openRefundVoid(id){
 if(!mayDiscardOtherPurchases(null))return;
 try{
  const {order:o}=await api('/orders/'+encodeURIComponent(CURRENT));const refund=(o.refunds||[]).find(x=>x.id===id&&!x.voided_at);
  if(!refund){toast(oeText('راجعي السجل؛ هذا الإدخال لم يعد متاحًا.','Review the history; this entry is no longer active.'));return;}
  orderRefundVoidState={code:o.code,id,revision:o.financial_revision};
  showInventoryModal(oeText('تصحيح إدخال مرتجع خاطئ','Correct an erroneous refund entry'),
    oeText('استخدمي هذا فقط إذا سُجّل المرتجع بالخطأ. لا يعني إعادة المال إلى حسابك؛ سيبقى الإدخال القديم ظاهرًا في السجل.','Use only if the refund was recorded by mistake. It does not bring money back; the old entry remains in history.'),
    `<div class="inv-form-note">${oeText('السجل','Entry')}: <b>${EGP(refund.amount)} ${tr('currency_egp')}</b> · ${safeCustom(refund.refunded_on)}</div>`+
    oeField('refund-void-reason',oeText('سبب التصحيح','Reason for correction'),'','text','required maxlength="300"',true)+
    `<label class="inv-span oe-check"><input id="refund-void-confirm" type="checkbox"> ${oeText('أؤكد أن التسجيل كان خطأ، وليس تحويلًا حقيقيًا أريد التراجع عنه.','I confirm this entry was an error, not a real transfer I want to reverse.')}</label>`,
    `<button class="btn primary" id="refund-void-submit" onclick="saveRefundVoid()">${oeText('تأكيد تصحيح السجل','Confirm correction')}</button>`);
 }catch(e){toast(e.message)}
}
async function saveRefundVoid(){
 if(!$('refund-void-confirm').checked){invError(new Error(oeText('أكدي أن الإدخال كان خطأ.','Confirm the entry was an error.')));return;}
 const b=$('refund-void-submit');b.disabled=true;
 try{await api('/orders/'+encodeURIComponent(orderRefundVoidState.code)+'/refunds/'+orderRefundVoidState.id+'/void',{method:'POST',body:{reason:$('refund-void-reason').value,confirm_clerical:true,financial_revision:orderRefundVoidState.revision}});
  closeModal();toast(oeText('تم تصحيح السجل مع حفظ التاريخ','Entry corrected; history retained'));await render();
 }catch(e){invError(e.status?e:new Error(oeText('النتيجة غير مؤكدة؛ افتحي الأوردر وراجعي السجل.','Result unknown; reopen the order and review the history.')));b.disabled=false;}
}

async function openOrderEdit(){
 if(!mayDiscardOtherPurchases(null))return;
 try{
  const state=await api('/orders/'+encodeURIComponent(CURRENT)+'/edit'),o=state.order;orderEditState=state;
  try{await loadStyles();OE_STYLE_OPTIONS=CACHE.styles.filter(s=>s.type==='made'&&s.active&&s.id!=='CUSTOM-DESIGN'&&s.id!=='MANUAL-CUSTOM').map(s=>`<option value="${safeCustom(s.id)}">${safeCustom(s.name)}</option>`).join('');}catch(e){OE_STYLE_OPTIONS='';}
  const channels=[['whatsapp','WhatsApp'],['facebook','Facebook'],['instagram','Instagram'],['online',oeText('المتجر','Store')],['walkin',oeText('داخل المحل','Walk-in')],['other',oeText('أخرى','Other')]];
  if(!channels.some(x=>x[0]===o.channel))channels.push([o.channel,o.channel]);
  const ms=[['bust',oeText('الصدر','Bust')],['waist',oeText('الوسط','Waist')],['hip',oeText('الأرداف','Hip')],['shoulder',oeText('عرض الكتف','Shoulder')],['length',oeText('الطول','Length')],['sleeve',oeText('الكم','Sleeve')],['arm',oeText('الذراع','Arm')]];
  const itemFields=o.items.map((x,n)=>`<fieldset class="oe-item inv-span" data-item-id="${Number(x.id)}"><legend>${oeText('قطعة','Item')} ${n+1} · ${safeCustom(x.style_id)}</legend><div class="oe-grid">
    ${oeField('oe-item-name-'+x.id,oeText('اسم القطعة لهذا الأوردر','Item name for this order'),x.name,'text','maxlength="120" required',true)}
    ${oeField('oe-item-colour-'+x.id,oeText('اللون','Colour'),x.colour||'','text','maxlength="80"')}
    ${oeField('oe-item-size-'+x.id,oeText('المقاس','Size'),x.size||'','text','maxlength="40"')}
    ${oeField('oe-item-length-'+x.id,oeText('الطول بالسم','Length in cm'),x.length_cm??'','number','min="1" max="250" step="1"')}
    ${oeField('oe-item-qty-'+x.id,oeText('عدد القطع','Quantity'),x.qty,'number','min="1" max="1000" step="1" required')}
    ${oeField('oe-item-price-'+x.id,oeText('سعر القطعة','Unit price'),x.unit_price,'number',`min="0" step="0.01" ${x.status==='custom_pending'?'disabled':''}`)}
    ${oeField('oe-item-fabric-'+x.id,oeText('خامة القطعة','Item fabric'),x.fabric_choice||'','text','maxlength="120"')}
    ${oeField('oe-item-note-'+x.id,oeText('ملاحظة القطعة','Item note'),x.item_note||'','text','maxlength="500"',true)}
    ${x.status==='custom_pending'?`<div class="inv-form-note">${oeText('سعّري التصميم أولًا من قسم مراجعة التصميم الخاص.','Price this custom item from its review section first.')}</div>`:''}
    ${x.style_type==='stock'?`<div class="inv-form-note">${oeText('تغيير العدد أو اللون أو المقاس يراجع الحجز والمخزون. تكلفة الشراء القديمة لا تتغير تلقائيًا.','Changing quantity, colour or size checks the reservation and inventory. The recorded purchase cost is not automatically repriced.')}</div>`:''}
   </div></fieldset>`).join('');
  const content=`<div class="inv-form-note">${oeText('التعديل لهذا الأوردر فقط؛ لا يغيّر اسم الموديل في الكتالوج أو بيانات دخول العميلة. الأرقام القديمة للأوردر تظل تفتح نفس الطلب.','Changes apply to this order only, not the catalogue or customer login. Earlier order numbers still open the same order.')}</div>`+
   oeField('oe-code',oeText('رقم الأوردر','Order number'),o.code,'text','required maxlength="40" dir="ltr"')+
   `<label class="inv-field">${oeText('قناة الطلب','Order channel')}<select id="oe-channel">${channels.map(([v,l])=>oeOption(v,l,o.channel)).join('')}</select></label>`+
   oeField('oe-name',oeText('اسم العميلة لهذا الأوردر','Customer name for this order'),o.contact.name,'text','required maxlength="100"')+
   oeField('oe-phone',oeText('رقم التواصل لهذا الأوردر','Contact number for this order'),o.contact.phone,'tel','required maxlength="20" dir="ltr"')+
   oeField('oe-area',oeText('المنطقة والعنوان','Area / address'),o.contact.area,'text','maxlength="200"')+
   oeField('oe-gov',oeText('المحافظة','Governorate'),o.governorate||'','text','maxlength="80"')+
   `<label class="inv-field">${oeText('طريقة الاستلام','Fulfilment')}<select id="oe-delivery">${oeOption('yes',oeText('توصيل','Delivery'),o.delivery_requested?'yes':'no')}${oeOption('no',oeText('استلام حسب الاتفاق','Collection'),o.delivery_requested?'yes':'no')}</select></label>`+
   oeField('oe-shipping',oeText('شحن العميلة','Customer shipping'),o.shipping_quoted?o.delivery_fee:'','number','min="0" step="0.01"')+
   oeField('oe-discount',oeText('خصم الأوردر','Order discount'),o.discount,'number','min="0" step="0.01"')+
   oeField('oe-date',oeText('موعد التسليم','Promise date'),o.promise_date||'','date')+
   oeField('oe-fabric',oeText('خامة الأوردر','Order fabric'),o.fabric_choice||'','text','maxlength="120"',true)+
   `<label class="inv-field inv-span">${oeText('ملاحظات الأوردر','Order notes')}<textarea id="oe-note" class="oe-textarea" maxlength="1000">${safeCustom(o.note||'')}</textarea></label>`+
   `<div class="inv-form-note">${oeText('الدفعات والمرتجعات المحفوظة لا تتغير. إذا تغير السعر أو العدد يُحسب الباقي مجددًا، وقد تتغير تكلفة الورشة المحسوبة بالقطعة.','Payments and refunds stay unchanged. A price or quantity edit recalculates the balance and may change per-piece workshop cost.')}</div>`+
   itemFields+
   `<div class="inv-span" style="display:flex;align-items:center;gap:8px;margin:4px 0 8px;flex-wrap:wrap"><button type="button" class="btn sm" onclick="oeAddDress()">＋ ${oeText('إضافة فستان','Add a dress')}</button><span class="inv-form-note" style="margin:0">${oeText('يُضاف الفستان للطلب عند الحفظ ويُحسب في الإجمالي والعربون.','The dress joins the order on save and counts in the total and deposit.')}</span></div>`+
   `<div id="oe-new-items" class="inv-span"></div>`+
   `<fieldset class="oe-item inv-span"><legend>${oeText('مقاسات هذا الأوردر','Measurements for this order')}</legend><div class="oe-grid">${ms.map(([k,label])=>oeField('oe-measure-'+k,label,o.measurements[k]??'','number','min="20" max="250" step="1"')).join('')}</div></fieldset>`;
  showInventoryModal(oeText('تعديل بيانات الأوردر','Edit order details'),oeText('راجعي القيم قبل الحفظ. لتعديل المدفوعات استخدمي سجل الدفع والمرتجعات.','Review the values before saving. Use the payment and refund history for money records.'),content,
   `<button class="btn primary" id="oe-save" onclick="saveOrderEdit()">${oeText('حفظ التعديلات','Save changes')}</button>`);
 }catch(e){toast(e.message)}
}
window.oeAddDress=function(){
 const host=document.getElementById('oe-new-items');if(!host)return;
 if(host.querySelectorAll('[data-oe-new]').length>=20){toast(oeText('الحد الأقصى ٢٠ فستانًا إضافيًا في التعديل الواحد','At most 20 dresses can be added per edit'));return;}
 host.insertAdjacentHTML('beforeend',`<div data-oe-new style="border:1px solid var(--line);border-radius:10px;padding:10px 8px;margin-bottom:8px">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><small style="color:var(--muted)">✦ ${oeText('فستان جديد','New dress')}</small><button type="button" class="btn sm" onclick="oeRemoveDress(this)">${oeText('إزالة','Remove')}</button></div>
  <label class="inv-field">${oeText('موديل من الكتالوج','Catalogue style')}<select class="oe-n-style" onchange="oeNewStyleChanged(this)"><option value="">${oeText('وصف من خارج الكتالوج','Described, out of catalogue')}</option>${OE_STYLE_OPTIONS}</select></label>
  <label class="inv-field oe-n-custom-wrap" style="display:none">${oeText('وصف التصميم','Design description')}<input class="oe-n-custom" type="text" maxlength="100"></label>
  <label class="inv-field">${oeText('اللون','Colour')}<input class="oe-n-colour" type="text" maxlength="80"></label>
  <label class="inv-field">${oeText('العدد','Quantity')}<input class="oe-n-qty" type="number" value="1" min="1" max="20" step="1"></label>
  <label class="inv-field">${oeText('سعر القطعة','Unit price')}<input class="oe-n-price" type="number" min="0" step="0.01"></label>
  <label class="inv-field">${oeText('خامة القطعة','Item fabric')}<input class="oe-n-fabric" type="text" maxlength="120"></label>
  <label class="inv-field">${oeText('ملاحظة القطعة','Item note')}<input class="oe-n-note" type="text" maxlength="500"></label>
 </div>`);
};
window.oeRemoveDress=function(btn){btn.closest('[data-oe-new]')?.remove();};
window.oeNewStyleChanged=function(sel){const wrap=sel.closest('[data-oe-new]')?.querySelector('.oe-n-custom-wrap');if(wrap)wrap.style.display=sel.value?'none':'';};

async function saveOrderEdit(){
 const state=orderEditState;if(!state)return;
 const original=state.order,val=id=>$(id).value;
 const measurements={};for(const k of ['bust','waist','hip','shoulder','length','sleeve','arm'])measurements[k]=val('oe-measure-'+k);
 const items=original.items.map(x=>({id:x.id,name:val('oe-item-name-'+x.id),qty:val('oe-item-qty-'+x.id),colour:val('oe-item-colour-'+x.id),size:val('oe-item-size-'+x.id),length_cm:val('oe-item-length-'+x.id),unit_price:val('oe-item-price-'+x.id),fabric_choice:val('oe-item-fabric-'+x.id),item_note:val('oe-item-note-'+x.id)}));
 const added=[...document.querySelectorAll('#oe-new-items [data-oe-new]')].map(row=>({
  style_id:(row.querySelector('.oe-n-style')||{}).value||'',
  custom_name:(row.querySelector('.oe-n-custom')||{}).value||'',
  colour:(row.querySelector('.oe-n-colour')||{}).value||'',
  qty:(row.querySelector('.oe-n-qty')||{}).value||'1',
  unit_price:(row.querySelector('.oe-n-price')||{}).value||'',
  fabric_choice:(row.querySelector('.oe-n-fabric')||{}).value||'',
  item_note:(row.querySelector('.oe-n-note')||{}).value||'',
 })).filter(x=>x.style_id||x.custom_name.trim()||x.unit_price!=='');
 const badAdded=added.find(x=>(!x.style_id&&!x.custom_name.trim())||!(Number(x.qty)>=1)||x.unit_price===''||!(Number(x.unit_price)>=0));
 if(badAdded){toast(oeText('أكملي بيانات كل فستان جديد (موديل أو وصف وكمية وسعر) أو احذفي الصف الفارغ.','Complete every new dress (style or description, quantity and price) or remove the empty row.'));return;}
 const order={code:val('oe-code'),channel:val('oe-channel'),contact:{name:val('oe-name'),phone:val('oe-phone'),area:val('oe-area')},governorate:val('oe-gov'),delivery_requested:val('oe-delivery')==='yes',delivery_fee:val('oe-shipping'),discount:val('oe-discount'),promise_date:val('oe-date'),fabric_choice:val('oe-fabric'),note:val('oe-note'),measurements};
 const changed=items.some((x,i)=>Number(x.qty)!==original.items[i].qty||Number(x.unit_price)!==original.items[i].unit_price)||added.length>0||Number(order.discount)!==original.discount||(order.delivery_fee!==''&&Number(order.delivery_fee)!==original.delivery_fee);
 const stock=items.some((x,i)=>original.items[i].style_type==='stock'&&(Number(x.qty)!==original.items[i].qty||x.colour!==(original.items[i].colour||'')||x.size!==(original.items[i].size||'')));
 if(changed||stock){const next=items.reduce((sum,x)=>sum+Number(x.qty)*Number(x.unit_price),0)+added.reduce((sum,x)=>sum+Number(x.qty)*Number(x.unit_price),0)-Number(order.discount)+(order.delivery_fee===''?original.delivery_fee:Number(order.delivery_fee));
  if(!confirm(oeText('الإجمالي قبل التعديل: ','Previous total: ')+EGP(original.totals.total)+'\n'+oeText('الإجمالي بعد التعديل: ','New total: ')+EGP(next)+(added.length?'\n'+oeText('فساتين تُضاف: ','Dresses being added: ')+added.length:'')+'\n'+oeText('الدفعات والمرتجعات لا تتغير، وسيُحسب الباقي من جديد. راجعي التكاليف والمخزون إن لزم. حفظ؟','Payments and refunds remain unchanged; the balance is recalculated. Review costs and stock where needed. Save?')))return;
 }
 const b=$('oe-save');b.disabled=true;
 try{const result=await api('/orders/'+encodeURIComponent(original.code)+'/edit',{method:'PATCH',body:{revision:state.revision,order,items:items.concat(added)}});CURRENT=result.code;closeModal();await render();
  if(result.quote_needs_review)alert(oeText('تم الحفظ. تغيّر المبلغ قبل تأكيد العربون، لذا احفظي عرضًا جديدًا قبل طلب الإيصال.','Saved. The amount changed before deposit approval, so save a new quote before requesting a receipt.'));
  else toast(oeText('تم حفظ بيانات الأوردر','Order details saved'));
 }catch(e){invError(e.status?e:new Error(oeText('النتيجة غير مؤكدة؛ افتحي الأوردر وراجعي بياناته قبل المحاولة.','Result unknown; reopen the order and review its details before retrying.')));b.disabled=false;}
}
