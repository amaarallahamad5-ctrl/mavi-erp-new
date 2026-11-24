// An owner can submit proof on behalf of the customer. Upload and confirmation
// deliberately remain two separate actions; an image is not proof of payment.
let receiptObjectUrls=[];
let receiptImageGeneration=0;
function clearAdminReceiptImages(){
  receiptImageGeneration++;
  for(const url of receiptObjectUrls)URL.revokeObjectURL(url);
  receiptObjectUrls=[];
}
function privateReceiptImage(path,alt){
  return `<img data-private-receipt="${safeCustom(path)}" alt="${safeCustom(alt)}"><p class="ux-help private-receipt-status">${btAdminText('جاري عرض الإيصال…','Loading receipt…')} <button class="btn sm" type="button" onclick="retryPrivateReceipt(this)" hidden>${btAdminText('إعادة المحاولة','Retry')}</button></p><button class="btn sm private-receipt-zoom" type="button" onclick="zoomAdminReceipt(this)" disabled>${btAdminText('تكبير الإيصال','Enlarge receipt')}</button>`;
}
async function loadPrivateReceipt(img){
  const generation=receiptImageGeneration,status=img.parentElement.querySelector('.private-receipt-status'),retry=status?.querySelector('button'),zoom=img.parentElement.querySelector('.private-receipt-zoom');
  if(status){status.hidden=false;status.firstChild.textContent=btAdminText('جاري عرض الإيصال… ','Loading receipt… ');}
  if(retry)retry.hidden=true;if(zoom)zoom.disabled=true;
  try{
    // Separate store/admin HttpOnly cookies keep tabs isolated; still pass in-memory bearer token when present.
    const response=await fetch(img.dataset.privateReceipt,{cache:'no-store',credentials:'same-origin',headers:TOKEN?{Authorization:'Bearer '+TOKEN,'X-Mavi-Token':TOKEN}:{}});
    if(!response.ok)throw new Error('receipt');
    const blob=await response.blob();
    if(generation!==receiptImageGeneration||!img.isConnected)return;
    const url=URL.createObjectURL(blob);receiptObjectUrls.push(url);img.src=url;
    if(img.decode)await img.decode();
    if(generation!==receiptImageGeneration||!img.isConnected)return;
    img.hidden=false;if(status)status.hidden=true;if(zoom)zoom.disabled=false;
  }catch(_){
    if(generation!==receiptImageGeneration||!img.isConnected)return;
    img.hidden=true;
    if(status){status.hidden=false;status.firstChild.textContent=btAdminText('تعذّر عرض الإيصال؛ أعيدي المحاولة أو سجلي الدخول. ','Could not display receipt; retry or sign in again. ');}
    if(retry)retry.hidden=false;
  }
}
function hydrateAdminReceiptImages(){document.querySelectorAll('img[data-private-receipt]').forEach(loadPrivateReceipt);}
function retryPrivateReceipt(button){const img=button.closest('figure')?.querySelector('img[data-private-receipt]');if(img)loadPrivateReceipt(img);}
function zoomAdminReceipt(button){
  const img=button.closest('figure')?.querySelector('img[data-private-receipt]');
  if(!img?.src||!img.src.startsWith('blob:'))return;
  $('modal').innerHTML=`<h3>${btAdminText('مراجعة إيصال التحويل','Review transfer receipt')}</h3><p class="hint">${btAdminText('تحققي من وصول المبلغ في حسابك؛ الصورة وحدها لا تؤكد الدفع.','Verify the money reached your account; the image alone does not confirm payment.')}</p><img src="${safeCustom(img.src)}" alt="${safeCustom(img.alt)}" style="display:block;width:100%;max-height:65vh;object-fit:contain;background:#f5f7fa"><div class="row"><button class="btn primary" type="button" onclick="closeModal()">${tr('close')}</button></div>`;
  $('ovl').classList.add('on');
}
function receiptSourceLabel(source){
  return source==='admin'?btAdminText('رفعتها الإدارة','Uploaded by management'):
    source==='customer'?btAdminText('رفعتها العميلة','Uploaded by customer'):
    btAdminText('مصدر الصورة القديمة غير مسجل','Older receipt: uploader not recorded');
}
function adminReceiptForm(kind,key,snapshot,quoteRevision=''){
  return `<div class="admin-receipt" data-kind="${safeCustom(kind)}" data-key="${safeCustom(key)}" data-quote-revision="${safeCustom(quoteRevision)}" data-snapshot="${safeCustom(JSON.stringify(snapshot))}">
    <div class="admin-receipt-head"><span class="admin-receipt-icon" aria-hidden="true">↥</span><div>
      <b>${btAdminText('رفع إيصال بدل العميلة','Upload proof for the customer')}</b>
      <p>${btAdminText('احفظي أي تعديل على العرض أولًا. رفع الصورة للمراجعة فقط ولا يسجل دفعة أو يؤكد التحويل.','Save any quote changes first. Upload only submits the image for review; it does not record or confirm payment.')}</p>
    </div></div>
    <div class="ux-fields"><label class="ux-field">${btAdminText('طريقة التحويل','Payment method')}
      <select class="admin-receipt-method"><option value="wallet">${tr('mobile_wallet')}</option><option value="instapay">${tr('instapay')}</option></select></label>
      <label class="ux-field">${btAdminText('صورة الإيصال','Receipt image')} <small>JPG / PNG / WebP · 2 MB</small>
      <input class="admin-receipt-file" type="file" accept="image/jpeg,image/png,image/webp"></label></div>
    <div class="ux-actions"><button class="btn" type="button" onclick="uploadAdminReceipt(this)">${btAdminText('رفع الصورة للمراجعة','Upload for review')}</button></div>
  </div>`;
}
function receiptQuoteDirty(panel){
  const kind=panel.dataset.kind,key=panel.dataset.key,s=JSON.parse(panel.dataset.snapshot||'{}');
  const current=kind==='order'?{
    percent:$('od-percent')?.value??'',payment:$('od-payment')?.value??'',shipping:$('od-shipping')?.value??null
  }:{price:$('cq-price-'+key)?.value??'',percent:$('cq-percent-'+key)?.value??'',shipping:$('cq-shipping-'+key)?.value??'',payment:$('cq-payment-'+key)?.value??'',advice:$('cq-advice-'+key)?.value??''};
  const normal=x=>x===null||x===undefined?null:String(x).trim();
  return Object.keys(s).some(k=>normal(s[k])!==normal(current[k]));
}
function readAdminReceipt(file){
  return new Promise((resolve,reject)=>{
    if(!file)return reject(new Error(btAdminText('اختاري صورة الإيصال أولًا','Choose a receipt image first.')));
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>2*1024*1024||!file.size)
      return reject(new Error(btAdminText('اختاري صورة JPG أو PNG أو WebP حتى ٢ ميجابايت','Choose a JPG, PNG or WebP image up to 2 MB.')));
    const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error(btAdminText('تعذر قراءة الصورة','Could not read the image.')));reader.readAsDataURL(file);
  });
}
async function uploadAdminReceipt(button){
  const panel=button.closest('.admin-receipt'),kind=panel.dataset.kind,key=panel.dataset.key;
  if(receiptQuoteDirty(panel)){toast(btAdminText('احفظي تعديل العرض أولًا، ثم ارفعي الإيصال.','Save the changed quote before uploading the receipt.'));return;}
  if(kind==='order'&&!mayDiscardOtherPurchases(null))return;
  button.disabled=true;
  try{
    const image=await readAdminReceipt(panel.querySelector('.admin-receipt-file').files[0]);
    const method=panel.querySelector('.admin-receipt-method').value;
    const path=kind==='order'?'/order-deposits/'+encodeURIComponent(key)+'/receipt':'/custom-requests/'+encodeURIComponent(key)+'/receipt';
    await api(path,{method:'POST',body:{image,method,quote_revision:panel.dataset.quoteRevision}});
    toast(btAdminText('تم رفع الإيصال؛ راجعي التحويل ثم أكدي الاستلام.','Receipt uploaded. Verify the transfer, then confirm receipt.'));
    await render();
    if(kind==='custom'){
      const entry=[...document.querySelectorAll('[data-custom-alert-id]')].find(x=>x.dataset.customAlertId===key);
      if(entry){entry.open=true;entry.scrollIntoView({block:'start'});}
    }
  }catch(e){
    toast(e.status||e.message&&!/fetch|network|failed/i.test(e.message)?e.message:btAdminText('تعذر تأكيد الرفع؛ افتحي الطلب وراجعي حالة الإيصال قبل الإعادة.','Upload result unknown. Reopen the request and check the receipt before retrying.'));
  }finally{button.disabled=false;}
}
function matchingDepositPayments(d){
  const recorded=d.recorded_payments||[],linkable=d.linkable_payments||[];
  const snapshot=`<input id="od-payment-snapshot" type="hidden" value="${safeCustom(JSON.stringify(recorded.map(p=>Number(p.id))))}"><input id="od-financial-revision" type="hidden" value="${safeCustom(d.financial_revision||'')}">`;
  if(!recorded.length)return snapshot+`<input id="od-existing-payment" type="hidden" value="new">`;
  const rows=recorded.map(p=>`<li>#${Number(p.id)} · <b>${EGP(p.amount)} ${tr('currency_egp')}</b> · ${safeCustom(p.method)} · ${safeCustom(p.created_at)}${p.note?' · '+safeCustom(p.note):''}</li>`).join('');
  const fragmented=recorded.some(p=>Number(p.amount)<Number(d.amount)-0.005)&&!linkable.length;
  return snapshot+`<div class="ux-inline-note"><b>${btAdminText('لهذا الطلب دفعات مسجلة بالفعل','This order already has recorded payments')}: ${EGP(d.paid_to_date)} ${tr('currency_egp')}</b><br>${btAdminText('راجعي جميع الدفعات؛ المبلغ والطريقة وحدهما لا يثبتان أنها نفس التحويل.','Review every payment; amount and method alone do not prove it is the same transfer.')}
    <details><summary>${btAdminText('عرض الدفعات المسجلة','Show recorded payments')} (${recorded.length})</summary><ul>${rows}</ul></details>
    ${Number(d.refunded)>0?`<p>${btAdminText('يوجد مرتجع مسجل','A refund is recorded')}: ${EGP(d.refunded)} ${tr('currency_egp')}. ${btAdminText('تحققي أن الدفعة المختارة لم تُرد وأن صافي المدفوع يغطي العربون.','Verify the chosen payment was not returned and net paid covers the deposit.')}</p>`:''}
    ${fragmented?`<p>${btAdminText('إذا كان العربون موزعًا على عدة دفعات صغيرة، راجعيه يدويًا قبل التأكيد؛ لا يربط النظام عدة دفعات بعربون واحد.','If the deposit is split across several smaller payments, review it manually before confirming; the system cannot link several payments to one deposit.')}</p>`:''}
    <label class="ux-field">${btAdminText('كيف يُسجّل العربون؟','How should the deposit be recorded?')}<select id="od-existing-payment">
      <option value="">${btAdminText('اختاري بعد مراجعة الدفعات','Choose after reviewing the payments')}</option>
      <option value="new">${btAdminText('تسجيل تحويل جديد مختلف عن المسجل','Record a new transfer distinct from those recorded')}</option>
      ${linkable.map(p=>{const differs=p.method!==d.payment_method||Math.abs(Number(p.amount)-Number(d.amount))>=0.005,mismatch=Number(d.refunded)>0||differs;return `<option value="${Number(p.id)}" data-mismatch="${mismatch?'1':'0'}">#${Number(p.id)} · ${EGP(p.amount)} ${tr('currency_egp')} · ${safeCustom(p.method)} · ${safeCustom(p.created_at)}${differs?' · '+btAdminText('مبلغ/طريقة مختلفة','different amount/method'):''}${Number(d.refunded)>0?' · '+btAdminText('راجعي المرتجع','review refund'):''}${p.note?' · '+safeCustom(p.note):''}</option>`}).join('')}
    </select></label></div>`;
}
