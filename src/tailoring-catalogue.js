'use strict';
const express=require('express');const {db,get,all,run,audit}=require('./db');const A=require('./auth');const {photo}=require('./custom-requests');const publicCache=require('./public-cache');
const admin=express.Router(),pub=express.Router();
const txt=x=>String(x??'').trim();
const safe=x=>x.length<=80&&!/[<>&"'`\\]/.test(x);
const info=id=>({images:all('SELECT id FROM style_images WHERE style_id=? ORDER BY is_primary DESC,id',id).map(r=>r.id),fabrics:all('SELECT name FROM style_fabrics WHERE style_id=? ORDER BY name',id).map(x=>x.name),sections:all('SELECT section,trend_year FROM style_sections WHERE style_id=? ORDER BY section',id)});
function detailsBatch(styleIds){
 const out=new Map();
 const ids=[...new Set((styleIds||[]).filter(Boolean))];
 for(const id of ids)out.set(id,{images:[],fabrics:[],sections:[],colours:[],lengths:[],sizes:[],variants:[],in_stock:0});
 if(!ids.length)return out;
 const ph=ids.map(()=>'?').join(',');
 for(const r of all(`SELECT style_id,id FROM style_images WHERE style_id IN (${ph}) ORDER BY is_primary DESC,id`,...ids))out.get(r.style_id)?.images.push(r.id);
 for(const r of all(`SELECT style_id,name FROM style_fabrics WHERE style_id IN (${ph}) ORDER BY name`,...ids))out.get(r.style_id)?.fabrics.push(r.name);
 for(const r of all(`SELECT style_id,section,trend_year FROM style_sections WHERE style_id IN (${ph}) ORDER BY section`,...ids))out.get(r.style_id)?.sections.push({section:r.section,trend_year:r.trend_year});
 for(const r of all(`SELECT style_id,name,hex FROM style_colours WHERE style_id IN (${ph}) ORDER BY sort`,...ids))out.get(r.style_id)?.colours.push({name:r.name,hex:r.hex});
 for(const r of all(`SELECT style_id,cm FROM style_lengths WHERE style_id IN (${ph}) ORDER BY cm`,...ids))out.get(r.style_id)?.lengths.push(r.cm);
 for(const r of all(`SELECT style_id,size FROM style_sizes WHERE style_id IN (${ph}) ORDER BY size`,...ids))out.get(r.style_id)?.sizes.push(r.size);
 for(const r of all(`SELECT style_id,size,colour,qty FROM stock_items WHERE style_id IN (${ph}) ORDER BY size,colour`,...ids)){
  const entry=out.get(r.style_id);if(!entry)continue;
  entry.variants.push({size:r.size,colour:r.colour,qty:r.qty});
  entry.in_stock+=Number(r.qty||0);
 }
 return out;
}
pub.get('/images/:id',(q,r)=>{const x=get('SELECT i.image,i.image_type FROM style_images i JOIN styles s ON s.id=i.style_id WHERE i.id=? AND s.active=1 AND s.type=\'made\'',q.params.id);if(!x)return r.sendStatus(404);r.set({'Content-Type':x.image_type,'X-Content-Type-Options':'nosniff','Cache-Control':'public, max-age=300'}).send(x.image)});
// Authenticated staff may preview hidden catalogue photos, but only the owner can edit.
admin.get('/styles/:id/images/:image',A.requireStaff,(q,r)=>{const x=get('SELECT image,image_type FROM style_images WHERE style_id=? AND id=?',q.params.id,q.params.image);if(!x)return r.sendStatus(404);r.set({'Content-Type':x.image_type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'}).send(x.image)});
admin.use(A.requireOwner);
admin.post('/styles/:id/images/:image/cover',(q,r)=>{const id=q.params.id,img=q.params.image;if(!get('SELECT id FROM style_images WHERE style_id=? AND id=?',id,img))return r.status(404).json({message:'الصورة غير موجودة لهذا الموديل'});db.transaction(()=>{run('UPDATE style_images SET is_primary=0 WHERE style_id=?',id);run('UPDATE style_images SET is_primary=1 WHERE style_id=? AND id=?',id,img);audit('style',id,'cover_changed',`user:${q.user.id}`,{image:Number(img)})})();publicCache.invalidateCatalogue();r.json({ok:true})});
admin.post('/styles',(q,r)=>{const b=q.body||{},name=txt(b.name),id=txt(b.id).toUpperCase(),note=txt(b.note),price=Number(b.price),lead=Number(b.lead_days);let colours=b.colours,fabrics=b.fabrics;if(!/^[A-Z0-9_-]{1,30}$/.test(id)||!name||!safe(name)||note.length>500||/[<>&"'`\\]/.test(note)||!Number.isFinite(price)||price<0||price>1e8||!Number.isInteger(lead)||lead<1||lead>365||!Array.isArray(colours)||!Array.isArray(fabrics)||colours.length>30||fabrics.length>30||[...colours,...fabrics].some(x=>!txt(x)||!safe(txt(x))))return r.status(400).json({message:'راجعي كود الموديل والاسم والسعر والألوان والخامات'});
 const sections=b.sections===undefined?null:b.sections, sale=b.sale_price===undefined?undefined:(b.sale_price===null||String(b.sale_price).trim()===''?null:Number(b.sale_price));if(sections!==null&&(!Array.isArray(sections)||sections.some(x=>!['summer','winter','trend'].includes(x))))return r.status(400).json({message:'أقسام الموديل غير صالحة'});if(sale!==undefined&&sale!==null&&(!Number.isFinite(sale)||sale<0||sale>=price))return r.status(400).json({message:'سعر العرض يجب أن يكون أقل من السعر الأصلي'});
 const old=get('SELECT * FROM styles WHERE id=?',id);if(old&&old.type!=='made')return r.status(409).json({message:'الكود مستخدم لموديل قديم؛ اختاري كودًا آخر'});
 db.transaction(()=>{if(old)run('UPDATE styles SET name=?,price=?,lead_days=?,note=?,active=? WHERE id=?',name,price,lead,note,b.active?1:0,id);else run("INSERT INTO styles(id,name,type,price,lead_days,note,active) VALUES(?,?,'made',?,?,?,?)",id,name,price,lead,note,b.active?1:0);if(sale!==undefined)run('UPDATE styles SET sale_price=? WHERE id=?',sale,id);if(sections!==null){run('DELETE FROM style_sections WHERE style_id=?',id);for(const section of new Set(sections))run('INSERT INTO style_sections(style_id,section,trend_year) VALUES(?,?,?)',id,section,section==='trend'?Number(new Intl.DateTimeFormat('en',{year:'numeric',timeZone:'Africa/Cairo'}).format(new Date())):null)}run('DELETE FROM style_colours WHERE style_id=?',id);run('DELETE FROM style_fabrics WHERE style_id=?',id);[...new Set(colours.map(txt))].forEach((c,i)=>run('INSERT INTO style_colours(style_id,name,sort) VALUES(?,?,?)',id,c,i));[...new Set(fabrics.map(txt))].forEach(f=>run('INSERT INTO style_fabrics(style_id,name) VALUES(?,?)',id,f));audit('style',id,old?'edited':'created',`user:${q.user.id}`)})();publicCache.invalidateCatalogue();r.json({ok:true,id});});
admin.post('/styles/:id/images',(q,r)=>{const id=q.params.id;let s=get("SELECT id FROM styles WHERE id=? AND type='made'",id),p=photo(q.body.image);if(!s)return r.sendStatus(404);if(!p)return r.status(400).json({message:'الصورة يجب أن تكون JPG أو PNG أو WebP حتى ٢ ميجابايت'});if(get('SELECT count(*) n FROM style_images WHERE style_id=?',id).n>=10)return r.status(400).json({message:'الحد الأقصى ١٠ صور للموديل'});let x=run('INSERT INTO style_images(style_id,image,image_type) VALUES(?,?,?)',id,p.data,p.type);audit('style',id,'image_added',`user:${q.user.id}`);publicCache.invalidateCatalogue();r.json({id:x.lastInsertRowid})});
admin.delete('/styles/:id/images/:image',(q,r)=>{const style=get('SELECT active FROM styles WHERE id=?',q.params.id);const exists=get('SELECT id FROM style_images WHERE id=? AND style_id=?',q.params.image,q.params.id);if(!exists)return r.sendStatus(404);if(style?.active&&get('SELECT COUNT(*) n FROM style_images WHERE style_id=?',q.params.id).n<=1)return r.status(409).json({message:'لا يمكن حذف آخر صورة لموديل ظاهر. أضيفي صورة أخرى أولًا أو أخفي الموديل.'});let x=run('DELETE FROM style_images WHERE id=? AND style_id=?',q.params.image,q.params.id);if(!x.changes)return r.sendStatus(404);audit('style',q.params.id,'image_deleted',`user:${q.user.id}`);publicCache.invalidateCatalogue();r.json({ok:true})});
module.exports={admin,pub,info,detailsBatch};
