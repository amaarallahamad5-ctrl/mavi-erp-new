function filterInventory(input,id){const q=input.value.trim().toLocaleLowerCase();let count=0;document.querySelectorAll(`#${id} tr[data-search]`).forEach(row=>{const hit=row.dataset.search.includes(q);row.hidden=!hit;if(hit)count++});const empty=$(id+'-empty');if(empty)empty.hidden=!!count||!q;}
function showInventoryModal(title,subtitle,content,actions){
 $('modal').innerHTML=`<div class="inv-modal-head"><div><h3>${title}</h3><p>${subtitle}</p></div><button class="inv-close" onclick="closeModal()" aria-label="${tr('close')}">×</button></div><div class="inv-form">${content}</div><div id="inv-error" role="alert" style="color:var(--bad);font-size:12px;margin-top:9px" hidden></div><div class="inv-modal-actions">${actions}<button class="btn" onclick="closeModal()">${tr('cancel')}</button></div>`;$('ovl').classList.add('on');setTimeout(()=>{$('modal').querySelector('input,select,button')?.focus()},0);
}
function inputInv(id,label,value='',type='text',attr='',wide=false){return `<label class="inv-field ${wide?'inv-span':''}">${label}<input id="${id}" type="${type}" value="${safeCustom(value)}" ${attr}></label>`}
function invError(e){const el=$('inv-error');if(el){el.textContent=e.message;el.hidden=false}else toast(e.message)}
function fabricEditor(id){
 const x=CACHE.fabric.find(f=>f.id===id)||{name:'',colour:'',details:''};
 showInventoryModal(id?btAdminText('تعديل بيانات الخامة','Edit fabric details'):btAdminText('إضافة خامة','Add fabric'),
   btAdminText('البيانات اختيارية. الأسعار والأمتار وشحن المتر تُسجل لكل عملية شراء داخل الأوردر.','All details are optional. Metres, price and shipping per metre are recorded for each purchase on the order.'),
   inputInv('iv-name',btAdminText('اسم الخامة (اختياري)','Fabric name (optional)'),x.name||'','text','maxlength="80"')+
   inputInv('iv-colour',btAdminText('اللون (اختياري)','Colour (optional)'),x.colour||'','text','maxlength="80"')+
   inputInv('iv-details',btAdminText('تفاصيل الخامة (اختياري)','Fabric details (optional)'),x.details||'','text','maxlength="500"',true),
   `<button class="btn primary" onclick="saveFabricInventory(${id||0})">${tr('save')}</button>`);
}
async function saveFabricInventory(id){try{await api('/inventory/fabric'+(id?'/'+id:''),{method:id?'PATCH':'POST',body:{name:$('iv-name').value,colour:$('iv-colour').value,details:$('iv-details').value}});closeModal();toast(btAdminText('تم حفظ بيانات الخامة','Fabric details saved'));render()}catch(e){invError(e)}}
function workshopEditor(id=0){
 const w=CACHE.tailors.find(t=>t.id===id)||{};
 showInventoryModal(id?btAdminText('تعديل الورشة','Edit workshop'):btAdminText('إضافة ورشة','Add workshop'),
   btAdminText('بيانات الورشة وسعر افتراضي اختياري؛ تتحدد تكلفة التفصيل الفعلية داخل الأوردر.','Workshop details and an optional default rate; the actual rate is recorded on each order.'),
   inputInv('tw-name',btAdminText('اسم الورشة','Workshop name'),w.name||'','text','required maxlength="80"')+
   inputInv('tw-phone',btAdminText('رقم الهاتف (اختياري)','Phone (optional)'),w.phone||'','tel','maxlength="30"')+
   inputInv('tw-rate',btAdminText('تكلفة افتراضية للقطعة (اختياري)','Default rate per piece (optional)'),w.rate_per_piece??'','number','min="0" step="any"')+
   inputInv('tw-address',btAdminText('العنوان (اختياري)','Address (optional)'),w.address||'','text','maxlength="200"')+
   inputInv('tw-notes',btAdminText('ملاحظات (اختياري)','Notes (optional)'),w.notes||'','text','maxlength="500"',true),
   `<button class="btn primary" onclick="saveWorkshop(${id})">${tr('save')}</button>`);
}
async function saveWorkshop(id=0){try{await api('/tailors'+(id?'/'+id:''),{method:id?'PATCH':'POST',body:{name:$('tw-name').value,phone:$('tw-phone').value,rate_per_piece:$('tw-rate').value,address:$('tw-address').value,notes:$('tw-notes').value}});closeModal();toast(tr('inv_workshop_saved'));render()}catch(e){invError(e)}}
function toggleNewStock(){const isNew=!$('iv-model').value;$('iv-new-group').hidden=!isNew;}
function stockEditor(id){const x=CACHE.stock.find(s=>s.id===id);if(id&&!x)return;
 if(id){showInventoryModal(tr('inv_edit_stock'),`${safeCustom(x.style_name)} · ${safeCustom(x.colour)} · ${safeCustom(x.size)}`,inputInv('iv-name',tr('admin_style_name'),x.style_name)+inputInv('iv-sale',tr('inv_sale_price'),x.sale_price,'number','min="0" step="any"')+`<div class="inv-form-note">${tr('inv_edit_note')}</div>`+inputInv('iv-qty',tr('inv_available'),x.qty,'number','min="0" step="1"')+inputInv('iv-buy',tr('inv_buy_cost'),x.buy_price,'number','min="0" step="any"'),`<button class="btn primary" onclick="saveStockInventory(${id})">${tr('inv_save_changes')}</button><button class="btn" onclick="stockHistory(${id})">${tr('inv_history')}</button>`);return}
 const opts=CACHE.styles.filter(s=>s.type==='stock'&&s.id!=='CUSTOM-DESIGN').map(s=>`<option value="${safeCustom(s.id)}">${safeCustom(s.name)}</option>`).join('');
 showInventoryModal(tr('inv_add_stock'),tr('inv_stock_help'),`<label class="inv-field inv-span">${tr('inv_style')}<select id="iv-model" onchange="toggleNewStock()"><option value="">${tr('inv_new_style')}</option>${opts}</select></label><div class="inv-span inv-form" id="iv-new-group" style="margin:0">${inputInv('iv-newname',tr('inv_new_name'))}${inputInv('iv-sale',tr('inv_sale_price'),0,'number','min="0" step="any"')}</div><div class="inv-form-note">${tr('inv_existing_note')}</div>`+inputInv('iv-size',tr('size'))+inputInv('iv-colour',tr('colour'))+inputInv('iv-qty',tr('inv_qty'),0,'number','min="0" step="1"')+inputInv('iv-buy',tr('inv_buy_cost'),0,'number','min="0" step="any"'),`<button class="btn primary" onclick="saveStockInventory(0)">${tr('inv_add_to_stock')}</button>`)
}
async function saveStockInventory(id){const body=id?{qty:$('iv-qty').value,buy_price:$('iv-buy').value,style_name:$('iv-name').value,sale_price:$('iv-sale').value}:{style_id:$('iv-model').value,new_name:$('iv-newname').value,sale_price:$('iv-sale').value,size:$('iv-size').value,colour:$('iv-colour').value,qty:$('iv-qty').value,buy_price:$('iv-buy').value};try{await api('/inventory/stock'+(id?'/'+id:''),{method:id?'PATCH':'POST',body});closeModal();toast(tr('inv_stock_saved'));render()}catch(e){invError(e)}}
async function stockHistory(id){try{const data=await api(`/inventory/stock/${id}/movements`);showInventoryModal(tr('inv_history'),tr('inv_history_help'),`<div class="inv-span">${data.movements.map(m=>`<div class="inv-history"><span>${safeCustom(m.reason)}<br><small>${safeCustom(m.created_at)}</small></span><b dir="ltr">${m.delta>0?'+':''}${m.delta}</b></div>`).join('')||`<div class="inv-empty">${tr('inv_no_history')}</div>`}</div>`,`<button class="btn primary" onclick="stockEditor(${id})">${tr('inv_return_edit')}</button>`)}catch(e){toast(e.message)}}
