'use strict';
const express=require('express');
const {db,get,all,run}=require('./db');
const A=require('./auth');
const D=require('./domain');
const {photo}=require('./custom-requests');
const customer=express.Router(), admin=express.Router();
customer.use(A.requireCustomer);admin.use(A.requireOwner);
const fail=(res,status,message)=>res.status(status).json({message});
customer.get('/',(q,r)=>r.json({drafts:all('SELECT id,details,date_needed,colour,fabric_type,fabric_choice,created_at FROM cart_custom_drafts WHERE customer_id=? AND order_item_id IS NULL ORDER BY id',q.user.id)}));
customer.post('/',(q,r)=>{
 const details=String(q.body.details||'').trim(),colour=String(q.body.colour||'').trim(),fabric_type=String(q.body.fabric_type||'').trim(),fabric_choice=String(q.body.fabric_choice||''),date=String(q.body.date_needed||'').trim();
 if(details.length>1000||colour.length<1||colour.length>80||fabric_type.length<1||fabric_type.length>80||!['قماش العميلة','قماش MAVI'].includes(fabric_choice)||(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date)))return fail(r,400,'راجعي تفاصيل التصميم واللون والخامة');
 if(get('SELECT count(*) n FROM cart_custom_drafts WHERE customer_id=? AND order_item_id IS NULL',q.user.id).n>=30)return fail(r,400,'السلة ممتلئة');
 const x=run('INSERT INTO cart_custom_drafts(customer_id,details,date_needed,colour,fabric_type,fabric_choice) VALUES(?,?,?,?,?,?)',q.user.id,details,date||null,colour,fabric_type,fabric_choice);
 r.status(201).json({id:Number(x.lastInsertRowid)});
});
customer.get('/:id',(q,r)=>{const d=get('SELECT id,details,date_needed,colour,fabric_type,fabric_choice FROM cart_custom_drafts WHERE id=? AND customer_id=? AND order_item_id IS NULL',q.params.id,q.user.id);if(!d)return fail(r,404,'التصميم غير موجود');d.image_ids=all('SELECT id FROM cart_custom_images WHERE draft_id=? ORDER BY id',d.id).map(x=>x.id);r.json({draft:d})});
customer.get('/:id/thumbnail',(q,r)=>{const x=get('SELECT i.image,i.image_type FROM cart_custom_images i JOIN cart_custom_drafts d ON d.id=i.draft_id WHERE d.id=? AND d.customer_id=? AND d.order_item_id IS NULL ORDER BY i.id LIMIT 1',q.params.id,q.user.id);if(!x)return r.sendStatus(404);r.set({'Content-Type':x.image_type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}).send(x.image)});
customer.get('/:id/images/:image',(q,r)=>{const x=get('SELECT i.image,i.image_type FROM cart_custom_images i JOIN cart_custom_drafts d ON d.id=i.draft_id WHERE i.id=? AND d.id=? AND d.customer_id=? AND d.order_item_id IS NULL',q.params.image,q.params.id,q.user.id);if(!x)return r.sendStatus(404);r.set({'Content-Type':x.image_type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}).send(x.image)});
customer.patch('/:id',(q,r)=>{
 const d=get('SELECT id FROM cart_custom_drafts WHERE id=? AND customer_id=? AND order_item_id IS NULL',q.params.id,q.user.id);if(!d)return fail(r,404,'التصميم غير موجود');
 const details=String(q.body.details||'').trim(),colour=String(q.body.colour||'').trim(),fabric_type=String(q.body.fabric_type||'').trim(),fabric_choice=String(q.body.fabric_choice||''),date=String(q.body.date_needed||'').trim();
 if(details.length>1000||!colour||colour.length>80||!fabric_type||fabric_type.length>80||!['قماش العميلة','قماش MAVI'].includes(fabric_choice)||(date&&!/^\d{4}-\d{2}-\d{2}$/.test(date)))return fail(r,400,'راجعي تفاصيل التصميم');
 run('UPDATE cart_custom_drafts SET details=?,date_needed=?,colour=?,fabric_type=?,fabric_choice=? WHERE id=?',details,date||null,colour,fabric_type,fabric_choice,d.id);r.json({ok:true});
});
customer.delete('/:id/images/:image',(q,r)=>{const d=get('SELECT id FROM cart_custom_drafts WHERE id=? AND customer_id=? AND order_item_id IS NULL',q.params.id,q.user.id);if(!d)return fail(r,404,'التصميم غير موجود');if(get('SELECT count(*) n FROM cart_custom_images WHERE draft_id=?',d.id).n<=1)return fail(r,400,'التصميم يحتاج صورة واحدة على الأقل؛ أضيفي البديلة أولًا');const x=run('DELETE FROM cart_custom_images WHERE id=? AND draft_id=?',q.params.image,d.id);if(!x.changes)return fail(r,404,'الصورة غير موجودة');r.json({ok:true})});
customer.post('/:id/images',(q,r)=>{
 const draft=get('SELECT id FROM cart_custom_drafts WHERE id=? AND customer_id=? AND order_item_id IS NULL',q.params.id,q.user.id);if(!draft)return fail(r,404,'التصميم غير موجود');
 if(get('SELECT count(*) n FROM cart_custom_images WHERE draft_id=?',draft.id).n>=10)return fail(r,400,'الحد الأقصى عشر صور');
 const p=photo(q.body.image);if(!p)return fail(r,400,'الصورة غير صالحة أو أكبر من ٢ ميجابايت');
 const x=run('INSERT INTO cart_custom_images(draft_id,image,image_type) VALUES(?,?,?)',draft.id,p.data,p.type);r.status(201).json({id:Number(x.lastInsertRowid)});
});
customer.delete('/:id',(q,r)=>{const x=run('DELETE FROM cart_custom_drafts WHERE id=? AND customer_id=? AND order_item_id IS NULL',q.params.id,q.user.id);if(!x.changes)return fail(r,404,'التصميم غير موجود');r.json({ok:true})});
admin.get('/orders/:code',(q,r)=>{const o=D.orderByCode(q.params.code);if(!o)return fail(r,404,'الطلب غير موجود');const pieces=all(`SELECT d.id,d.order_item_id,d.details,d.date_needed,d.colour,d.fabric_type,d.fabric_choice,oi.unit_price,oi.status FROM cart_custom_drafts d JOIN order_items oi ON oi.id=d.order_item_id WHERE oi.order_id=? ORDER BY oi.id`,o.id).map(d=>({...d,image_ids:all('SELECT id FROM cart_custom_images WHERE draft_id=? ORDER BY id',d.id).map(i=>i.id)}));r.json({pieces})});
admin.get('/images/:id',(q,r)=>{const x=get('SELECT i.image,i.image_type FROM cart_custom_images i JOIN cart_custom_drafts d ON d.id=i.draft_id WHERE i.id=? AND d.order_item_id IS NOT NULL',q.params.id);if(!x)return r.sendStatus(404);r.set({'Content-Type':x.image_type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}).send(x.image)});
admin.post('/items/:id/price',(q,r)=>{
 const item=get('SELECT i.id,i.order_id,o.status,d.status deposit_status FROM order_items i JOIN cart_custom_drafts c ON c.order_item_id=i.id JOIN orders o ON o.id=i.order_id JOIN order_deposits d ON d.order_id=o.id WHERE i.id=?',q.params.id);
 if(!item)return fail(r,404,'التصميم غير موجود');
 if(!['new','confirmed'].includes(item.status)||item.deposit_status!=='needs_quote')return fail(r,409,'لا يمكن تعديل السعر بعد نشر العرض؛ راجعي حالة العربون');
 const price=Number(q.body.price);if(q.body.price===''||!Number.isFinite(price)||price<=0||price>1e8)return fail(r,400,'أدخلي سعرًا صحيحًا');
 run("UPDATE order_items SET unit_price=?,status='custom_priced' WHERE id=?",price,item.id);r.json({ok:true});
});
module.exports={customer,admin};
