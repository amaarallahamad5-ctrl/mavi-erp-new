// Owner-only operating/general expenses. They never change an order or dress cost.
const EX = { rows:[], history:[], from:'', to:'', draft:null, saving:false };
const ex = (ar,en)=>btAdminText(ar,en);
const exEsc = value=>safeCustom(value??'');
const exMoney = n=>`${EGP(Number(n)||0)} ${tr('currency_egp')}`;
function expenseEventTime(value){
 if(!value)return '—';let stamp=String(value).replace(' ','T');
 if(!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(stamp))stamp+='Z';
 const date=new Date(stamp);if(!Number.isFinite(date.getTime()))return String(value)+' UTC';
 const text=new Intl.DateTimeFormat(STAGED_LANGUAGE==='en'?'en-GB':'ar-EG-u-nu-latn',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(date);
 return text+' '+ex('توقيت القاهرة','Cairo time');
}

async function expensesView(){
 const [data,log]=await Promise.all([api('/money/expenses'),api('/money/expenses/history')]);
 EX.rows=data.expenses||[];EX.history=log.history||[];
 const invalid=EX.rows.filter(x=>!x.report_day).length;
 return `<div class="topbar ex-topbar"><div><div class="ex-eyebrow">MAVI / ${ex('الإدارة المالية','FINANCIAL MANAGEMENT')}</div><h1>${ex('المصروفات التشغيلية والعمومية','Operating & general expenses')}</h1><div class="sub">${ex('مصروفات الشغل العامة في مكان مستقل عن تكلفة كل فستان وطلب.','Business overhead, separate from every dress and order cost.')}</div></div><button class="btn primary ex-add" type="button" id="ex-add" onclick="openExpenseEditor()">＋ ${ex('إضافة مصروف','Add expense')}</button></div>
 <section class="card ex-intro"><div class="ex-intro-icon" aria-hidden="true">◈</div><div><h2>${ex('المصروفات العامة بتأثر على صافي الربح فقط','Overhead affects overall net profit only')}</h2><p>${ex('مثل الإيجار والإعلانات والفواتير والمصاريف الإدارية. المصروف هنا لا يتوزّع على الفساتين، ولا يغيّر سعر أو تكلفة أي طلب.','For example rent, advertising, utilities and administrative expenses. Nothing here is allocated to dresses or changes an order’s price or cost.')}</p><div class="ex-formula"><span>${ex('مبيعات الطلبات','Order sales')}</span><i>−</i><span>${ex('تكلفة الطلبات','Order costs')}</span><i>−</i><span>${ex('المصروفات العامة','Overhead')}</span><i>=</i><strong>${ex('صافي الربح التقديري','Estimated net profit')}</strong></div><p class="ex-small">${ex('الأرقام تعتمد على المسجّل: الطلبات حسب تاريخ إنشائها والمصروفات حسب تاريخ المصروف، وليست رصيد الخزنة أو ربحًا محاسبيًا نهائيًا. لا تسجلي نفس المصروف هنا وفي تكلفة الطلب.','Figures use recorded amounts: orders by creation date and expenses by expense date. This is not cash on hand or final accounting profit. Do not record the same cost here and on an order.')}</p></div></section>
 <section class="ex-summary-grid"><div class="card ex-summary"><span>${ex('المصروفات المعروضة','Displayed expenses')}</span><strong id="ex-filtered-total">—</strong><small id="ex-filtered-count"></small></div><div class="card ex-summary ex-summary-link"><span>${ex('راجعي التأثير','Review the effect')}</span><p>${ex('صافي الربح في الفلوس، وتفصيل الفترات في التقارير.','See net profit in Finance and period breakdowns in Reports.')}</p><div><button class="btn sm" type="button" onclick="go('money')">${ex('الفلوس','Finance')}</button><button class="btn sm" type="button" onclick="go('rep')">${ex('التقارير','Reports')}</button></div></div></section>
 <section class="card ex-list"><div class="ex-list-head"><div><h2>${ex('سجل المصروفات','Expense entries')}</h2><p>${ex('كل مصروف يُسجل مرة واحدة باسمه ومبلغه وتاريخه.','Record each expense once with its name, amount and date.')}</p></div><button class="btn" type="button" onclick="openExpenseEditor()">＋ ${ex('إضافة مصروف','Add expense')}</button></div>
 <div class="ex-filters"><label>${ex('من تاريخ','From')}<input type="date" id="ex-from" value="${exEsc(EX.from)}" oninput="expenseFilter()"></label><label>${ex('إلى تاريخ','To')}<input type="date" id="ex-to" value="${exEsc(EX.to)}" oninput="expenseFilter()"></label><button class="btn sm" type="button" onclick="expenseClearFilter()">${ex('كل الفترات','All dates')}</button></div><p class="ex-small">${ex('الفلتر يعرض مصروفات حسب تاريخ المصروف ولا يغيّر أي بيانات. إجمالي صفحة الفلوس يشمل كل المصروفات المسجلة.','The filter uses expense date and does not change data. Finance totals include every recorded expense.')}</p><div id="ex-filter-error" class="ex-warning" role="status" hidden></div>${invalid?`<div class="ex-warning">${ex('يوجد مصروفات قديمة بتاريخ غير مفهوم:','Older expenses have an unrecognised date:')} ${invalid}. ${ex('تدخل إجمالي الفلوس لكنها لا تظهر في تقرير فترة حتى يصحح تاريخها.','They are included in Finance totals but not a period report until their dates are corrected.')}</div>`:''}
 <div class="tscroll ex-table-scroll"><table class="ex-table"><thead><tr><th>${ex('البند','Expense')}</th><th>${ex('التاريخ','Date')}</th><th>${ex('المبلغ','Amount')}</th><th>${ex('الإجراءات','Actions')}</th></tr></thead><tbody id="ex-rows"></tbody></table></div><div id="ex-empty" class="ex-empty" hidden></div></section>
 <details class="card ex-history"><summary><span>${ex('سجل الإضافات والتعديلات والحذف','Expense activity history')}</span><b>${EX.history.length}</b></summary><p>${ex('آخر ٢٠٠ عملية منذ إضافة سجل المتابعة؛ لا نختلق تاريخًا للبيانات الأقدم.','Last 200 actions since this history was added; older records have no invented history.')}</p>${expenseHistoryMarkup(EX.history)}</details>`;
}

function expenseRow(x){
 const id=Number(x.id),day=x.report_day||'',raw=x.spent_on||'';
 return `<tr><td data-label="${ex('البند','Expense')}"><b>${exEsc(x.category)}</b>${x.note?`<small>${exEsc(x.note)}</small>`:''}</td><td data-label="${ex('التاريخ','Date')}"><span dir="ltr">${exEsc(day||raw||'—')}</span>${!day?`<small class="ex-invalid">${ex('تاريخ يحتاج مراجعة','Date needs review')}</small>`:''}</td><td data-label="${ex('المبلغ','Amount')}" class="ex-amount">${exMoney(x.amount)}</td><td data-label="${ex('الإجراءات','Actions')}"><div class="ex-row-actions"><button class="btn sm" type="button" onclick="openExpenseEditor(${id})">${ex('تعديل','Edit')}</button><button class="btn sm danger" type="button" onclick="prepareDelete('expense',${id})">${tr('admin_delete')}</button></div></td></tr>`;
}
function expenseHistorySnapshot(x){
 if(!x||typeof x!=='object')return '—';
 return `${exEsc(x.category||'—')} · <b>${exMoney(x.amount)}</b> · <span dir="ltr">${exEsc(x.spent_on||'—')}</span>${x.note?` · ${exEsc(x.note)}`:''}`;
}
function expenseHistoryMarkup(rows){
 if(!rows.length)return `<div class="ex-empty">${ex('لا توجد عمليات جديدة في السجل بعد.','No new activity yet.')}</div>`;
 return `<ol class="ex-history-list">${rows.map(x=>{
  const detail=x.detail||{},title=x.action==='created'?ex('إضافة مصروف','Expense added'):x.action==='updated'?ex('تعديل مصروف','Expense edited'):ex('حذف مصروف','Expense deleted');
  const change=x.action==='updated'?`${ex('قبل','Before')}: ${expenseHistorySnapshot(detail.before)}<br>${ex('بعد','After')}: ${expenseHistorySnapshot(detail.after)}`:expenseHistorySnapshot(x.action==='created'?detail.after:detail.before);
  return `<li><div class="ex-history-heading"><strong>${title} · #${exEsc(x.expense_id)}</strong><span dir="auto">${exEsc(expenseEventTime(x.created_at))}</span></div><div>${change}</div><small>${ex('بواسطة','By')}: ${exEsc(x.actor_name||ex('غير معروف','Unknown'))}${detail.reason?` · ${ex('السبب','Reason')}: ${exEsc(detail.reason)}`:''}</small></li>`;
 }).join('')}</ol>`;
}
function expenseFilter(){
 const from=$('ex-from')?.value||'',to=$('ex-to')?.value||'';EX.from=from;EX.to=to;
 const error=$('ex-filter-error'),tbody=$('ex-rows'),empty=$('ex-empty');if(!tbody||!error||!empty)return;
 if(from&&to&&from>to){error.textContent=ex('تاريخ البداية بعد النهاية؛ اختاري فترة صحيحة.','The start date is after the end date. Choose a valid range.');error.hidden=false;tbody.innerHTML='';empty.hidden=true;$('ex-filtered-total').textContent='—';$('ex-filtered-count').textContent='';return;}
 error.hidden=true;
 const rows=EX.rows.filter(x=>{
  if(!from&&!to)return true;
  if(!x.report_day)return false;
  return (!from||x.report_day>=from)&&(!to||x.report_day<=to);
 });
 tbody.innerHTML=rows.map(expenseRow).join('');
 empty.hidden=!!rows.length;empty.textContent=EX.rows.length?ex('لا توجد مصروفات في الفترة المختارة.','No expenses in the selected period.'):ex('لا توجد مصروفات مسجلة بعد. اضغطي «إضافة مصروف» للبدء.','No expenses recorded yet. Select Add expense to begin.');
 $('ex-filtered-total').textContent=exMoney(rows.reduce((sum,x)=>sum+(Number.isFinite(Number(x.amount))?Number(x.amount):0),0));
 $('ex-filtered-count').textContent=rows.length+' '+ex('مصروف','entries');
 requestAnimationFrame(decorateAdminTables);
}
function expenseClearFilter(){if($('ex-from'))$('ex-from').value='';if($('ex-to'))$('ex-to').value='';expenseFilter();}
function expenseMarkDirty(){if(EX.draft)EX.draft.dirty=true;}
function expenseHasUnsaved(){return !!(EX.draft?.dirty&&$('ovl')?.classList.contains('on')&&$('ex-save'));}
function expenseMayClose(){
 if(!$('ex-save'))return true;
 if(EX.saving){toast(ex('انتظري حتى تنتهي عملية الحفظ.','Please wait for saving to finish.'));return false;}
 if(!expenseHasUnsaved())return true;
 return confirm(EX.draft.uncertain?ex('نتيجة الحفظ غير مؤكدة. أغلقي النافذة وراجعي السجل قبل إضافة المصروف مرة أخرى؟','The save result is unknown. Close and check the list before adding the expense again?'):ex('يوجد بيانات مصروف غير محفوظة. هل تريدين إغلاقها؟','This expense has unsaved changes. Close without saving?'));
}
function openExpenseEditor(id=0){
 const item=id?EX.rows.find(x=>Number(x.id)===Number(id)):null;if(id&&!item)return;
 const date=item?(item.report_day||''):rhToday();
 EX.draft={id:Number(id)||0,revision:item?.revision||null,token:purchaseToken(),dirty:false,uncertain:false,lastPayload:null};
 const options=STAGED_LANGUAGE==='en'?['Rent','Advertising and marketing','Utilities','Administrative salaries','Internet and communications','Other']:['إيجار','إعلانات وتسويق','كهرباء ومياه','رواتب إدارية','إنترنت واتصالات','أخرى'];
 const marks='oninput="expenseMarkDirty()"';
 const content=`<div class="inv-form-note">${ex('مصروف عام للعمل كله، لا يُضاف لتكلفة الفستان أو الطلب. لا يُجرى دفع تلقائي.','A business-wide expense, not an order or dress cost. No payment is made automatically.')}</div>`+
  inputInv('ex-category',ex('اسم أو نوع المصروف','Expense name or category'),item?.category||'','text',`required maxlength="100" list="ex-categories" ${marks}`,true)+
  `<datalist id="ex-categories">${options.map(v=>`<option value="${exEsc(v)}"></option>`).join('')}</datalist>`+
  inputInv('ex-amount',ex('المبلغ بالجنيه','Amount in EGP'),item?.amount??'','number',`required min="0.01" max="100000000" step="0.01" inputmode="decimal" ${marks}`)+
  inputInv('ex-date',ex('تاريخ المصروف','Expense date'),date,'date',`required ${marks}`)+
  inputInv('ex-note',ex('ملاحظة (اختياري)','Note (optional)'),item?.note||'','text',`maxlength="500" ${marks}`,true)+
  (item?inputInv('ex-reason',ex('سبب التعديل (اختياري)','Reason for edit (optional)'),'','text',`maxlength="300" ${marks}`,true):'')+
  (!date&&item?`<div class="inv-form-note">${ex('تاريخ المصروف القديم غير مفهوم؛ اختاري تاريخًا صحيحًا قبل حفظه.','The old expense date is unrecognised; choose a valid date before saving.')}</div>`:'');
 showInventoryModal(item?ex('تعديل مصروف عام','Edit a general expense'):ex('إضافة مصروف عام','Add a general expense'),ex('يتحدث صافي الربح وتقارير الفترات بعد الحفظ، وتبقى تكلفة الفستان كما هي.','Net profit and period reports update after saving; dress costs stay unchanged.'),content,`<button class="btn primary" type="button" id="ex-save" onclick="saveExpense()">${item?ex('حفظ التعديل','Save changes'):ex('حفظ المصروف','Save expense')}</button>`);
}
function expenseError(error){
 const code=error?.data?.error;
 if(code==='bad_expense')return ex('راجعي اسم المصروف والمبلغ الموجب حتى منزلتين عشريتين والتاريخ.','Check the expense name, positive amount (up to two decimals), and date.');
 if(code==='stale_expense')return ex('المصروف اتغيّر في نافذة أخرى؛ أغلقي النموذج وافتحيه وراجعيه من جديد.','This expense changed in another window. Close, reopen and review it.');
 if(code==='token_conflict'||code==='request_deleted')return ex('راجعي السجل قبل إضافة المصروف من جديد؛ لا يمكن تكرار هذه المحاولة ببيانات مختلفة.','Review the list before adding a new expense; this attempt cannot be replayed with different details.');
 return error?.message||ex('تعذر حفظ المصروف.','Could not save the expense.');
}
async function saveExpense(){
 const draft=EX.draft;if(!draft||EX.saving)return;
 const category=$('ex-category').value.trim(),amount=$('ex-amount').value.trim(),spent_on=$('ex-date').value,note=$('ex-note').value.trim();
 if(!category||!/^\d+(?:\.\d{1,2})?$/.test(amount)||Number(amount)<=0||Number(amount)>100000000||!spent_on){invError(Error(ex('اكتبي اسم المصروف ومبلغًا موجبًا وتاريخًا صحيحًا.','Enter an expense name, a positive amount and a valid date.')));return;}
 const body={category,amount,spent_on,note};
 if(draft.id){body.revision=draft.revision;body.reason=$('ex-reason').value.trim();}else body.request_id=draft.token;
 const key=JSON.stringify(body);
 if(draft.uncertain&&draft.lastPayload!==key){invError(Error(ex('النتيجة السابقة غير مؤكدة. أعيدي المحاولة بنفس البيانات دون تغيير، أو أغلقي وراجعي السجل أولًا.','The previous result is unknown. Retry with the same details, or close and review the list first.')));return;}
 EX.saving=true;const btn=$('ex-save');btn.disabled=true;
 try{
  await api('/money/expenses'+(draft.id?'/'+draft.id:''),{method:draft.id?'PATCH':'POST',body});
  EX.saving=false;draft.dirty=false;closeModal();EX.draft=null;
  toast(ex('تم حفظ المصروف العام','General expense saved'));await render();
 }catch(error){
  EX.saving=false;
  if(!error.status){draft.uncertain=true;draft.lastPayload=key;invError(Error(ex('نتيجة الحفظ غير مؤكدة. راجعي السجل أو أعيدي المحاولة بنفس البيانات دون تغيير.','The save result is unknown. Check the list or retry with the same details.')));}
  else invError(Error(expenseError(error)));
  if(btn.isConnected)btn.disabled=false;
 }
}
