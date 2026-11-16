'use strict';
// Owner-only report centre. Order-level costs are never allocated to a model.
// The complete result is collected in one read transaction for a coherent view.
const {db,get,all}=require('./db');
const D=require('./domain');
const {cairoDate,validDate}=require('./business-date');
const {costDetail}=require('./order-costs');

function reportHub(from,to){
 return db.transaction(()=>{
  const today=cairoDate(new Date().toISOString());
  const costs=costDetail(from,to);
  const orders=all(`SELECT o.id,o.code,o.customer_id,o.channel,o.status,o.created_at,o.promise_date,
                           COALESCE(o.contact_name,c.name) AS customer_name,COALESCE(o.contact_phone,c.phone) AS customer_phone,
                           EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending') AS unpriced,
                           d.status AS deposit_status,d.percent AS deposit_percent,d.payment_method,d.receipt_source,
                           (d.receipt IS NOT NULL) AS has_receipt
                    FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
                    LEFT JOIN order_deposits d ON d.order_id=o.id
                    WHERE mavi_cairo_date(o.created_at) BETWEEN ? AND ? ORDER BY o.id DESC`,from,to);
  const salesByDesign=new Map(),colours=new Map(),channels=new Map(),months=new Map(),statuses=new Map(),dues=[],overpaidRows=[],orderSales=[],late=[],deposits=[];
  const monthRow=key=>{if(!months.has(key))months.set(key,{month:key,orders:0,sales:0,cost:0,expenses:0,collected:0,gross_collected:0,refunded:0});return months.get(key)};
  let outstanding=0,overpaid=0,unpriced=0,cancelled=0,eligibleCount=0,activeWithoutDate=0,confirmedOrderDeposits=0;
  const countStatus=(key)=>statuses.set(key,(statuses.get(key)||0)+1);
  for(const o of orders){
   countStatus(o.status);
   if(o.unpriced&&o.status!=='cancelled')unpriced++;
   if(o.status==='cancelled')cancelled++;
   const active=!['cancelled','delivered'].includes(o.status);
   if(o.status!=='cancelled'&&o.deposit_status==='approved')confirmedOrderDeposits++;
   if(active){
    if(!validDate(o.promise_date))activeWithoutDate++;
    else if(o.promise_date<today)late.push({code:o.code,customer:o.customer_name||'',promise_date:o.promise_date,status:o.status,deposit_status:o.deposit_status,unpriced:!!o.unpriced});
   }
   const total=D.orderTotals(o.id);
   if(o.deposit_status&&active&&o.deposit_status!=='approved'){
    const pct=Number(o.deposit_percent);
    deposits.push({kind:'order',code:o.code,customer:o.customer_name||'',status:o.deposit_status,created_at:o.created_at,
      amount:!o.unpriced&&o.deposit_percent!==null&&Number.isFinite(pct)&&pct>0?Math.round(total.total*pct)/100:null,
      has_receipt:!!o.has_receipt,receipt_source:o.receipt_source});
   }
   if(o.status==='cancelled'||o.unpriced)continue;
   eligibleCount++;
   const m=monthRow(cairoDate(o.created_at).slice(0,7));m.orders++;m.sales+=total.total;m.cost+=total.cost;
   const c=channels.get(o.channel)||{channel:o.channel,orders:0,sales:0};c.orders++;c.sales+=total.total;channels.set(o.channel,c);
   outstanding+=Math.max(0,total.due);overpaid+=Math.max(0,-total.due);
   if(total.due>0)dues.push({code:o.code,customer:o.customer_name||'',phone:o.customer_phone||'',created_at:o.created_at,status:o.status,total:total.total,paid:total.paid,due:total.due});
   else if(total.due<0)overpaidRows.push({code:o.code,customer:o.customer_name||'',created_at:o.created_at,status:o.status,total:total.total,paid:total.paid,overpaid:-total.due});
   orderSales.push({code:o.code,customer:o.customer_name||'',created_at:o.created_at,status:o.status,sales:total.total,cost:total.cost,profit:total.profit,margin:total.margin});
   const items=all(`SELECT i.style_id,i.qty,i.unit_price,i.colour,COALESCE(NULLIF(i.description,''),NULLIF(s.name,''),i.style_id,'تصميم غير معروف') AS name
                    FROM order_items i LEFT JOIN styles s ON s.id=i.style_id WHERE i.order_id=?`,o.id);
   for(const item of items){
    const key=JSON.stringify([item.style_id,item.name]),r=salesByDesign.get(key)||{style_id:item.style_id,name:item.name,quantity:0,sales_before_adjustments:0};
    r.quantity+=item.qty;r.sales_before_adjustments+=item.qty*item.unit_price;salesByDesign.set(key,r);
    if(item.colour)colours.set(item.colour,(colours.get(item.colour)||0)+item.qty);
   }
  }
  // All cancelled-order cash movements are excluded from financial reports.
  // Refunds are actual returned amounts, dated separately from original receipt.
  const payments=all(`SELECT p.id,p.amount,p.method,p.note,p.created_at,mavi_cairo_date(p.created_at) AS business_day,
                             o.code,o.status,COALESCE(o.contact_name,c.name) AS customer,
                             EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending') AS unpriced
                      FROM payments p JOIN orders o ON o.id=p.order_id LEFT JOIN customers c ON c.id=o.customer_id
                      WHERE o.status!='cancelled' AND mavi_cairo_date(p.created_at) BETWEEN ? AND ? ORDER BY p.created_at DESC,p.id DESC`,from,to);
  const refunds=all(`SELECT r.id,r.amount,r.method,r.note,r.refunded_on AS business_day,o.code,o.status,
                            COALESCE(o.contact_name,c.name) AS customer
                     FROM order_refunds r JOIN orders o ON o.id=r.order_id LEFT JOIN customers c ON c.id=o.customer_id
                     WHERE o.status!='cancelled' AND r.voided_at IS NULL AND r.refunded_on BETWEEN ? AND ? ORDER BY r.refunded_on DESC,r.id DESC`,from,to);
  const paymentMethods=new Map();
  for(const payment of payments){
   const month=monthRow(payment.business_day.slice(0,7));month.collected+=payment.amount;month.gross_collected+=payment.amount;
   const row=paymentMethods.get(payment.method)||{method:payment.method,count:0,amount:0};
   row.count++;row.amount+=payment.amount;paymentMethods.set(payment.method,row);
  }
  for(const refund of refunds){const month=monthRow(refund.business_day.slice(0,7));month.collected-=refund.amount;month.refunded+=refund.amount;}
  const expenseByCategory=new Map();let expenses=0;
  for(const e of all('SELECT category,amount,date(spent_on) AS business_day FROM expenses WHERE date(spent_on) BETWEEN ? AND ?',from,to)){
   expenses+=e.amount;monthRow(e.business_day.slice(0,7)).expenses+=e.amount;
   expenseByCategory.set(e.category,(expenseByCategory.get(e.category)||0)+e.amount);
  }
  let collected=0,grossCollected=0,refunded=0;for(const m of months.values()){collected+=m.collected;grossCollected+=m.gross_collected;refunded+=m.refunded;}
  const workshops=new Map();
  for(const o of costs.rows)for(const w of o.workshops){
   // Missing references cannot safely be grouped by a shared name alone.
   const key=w.tailor_id?'id:'+w.tailor_id:'unlinked:'+w.id;
   const x=workshops.get(key)||{id:w.tailor_id,name:w.current_tailor_name||w.tailor_name,missing_reference:!w.tailor_id||!w.current_tailor_name,quantity:0,cost:0,orders:new Set(),legacy_entries:0,entries:0};
   x.quantity+=w.quantity;x.cost+=w.quantity*w.unit_cost;x.entries++;if(w.legacy_quantity)x.legacy_entries++;
   x.orders.add(o.code);workshops.set(key,x);
  }
  const workshopRows=[...workshops.values()].map(w=>({id:w.id,name:w.name,missing_reference:w.missing_reference,quantity:w.quantity,cost:w.cost,orders:w.orders.size,entries:w.entries,legacy_entries:w.legacy_entries,average_per_piece:w.quantity?w.cost/w.quantity:null})).sort((a,b)=>b.cost-a.cost||String(a.name).localeCompare(String(b.name)));
  // A catalogue reference is stable; named, unlinked purchases are grouped by
  // their recorded name, which is only a helpful approximation. Never assign
  // the unknown historical per-item fabric costs to these new purchases.
  const fabricNames=new Map(all('SELECT id,name FROM fabric').map(f=>[f.id,f.name]));
  const fabricGroups=new Map();
  for(const o of costs.rows)for(const p of o.purchases){
   const name=String(p.fabric_name||'').trim(),key=p.fabric_id?'id:'+p.fabric_id:name?'name:'+name.toLocaleLowerCase('ar'):'unnamed';
   const existingName=p.fabric_id?fabricNames.get(p.fabric_id):null;
   const state=p.fabric_id?(fabricNames.has(p.fabric_id)?'linked':'missing'):name?'name_only':'unnamed';
   const x=fabricGroups.get(key)||{id:p.fabric_id||null,name:existingName||name||'',state,metres:0,material:0,shipping:0,orders:new Set(),purchases:0,min_per_metre:null,max_per_metre:null};
   const metreRate=p.price_per_metre+p.shipping_per_metre;
   x.metres+=p.metres;x.material+=p.metres*p.price_per_metre;x.shipping+=p.metres*p.shipping_per_metre;
   x.purchases++;x.orders.add(o.code);x.min_per_metre=x.min_per_metre===null?metreRate:Math.min(x.min_per_metre,metreRate);x.max_per_metre=x.max_per_metre===null?metreRate:Math.max(x.max_per_metre,metreRate);
   fabricGroups.set(key,x);
  }
  const fabricRows=[...fabricGroups.values()].map(f=>({id:f.id,name:f.name,state:f.state,metres:f.metres,material:f.material,shipping:f.shipping,total:f.material+f.shipping,orders:f.orders.size,purchases:f.purchases,average_per_metre:f.metres?(f.material+f.shipping)/f.metres:null,min_per_metre:f.min_per_metre,max_per_metre:f.max_per_metre})).sort((a,b)=>b.total-a.total||String(a.name).localeCompare(String(b.name)));
  const pendingCustom=all(`SELECT cr.id,cr.customer_id,cr.status,cr.price,cr.deposit_percent,cr.shipping_fee,cr.created_at,cr.receipt_source,
                                  (cr.receipt IS NOT NULL) AS has_receipt,c.name AS customer_name
                           FROM custom_requests cr LEFT JOIN customers c ON c.id=cr.customer_id
                           WHERE cr.status IN ('review','quoted','receipt_pending','receipt_rejected')
                             AND NOT EXISTS(SELECT 1 FROM custom_order_links l WHERE l.request_id=cr.id)
                             AND mavi_cairo_date(cr.created_at) BETWEEN ? AND ? ORDER BY cr.id DESC`,from,to);
  for(const x of pendingCustom){
   const pct=Number(x.deposit_percent),price=Number(x.price);
   deposits.push({kind:'custom',id:x.id,customer:x.customer_name||'',status:x.status==='review'?'needs_quote':x.status,
     created_at:x.created_at,amount:x.price!==null&&x.deposit_percent!==null&&Number.isFinite(price)&&Number.isFinite(pct)&&pct>0?Math.round((price+Number(x.shipping_fee||0))*pct)/100:null,
     has_receipt:!!x.has_receipt,receipt_source:x.receipt_source});
  }
  // Late work should never disappear just because it was created before the
  // selected sales period. Keep both the period view and an explicitly labelled
  // all-time, currently-open list for operations follow-up.
  const outsideOpen=all(`SELECT o.code,o.status,o.promise_date,COALESCE(o.contact_name,c.name) AS customer_name,d.status AS deposit_status,
                              EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending') AS unpriced
                       FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
                       LEFT JOIN order_deposits d ON d.order_id=o.id
                       WHERE o.status NOT IN ('cancelled','delivered') AND
                         (mavi_cairo_date(o.created_at) IS NULL OR mavi_cairo_date(o.created_at) NOT BETWEEN ? AND ?)`,from,to);
  const allLate=[...late];let allWithoutDate=activeWithoutDate;
  for(const o of outsideOpen){
   if(!validDate(o.promise_date))allWithoutDate++;
   else if(o.promise_date<today)allLate.push({code:o.code,customer:o.customer_name||'',promise_date:o.promise_date,status:o.status,deposit_status:o.deposit_status,unpriced:!!o.unpriced});
  }
  allLate.sort((a,b)=>String(a.promise_date).localeCompare(String(b.promise_date))||String(a.code).localeCompare(String(b.code)));
  const allOpen=orders.filter(o=>!['cancelled','delivered'].includes(o.status)).length+outsideOpen.length;
  const outsideDeposits=[];
  for(const o of all(`SELECT o.id,o.code,o.created_at,COALESCE(o.contact_name,c.name) AS customer_name,d.status,d.percent,d.receipt_source,(d.receipt IS NOT NULL) AS has_receipt,
                             EXISTS(SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending') AS unpriced
                      FROM orders o JOIN order_deposits d ON d.order_id=o.id LEFT JOIN customers c ON c.id=o.customer_id
                      WHERE o.status NOT IN ('cancelled','delivered') AND d.status!='approved' AND
                        (mavi_cairo_date(o.created_at) IS NULL OR mavi_cairo_date(o.created_at) NOT BETWEEN ? AND ?)`,from,to)){
   const pct=Number(o.percent),total=D.orderTotals(o.id).total;
   outsideDeposits.push({kind:'order',code:o.code,customer:o.customer_name||'',status:o.status,created_at:o.created_at,
    amount:!o.unpriced&&o.percent!==null&&Number.isFinite(pct)&&pct>0?Math.round(total*pct)/100:null,
    has_receipt:!!o.has_receipt,receipt_source:o.receipt_source});
  }
  for(const x of all(`SELECT cr.id,cr.status,cr.price,cr.deposit_percent,cr.shipping_fee,cr.created_at,cr.receipt_source,
                             (cr.receipt IS NOT NULL) AS has_receipt,c.name AS customer_name
                      FROM custom_requests cr LEFT JOIN customers c ON c.id=cr.customer_id
                      WHERE cr.status IN ('review','quoted','receipt_pending','receipt_rejected')
                        AND NOT EXISTS(SELECT 1 FROM custom_order_links l WHERE l.request_id=cr.id)
                        AND (mavi_cairo_date(cr.created_at) IS NULL OR mavi_cairo_date(cr.created_at) NOT BETWEEN ? AND ?)`,from,to)){
   const pct=Number(x.deposit_percent),price=Number(x.price);
   outsideDeposits.push({kind:'custom',id:x.id,customer:x.customer_name||'',status:x.status==='review'?'needs_quote':x.status,created_at:x.created_at,
    amount:x.price!==null&&x.deposit_percent!==null&&Number.isFinite(price)&&Number.isFinite(pct)&&pct>0?Math.round((price+Number(x.shipping_fee||0))*pct)/100:null,
    has_receipt:!!x.has_receipt,receipt_source:x.receipt_source});
  }
  const confirmedCustom=get("SELECT COUNT(*) n FROM custom_requests WHERE status='approved' AND mavi_cairo_date(created_at) BETWEEN ? AND ?",from,to).n;
  const priority={receipt_pending:0,receipt_rejected:1,quoted:2,needs_quote:3};
  const sortDeposits=list=>list.sort((a,b)=>(priority[a.status]??9)-(priority[b.status]??9)||String(b.created_at).localeCompare(String(a.created_at)));
  sortDeposits(deposits);const allDeposits=sortDeposits([...deposits,...outsideDeposits]);
  late.sort((a,b)=>String(a.promise_date).localeCompare(String(b.promise_date))||String(a.code).localeCompare(String(b.code)));
  dues.sort((a,b)=>b.due-a.due||String(a.code).localeCompare(String(b.code)));
  const countDeposits=list=>{const counts={needs_quote:0,quoted:0,receipt_pending:0,receipt_rejected:0,other:0};for(const d of list){const key=Object.prototype.hasOwnProperty.call(counts,d.status)?d.status:'other';counts[key]++;}return counts;};
  const depositCounts=countDeposits(deposits),allDepositCounts=countDeposits(allDeposits);
  const summary={orders:eligibleCount,sales:costs.totals.sales,cost:costs.totals.total,
   before_expenses:costs.totals.profit,expenses,net_difference:costs.totals.profit-expenses,collected_in_period:collected,
   gross_collected_in_period:grossCollected,refunded_in_period:refunded,
   outstanding_for_period_orders:outstanding,overpaid_for_period_orders:overpaid,unpriced,cancelled};
  return {from,to,today,summary,cost_detail:costs,
   sales:{designs:[...salesByDesign.values()].sort((a,b)=>b.sales_before_adjustments-a.sales_before_adjustments||String(a.name).localeCompare(String(b.name))),
    colours:[...colours].map(([name,quantity])=>({name,quantity})).sort((a,b)=>b.quantity-a.quantity),
    channels:[...channels.values()].sort((a,b)=>b.sales-a.sales),orders:orderSales,
    months:[...months.values()].sort((a,b)=>a.month.localeCompare(b.month)).map(x=>({...x,net_difference:x.sales-x.cost-x.expenses})),
    expense_categories:[...expenseByCategory].map(([name,amount])=>({name,amount})).sort((a,b)=>b.amount-a.amount)},
   workshops:{rows:workshopRows,total:costs.totals.tailoring,classified_legacy:costs.totals.legacy_tailoring},
   fabrics:{rows:fabricRows,total:costs.totals.material,metres:costs.totals.metres,classified_legacy:costs.totals.legacy_material},
   payments:{rows:payments,refunds,methods:[...paymentMethods.values()].sort((a,b)=>b.amount-a.amount)},
   balances:{rows:dues,overpaid_rows:overpaidRows,outstanding,overpaid},
   deposits:{counts:depositCounts,rows:deposits,all_counts:allDepositCounts,all_rows:allDeposits,confirmed_order_deposits:confirmedOrderDeposits,confirmed_custom_requests:confirmedCustom},
   operations:{statuses:[...statuses].map(([status,count])=>({status,count})),late,active_without_promise_date:activeWithoutDate,total_orders:orders.length,
    all_late:allLate,all_active_without_promise_date:allWithoutDate,all_open:allOpen}};
 })();
}
module.exports={reportHub};
