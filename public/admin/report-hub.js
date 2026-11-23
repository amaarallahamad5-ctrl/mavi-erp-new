// Private report centre for the owner. A single server snapshot feeds every tab.
const RH = {from:'',to:'',tab:'overview',sequence:0};
const rh = (ar,en)=>btAdminText(ar,en);
const rhEsc = value=>safeCustom(value??'');
const rhNum = value=>EGP(Number(value)||0);
const rhMoney = value=>rhNum(value)+' '+tr('currency_egp');
const rhEmpty = ()=>`<div class="rh-empty">${rh('لا توجد بيانات في الفترة المختارة.','No data for the selected period.')}</div>`;
function rhToday(){
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
 return `${parts.year}-${parts.month}-${parts.day}`;
}
function rhBusinessDay(value){
 if(!value)return '—';let stamp=String(value).trim();if(/^\d{4}-\d{2}-\d{2}$/.test(stamp))return stamp;
 stamp=stamp.replace(' ','T');if(!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(stamp))stamp+='Z';
 const date=new Date(stamp);if(!Number.isFinite(date.getTime()))return String(value);
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
 return `${p.year}-${p.month}-${p.day}`;
}
function rhStatus(value){return rhEsc(adminStatusLabel(value||''));}
function rhDepositStatus(value){
 const values={needs_quote:[rh('تنتظر عرض العربون','Awaiting quote'),'new'],quoted:[rh('بانتظار الإيصال','Awaiting receipt'),'new'],receipt_pending:[rh('إيصال للمراجعة','Receipt to review'),'part'],receipt_rejected:[rh('تحتاج إيصالًا جديدًا','New receipt needed'),'unpaid'],approved:[rh('مؤكد','Confirmed'),'delivered']};
 const row=values[value]||[String(value||'—'),'new'];return `<span class="tag ${row[1]}">${rhEsc(row[0])}</span>`;
}
function rhPaymentMethod(value){return ({cash:rh('نقدًا','Cash'),wallet:tr('mobile_wallet'),instapay:tr('instapay'),bank:rh('تحويل بنكي','Bank transfer')})[value]||String(value||'—');}
function rhOpenOrder(code){return `<button type="button" class="rh-link" data-code="${rhEsc(code)}" onclick="openOrder(this.dataset.code)">${rhEsc(code)}</button>`;}
function rhPanel(title,subtitle,body,extra=''){
 return `<section class="card rh-panel ${extra}"><div class="rh-panel-head"><div><h2>${title}</h2>${subtitle?`<p>${subtitle}</p>`:''}</div></div>${body}</section>`;
}
function rhTable(headers,rows){
 if(!rows.length)return rhEmpty();
 return `<div class="rh-scroll-hint">↔ ${rh('اسحبي الجدول لعرض باقي الأعمدة','Swipe the table to see more columns')}</div><div class="tscroll rh-table-scroll"><table class="rh-table"><thead><tr>${headers.map(h=>`<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}
function rhMetric(label,value,foot='',variant=''){
 return `<div class="rh-metric ${variant}"><span>${label}</span><strong>${value}</strong>${foot?`<small>${foot}</small>`:''}</div>`;
}
function rhBarRows(rows,label,value,detail){
 if(!rows.length)return rhEmpty();const max=rows.reduce((m,x)=>Math.max(m,value(x)),1);
 return `<div class="rh-bars">${rows.map(x=>`<div class="rh-bar-row"><div class="rh-bar-text"><b>${label(x)}</b><span>${detail(x)}</span></div><div class="rh-bar-track"><i style="width:${Math.max(0,Math.min(100,100*value(x)/max))}%"></i></div></div>`).join('')}</div>`;
}
function reportHubView(){
 const today=rhToday(),from=RH.from||today.slice(0,7)+'-01',to=RH.to||today;
 const tabs=[['overview',rh('الملخص','Overview')],['sales',rh('المبيعات','Sales')],['comparison',rh('الورش والخامات','Workshops & fabric')],['cost',rh('التكلفة والربح','Costs & profit')],['cash',rh('المقبوضات والعربون','Payments & deposits')],['operations',rh('المتابعة والإنتاج','Operations')]];
 return `<div class="topbar rh-top"><div><div class="rh-kicker">MAVI / ${rh('مركز الأعمال','BUSINESS INSIGHTS')}</div><h1>${rh('التقارير','Reports')}</h1><div class="sub">${rh('كل الأرقام في مكان واحد، مع تفاصيل يمكن الرجوع منها للطلب.','A clear view of the business, with links back to each order.')}</div></div><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button type="button" class="btn primary sm" onclick="officeOpenOpsAssistant('finance')">✨ ${rh('خطة الأسبوع وقمع التحويل (رامي وفرح)','Weekly plan & funnel')}</button><span class="rh-private">◈ ${rh('للمالكة فقط','Owner only')}</span></div></div>
 <section class="card rh-filters" aria-label="${rh('فترة التقرير','Report period')}"><div class="rh-filter-heading"><div><h2>${rh('اختاري فترة التقرير','Choose a reporting period')}</h2><p>${rh('حسب تاريخ إنشاء الطلب، وتاريخ كل دفعة أو مرتجع أو مصروف.','Orders use their creation date; payments, refunds and expenses use their own dates.')}</p></div><div class="rh-presets"><button class="btn sm" type="button" onclick="reportPreset('month')">${rh('هذا الشهر','This month')}</button><button class="btn sm" type="button" onclick="reportPreset('quarter')">${rh('آخر ٣ أشهر','Last 3 months')}</button><button class="btn sm" type="button" onclick="reportPreset('year')">${rh('هذا العام','This year')}</button></div></div>
 <div class="ux-report-filters"><label>${tr('rp_from')}<input id="rep-from" type="date" value="${rhEsc(from)}" oninput="reportPeriodDirty()"></label><label>${tr('rp_to')}<input id="rep-to" type="date" value="${rhEsc(to)}" oninput="reportPeriodDirty()"></label><button class="btn primary" type="button" onclick="periodReport()">${rh('عرض التقارير','Show reports')} ↗</button></div>
 <div id="rh-status" class="rh-status" role="status" aria-live="polite">${rh('جاري تجهيز التقرير…','Preparing your report…')}</div></section>
 <div id="rh-results" hidden><div id="rh-range" class="rh-range"></div><div class="rh-tabs" role="tablist" aria-label="${rh('أقسام التقارير','Report sections')}">${tabs.map(([key,label])=>`<button type="button" role="tab" id="rh-tab-${key}" data-rh-button="${key}" aria-controls="rh-section-${key}" aria-selected="false" onclick="selectReportTab('${key}')">${label}</button>`).join('')}</div>
 <div id="rh-section-overview" role="tabpanel" aria-labelledby="rh-tab-overview" data-rh-section="overview"><div id="period-result"></div></div>
 <div id="rh-section-sales" role="tabpanel" aria-labelledby="rh-tab-sales" data-rh-section="sales" hidden><div id="rh-sales"></div></div>
 <div id="rh-section-comparison" role="tabpanel" aria-labelledby="rh-tab-comparison" data-rh-section="comparison" hidden><div id="rh-comparison"></div></div>
 <div id="rh-section-cost" role="tabpanel" aria-labelledby="rh-tab-cost" data-rh-section="cost" hidden><section class="card rh-panel"><div id="cost-detail-result"></div></section></div>
 <div id="rh-section-cash" role="tabpanel" aria-labelledby="rh-tab-cash" data-rh-section="cash" hidden><div id="rh-cash"></div></div>
 <div id="rh-section-operations" role="tabpanel" aria-labelledby="rh-tab-operations" data-rh-section="operations" hidden><div id="rh-operations"></div></div></div>`;
}
function selectReportTab(tab){
 if(!['overview','sales','comparison','cost','cash','operations'].includes(tab))return;RH.tab=tab;
 document.querySelectorAll('[data-rh-section]').forEach(x=>{x.hidden=x.dataset.rhSection!==tab});
 document.querySelectorAll('[data-rh-button]').forEach(x=>x.setAttribute('aria-selected',String(x.dataset.rhButton===tab)));
}
function reportPeriodDirty(){
 RH.sequence++;const button=document.querySelector('button[onclick="periodReport()"]');if(button)button.disabled=false;
 const status=$('rh-status');if(status)status.textContent=rh('الفترة تغيّرت؛ اضغطي عرض التقارير لتحديث الأرقام.','The period has changed; select Show reports to update the figures.');
}
function reportPreset(which){
 const today=rhToday(),year=Number(today.slice(0,4)),month=Number(today.slice(5,7));
 let from=today.slice(0,7)+'-01';
 if(which==='quarter')from=new Date(Date.UTC(year,month-3,1)).toISOString().slice(0,10);
 if(which==='year')from=year+'-01-01';
 $('rep-from').value=from;$('rep-to').value=today;periodReport();
}
function rhOverview(data){
 const s=data.summary,e=data.cost_detail.excluded;
 const cards=[
  rhMetric(rh('مبيعات الطلبات','Order sales'),rhMoney(s.sales),rhNum(s.orders)+' '+rh('طلب محتسب','eligible orders'),'accent'),
  rhMetric(rh('تكلفة الطلبات','Recorded order costs'),rhMoney(s.cost),rh('من البنود المسجلة فقط','Recorded entries only')),
  rhMetric(rh('الفرق قبل المصاريف العامة','Difference before overhead'),rhMoney(s.before_expenses),rh('المبيعات − تكلفة الطلبات','Sales − order costs')),
  rhMetric(rh('المصاريف العامة للفترة','Period overhead'),rhMoney(s.expenses),rh('حسب تاريخ المصروف','By expense date')),
  rhMetric(rh('صافي الربح التقديري بعد المصروفات','Estimated net profit after overhead'),rhMoney(s.net_difference),rh('مؤشر تقديري وليس ربحًا محاسبيًا نهائيًا','Estimate, not final accounting profit'),'gold'),
  rhMetric(rh('صافي مقبوضات الفترة','Net receipts in period'),rhMoney(s.collected_in_period),rh('الدفعات ناقص المرتجعات الفعلية','Payments minus actual refunds')),
  rhMetric(rh('مستحق طلبات الفترة الآن','Currently due on period orders'),rhMoney(s.outstanding_for_period_orders),rh('بعد كل الدفعات المسجلة حتى الآن','After all payments recorded to date')),
  rhMetric(rh('مدفوع زيادة','Overpaid'),rhMoney(s.overpaid_for_period_orders),rh('لا يُخصم من مستحق طلبات أخرى','Not offset against other orders')),
 ].join('');
 const note=rh('المبيعات والتكلفة حسب تاريخ إنشاء الطلب وحالته الحالية. مبالغ الطلب الملغي مستبعدة وسجله محفوظ داخله؛ المصروفات العامة غير المرتبطة بطلب تحتاج مراجعة منفصلة. صافي المقبوضات = دفعات غير الملغي − المرتجعات الفعلية المسجلة في الفترة؛ يشمل غير المسعّر وليس رصيد الخزنة الفعلي.','Sales and costs use order creation date and current status. Cancelled-order amounts are excluded and their history is retained; overhead expenses not linked to an order require separate review. Net receipts equal non-cancelled payments minus actual refunds in the period; unpriced orders are included. This is not actual cash on hand.');
 const excluded=(e.cancelled.orders||e.unpriced.orders)?`<div class="rh-note warn"><b>${rh('مستبعد من المبيعات والتكلفة:','Excluded from sales and costs:')}</b> ${rhNum(e.cancelled.orders)} ${rh('طلب ملغي','cancelled orders')} · ${rhNum(e.unpriced.orders)} ${rh('بانتظار التسعير بتكلفة مسجلة','awaiting pricing, recorded costs')} ${rhMoney(e.unpriced.recorded_cost)}. ${rh('لا تسجلي المصروف مرتين.','Do not enter the same expense twice.')}</div>`:'';
 const exp=data.sales.expense_categories.length?data.sales.expense_categories.map(x=>`<tr><td>${rhEsc(x.name)}</td><td>${rhMoney(x.amount)}</td></tr>`):[];
 return `<div class="rh-metrics">${cards}</div><div class="rh-note">${note} ${rh('الشحن المحصّل داخل المبيعات؛ تكلفة التوصيل الفعلية تحتاج تسجيلًا. لا تُحسب المرتجعات تلقائيًا.','Customer shipping is included in sales; actual delivery cost must be recorded. Refunds are not automatic.')}</div>${excluded}`+
  rhPanel(rh('المصاريف العامة','Overhead by category'),rh('مصروفات الفترة حسب تاريخ المصروف؛ لا تعيدي إدخال مصروف سُجل بالفعل ضمن تكلفة طلب.','Period expenses by expense date; do not enter an expense twice if it is already in an order cost.'),rhTable([rh('الفئة','Category'),rh('المبلغ','Amount')],exp));
}
function rhSales(data){
 const d=data.sales;
 const designBars=rhBarRows(d.designs,x=>rhEsc(x.name)+(x.style_id?` <small>${rhEsc(x.style_id)}</small>`:''),x=>x.sales_before_adjustments,x=>`${rhNum(x.quantity)} ${rh('قطعة','pieces')} · ${rhMoney(x.sales_before_adjustments)}`);
 const colourBars=rhBarRows(d.colours,x=>rhEsc(x.name),x=>x.quantity,x=>rhNum(x.quantity)+' '+rh('قطعة','pieces'));
 const channelRows=d.channels.map(c=>`<tr><td>${rhEsc(c.channel||'—')}</td><td>${rhNum(c.orders)}</td><td>${rhMoney(c.sales)}</td></tr>`);
 const monthRows=d.months.map(m=>`<tr><td dir="ltr">${rhEsc(m.month)}</td><td>${rhNum(m.orders)}</td><td>${rhMoney(m.sales)}</td><td>${rhMoney(m.cost)}</td><td>${rhMoney(m.expenses)}</td><td>${rhMoney(m.net_difference)}</td><td>${rhMoney(m.collected)}</td></tr>`);
 const orderRows=d.orders.map(o=>`<tr><td>${rhOpenOrder(o.code)}</td><td>${rhEsc(o.customer||'—')}</td><td dir="ltr">${rhEsc(rhBusinessDay(o.created_at))}</td><td>${rhStatus(o.status)}</td><td>${rhMoney(o.sales)}</td><td>${rhMoney(o.cost)}</td><td class="${o.profit<0?'rh-negative':''}">${rhMoney(o.profit)}</td><td>${rhNum(o.margin)}%</td></tr>`);
 return `<div class="rh-two">${rhPanel(rh('مبيعات الموديلات','Sales by design'),rh('بيع القطع قبل خصم الطلب وشحن العميلة. لا نوزّع تكلفة الطلب المشتركة أو نخترع ربحًا للموديل.','Item sales before order discount and customer shipping. Shared costs and profit are not allocated to designs.'),designBars)}${rhPanel(rh('الألوان الأكثر طلبًا','Most requested colours'),rh('عدد قطع الطلبات المحتسبة في الفترة.','Pieces on eligible orders in the period.'),colourBars)}</div>`+
  rhPanel(rh('المبيعات حسب القناة','Sales by channel'),rh('إجمالي الطلب بعد الخصم وشحن العميلة.','Order total after discount and customer shipping.'),rhTable([rh('القناة','Channel'),rh('الطلبات','Orders'),rh('المبيعات','Sales')],channelRows))+
  rhPanel(rh('مقارنة شهرية','Monthly comparison'),rh('الطلبات حسب تاريخ الإنشاء؛ الدفعات والمرتجعات والمصاريف حسب تاريخ كل حركة. الطلبات الملغاة مستبعدة. هذا ليس رصيد الخزنة.','Orders use creation date; payments, refunds and overhead use their own dates. Cancelled orders are excluded. This is not cash on hand.'),rhTable([rh('الشهر','Month'),rh('الطلبات','Orders'),rh('المبيعات','Sales'),rh('التكلفة','Costs'),rh('المصاريف','Overhead'),rh('الفرق بعدها','Difference'),rh('صافي المقبوضات','Net receipts')],monthRows))+
  rhPanel(rh('ربحية كل طلب','Order-level profitability'),rh('الفرق والهامش قبل المصاريف العامة وبحسب التكاليف المسجلة فقط. افتحي تقرير التكلفة لمراجعة البنود.','Difference and margin are before overhead and use recorded costs only. Open Costs for entry details.'),rhTable([rh('الطلب','Order'),rh('العميلة','Customer'),rh('تاريخ الإنشاء','Created'),rh('الحالة','Status'),rh('البيع','Sales'),rh('التكلفة','Cost'),rh('الفرق','Difference'),rh('الهامش','Margin')],orderRows));
}
function rhComparison(data){
 const w=data.workshops,f=data.fabrics;
 const workshops=w.rows.map(x=>`<tr><td><b>${rhEsc(x.name||rh('ورشة سابقة','Previous workshop'))}</b>${x.missing_reference?` <small class="rh-muted">${rh('مرجع قديم','old reference')}</small>`:''}</td><td>${rhNum(x.orders)}</td><td>${rhNum(x.entries)}</td><td>${rhNum(x.quantity)}</td><td>${rhMoney(x.cost)}</td><td>${x.average_per_piece===null?'—':rhMoney(x.average_per_piece)}</td></tr>`);
 const fabric=f.rows.map(x=>`<tr><td><b>${rhEsc(x.name||rh('مشتريات بلا اسم (مجمعة)','Unnamed purchases (combined)'))}</b><small class="rh-muted"> ${x.state==='name_only'?rh('تجميع بالاسم','grouped by name'):x.state==='missing'?rh('مرجع قديم','old reference'):x.state==='unnamed'?rh('خامات قد تكون مختلفة','may be different fabrics'):''}</small></td><td>${rhNum(x.purchases)}</td><td>${rhNum(x.orders)}</td><td>${rhNum(x.metres)}</td><td>${rhMoney(x.material)}</td><td>${rhMoney(x.shipping)}</td><td>${rhMoney(x.total)}</td><td>${x.average_per_metre===null?'—':rhMoney(x.average_per_metre)}</td><td>${x.min_per_metre===null?'—':rhMoney(x.min_per_metre)+' – '+rhMoney(x.max_per_metre)}</td></tr>`);
 return `<div class="rh-metrics rh-compact">${rhMetric(rh('تكاليف الورش الجديدة','New workshop costs'),rhMoney(w.total))}${rhMetric(rh('مشتريات خامات جديدة','New fabric purchases'),rhMoney(f.total))}${rhMetric(rh('أمتار مشتراة','Metres purchased'),rhNum(f.metres))}</div>`+
  rhPanel(rh('مقارنة الورش','Workshop comparison'),rh('مجموع قطع البنود قد يكرر القطعة إذا كان لها أكثر من عملية. المتوسط = إجمالي البنود ÷ مجموع قطعها. التفصيل القديم المصنّف','Piece counts sum the entries and may repeat an item with multiple operations. Average = entry total ÷ summed pieces. Classified previous tailoring')+`: ${rhMoney(w.classified_legacy)} — `+rh('لا يُوزّع على الورش هنا.','is not allocated to workshops here.'),rhTable([rh('الورشة','Workshop'),rh('طلبات','Orders'),rh('بنود','Entries'),rh('قطع البنود','Entry pieces'),rh('التكلفة','Cost'),rh('متوسط القطعة','Average / piece')],workshops))+
  rhPanel(rh('مقارنة مشتريات الخامات','Fabric purchase comparison'),rh('متوسط المتر موزون بالأمتار ويشمل شحن المتر؛ النطاق أقل وأعلى سعر شامل الشحن في بند شراء. التجميع بالاسم تقريبي، والبنود بلا اسم قد تكون خامات مختلفة. الخامة السابقة المصنّفة','Weighted average per metre includes shipping; range is the lowest and highest purchase rate including shipping. Name grouping is approximate; unnamed purchases may be different fabrics. Classified previous fabric')+`: ${rhMoney(f.classified_legacy)} — `+rh('غير موزعة على المشتريات الجديدة.','is not allocated to new purchases.'),rhTable([rh('الخامة','Fabric'),rh('مشتريات','Purchases'),rh('طلبات','Orders'),rh('أمتار','Metres'),rh('الخامة','Material'),rh('شحن المتر','Shipping'),rh('الإجمالي','Total'),rh('متوسط المتر','Avg / metre'),rh('نطاق المتر','Range / metre')],fabric));
}
function rhCash(data){
 const p=data.payments,b=data.balances,d=data.deposits;
 const pay=p.rows.map(x=>`<tr><td dir="ltr">${rhEsc(x.business_day)}</td><td>${rhOpenOrder(x.code)}</td><td>${rhEsc(x.customer||'—')}</td><td>${rhEsc(rhPaymentMethod(x.method))}</td><td>${rhMoney(x.amount)}${x.corrected?`<br><small>${rh('مبلغ مصحّح','Corrected amount')}</small>`:''}</td><td>${rhEsc(x.note||'—')}</td><td>${rhStatus(x.status)}${x.unpriced?` · ${rh('قيد التسعير','Pricing pending')}`:''}</td></tr>`);
 const refundRows=(p.refunds||[]).map(x=>`<tr><td dir="ltr">${rhEsc(x.business_day)}</td><td>${rhOpenOrder(x.code)}</td><td>${rhEsc(x.customer||'—')}</td><td>${rhEsc(rhPaymentMethod(x.method))}</td><td>${rhMoney(x.amount)}</td><td>${rhEsc(x.note||'—')}</td></tr>`);
 const due=b.rows.map(x=>`<tr><td>${rhOpenOrder(x.code)}</td><td>${rhEsc(x.customer||'—')}</td><td>${rhStatus(x.status)}</td><td>${rhMoney(x.total)}</td><td>${rhMoney(x.paid)}</td><td>${rhMoney(x.due)}</td></tr>`);
 const over=b.overpaid_rows.map(x=>`<tr><td>${rhOpenOrder(x.code)}</td><td>${rhEsc(x.customer||'—')}</td><td>${rhMoney(x.total)}</td><td>${rhMoney(x.paid)}</td><td>${rhMoney(x.overpaid)}</td></tr>`);
 const pending=(d.all_rows||d.rows).map(x=>`<tr><td>${x.kind==='order'?rh('طلب','Order'):rh('تصميم خاص','Custom design')}</td><td>${x.kind==='order'?rhOpenOrder(x.code):`<button type="button" class="rh-link" data-id="${Number(x.id)}" onclick="maviOpenCustomAdmin(Number(this.dataset.id))">#${Number(x.id)}</button>`}</td><td>${rhEsc(x.customer||'—')}</td><td dir="ltr">${rhEsc(rhBusinessDay(x.created_at))}</td><td>${x.amount===null?'—':rhMoney(x.amount)}</td><td>${rhDepositStatus(x.status)}</td><td>${x.has_receipt?rhEsc(receiptSourceLabel(x.receipt_source)):'—'}</td></tr>`);
 const methods=p.methods.map(x=>rhMetric(rhEsc(rhPaymentMethod(x.method)),rhMoney(x.amount),rhNum(x.count)+' '+rh('دفعة','payments'))).join('');
 const counts=[['receipt_pending',rh('إيصالات للمراجعة','Receipts to review')],['quoted',rh('بانتظار الإيصال','Awaiting receipt')],['receipt_rejected',rh('تحتاج إيصالًا جديدًا','New receipt needed')],['needs_quote',rh('تنتظر عرض العربون','Awaiting quote')]].map(([key,label])=>rhMetric(label,rhNum((d.all_counts||d.counts)[key]))).join('');
 return rhPanel(rh('الدفعات خلال الفترة','Payments during the period'),rh('حسب تاريخ الدفعة للطلبات غير الملغاة، حتى إن كان الطلب أقدم أو غير مسعّر. تصحيح إدخال خاطئ يحدّث مبلغ الدفعة في تاريخها الأصلي؛ تفاصيله في سجل الأوردر.','By payment date for non-cancelled orders, including older or unpriced orders. A clerical correction updates the original payment date; its history is in the order.'),`<div class="rh-metrics rh-compact">${rhMetric(rh('إجمالي الدفعات','Gross payments'),rhMoney(data.summary.gross_collected_in_period))}${rhMetric(rh('المرتجعات المسجلة','Recorded refunds'),rhMoney(data.summary.refunded_in_period))}${rhMetric(rh('صافي المقبوضات','Net receipts'),rhMoney(data.summary.collected_in_period))}</div>${methods?`<div class="rh-metrics rh-compact">${methods}</div>`:''}${rhTable([rh('تاريخ الدفعة','Payment date'),rh('الطلب','Order'),rh('العميلة','Customer'),rh('الطريقة','Method'),rh('المبلغ','Amount'),rh('ملاحظة','Note'),rh('حالة الطلب الآن','Current order status')],pay)}`)+
  rhPanel(rh('مرتجعات فعلية خلال الفترة','Actual refunds in the period'),rh('ما سُجّل أنه رُد فعلًا للطلبات غير الملغاة. المرتجع لا ينفذ تحويلًا آليًا.','Money recorded as actually returned for non-cancelled orders. Recording a refund does not send money.'),rhTable([rh('تاريخ الرد','Refund date'),rh('الطلب','Order'),rh('العميلة','Customer'),rh('الطريقة','Method'),rh('المبلغ','Amount'),rh('ملاحظة','Note')],refundRows))+
  rhPanel(rh('المستحق على طلبات الفترة','Amount currently due on period orders'),rh('الطلبات المنشأة في الفترة والمحتسبة ماليًا، بعد كل الدفعات المسجلة حتى الآن وليس دفعات الفترة فقط.','Eligible orders created in the period, after all payments recorded to date, not only payments in the period.'),rhTable([rh('الطلب','Order'),rh('العميلة','Customer'),rh('الحالة','Status'),rh('إجمالي الطلب','Order total'),rh('مدفوع حتى الآن','Paid to date'),rh('المستحق','Due')],due))+
  (over.length?rhPanel(rh('طلبات بها مبلغ مدفوع زيادة','Overpaid orders'),rh('تظهر منفصلة ولا تُخصم من مستحقات طلبات أخرى.','Shown separately and not offset against other orders.'),rhTable([rh('الطلب','Order'),rh('العميلة','Customer'),rh('الإجمالي','Total'),rh('المدفوع','Paid'),rh('الزيادة','Overpaid')],over)):'')+
  rhPanel(rh('متابعة العربون حاليًا — كل الفترات','Current deposit follow-up — all dates'),rh('قائمة المتابعة تشمل الطلبات وطلبات التصميم المفتوحة من كل الفترات، ولا تتقيد بالفترة المختارة. الملغي والمسلَّم مستبعدان. رفع الصورة وحده لا يؤكد الدفع.','Follow-up includes open orders and custom requests from all dates, not only the selected period. Cancelled and delivered orders are excluded. Uploading an image alone does not confirm payment.'),`<div class="rh-metrics rh-compact">${counts}</div><p class="rh-muted">${rh('للمقارنة داخل الفترة المختارة فقط: عربون مؤكد للطلبات','Within the selected period only: confirmed order deposits')}: ${rhNum(d.confirmed_order_deposits)} · ${rh('طلبات تصميم خاص مؤكدة','confirmed custom requests')}: ${rhNum(d.confirmed_custom_requests)}. ${rh('حسب تاريخ إنشاء الطلب أو طلب التصميم، وليس تاريخ التأكيد.','Based on creation date, not confirmation date.')}</p>${rhTable([rh('النوع','Type'),rh('الرقم','Reference'),rh('العميلة','Customer'),rh('تاريخ الإنشاء','Created'),rh('العربون المطلوب','Deposit requested'),rh('الحالة','Status'),rh('مصدر الإيصال','Receipt source')],pending)}`);
}
function rhOperations(data){
 const o=data.operations;
 const statuses=o.statuses.map(x=>rhMetric(rhStatus(x.status),rhNum(x.count))).join('');
 const late=(o.all_late||o.late).map(x=>`<tr><td>${rhOpenOrder(x.code)}</td><td>${rhEsc(x.customer||'—')}</td><td dir="ltr">${rhEsc(x.promise_date)}</td><td>${rhStatus(x.status)}</td><td>${x.deposit_status?rhDepositStatus(x.deposit_status):'—'}</td><td>${x.unpriced?rh('قيد التسعير','Pricing pending'):'—'}</td></tr>`);
 return rhPanel(rh('مراحل الإنتاج لطلبات الفترة','Production stages for period orders'),rh('كل الطلبات المنشأة في الفترة حسب حالتها الحالية، بما فيها الملغي وغير المسعّر.','All orders created in the period by current status, including cancelled and unpriced.'),`<div class="rh-metrics rh-compact">${statuses||rhEmpty()}</div><div class="rh-note">${rh('طلبات الفترة المفتوحة بلا موعد تسليم صالح','Open period orders without a valid promise date')}: <b>${rhNum(o.active_without_promise_date)}</b> · ${rh('إجمالي طلبات الفترة','Total period orders')}: <b>${rhNum(o.total_orders)}</b></div>`)+
  rhPanel(rh('الطلبات المتأخرة حاليًا — كل الفترات','Currently late orders — all dates'),rh('تشمل كل الطلبات المفتوحة التي تجاوزت موعد التسليم حتى اليوم بتوقيت القاهرة، حتى لو أُنشئت قبل الفترة المختارة. هذا الجدول لا يتقيد بفترة التقرير.','All open orders past their promise date as of today in Cairo, including orders created before the selected period. This table is not limited to the report period.')+` (${rhEsc(data.today)}).`,`<div class="rh-metrics rh-compact">${rhMetric(rh('طلبات مفتوحة حاليًا','Currently open'),rhNum(o.all_open))}${rhMetric(rh('متأخرة حاليًا','Currently late'),rhNum(late.length))}${rhMetric(rh('مفتوحة بلا موعد صالح','Open without valid date'),rhNum(o.all_active_without_promise_date))}</div>${rhTable([rh('الطلب','Order'),rh('العميلة','Customer'),rh('موعد التسليم','Promise date'),rh('المرحلة','Stage'),rh('العربون','Deposit'),rh('ملاحظة','Note')],late)}`);
}
async function runReportHub(){
 const from=$('rep-from')?.value,to=$('rep-to')?.value,holder=$('rh-results'),status=$('rh-status');
 if(!holder||!status)return;
 const seq=++RH.sequence,button=document.querySelector('button[onclick="periodReport()"]');
 if(!from||!to||from>to){status.textContent=rh('اختاري تاريخ بداية ونهاية صحيحين.','Choose a valid start and end date.');return;}
 status.textContent=rh('جاري تجهيز التقرير…','Preparing your report…');if(button)button.disabled=true;
 try{
  const data=await api(`/money/report-hub?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  if(seq!==RH.sequence||VIEW!=='rep'||!holder.isConnected)return;
  RH.from=from;RH.to=to;
  $('rh-range').innerHTML=`<span>◷ ${rh('الفترة المعروضة','Showing period')}: <b dir="ltr">${rhEsc(from)} — ${rhEsc(to)}</b></span><span>${rh('توقيت القاهرة','Cairo time')}</span>`;
  $('period-result').innerHTML=rhOverview(data);$('rh-sales').innerHTML=rhSales(data);$('rh-comparison').innerHTML=rhComparison(data);
  $('rh-cash').innerHTML=rhCash(data);$('rh-operations').innerHTML=rhOperations(data);
  await detailedCostReport(from,to,data.cost_detail);
  if(seq!==RH.sequence||VIEW!=='rep'||!holder.isConnected)return;
  holder.hidden=false;selectReportTab(RH.tab);status.textContent=rh('تم تحديث التقرير.','Report updated.');
 }catch(e){if(seq===RH.sequence&&status.isConnected){status.textContent=e.message||rh('تعذر تحميل التقرير.','Could not load the report.');}}
 finally{if(seq===RH.sequence&&button?.isConnected)button.disabled=false;}
}
