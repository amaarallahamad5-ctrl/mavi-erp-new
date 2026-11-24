let MO_STYLE_OPTIONS='';
function moItemRow(){return `<div data-mo-item style="border:1px solid var(--line);border-radius:10px;padding:10px 8px;margin-bottom:8px">
 <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px"><small style="color:var(--muted)">✦ ${tr('mo_item_n')}</small><button type="button" class="btn sm" onclick="moRemoveItem(this)">${tr('mo_remove_item')}</button></div>
 <label class="inv-field">${tr('mo_catalogue_style')}<select class="mo-i-style" onchange="moStylePrice(this)"><option value="">${tr('mo_custom_style')}</option>${MO_STYLE_OPTIONS}</select></label>
 <label class="inv-field">${tr('mo_custom_description')}<input class="mo-i-custom" type="text" maxlength="100"></label>
 <label class="inv-field">${tr('inv_colour_optional')}<input class="mo-i-colour" type="text" maxlength="80"></label>
 <label class="inv-field">${tr('mo_quantity')}<input class="mo-i-qty" type="number" value="1" min="1" max="20" step="1"></label>
 <label class="inv-field">${tr('mo_price')}<input class="mo-i-price" type="number" min="0" step="0.01"></label>
</div>`;}
window.moAddItem=function(){const c=document.getElementById('mo-items');if(!c)return;if(c.querySelectorAll('[data-mo-item]').length>=20){toast(tr('mo_max_items'));return}c.insertAdjacentHTML('beforeend',moItemRow());};
window.moRemoveItem=function(btn){const c=document.getElementById('mo-items');if(!c)return;if(c.querySelectorAll('[data-mo-item]').length<=1){toast(tr('mo_min_items'));return}btn.closest('[data-mo-item]').remove();};
window.moStylePrice=function(sel){try{const row=sel.closest('[data-mo-item]');const price=row&&row.querySelector('.mo-i-price');const s=CACHE.styles.find(x=>x.id===sel.value);if(price&&!price.value&&s&&(s.sale_price??s.price)!=null)price.value=(s.sale_price??s.price);}catch(e){}};
async function openManualOrder(){try{
 await loadStyles();
 MO_STYLE_OPTIONS=CACHE.styles.filter(s=>s.type==='made'&&s.active&&s.id!=='CUSTOM-DESIGN').map(s=>`<option value="${safeCustom(s.id)}">${safeCustom(s.name)}</option>`).join('');
 const select=(id,label,opts)=>`<label class="inv-field">${label}<select id="${id}">${opts}</select></label>`;
 const measurements=[['bust',tr('ac_bust')],['waist',tr('ac_waist')],['hip',tr('ac_hip')],['shoulder',tr('ac_shoulder')],['length',tr('ac_length')],['sleeve',tr('ac_sleeve')],['arm',tr('ac_arm')]].map(([k,n])=>inputInv('mo-'+k,n+' · '+tr('cm'),'','number','min="20" max="250" step="1"')).join('');
 showInventoryModal(tr('admin_manual_order'),tr('mo_intro'),
 inputInv('mo-name',tr('mo_name'),'','text','required maxlength="100"')+inputInv('mo-phone',tr('mo_phone'),'','tel','required maxlength="11" inputmode="numeric"')+
 inputInv('mo-gov',tr('mo_gov'),'','text','maxlength="80"')+inputInv('mo-area',tr('mo_area'),'','text','maxlength="200"')+
 select('mo-channel',tr('mo_channel'),`<option value="whatsapp">${tr('whatsapp')}</option><option value="facebook">${tr('mo_facebook')}</option><option value="instagram">${tr('mo_instagram')}</option><option value="walkin">${tr('mo_walkin')}</option><option value="other">${tr('mo_other')}</option>`)+
 `<div style="margin:10px 0 4px;font-weight:700">${tr('mo_items')}</div><div id="mo-items">${moItemRow()}</div>
 <button type="button" class="btn sm" style="margin-bottom:10px" onclick="moAddItem()">${tr('mo_add_item')}</button>`+
 inputInv('mo-shipping',tr('mo_shipping'),'','number','min="0" step="0.01"')+inputInv('mo-paid',tr('mo_paid'),'','number','min="0" step="0.01"')+
 select('mo-method',tr('payment_method'),`<option value="cash">${tr('mo_cash')}</option><option value="instapay">${tr('instapay')}</option><option value="wallet">${tr('mobile_wallet')}</option><option value="other">${tr('mo_other')}</option>`)+
 select('mo-status',tr('mo_status'),`<option value="new">${tr('admin_status_new')}</option><option value="confirmed">${tr('admin_status_confirmed')}</option><option value="cut">${tr('admin_status_cut')}</option><option value="sewing">${tr('mo_sewing')}</option><option value="ready">${tr('admin_status_ready')}</option><option value="delivering">${tr('admin_status_delivering')}</option><option value="delivered">${tr('admin_status_delivered')}</option>`)+
 inputInv('mo-date',tr('mo_due_date'),'','date')+inputInv('mo-note',tr('mo_notes'),'','text','maxlength="1000"',true)+
 `<div class="inv-form-note">${tr('mo_warning')}</div>`+measurements,
 `<button class="btn primary" id="manual-save" onclick="saveManualOrder()">${tr('mo_save')}</button>`);
 }catch(e){toast(e.message)}}
async function saveManualOrder(){const btn=$('manual-save');btn.disabled=true;try{
 const val=id=>$(id).value, measurements={};for(const k of ['bust','waist','hip','shoulder','length','sleeve','arm'])measurements[k]=val('mo-'+k);
 const items=[...document.querySelectorAll('#mo-items [data-mo-item]')].map(row=>({
  style_id:(row.querySelector('.mo-i-style')||{}).value||'',
  custom_name:(row.querySelector('.mo-i-custom')||{}).value||'',
  colour:(row.querySelector('.mo-i-colour')||{}).value||'',
  qty:(row.querySelector('.mo-i-qty')||{}).value||'1',
  unit_price:(row.querySelector('.mo-i-price')||{}).value||'',
 }));
 const okItems=items.every(it=>(it.style_id||it.custom_name.trim())&&Number(it.qty)>=1&&it.unit_price!==''&&Number(it.unit_price)>=0);
 if(!okItems){toast(tr('mo_items_invalid'));btn.disabled=false;return}
 const body={customer_name:val('mo-name'),customer_phone:val('mo-phone'),governorate:val('mo-gov'),area:val('mo-area'),channel:val('mo-channel'),items,shipping_fee:val('mo-shipping'),paid:val('mo-paid'),payment_method:val('mo-method'),status:val('mo-status'),promise_date:val('mo-date'),note:val('mo-note'),measurements};
 let result;try{result=await api('/manual-orders',{method:'POST',body})}catch(e){if(e.data?.error!=='customer_exists')throw e;if(!confirm(tr('mo_existing_before')+e.data.existing_name+tr('mo_existing_after'))){btn.disabled=false;return}result=await api('/manual-orders',{method:'POST',body:{...body,confirm_existing:true}})}closeModal();toast(result.customer_created?tr('mo_saved_new'):tr('mo_saved_existing')+result.existing_name);openOrder(result.code);
 }catch(e){invError(e);btn.disabled=false}}

async function saveManualShipping(code){if(!mayDiscardOtherPurchases(null))return;try{await api('/manual-orders/'+encodeURIComponent(code)+'/shipping',{method:'PATCH',body:{shipping_fee:$('manual-shipping').value,governorate:$('manual-gov').value}});toast(tr('mo_shipping_saved'));render()}catch(e){toast(e.message)}}
