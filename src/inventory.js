'use strict';
const {get,all,run,audit}=require('./db');
function reserve(orderId,actor){
 const items=all(`SELECT i.* FROM order_items i JOIN styles s ON s.id=i.style_id WHERE i.order_id=? AND s.type='stock'`,orderId);
 for(const i of items){
  const existing=get(`SELECT r.*,s.style_id,s.size,s.colour FROM stock_reservations r
                      JOIN stock_items s ON s.id=r.stock_id WHERE r.order_item_id=?`,i.id);
  if(existing){
   // A cancellation of a legacy unapproved order may have released an
   // earlier reservation; reactivation already reacquired it atomically.
   // Reuse only an active, exactly matching reservation, never deduct twice.
   if(existing.released||existing.style_id!==i.style_id||
      (existing.size??'')!==(i.size??'')||(existing.colour??'')!==(i.colour??'')||existing.qty!==i.qty)
    throw new Error('سجل حجز المخزون لا يطابق القطعة؛ راجعيه قبل تأكيد العربون');
   continue;
  }
  const variants=all('SELECT * FROM stock_items WHERE style_id=? AND size IS ? AND colour IS ?',i.style_id,i.size,i.colour);
  if(variants.length!==1)throw new Error('المقاس واللون غير متاحين في المخزون؛ راجعي الطلب قبل تأكيد العربون');
  const v=variants[0];const upd=run('UPDATE stock_items SET qty=qty-? WHERE id=? AND qty>=?',i.qty,v.id,i.qty);
  if(!upd.changes)throw new Error('الكمية المتاحة لا تكفي؛ لم يتم تأكيد العربون أو خصم المخزون');
  run('INSERT INTO stock_reservations(order_item_id,stock_id,qty) VALUES(?,?,?)',i.id,v.id,i.qty);
  run('INSERT INTO stock_movements(stock_id,delta,reason,actor) VALUES(?,?,?,?)',v.id,-i.qty,'تأكيد عربون الطلب',actor);
  audit('stock',v.id,'reserved',actor,{orderId,qty:i.qty});
 }
}
function release(orderId,actor,reason='إلغاء الطلب قبل التسليم'){
 const rows=all(`SELECT r.* FROM stock_reservations r JOIN order_items i ON i.id=r.order_item_id WHERE i.order_id=? AND r.released=0`,orderId);
 for(const r of rows){run('UPDATE stock_items SET qty=qty+? WHERE id=?',r.qty,r.stock_id);run('UPDATE stock_reservations SET released=1 WHERE order_item_id=?',r.order_item_id);run('INSERT INTO stock_movements(stock_id,delta,reason,actor) VALUES(?,?,?,?)',r.stock_id,r.qty,reason,actor);audit('stock',r.stock_id,'released',actor,{orderId,qty:r.qty})}
}
// Called inside the caller's IMMEDIATE transaction. Re-acquire only stock
// that this order previously released; do not invent reservations for legacy
// orders whose old stock history is incomplete.
function restore(orderId,actor,stage='new',previousUnknown=false){
 const rows=all(`SELECT i.id,i.qty,i.size,i.colour,i.style_id,r.stock_id,r.qty AS reserved_qty,r.released,
                         s.style_id AS stock_style,s.size AS stock_size,s.colour AS stock_colour
                 FROM order_items i JOIN styles st ON st.id=i.style_id AND st.type='stock'
                 LEFT JOIN stock_reservations r ON r.order_item_id=i.id
                 LEFT JOIN stock_items s ON s.id=r.stock_id WHERE i.order_id=? ORDER BY i.id`,orderId);
 // If the old stage is unknown, even a missing or released reservation does
 // not prove that a finished piece was never delivered. Do not resume a stock
 // workflow that could later return an already-delivered piece automatically.
 if(previousUnknown&&rows.length)throw new Error('مرحلة الطلب القديمة وحجز المخزون غير واضحين؛ راجعيهما يدويًا قبل إعادة التشغيل');
 const dep=get('SELECT status FROM order_deposits WHERE order_id=?',orderId);
 let restored=0,unreserved=0;const pending=new Map();
 for(const i of rows){
  if(i.stock_id==null){
   // An unapproved, still-new order normally never reserved stock. In an
   // advanced/approved/legacy order, absent history cannot tell us whether
   // stock was already consumed; refuse to guess or double-deduct it.
   if(stage!=='new'||!dep||dep.status==='approved')throw new Error('سجل حجز قطعة المخزون القديمة غير مكتمل؛ راجعي المخزون قبل إعادة التشغيل');
   const variants=all('SELECT id FROM stock_items WHERE style_id=? AND size IS ? AND colour IS ?',i.style_id,i.size,i.colour);
   if(variants.length!==1)throw new Error('المقاس واللون غير متاحين في المخزون؛ راجعي الطلب قبل إعادة التشغيل');
   pending.set(variants[0].id,(pending.get(variants[0].id)||0)+i.qty);unreserved+=i.qty;
   continue;
  }
  if(i.stock_style!==i.style_id||(i.stock_size??'')!==(i.size??'')||(i.stock_colour??'')!==(i.colour??'')||i.reserved_qty!==i.qty)
   throw new Error('بيانات حجز المخزون لا تطابق القطعة؛ راجعي المخزون قبل إعادة التشغيل');
  if(!i.released)continue; // a known old cancellation may have kept a reservation
  const changed=run('UPDATE stock_items SET qty=qty-? WHERE id=? AND qty>=?',i.reserved_qty,i.stock_id,i.reserved_qty);
  if(!changed.changes)throw new Error('المخزون المتاح لم يعد يكفي؛ لم يُعَد تشغيل الطلب');
  run('UPDATE stock_reservations SET released=0 WHERE order_item_id=? AND released=1',i.id);
  run('INSERT INTO stock_movements(stock_id,delta,reason,actor) VALUES(?,?,?,?)',i.stock_id,-i.reserved_qty,'إعادة تشغيل الطلب',actor);
  audit('stock',i.stock_id,'reactivated_reservation',actor,{orderId,qty:i.reserved_qty});
  restored+=i.reserved_qty;
 }
 // These unapproved lines have never been held: check the combined demand,
 // but keep the existing policy of reserving them at deposit confirmation.
 for(const [id,qty] of pending){
  const available=get('SELECT qty FROM stock_items WHERE id=?',id)?.qty;
  if(available===undefined||available<qty)throw new Error('المخزون المتاح لم يعد يكفي؛ لم يُعَد تشغيل الطلب');
 }
 return {restored,unreserved};
}

// Apply stock reservation changes for edited pieces atomically. Release all
// affected variants first, then reserve all targets; any shortage rolls the
// entire order edit back. The current stock purchase cost is not guessed.
function adjustEditedItems(order,changes,actor){
 const adjusted=[];
 const dep=get('SELECT status FROM order_deposits WHERE order_id=?',order.id);
 for(const x of changes){
  if(x.old.style_type!=='stock')continue;
  if(x.old.qty===x.qty&&(x.old.size??'')===(x.size??'')&&(x.old.colour??'')===(x.colour??''))continue;
  if(order.status==='delivered'||(order.status==='cancelled'&&order.cancelled_from_status==='delivered'))throw new Error('لا يمكن تعديل عدد أو لون أو مقاس قطعة مخزون سُلّمت؛ راجعي المرتجع يدويًا');
  const variants=all('SELECT id,qty FROM stock_items WHERE style_id=? AND size IS ? AND colour IS ?',x.old.style_id,x.size||null,x.colour||null);
  if(variants.length!==1)throw new Error('المقاس واللون المختاران غير موجودين بمخزون القطعة');
  const r=get(`SELECT r.*,s.style_id,s.size,s.colour FROM stock_reservations r
               JOIN stock_items s ON s.id=r.stock_id WHERE r.order_item_id=?`,x.old.id);
  if(r&&((order.status==='cancelled'&&!r.released)||(order.status!=='cancelled'&&r.released)))
    throw new Error('حالة حجز المخزون غير متسقة؛ راجعي السجل قبل تعديل القطعة');
  if(r&&(r.style_id!==x.old.style_id||(r.size??'')!==(x.old.size??'')||
         (r.colour??'')!==(x.old.colour??'')||r.qty!==x.old.qty))
    throw new Error('سجل حجز المخزون لا يطابق القطعة؛ راجعيه قبل تعديلها');
  if(!r&&(!dep||dep.status==='approved'))
    throw new Error('لا يوجد سجل حجز موثوق لقطعة المخزون القديمة؛ راجعي المخزون قبل تعديل العدد أو المقاس أو اللون');
  adjusted.push({x,r,target:variants[0]});
 }
 for(const a of adjusted){
  if(a.r&&!a.r.released){
   run('UPDATE stock_items SET qty=qty+? WHERE id=?',a.r.qty,a.r.stock_id);
   run('INSERT INTO stock_movements(stock_id,delta,reason,actor) VALUES(?,?,?,?)',a.r.stock_id,a.r.qty,'تعديل قطعة طلب: فك الحجز السابق',actor);
  }
 }
 for(const a of adjusted){
  if(a.r&&!a.r.released){
   const v=run('UPDATE stock_items SET qty=qty-? WHERE id=? AND qty>=?',a.x.qty,a.target.id,a.x.qty);
   if(!v.changes)throw new Error('الكمية المطلوبة غير متاحة؛ لم يُحفظ تعديل الأوردر');
   run('INSERT INTO stock_movements(stock_id,delta,reason,actor) VALUES(?,?,?,?)',a.target.id,-a.x.qty,'تعديل قطعة طلب: حجز جديد',actor);
  }
  if(a.r)run('UPDATE stock_reservations SET stock_id=?,qty=? WHERE order_item_id=?',a.target.id,a.x.qty,a.x.old.id);
  audit('stock',a.target.id,'order_item_edited',actor,{orderId:order.id,itemId:a.x.old.id,qty:a.x.qty});
 }
}
module.exports={reserve,release,restore,adjustEditedItems};
