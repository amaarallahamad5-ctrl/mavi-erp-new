'use strict';
// Generic, account-scoped notifications. No customer details in push messages.
const express=require('express');const webpush=require('web-push');const {db,get,all,run}=require('./db');const A=require('./auth');
const router=express.Router();
db.exec(`
CREATE TABLE IF NOT EXISTS web_alert_events(id INTEGER PRIMARY KEY AUTOINCREMENT,realm TEXT NOT NULL,subject_id INTEGER,kind TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')),dispatched INTEGER NOT NULL DEFAULT 0,claimed_at TEXT);
CREATE INDEX IF NOT EXISTS web_alert_realm_subject ON web_alert_events(realm,subject_id,id);
CREATE TABLE IF NOT EXISTS web_alert_reads(realm TEXT NOT NULL,subject_id INTEGER NOT NULL,last_id INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(realm,subject_id));
CREATE TABLE IF NOT EXISTS web_push_subscriptions(endpoint TEXT PRIMARY KEY,realm TEXT NOT NULL,subject_id INTEGER NOT NULL,subscription TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS web_push_private(id INTEGER PRIMARY KEY CHECK(id=1),public_key TEXT NOT NULL,private_key TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS web_push_delivery(event_id INTEGER NOT NULL REFERENCES web_alert_events(id) ON DELETE CASCADE,endpoint TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,done INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(event_id,endpoint));
CREATE TRIGGER IF NOT EXISTS web_alert_customer_deleted AFTER DELETE ON customers BEGIN
 DELETE FROM web_alert_events WHERE realm='store' AND subject_id=OLD.id;
 DELETE FROM web_alert_reads WHERE realm='store' AND subject_id=OLD.id;
 DELETE FROM web_push_subscriptions WHERE realm='store' AND subject_id=OLD.id; END;
CREATE TRIGGER IF NOT EXISTS web_alert_staff_deleted AFTER DELETE ON users BEGIN
 DELETE FROM web_alert_reads WHERE realm='admin' AND subject_id=OLD.id;
 DELETE FROM web_push_subscriptions WHERE realm='admin' AND subject_id=OLD.id; END;
CREATE TRIGGER IF NOT EXISTS web_alert_new_order AFTER INSERT ON orders WHEN NEW.channel='online' AND NEW.status='new' BEGIN
 INSERT INTO web_alert_events(realm,kind) VALUES('admin','new_order'); END;
CREATE TRIGGER IF NOT EXISTS web_alert_new_custom AFTER INSERT ON custom_requests BEGIN
 INSERT INTO web_alert_events(realm,kind) VALUES('admin','new_custom'); END;
CREATE TRIGGER IF NOT EXISTS web_alert_order_status AFTER UPDATE OF status ON orders WHEN NEW.status<>OLD.status AND NEW.customer_id IS NOT NULL BEGIN
 INSERT INTO web_alert_events(realm,subject_id,kind) VALUES('store',NEW.customer_id,'order_update'); END;
CREATE TRIGGER IF NOT EXISTS web_alert_custom_status AFTER UPDATE OF status ON custom_requests WHEN NEW.status<>OLD.status BEGIN
 INSERT INTO web_alert_events(realm,subject_id,kind) SELECT 'store',NEW.customer_id,'custom_update' WHERE NEW.status IN ('quoted','approved','receipt_rejected');
 INSERT INTO web_alert_events(realm,kind) SELECT 'admin','receipt' WHERE NEW.status='receipt_pending'; END;
CREATE TRIGGER IF NOT EXISTS web_alert_custom_requote AFTER UPDATE OF price,deposit_percent,payment_details,shipping_fee ON custom_requests WHEN OLD.status='quoted' AND NEW.status='quoted' AND (NEW.price IS NOT OLD.price OR NEW.deposit_percent IS NOT OLD.deposit_percent OR NEW.payment_details IS NOT OLD.payment_details OR NEW.shipping_fee IS NOT OLD.shipping_fee) BEGIN
 INSERT INTO web_alert_events(realm,subject_id,kind) VALUES('store',NEW.customer_id,'custom_update'); END;
CREATE TRIGGER IF NOT EXISTS web_alert_deposit_requote AFTER UPDATE OF percent,payment_details ON order_deposits WHEN OLD.status='quoted' AND NEW.status='quoted' AND (NEW.percent IS NOT OLD.percent OR NEW.payment_details IS NOT OLD.payment_details) BEGIN
 INSERT INTO web_alert_events(realm,subject_id,kind) SELECT 'store',o.customer_id,'deposit_update' FROM orders o WHERE o.id=NEW.order_id; END;
CREATE TRIGGER IF NOT EXISTS web_alert_deposit_status AFTER UPDATE OF status ON order_deposits WHEN NEW.status<>OLD.status BEGIN
 INSERT INTO web_alert_events(realm,subject_id,kind) SELECT 'store',o.customer_id,'deposit_update' FROM orders o WHERE o.id=NEW.order_id AND NEW.status IN ('quoted','approved','receipt_rejected');
 INSERT INTO web_alert_events(realm,kind) SELECT 'admin','receipt' WHERE NEW.status='receipt_pending'; END;
`);
if(!db.pragma('table_info(web_alert_events)').some(x=>x.name==='claimed_at')){try{db.exec('ALTER TABLE web_alert_events ADD COLUMN claimed_at TEXT')}catch(e){if(!String(e.message).includes('duplicate column'))throw e}}
let keys=get('SELECT public_key,private_key FROM web_push_private WHERE id=1');
if(!keys){const k=webpush.generateVAPIDKeys();run('INSERT OR IGNORE INTO web_push_private(id,public_key,private_key) VALUES(1,?,?)',k.publicKey,k.privateKey);keys=get('SELECT public_key,private_key FROM web_push_private WHERE id=1')}
webpush.setVapidDetails('https://9ev8jkxh7wzb-production-hkkaenim.us-central1.suga.run/store/',keys.public_key,keys.private_key);
const labels={new_order:['طلب جديد','New order'],new_custom:['طلب تصميم جديد','New custom design request'],order_update:['تحديث على طلبك','Your order has an update'],custom_update:['تحديث على تصميمك الخاص','Your custom design has an update'],deposit_update:['تحديث على العربون','Your deposit has an update'],receipt:['إيصال جديد للمراجعة','New receipt to review']};
function auth(realm){return realm==='store'?A.requireCustomer:A.requireStaff}
function allowedEndpoint(value){try{let u=new URL(value),h=u.hostname.toLowerCase();return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&value.length<=2048&&(h==='fcm.googleapis.com'||h==='android.googleapis.com'||h==='updates.push.services.mozilla.com'||h==='push.services.mozilla.com'||h.endsWith('.push.apple.com')||h==='push.apple.com'||h.endsWith('.notify.windows.com'))}catch(e){return false}}
router.use(['/api/store/web-alerts','/api/admin/web-alerts'],(_q,r,next)=>{r.set('Cache-Control','no-store');next()});
for(const realm of ['store','admin']){
 const guard=auth(realm),prefix='/api/'+realm+'/web-alerts';
 router.get(prefix,guard,(q,r)=>{
  const id=q.user.id,last=get('SELECT last_id FROM web_alert_reads WHERE realm=? AND subject_id=?',realm,id)?.last_id||0;
  const filter=realm==='store'?"realm='store' AND subject_id=?":(q.user.role==='owner'?"realm='admin'":"realm='admin' AND kind='new_order'");
  const args=realm==='store'?[id]:[];const rows=all(`SELECT id,kind,created_at FROM web_alert_events WHERE ${filter} ORDER BY id DESC LIMIT 30`,...args);
  const unread=get(`SELECT COUNT(*) n FROM web_alert_events WHERE ${filter} AND id>?`,...args,last).n;
  r.json({unread,alerts:rows.map(x=>({id:x.id,kind:x.kind,created_at:x.created_at,read:x.id<=last,ar:(labels[x.kind]||['تحديث جديد'])[0],en:(labels[x.kind]||['','New update'])[1]}))});
 });
 router.post(prefix+'/read',guard,(q,r)=>{
  const max=realm==='store'?get("SELECT COALESCE(MAX(id),0) n FROM web_alert_events WHERE realm='store' AND subject_id=?",q.user.id).n:get(q.user.role==='owner'?"SELECT COALESCE(MAX(id),0) n FROM web_alert_events WHERE realm='admin'":"SELECT COALESCE(MAX(id),0) n FROM web_alert_events WHERE realm='admin' AND kind='new_order'").n;
  run('INSERT INTO web_alert_reads(realm,subject_id,last_id) VALUES(?,?,?) ON CONFLICT(realm,subject_id) DO UPDATE SET last_id=MAX(last_id,excluded.last_id)',realm,q.user.id,max);r.json({ok:true});
 });
 router.get(prefix+'/key',guard,(q,r)=>r.json({publicKey:keys.public_key}));
 router.post(prefix+'/subscribe',guard,(q,r)=>{
  const s=q.body?.subscription;if(!s||typeof s.endpoint!=='string'||!allowedEndpoint(s.endpoint)||!s.keys||typeof s.keys.p256dh!=='string'||typeof s.keys.auth!=='string'||!/^[A-Za-z0-9_-]{80,100}$/.test(s.keys.p256dh)||!/^[A-Za-z0-9_-]{20,30}$/.test(s.keys.auth))return r.status(400).json({error:'invalid_subscription'});
  const count=get('SELECT COUNT(*) n FROM web_push_subscriptions WHERE realm=? AND subject_id=?',realm,q.user.id).n;if(count>=10&&!get('SELECT endpoint FROM web_push_subscriptions WHERE endpoint=? AND realm=? AND subject_id=?',s.endpoint,realm,q.user.id))return r.status(429).json({error:'subscription_limit'});
  run('INSERT INTO web_push_subscriptions(endpoint,realm,subject_id,subscription) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET realm=excluded.realm,subject_id=excluded.subject_id,subscription=excluded.subscription',s.endpoint,realm,q.user.id,JSON.stringify({endpoint:s.endpoint,keys:{p256dh:s.keys.p256dh,auth:s.keys.auth},lang:q.body?.lang==='en'?'en':'ar'}));r.json({ok:true});
 });
 router.post(prefix+'/unsubscribe',guard,(q,r)=>{let ep=q.body?.endpoint;if(typeof ep!=='string'||ep.length>2048)return r.status(400).json({error:'invalid'});run('DELETE FROM web_push_subscriptions WHERE endpoint=? AND realm=? AND subject_id=?',ep,realm,q.user.id);r.json({ok:true})});
}
let busy=false;
async function dispatch(){
 if(busy)return;busy=true;
 try{run("UPDATE web_alert_events SET dispatched=0,claimed_at=NULL WHERE dispatched=2 AND claimed_at<datetime('now','-30 minutes')");const pending=all('SELECT id,realm,subject_id,kind FROM web_alert_events WHERE dispatched=0 ORDER BY id LIMIT 20');
  for(const ev of pending){if(!run("UPDATE web_alert_events SET dispatched=2,claimed_at=datetime('now') WHERE id=? AND dispatched=0",ev.id).changes)continue;const subs=ev.realm==='store'?all("SELECT endpoint,subscription FROM web_push_subscriptions WHERE realm='store' AND subject_id=?",ev.subject_id):all(ev.kind==='new_order'?"SELECT endpoint,subscription FROM web_push_subscriptions WHERE realm='admin' AND subject_id IN (SELECT id FROM users WHERE active=1)":"SELECT endpoint,subscription FROM web_push_subscriptions WHERE realm='admin' AND subject_id IN (SELECT id FROM users WHERE active=1 AND role='owner')");
   for(const sub of subs)run('INSERT OR IGNORE INTO web_push_delivery(event_id,endpoint) VALUES(?,?)',ev.id,sub.endpoint);
   const pendingSubs=all("SELECT d.endpoint,d.attempts,s.subscription FROM web_push_delivery d JOIN web_push_subscriptions s ON s.endpoint=d.endpoint WHERE d.event_id=? AND d.done=0 AND s.realm=? AND ((?='store' AND s.subject_id=?) OR (?='admin' AND EXISTS (SELECT 1 FROM users u WHERE u.id=s.subject_id AND u.active=1 AND (?='new_order' OR u.role='owner'))))",ev.id,ev.realm,ev.realm,ev.subject_id,ev.realm,ev.kind);
   for(const sub of pendingSubs){try{const saved=JSON.parse(sub.subscription);const subscription={endpoint:saved.endpoint,keys:saved.keys};await webpush.sendNotification(subscription,JSON.stringify({realm:ev.realm,lang:saved.lang==='en'?'en':'ar'}),{TTL:86400,timeout:10000});run('UPDATE web_push_delivery SET done=1 WHERE event_id=? AND endpoint=?',ev.id,sub.endpoint)}catch(e){if(e.statusCode===404||e.statusCode===410){run('DELETE FROM web_push_subscriptions WHERE endpoint=?',sub.endpoint);run('UPDATE web_push_delivery SET done=1 WHERE event_id=? AND endpoint=?',ev.id,sub.endpoint)}else{run('UPDATE web_push_delivery SET attempts=attempts+1,done=CASE WHEN attempts+1>=3 THEN 1 ELSE 0 END WHERE event_id=? AND endpoint=?',ev.id,sub.endpoint);console.warn('[web-push] delivery unavailable',e.statusCode||'network')}}}
   const retry=get("SELECT COUNT(*) n FROM web_push_delivery d JOIN web_push_subscriptions s ON s.endpoint=d.endpoint WHERE d.event_id=? AND d.done=0 AND s.realm=? AND ((?='store' AND s.subject_id=?) OR (?='admin' AND EXISTS (SELECT 1 FROM users u WHERE u.id=s.subject_id AND u.active=1 AND (?='new_order' OR u.role='owner'))))",ev.id,ev.realm,ev.realm,ev.subject_id,ev.realm,ev.kind).n;
   if(retry)run('UPDATE web_alert_events SET dispatched=0,claimed_at=NULL WHERE id=?',ev.id);else{run('UPDATE web_alert_events SET dispatched=1 WHERE id=?',ev.id);run('DELETE FROM web_push_delivery WHERE event_id=?',ev.id)}
  }
 }catch(e){console.error('[web-alerts] dispatch error',e.message)}finally{busy=false}
}
const timer=setInterval(dispatch,5000);timer.unref();
module.exports=router;
