'use strict';
/* Domain rules shared by both faces.
   The mapping between INTERNAL status and CUSTOMER status lives here, in one place. */
const { get, all, run } = require('./db');

/* internal pipeline → what the customer is allowed to know */
const CUSTOMER_STATUS = {
  new:       { key: 'received', label: 'وصلنا طلبك',  step: 1 },
  confirmed: { key: 'confirmed', label: 'اتأكد',      step: 2 },
  cut:       { key: 'progress',  label: 'قص القماش', step: 3 },
  sewing:    { key: 'progress',  label: 'في الخياطة', step: 3 },
  ready:     { key: 'ready',     label: 'جاهز',       step: 4 },
  delivered: { key: 'done',      label: 'اتسلّم',     step: 5 },
  cancelled: { key: 'cancelled', label: 'ملغي',       step: 0 },
};
const INTERNAL_STATUSES = ['new','confirmed','cut','sewing','ready','delivered','cancelled'];

const customerStatus = (s) => CUSTOMER_STATUS[s] || { key: 'received', label: 'قيد المراجعة', step: 1 };

// Resolve old order numbers only to their original order. Tombstoned aliases
// never resolve and cannot be reused; authorization still checks customer_id.
function orderByCode(code) {
  const value=String(code??'');
  // Preserve an exact legacy reference, including any historical whitespace.
  if(!value.trim())return null;
  const exact=get('SELECT * FROM orders WHERE code=? COLLATE BINARY',value);
  const exactAlias=get('SELECT order_id FROM order_code_aliases WHERE code=? COLLATE BINARY',value);
  // A legacy database can contain codes that differ only by case. Never let
  // a case-insensitive lookup override an exact old alias or a tombstone.
  if(exact)return exactAlias&&exactAlias.order_id!==exact.id?null:exact;
  if(exactAlias)return exactAlias.order_id==null?null:get('SELECT * FROM orders WHERE id=?',exactAlias.order_id)||null;
  const current=all('SELECT * FROM orders WHERE code=? COLLATE NOCASE LIMIT 2',value);
  const alias=get('SELECT order_id FROM order_code_aliases WHERE code=? COLLATE NOCASE',value);
  if(current.length>1)return null;
  if(current.length===1)return alias&&alias.order_id!==current[0].id?null:current[0];
  return alias?.order_id==null?null:get('SELECT * FROM orders WHERE id=?',alias.order_id)||null;
}
// Before creating an alias/tombstone, detect legacy case-only duplicates or a
// code already held by a different alias. Silently ignoring the insert would
// allow an old link to point at the wrong order.
function orderCodeConflict(code,orderId){
  const current=get('SELECT id FROM orders WHERE code=? COLLATE NOCASE AND id<>? LIMIT 1',code,orderId);
  const alias=get('SELECT order_id FROM order_code_aliases WHERE code=? COLLATE NOCASE',code);
  return !!current||!!(alias&&alias.order_id!==orderId);
}
function orderContact(order) {
  const c=get('SELECT id,name,phone,area FROM customers WHERE id=?',order.customer_id);
  if(!c)return null;
  return {...c,name:order.contact_name??c.name,phone:order.contact_phone??c.phone,area:order.contact_area??c.area};
}
function orderMeasurements(order) {
  if(order.measurements_snapshot!==null&&order.measurements_snapshot!==undefined){
    try { const m=JSON.parse(order.measurements_snapshot); if(m&&typeof m==='object'&&!Array.isArray(m))return m; } catch(_) {}
  }
  return get('SELECT * FROM measurements WHERE customer_id=?',order.customer_id) || null;
}

/* ---------- order numbering: MV-YYMM-NNN ---------- */
// Custom order numbers may have very long numeric suffixes. Never let one
// overflow JavaScript's integer precision or poison the automatic counter.
const MAX_AUTO_COUNTER=999999999999;
const counterValue=value=>{const n=Number(value);return Number.isSafeInteger(n)&&n>=0&&n<=MAX_AUTO_COUNTER?n:0;};
function rememberOrderCode(code) {
  const m=/^MV-(\d{4})-(\d{1,12})$/.exec(String(code||'')); if(!m)return;
  const key='order_counter:'+m[1], n=counterValue(m[2]);
  const prev=counterValue(get('SELECT value FROM settings WHERE key=?',key)?.value||0);
  if(n>prev)run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,String(n));
}
function nextOrderCode(now = new Date()) {
  const yy = String(now.getFullYear()).slice(-2), mm = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `MV-${yy}${mm}-`, key='order_counter:'+yy+mm;
  const row=get(`SELECT MAX(CAST(SUBSTR(code,9) AS INTEGER)) n FROM orders WHERE code LIKE ?
                 AND LENGTH(SUBSTR(code,9)) BETWEEN 1 AND 12 AND SUBSTR(code,9) NOT GLOB '*[^0-9]*'`,prefix+'%');
  const counter=counterValue(get('SELECT value FROM settings WHERE key=?',key)?.value||0);
  let n=Math.max(counterValue(row.n||0),counter)+1;
  let code=prefix+String(n).padStart(3,'0');
  // Manually changed and deleted references stay reserved forever.
  while(get('SELECT 1 x FROM orders WHERE code=? COLLATE NOCASE',code)||get('SELECT 1 x FROM order_code_aliases WHERE code=? COLLATE NOCASE',code)){
    n++;code=prefix+String(n).padStart(3,'0');
  }
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,String(n));
  return code;
}

/* ---------- money ---------- */
function orderTotals(orderId) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) return null;
  const items = all('SELECT * FROM order_items WHERE order_id = ?', orderId);
  const gross_paid = get('SELECT COALESCE(SUM(amount),0) t FROM payments WHERE order_id = ?', orderId).t;
  const refunded = get('SELECT COALESCE(SUM(amount),0) t FROM order_refunds WHERE order_id = ? AND voided_at IS NULL', orderId).t;
  // A refund is recorded only after money actually left. It lowers the net
  // paid amount; reactivating an order therefore does not invent old money.
  const paid = Math.round((gross_paid-refunded)*100)/100;
  const subtotal = items.reduce((s, i) => s + i.unit_price * i.qty, 0);
  const total = subtotal - o.discount + o.delivery_fee;
  const purchases=get('SELECT COALESCE(SUM(metres*(price_per_metre+shipping_per_metre)),0) n FROM order_fabric_purchases WHERE order_id=?',orderId).n;
  const workshop=get(`SELECT COALESCE(SUM(COALESCE(i.qty,w.quantity)*w.unit_cost),0) n FROM order_workshop_costs w LEFT JOIN order_items i ON i.id=w.order_item_id AND i.order_id=w.order_id WHERE w.order_id=?`,orderId).n;
  const orderExtras=get('SELECT COALESCE(SUM(amount),0) n FROM order_other_costs WHERE order_id=?',orderId).n;
  const cost = items.reduce((s, i) => s + i.unit_cost * i.qty, 0) + purchases + workshop + orderExtras;
  return {
    subtotal, discount: o.discount, delivery_fee: o.delivery_fee,
    total, paid, gross_paid, refunded, due: total - paid, cost, profit: total - cost,
    margin: total > 0 ? Math.round(((total - cost) / total) * 100) : 0,
  };
}

// Fabric is purchased for each order. No fabric stock is deducted, restored,
// or repriced from the catalogue. Historical item costs remain as saved.

/* ---------- Arabic WhatsApp templates (owner-facing, one per stage) ---------- */
function buildMessage(orderId) {
  const o = get('SELECT * FROM orders WHERE id = ?', orderId);
  if (!o) return null;
  const c = orderContact(o);
  const items = all(`SELECT oi.*, COALESCE(NULLIF(oi.description,''),s.name) AS style_name FROM order_items oi
                     JOIN styles s ON s.id = oi.style_id WHERE oi.order_id = ?`, orderId);
  const t = orderTotals(orderId);
  const first = (c?.name || '').split(' ')[0] || 'حبيبتي';
  const list = items.map(i =>
    `• ${i.style_name} — ${i.colour || ''}${i.length_cm ? ` — طول ${i.length_cm} سم` : ''}${i.qty > 1 ? ` ×${i.qty}` : ''}`
  ).join('\n');
  const fmt = n => new Intl.NumberFormat('en-EG').format(Math.round(n));
  const date = o.promise_date
    ? new Date(o.promise_date).toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'long' })
    : 'قريباً';

  const T = {
    new: `أهلاً ${first} 🤍\nوصلني طلبك وبنتأكد منه دلوقتي.\n\n${list}\n\nكود الأوردر: ${o.code}\n\nأول ما نتأكد المقاسات والخامة هبلغك 🙏`,
    confirmed: `تأكيد أوردر ${o.code} ✅\n\nأهلاً ${first}، أوردرك اتأكد:\n${list}\n\nالإجمالي: ${fmt(t.total)} ج.م\nالمدفوع: ${fmt(t.paid)} ج.م\nالباقي: ${fmt(t.due)} ج.م\n\nموعد التسليم المتوقع: ${date} 🤍`,
    cut: `${first} حبيبتي 🤍\nبدأنا قص القماش لأوردر ${o.code}.\n\n${list}\n\nهيبدأ التفصيل بكرة إن شاء الله وهبلغك أول ما يخلص.`,
    sewing: `${first}، أوردرك ${o.code} في التفصيل دلوقتي ✂️\n\n${list}\n\nموعدنا ${date} — لو في أي تعديل في الطول قوليلي قبل ما نخلّص.`,
    ready: `${first} حبيبتي، أوردرك جاهز 🎉\n\n${list}\n\nالباقي: ${fmt(t.due)} ج.م\n\nتحبي نبعته بكوريير ولا تستلميه من عندنا؟ 🤍`,
    delivered: `${first}، شكراً إنك اخترتي Mavi 🤍\n\n${list}\n\nلو حبيتي، ابعتيلنا صورة وأنتي لابسة القطعة — بننشرها في #جمهورية_Mavi (بإذنك طبعاً).\nوأي حاجة محتاجاها، مقاساتك محفوظة عندنا فالأوردر الجاي هياخد دقيقة 💙`,
    cancelled: `${first}، تم إلغاء أوردر ${o.code}.\nلو حبيتي نعمله تاني في أي وقت، إحنا موجودين 🤍`,
  };
  return { status: o.status, text: T[o.status] || T.new };
}

/* ---------- customer-safe projection of an order ---------- */
function customerOrderView(orderId, customerId) {
  const o = get('SELECT * FROM orders WHERE id = ? AND customer_id = ?', orderId, customerId);
  if (!o) return null;
  const items = all(`SELECT oi.qty, oi.colour, oi.length_cm, oi.size, oi.unit_price, oi.fabric_choice, oi.item_note, oi.status, COALESCE(NULLIF(oi.description,''),s.name) AS style_name
                     FROM order_items oi JOIN styles s ON s.id = oi.style_id WHERE oi.order_id = ?`, orderId);
  const t = orderTotals(orderId);
  const cs = customerStatus(o.status);
  return {
    code: o.code,
    status: cs.key,
    statusLabel: cs.label,
    step: cs.step,
    created_at: o.created_at,
    promise_date: o.promise_date,
    delivery_fee: o.delivery_fee, governorate:o.governorate, delivery_requested:!!o.delivery_requested, shipping_quoted:!!o.shipping_quoted, fabric_choice:o.fabric_choice,
    total: t.total, custom_price_pending:items.some(i=>i.status==='custom_pending'), // partial until all custom pieces are priced
    paid: t.paid,
    refunded: t.refunded,
    // A cancelled order is not a current payment obligation. Its archived
    // receipts and refunds stay visible rather than claiming money was returned.
    due: o.status==='cancelled' ? 0 : t.due,
    deposit: (() => { const d=get('SELECT percent,payment_details,status,confirmed_amount FROM order_deposits WHERE order_id=?',orderId); if(!d)return null; const amount=d.percent == null ? null : Math.round(t.total*d.percent)/100; return {...d, amount, shortfall:d.status==='approved'&&amount!=null ? Math.max(0,Math.round((amount-t.paid)*100)/100) : 0}; })(),
    items: items.map(i => ({
      name: i.style_name, colour: i.colour, length_cm: i.length_cm,
      size: i.size, qty: i.qty, price: i.unit_price, fabric_choice: i.fabric_choice, item_note: i.item_note, price_pending:i.status==='custom_pending',
    })),
  };
}

module.exports = {
  CUSTOMER_STATUS, INTERNAL_STATUSES, customerStatus,
  orderByCode, orderCodeConflict, orderContact, orderMeasurements,
  nextOrderCode, rememberOrderCode, orderTotals,
  buildMessage, customerOrderView,
};
