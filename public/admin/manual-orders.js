async function openManualOrder(){try{
 await loadStyles();
 const options=CACHE.styles.filter(s=>s.type==='made'&&s.active&&s.id!=='CUSTOM-DESIGN').map(s=>`<option value="${safeCustom(s.id)}">${safeCustom(s.name)}</option>`).join('');
 const select=(id,label,opts)=>`<label class="inv-field">${label}<select id="${id}">${opts}</select></label>`;
 const measurements=[['bust',tr('ac_bust')],['waist',tr('ac_waist')],['hip',tr('ac_hip')],['length',tr('ac_length')],['sleeve',tr('ac_sleeve')],['arm',tr('ac_arm')]].map(([k,n])=>inputInv('mo-'+k,n+' · '+tr('cm'),'','number','min="20" max="250" step="1"')).join('');
 showInventoryModal(tr('admin_manual_order'),tr('mo_intro'),
 inputInv('mo-name',tr('mo_name'),'','text','required maxlength="100"')+inputInv('mo-phone',tr('mo_phone'),'','tel','required maxlength="11" inputmode="numeric"')+
 inputInv('mo-gov',tr('mo_gov'),'','text','maxlength="80"')+inputInv('mo-area',tr('mo_area'),'','text','maxlength="200"')+
 select('mo-channel',tr('mo_channel'),`<option value="whatsapp">${tr('whatsapp')}</option><option value="facebook">${tr('mo_facebook')}</option><option value="instagram">${tr('mo_instagram')}</option><option value="walkin">${tr('mo_walkin')}</option><option value="other">${tr('mo_other')}</option>`)+
 select('mo-style',tr('mo_catalogue_style'),`<option value="">${tr('mo_custom_style')}</option>`+options)+
 inputInv('mo-custom',tr('mo_custom_description'),'','text','maxlength="100"',true)+
 inputInv('mo-colour',tr('inv_colour_optional'))+inputInv('mo-fabric',tr('mo_fabric'))+
 inputInv('mo-qty',tr('mo_quantity'),'1','number','required min="1" max="20" step="1"')+inputInv('mo-price',tr('mo_price'),'','number','required min="0" step="0.01"')+
 inputInv('mo-shipping',tr('mo_shipping'),'','number','min="0" step="0.01"')+inputInv('mo-paid',tr('mo_paid'),'','number','min="0" step="0.01"')+
 select('mo-method',tr('payment_method'),`<option value="cash">${tr('mo_cash')}</option><option value="instapay">${tr('instapay')}</option><option value="wallet">${tr('mobile_wallet')}</option><option value="other">${tr('mo_other')}</option>`)+
 select('mo-status',tr('mo_status'),`<option value="new">${tr('admin_status_new')}</option><option value="confirmed">${tr('admin_status_confirmed')}</option><option value="cut">${tr('admin_status_cut')}</option><option value="sewing">${tr('mo_sewing')}</option><option value="ready">${tr('admin_status_ready')}</option><option value="delivered">${tr('admin_status_delivered')}</option>`)+
 inputInv('mo-date',tr('mo_due_date'),'','date')+inputInv('mo-note',tr('mo_notes'),'','text','maxlength="1000"',true)+
 `<div class="inv-form-note">${tr('mo_warning')}</div>`+measurements,
 `<button class="btn primary" id="manual-save" onclick="saveManualOrder()">${tr('mo_save')}</button>`);
 }catch(e){toast(e.message)}}
async function saveManualOrder(){const btn=$('manual-save');btn.disabled=true;try{
 const val=id=>$(id).value, measurements={};for(const k of ['bust','waist','hip','length','sleeve','arm'])measurements[k]=val('mo-'+k);
 const body={customer_name:val('mo-name'),customer_phone:val('mo-phone'),governorate:val('mo-gov'),area:val('mo-area'),channel:val('mo-channel'),style_id:val('mo-style'),custom_name:val('mo-custom'),colour:val('mo-colour'),fabric_choice:val('mo-fabric'),qty:val('mo-qty'),unit_price:val('mo-price'),shipping_fee:val('mo-shipping'),paid:val('mo-paid'),payment_method:val('mo-method'),status:val('mo-status'),promise_date:val('mo-date'),note:val('mo-note'),measurements};
 let result;try{result=await api('/manual-orders',{method:'POST',body})}catch(e){if(e.data?.error!=='customer_exists')throw e;if(!confirm(tr('mo_existing_before')+e.data.existing_name+tr('mo_existing_after'))){btn.disabled=false;return}result=await api('/manual-orders',{method:'POST',body:{...body,confirm_existing:true}})}closeModal();toast(result.customer_created?tr('mo_saved_new'):tr('mo_saved_existing')+result.existing_name);openOrder(result.code);
 }catch(e){invError(e);btn.disabled=false}}

async function saveManualShipping(code){try{await api('/manual-orders/'+encodeURIComponent(code)+'/shipping',{method:'PATCH',body:{shipping_fee:$('manual-shipping').value,governorate:$('manual-gov').value}});toast(tr('mo_shipping_saved'));render()}catch(e){toast(e.message)}}
