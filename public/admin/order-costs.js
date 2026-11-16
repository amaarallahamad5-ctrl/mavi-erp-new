// Order-level fabric purchases and workshop cost entries.
// No fabric stock is involved; workshop quantities come from the existing order item.
let purchaseOrderItems = [];
const pcText = (ar,en) => btAdminText(ar,en);
const fabricLabel = f => f.name || pcText('خامة بدون اسم','Unnamed fabric') + ' #' + Number(f.id);

async function orderPurchasesBlock(order) {
  const data = await api('/orders/'+encodeURIComponent(order.code)+'/cost-purchases');
  if(VIEW!=='order'||CURRENT!==order.code)return '';
  purchaseOrderItems = order.items.map(i=>({id:i.id,name:i.style_name,qty:i.qty}));
  const legacy = order.items.some(i=>(i.unit_cost||0)>0||(i.cost_material||0)>0||(i.cost_tailoring||0)>0);
  return `<section class="card ux-panel"><div class="ux-head"><div>
    <h3>${pcText('مشتريات الخامات وتفصيل الورش','Fabric purchases and workshop costs')}</h3>
    <p class="ux-help">${pcText('الأمتار تخص عملية الشراء للطلب كله، ولا تُضرب مرة ثانية في عدد القطع.','Metres are for this purchase for the whole order and are not multiplied by the number of pieces.')}</p></div></div>
    ${legacy?`<div class="ux-inline-note">${pcText('تنبيه: لهذا الطلب تكاليف مسجلة على القطع. راجعيها قبل إضافة نفس المبالغ هنا حتى لا تتكرر.','This order has recorded item costs. Review them before adding the same amounts again.')}</div>`:''}
    <h4>${pcText('مشتريات الخامات','Fabric purchases')}</h4>
    <p class="ux-help">${pcText('اختيار خامة من القائمة واسمها اختياريان. أدخلي الأمتار، سعر المتر وشحن المتر لكل شراء. اكتبي 0 إذا لا يوجد شحن.','Selecting a catalogue fabric and naming it are optional. Enter metres, price per metre and shipping per metre for each purchase. Enter 0 if there is no shipping.')}</p>
    <div id="purchase-fabric-rows">${data.purchases.map(x=>purchaseRow('fabric',x)).join('')}</div>
    <div class="ux-actions"><button class="btn sm" onclick="addPurchase('fabric')">＋ ${pcText('شراء خامة','Add fabric purchase')}</button></div>
    <div class="ux-divider"></div><h4>${pcText('تكاليف الورش','Workshop costs')}</h4>
    <p class="ux-help">${pcText('اختاري قطعة من الأوردر والورشة وأجر تفصيل القطعة؛ عدد القطع يُؤخذ تلقائيًا من الأوردر.','Choose an order item, a workshop and the rate per piece; the piece count comes from the order.')}</p>
    <div id="purchase-workshop-rows">${data.workshops.map(x=>purchaseRow('workshop',x)).join('')}</div>
    <div class="ux-actions"><button class="btn sm" onclick="addPurchase('workshop')">＋ ${pcText('تكلفة ورشة','Add workshop cost')}</button></div>
    <div class="ux-divider"></div><h4>${pcText('مصاريف إضافية للطلب كله','Additional whole-order costs')}</h4>
    <p class="ux-help">${pcText('مثل تكلفة توصيل العميلة الفعلية أو التغليف للطلب كله. يُضاف المبلغ مرة واحدة، وليس لكل قطعة.','For example, actual customer delivery or packaging for the whole order. The amount is added once, not per piece.')}</p>
    <div id="purchase-other-rows">${data.extras.map(x=>purchaseRow('other',x)).join('')}</div>
    <div class="ux-actions"><button class="btn sm" onclick="addPurchase('other')">＋ ${pcText('مصروف للطلب','Add order cost')}</button></div>
    <div class="ux-inline-note">${pcText('تُجمع هذه البنود مع تكاليف القطع السابقة والإضافية أدناه. لا تسجلي التكلفة نفسها في أكثر من مكان.','These entries are added to previous and additional item costs below. Do not enter the same expense in more than one place.')}</div></section>`;
}
function purchaseToken(){
  if(window.crypto?.randomUUID) return window.crypto.randomUUID();
  const bytes=new Uint8Array(16);
  if(window.crypto?.getRandomValues){window.crypto.getRandomValues(bytes);return Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');}
  return 'p'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2)+'_'+Math.random().toString(36).slice(2);
}
function purchaseRow(type,x={}) {
  const id=Number(x.id||0), fabric=type==='fabric';
  const token=id?'':purchaseToken();
  const option=(value,label,selected=false)=>`<option value="${safeCustom(value)}" ${selected?'selected':''}>${safeCustom(label)}</option>`;
  const input=(cls,label,value,step='any')=>`<label class="ux-field">${label}<input class="${cls}" type="number" min="0" step="${step}" value="${safeCustom(value??'')}" oninput="purchaseDirty(this);purchasePreview(this)"></label>`;
  let content;
  if(fabric) {
    const missing=id && x.fabric_id && !CACHE.fabric.some(f=>Number(f.id)===Number(x.fabric_id));
    const oldOption=missing?option(x.fabric_id,`${x.fabric_name||pcText('خامة سابقة','Previous fabric')} — ${pcText('مرجع قديم غير متاح','old reference unavailable')}`,true):'';
    const options=option('',pcText('بدون اختيار من القائمة','No catalogue selection'),!x.fabric_id)+oldOption+CACHE.fabric.map(f=>option(f.id,`${fabricLabel(f)}${f.colour?' · '+f.colour:''}`,Number(x.fabric_id)===Number(f.id))).join('');
    content=`<label class="ux-field">${pcText('خامة محفوظة (اختياري)','Saved fabric (optional)')}<select class="p-choice" onchange="purchaseChoice(this)">${options}</select></label>
      <label class="ux-field">${pcText('اسم الخامة في الشراء (اختياري)','Name on this purchase (optional)')}<input class="p-name" maxlength="80" value="${safeCustom(x.fabric_name||'')}" oninput="purchaseDirty(this)"></label>
      ${input('p-qty',pcText('أمتار الشراء للطلب','Metres purchased for order'),x.metres)}
      ${input('p-price',pcText('سعر المتر','Price per metre'),x.price_per_metre)}
      ${input('p-shipping',pcText('شحن المتر','Shipping per metre'),x.shipping_per_metre)}`;
  } else if(type==='workshop') {
    const onlyNew = !id && purchaseOrderItems.length===1 ? purchaseOrderItems[0].id : null;
    const itemId=x.order_item_id || onlyNew;
    const itemOptions=option('',x.legacy_quantity?pcText('سجل سابق غير مرتبط بقطعة','Older entry not linked to an item'):pcText('اختاري قطعة من الأوردر','Choose an order item'),!itemId)+purchaseOrderItems.map(i=>option(i.id,`${i.name} × ${i.qty}`,Number(itemId)===i.id)).join('');
    const missing=id && x.tailor_id && !CACHE.tailors.some(t=>Number(t.id)===Number(x.tailor_id));
    const oldLabel=id&&!x.tailor_id?`${x.tailor_name||pcText('ورشة سابقة','Previous workshop')} — ${pcText('محفوظة وغير متاحة','saved, no longer available')}`:pcText('اختاري الورشة','Choose a workshop');
    const oldOption=missing?option(x.tailor_id,`${x.current_tailor_name||x.tailor_name||pcText('ورشة سابقة','Previous workshop')} — ${x.current_tailor_active===0?pcText('غير نشطة','inactive'):pcText('مرجع قديم غير متاح','old reference unavailable')}`,true):'';
    const tailorOptions=option('',oldLabel,!x.tailor_id)+oldOption+CACHE.tailors.map(t=>option(t.id,t.name,Number(x.tailor_id)===Number(t.id))).join('');
    content=`<label class="ux-field">${pcText('قطعة الأوردر','Order item')}<select class="p-item" onchange="purchaseChoice(this)">${itemOptions}</select></label>
      <label class="ux-field">${pcText('الورشة','Workshop')}<select class="p-choice" onchange="purchaseChoice(this)">${tailorOptions}</select></label>
      ${input('p-price',pcText('تفصيل القطعة','Rate per piece'),x.unit_cost)}
      <div class="ux-field p-piece-label">${pcText('عدد القطع من الأوردر','Pieces from the order')}<div class="p-piece-count">${itemId?(purchaseOrderItems.find(i=>i.id===Number(itemId))?.qty??'—'):(x.legacy_quantity?x.quantity:'—')}</div></div>
      ${x.legacy_quantity?`<div class="ux-inline-note ux-wide">${pcText('العدد السابق محفوظ كما هو. عند تعديل البند اختاري قطعة لربط التكلفة بها.','The previous quantity is preserved. To edit, link this entry to an order item.')}</div>`:''}
      ${id&&(!x.tailor_id||missing)?`<div class="ux-help ux-wide">${pcText('الورشة السابقة محفوظة لهذا البند فقط؛ يمكنك الإبقاء عليها أو اختيار ورشة نشطة.','The previous workshop is preserved only for this entry; keep it or select an active workshop.')}</div>`:''}
      ${x.current_tailor_name&&x.current_tailor_name!==x.tailor_name?`<div class="ux-help ux-wide">${pcText('الاسم عند التسجيل','Name when recorded')}: ${safeCustom(x.tailor_name)}</div>`:''}`;
  } else {
    content=`<label class="ux-field">${pcText('اسم المصروف','Expense name')}<input class="p-label" maxlength="100" value="${safeCustom(x.label||'')}" oninput="purchaseDirty(this)"></label>
      ${input('p-amount',pcText('المبلغ للطلب كله','Amount for the whole order'),x.amount)}`;
  }
  const total=fabric?(x.metres||0)*((x.price_per_metre||0)+(x.shipping_per_metre||0)):type==='workshop'?(x.quantity||0)*(x.unit_cost||0):(x.amount||0);
  return `<div class="purchase-row ux-inline-note" data-type="${type}" data-id="${id}" data-token="${safeCustom(token)}" data-dirty="${id?'0':'1'}" data-legacy-qty="${safeCustom(x.legacy_quantity?x.quantity:'')}" style="margin:10px 0">
    <div class="ux-fields">${content}<label class="ux-field ux-wide">${pcText('ملاحظة (اختياري)','Note (optional)')}<input class="p-note" maxlength="500" value="${safeCustom(x.note||'')}" oninput="purchaseDirty(this)"></label></div>
    <div class="line"><span>${pcText('إجمالي البند','Entry total')}</span><b class="p-total">${id?EGP(total)+' '+tr('currency_egp'):'—'}</b></div>
    <div class="ux-actions"><button class="btn sm primary" onclick="savePurchase(this)">${pcText('حفظ البند','Save entry')}</button><button class="btn sm" onclick="removePurchase(this)">${pcText('حذف','Delete')}</button></div></div>`;
}
function addPurchase(type){
  if(document.querySelector('.purchase-row[data-id="0"]')) { toast(pcText('احفظي البند الجديد أولًا قبل إضافة بند آخر','Save the new entry before adding another.'));return; }
  $('purchase-'+type+'-rows').insertAdjacentHTML('beforeend',purchaseRow(type));
}
function purchaseDirty(el){el.closest('.purchase-row').dataset.dirty='1';}
function purchaseChoice(el){
  const row=el.closest('.purchase-row');purchaseDirty(el);
  if(row.dataset.type==='fabric' && el.classList.contains('p-choice')) {
    const f=CACHE.fabric.find(x=>String(x.id)===el.value);
    if(f)row.querySelector('.p-name').value=f.name||'';
  }
  if(row.dataset.type==='workshop' && el.classList.contains('p-choice')) {
    const t=CACHE.tailors.find(x=>String(x.id)===el.value);
    if(t)row.querySelector('.p-price').value=Number(t.rate_per_piece)>0?t.rate_per_piece:'';
  }
  purchasePreview(el);
}
function purchasePreview(el){
  const row=el.closest('.purchase-row'),fabric=row.dataset.type==='fabric';
  if(row.dataset.type==='other'){
    const amount=row.querySelector('.p-amount').value;
    row.querySelector('.p-total').textContent=amount!==''?EGP(Number(amount))+' '+tr('currency_egp'):'—';
    return;
  }
  const price=row.querySelector('.p-price').value,shipping=fabric?row.querySelector('.p-shipping').value:'0';
  let qty;
  if(fabric)qty=row.querySelector('.p-qty').value;
  else {
    const item=purchaseOrderItems.find(i=>String(i.id)===row.querySelector('.p-item').value);
    qty=item?.qty ?? row.dataset.legacyQty;
    row.querySelector('.p-piece-count').textContent=qty||'—';
  }
  row.querySelector('.p-total').textContent=(qty!==''&&qty!=null&&price!==''&&shipping!=='')?EGP(Number(qty)*(Number(price)+Number(shipping)))+' '+tr('currency_egp'):'—';
}
function mayDiscardOtherPurchases(row){
  const dirty=[...document.querySelectorAll('.purchase-row[data-dirty="1"], .item-cost-rows[data-dirty="1"]')].some(r=>r!==row);
  return !dirty || confirm(pcText('توجد تعديلات غير محفوظة في تكلفة أخرى وستضيع عند تحديث الصفحة. هل تريدين المتابعة؟','Another cost has unsaved changes that will be discarded on refresh. Continue?'));
}
async function savePurchase(el){
  const row=el.closest('.purchase-row');if(!mayDiscardOtherPurchases(row))return;
  const type=row.dataset.type,id=Number(row.dataset.id),base='/orders/'+encodeURIComponent(CURRENT)+'/cost-purchases/'+type;
  if(!id && type==='workshop'){
    const item=row.querySelector('.p-item').value, workshop=row.querySelector('.p-choice').value;
    const duplicate=[...document.querySelectorAll('#purchase-workshop-rows .purchase-row[data-id]:not([data-id="0"])')].some(other=>other.querySelector('.p-item').value===item&&other.querySelector('.p-choice').value===workshop);
    if(item&&workshop&&duplicate&&!confirm(pcText('هذه الورشة مسجلة لهذه القطعة بالفعل. هل هذا شغل إضافي مختلف وليس تكرارًا لنفس التكلفة؟','This workshop is already recorded for this item. Is this a separate job rather than the same cost twice?')))return;
  }
  const body={note:row.querySelector('.p-note').value};
  if(!id)body.request_id=row.dataset.token;
  if(type==='fabric')Object.assign(body,{fabric_id:row.querySelector('.p-choice').value,fabric_name:row.querySelector('.p-name').value,metres:row.querySelector('.p-qty').value,price_per_metre:row.querySelector('.p-price').value,shipping_per_metre:row.querySelector('.p-shipping').value});
  else if(type==='workshop')Object.assign(body,{order_item_id:row.querySelector('.p-item').value,tailor_id:row.querySelector('.p-choice').value,unit_cost:row.querySelector('.p-price').value});
  else Object.assign(body,{label:row.querySelector('.p-label').value,amount:row.querySelector('.p-amount').value});
  el.disabled=true;
  try{await api(base+(id?'/'+id:''),{method:id?'PUT':'POST',body});toast(pcText('تم حفظ التكلفة','Cost saved'));await render();}
  catch(e){toast(e.status?e.message:pcText('تعذر تأكيد الحفظ؛ أعيدي المحاولة بنفس البيانات أو افتحي الطلب لمراجعته.','Could not confirm the save. Retry with the same data or reopen the order to review it.'));}
  finally{el.disabled=false;}
}
async function removePurchase(el){
  const row=el.closest('.purchase-row'),id=Number(row.dataset.id);
  if(!id){row.remove();return;}
  if(!mayDiscardOtherPurchases(row)||!confirm(pcText('حذف هذا البند من تكلفة الطلب؟','Delete this entry from the order cost?')))return;
  el.disabled=true;
  try{await api('/orders/'+encodeURIComponent(CURRENT)+'/cost-purchases/'+row.dataset.type+'/'+id,{method:'DELETE'});toast(pcText('تم حذف البند','Entry deleted'));await render();}
  catch(e){toast(e.message);}
  finally{el.disabled=false;}
}

async function detailedCostReport(from,to,provided=null){
  const data=provided||await api(`/money/cost-detail?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),t=data.totals;
  const fmt=n=>EGP(n||0)+' '+tr('currency_egp');
  const workshops=new Map();
  for(const row of data.rows)for(const w of row.workshops){
    const key=w.tailor_id?'id:'+w.tailor_id:'unlinked:'+w.id;
    const value=workshops.get(key)||{name:w.current_tailor_name||w.tailor_name,cost:0,qty:0};
    value.cost+=w.quantity*w.unit_cost;value.qty+=w.quantity;workshops.set(key,value);
  }
  const cards=[
    [pcText('مشتريات خامات جديدة','New fabric purchases'),fmt(t.material)],
    [pcText('خامة سابقة مصنّفة','Classified previous fabric'),fmt(t.legacy_material)],
    [pcText('ورش جديدة','New workshop costs'),fmt(t.tailoring)],
    [pcText('تفصيل سابق مصنّف','Classified previous tailoring'),fmt(t.legacy_tailoring)],
    [pcText('مصاريف إضافية للطلب','Additional order costs'),fmt(t.order_other)],
    [pcText('بنود يدوية للقطع','Manual item costs'),fmt(t.manual)],
    [pcText('تكاليف أخرى أو قديمة غير مصنّفة','Other or unclassified previous costs'),fmt(t.legacy_other)],
    [pcText('إجمالي التكلفة المسجلة','Total recorded costs'),fmt(t.total)],
    [pcText('البيع مع الخصم وشحن العميلة','Sales after discount and customer shipping'),fmt(t.sales)],
    [pcText('الفرق قبل المصروفات العامة','Difference before overheads'),fmt(t.profit)],
    [pcText('أمتار المشتريات الجديدة','New purchased metres'),EGP(t.metres)],
  ];
  const excluded=data.excluded;
  $('cost-detail-result').innerHTML=`<div class="ux-divider"></div><h3>${pcText('تقرير التكلفة التفصيلي','Detailed cost report')}</h3>
    <p class="ux-help">${pcText('حسب تاريخ إنشاء الطلب بتوقيت القاهرة. الملغي والطلبات التي لم تُسعّر بالكامل مستبعدة من الإجماليات. التكاليف السابقة محفوظة؛ لا نُخمّن تفصيل غير المصنّف.','Based on order creation date in Cairo time. Cancelled and not-yet-priced orders are excluded. Previous costs are preserved and unclassified history is not guessed.')}</p>
    <div class="ux-report-result">${cards.map(([a,b])=>`<div><span>${a}</span><b>${b}</b></div>`).join('')}</div>
    <p class="ux-help">${pcText('الفرق يعتمد على البنود المدخلة فقط ويشمل شحن العميلة في البيع؛ تكلفة التوصيل الفعلية لا تُخصم إلا إذا سُجلت في مصاريف الطلب. المصروفات العامة منفصلة في ملخص الفترة.','The difference uses recorded costs only and includes customer shipping in sales. Actual delivery cost is deducted only if recorded as an order cost. Overheads are separate in the period summary.')}</p>
    ${(excluded.cancelled.orders||excluded.unpriced.orders)?`<div class="ux-inline-note">${pcText('مستبعد من الإجماليات:','Excluded from totals:')} ${excluded.cancelled.orders} ${pcText('طلب ملغي','cancelled orders')} · ${excluded.unpriced.orders} ${pcText('طلب ينتظر التسعير، تكلفة مسجلة','orders awaiting pricing, recorded cost')} ${fmt(excluded.unpriced.recorded_cost)}. ${pcText('لا تضيفي المصروف مرتين.','Do not enter the same expense twice.')}</div>`:''}
    <h4>${pcText('مقارنة تكاليف الورش الجديدة','Comparison of new workshop costs')}</h4>
    <div class="tscroll"><table><thead><tr><th>${pcText('الورشة','Workshop')}</th><th>${pcText('القطع','Pieces')}</th><th>${pcText('إجمالي التفصيل','Tailoring total')}</th><th>${pcText('متوسط القطعة','Average per piece')}</th></tr></thead>
    <tbody>${[...workshops.values()].map(w=>`<tr><td>${safeCustom(w.name)}</td><td>${EGP(w.qty)}</td><td>${fmt(w.cost)}</td><td>${w.qty?fmt(w.cost/w.qty):'—'}</td></tr>`).join('')||`<tr><td colspan="4">${pcText('لا توجد بيانات','No data')}</td></tr>`}</tbody></table></div>
    <h4>${pcText('تفاصيل كل طلب','Order details')}</h4>
    ${data.rows.map(row=>{
      const warning=row.profit<0?pcText(' · ⚠ التكلفة أعلى من البيع',' · ⚠ costs exceed sales'):(row.sales>0&&row.margin<20?pcText(' · ⚠ هامش أقل من 20% (مؤشر مبدئي)',' · ⚠ margin below 20% (rough indicator)'):'');
      const purchases=row.purchases.map(p=>`${safeCustom(p.fabric_name||pcText('خامة بدون اسم','Unnamed fabric'))}: ${EGP(p.metres)} ${pcText('م','m')} × (${fmt(p.price_per_metre)} + ${pcText('شحن','shipping')} ${fmt(p.shipping_per_metre)}) = ${fmt(p.metres*(p.price_per_metre+p.shipping_per_metre))}${p.note?' · '+safeCustom(p.note):''}`).join('<br>')||pcText('لا يوجد','None');
      const extras=row.extras.map(e=>`${safeCustom(e.label)}: ${fmt(e.amount)}${e.note?' · '+safeCustom(e.note):''}`).join('<br>')||pcText('لا يوجد','None');
      const workers=row.workshops.map(w=>`${safeCustom(w.tailor_name)}${w.item_name?' · '+safeCustom(w.item_name):''}: ${EGP(w.quantity)} × ${fmt(w.unit_cost)} = ${fmt(w.quantity*w.unit_cost)}${w.note?' · '+safeCustom(w.note):''}`).join('<br>')||pcText('لا يوجد','None');
      const items=row.items.map(i=>{
        let previous='';
        if(i.cost_material!==null&&i.cost_tailoring!==null&&i.cost_other_base!==null)previous=` (${pcText('خامة سابقة','previous fabric')} ${fmt(i.cost_material)}، ${pcText('تفصيل سابق','previous tailoring')} ${fmt(i.cost_tailoring)} ${pcText('للقطعة','per piece')})`;
        else if(Math.abs(i.unit_cost-i.lines.reduce((n,l)=>n+l.quantity*l.unit_cost,0))>0.001)previous=` (${pcText('التكلفة السابقة غير مصنفة','previous cost unclassified')})`;
        return `${safeCustom(i.name)}: ${EGP(i.qty)} × ${fmt(i.unit_cost)}${previous}${i.lines.map(l=>' · '+safeCustom(l.label)+' '+EGP(l.quantity)+' × '+fmt(l.unit_cost)+' '+pcText('للقطعة','per piece')).join('')}`;
      }).join('<br>');
      return `<section class="ux-inline-note"><button class="btn sm" data-code="${safeCustom(row.code)}" onclick="openOrder(this.dataset.code)">${safeCustom(row.code)}</button> · ${safeCustom(row.date)}${warning}<br>
        ${pcText('مشتريات جديدة','New fabric')} ${fmt(row.material)} · ${pcText('ورش جديدة','New workshops')} ${fmt(row.tailoring)} · ${pcText('مصاريف للطلب','Order extras')} ${fmt(row.order_other)} · ${pcText('تكاليف سابقة وبنود القطع','Previous and item costs')} ${fmt(row.other-row.order_other)}<br>
        <b>${pcText('التكلفة المسجلة','Recorded cost')}: ${fmt(row.cost)} · ${pcText('البيع','Sales')}: ${fmt(row.sales)} · ${pcText('الفرق','Difference')}: ${fmt(row.profit)} · ${pcText('الهامش','Margin')}: ${row.margin}%</b><br>
        ${row.legacy_other < -0.01?`⚠ ${pcText('تفاصيل التكلفة القديمة غير متسقة مع الإجمالي المحفوظ؛ لم نغيّرها، وراجعيها قبل التعديل.','Previous cost details do not reconcile with the saved total; they have not been changed. Review before editing.')}<br>`:''}
        ${pcText('تفصيل المتر كمؤشر تقريبي للطلب','Tailoring per metre as an approximate order indicator')}: ${row.tailoring_per_metre===null?pcText('غير متاح','Not available'):fmt(row.tailoring_per_metre)} — ${pcText('تكلفة الورش الجديدة ÷ أمتار المشتريات الجديدة، وليست تكلفة إضافية.','new workshop costs ÷ new purchased metres; not an additional cost.')}<br>
        <b>${pcText('مشتريات الخامات','Fabric purchases')}:</b> ${purchases}<br><b>${pcText('الورش','Workshops')}:</b> ${workers}<br><b>${pcText('مصاريف الطلب','Order extras')}:</b> ${extras}<br><b>${pcText('تكاليف القطع السابقة والإضافية','Previous and additional item costs')}:</b> ${items||'—'}</section>`;
    }).join('')||`<p>${pcText('لا توجد طلبات في الفترة.','No orders in this period.')}</p>`}`;
}
