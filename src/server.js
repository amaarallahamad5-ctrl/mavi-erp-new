'use strict';
// Operational diagnostics write numeric summaries to private runtime logs.
require('./diagnostics').startDiagnostics();
const express = require('express');
const path = require('path');
const { get, all, run, db, audit, setting } = require('./db');
const A = require('./auth');
const D = require('./domain');
const Notifications = require('./notifications');
const inventory = require('./inventory');
const orderCosts = require('./order-costs');
const { validDate } = require('./business-date');

const app = express();
// Health checks do not parse user cookies or depend on authentication.
// The database is still tested; do not report success when it fails.
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control','no-store');
  try { get('SELECT 1'); res.json({ ok:true, uptime:Math.round(process.uptime()) }); }
  catch (e) { console.error('[mavi-health] sqlite check failed'); res.status(503).json({ok:false}); }
});
require('./health-monitor').startLocalHealthProbe();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const DEV_SHOW_OTP = process.env.SHOW_OTP !== '0';
if (process.env.NODE_ENV === 'production' && DEV_SHOW_OTP) {
  console.warn('[WARN] SHOW_OTP is enabled in production — login codes will be returned in the API.');
}

// Large image uploads are accepted one at a time to limit peak memory on small hosts.
let imageUploadBusy = false;
function limitLargeUpload(req,res,next){
  if (!['POST','PUT'].includes(req.method)) return next();
  const length=Number(req.headers['content-length']||0);
  if (length && length <= 200000) return next();
  if (imageUploadBusy) return res.status(429).json({message:'يوجد رفع صورة جارٍ؛ انتظري قليلًا ثم حاولي مرة أخرى'});
  imageUploadBusy=true; let done=false;
  const release=()=>{if(!done){done=true;imageUploadBusy=false}};
  res.once('finish',release);res.once('close',release);next();
}
for (const p of ['/api/store/custom-requests','/api/store/cart-custom','/api/admin/catalogue','/api/store/order-deposits']) app.use(p,limitLargeUpload);
app.use('/api/store/custom-requests', express.json({limit:'3mb'}));
app.use('/api/store/cart-custom', express.json({limit:'3mb'}));
app.use('/api/admin/catalogue', express.json({limit:'3mb'}));
app.use('/api/store/order-deposits', express.json({limit:'3mb'}));
app.use(express.json({ limit: '200kb' }));
app.use(A.attachUser);
app.use(require('./web-alerts'));

/* never let a proxy/browser cache an authenticated response */
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

const list = (rows, fn) => rows.map(fn);
const bad = (res, code, error, message) => res.status(code).json({ error, message });
const toInt = (v, d = null) => (v === undefined || v === null || v === '' ? d : parseInt(v, 10));

/* ============================================================
   STORE API  — customer realm. NEVER returns cost/profit/workshop.
   ============================================================ */
app.use('/api/admin/inventory', require('./inventory-admin'));
app.use('/api/admin/deletions', require('./deletions'));
app.use('/api/admin/manual-orders', require('./manual-orders'));
const reviews=require('./reviews');app.use('/api/store/reviews',reviews.store);app.use('/api/admin/reviews',reviews.admin); 
const customRequests = require('./custom-requests');
const orderDeposits = require('./order-deposits');
app.use('/api/store/order-deposits', orderDeposits.customer);
app.use('/api/admin/order-deposits', orderDeposits.admin);
app.use('/api/store/custom-requests', customRequests.store);
app.use('/api/admin/custom-requests', customRequests.admin);
const cartCustom=require('./cart-custom');
app.use('/api/store/cart-custom',cartCustom.customer);
app.use('/api/admin/cart-custom',cartCustom.admin);
const catalogue = require('./tailoring-catalogue');
app.use('/api/catalogue', catalogue.pub);
app.use('/api/admin/catalogue', express.json({limit:'3mb'}), catalogue.admin);
const store = express.Router();

/* ---- public catalogue (no auth) ---- */
store.get('/catalogue', (_req, res) => {
  const styles = all(`SELECT id, name, type, price, sale_price, lead_days, note FROM styles
                      WHERE active = 1 AND type = 'made' ORDER BY id`);
  const out = list(styles, s => ({
    ...catalogue.info(s.id), id: s.id, name: s.name, type: s.type, price: s.sale_price ?? s.price, original_price: s.sale_price !== null ? s.price : null,
    lead_days: s.lead_days, note: s.note,
    colours: all('SELECT name, hex FROM style_colours WHERE style_id = ? ORDER BY sort', s.id),
    lengths: all('SELECT cm FROM style_lengths WHERE style_id = ? ORDER BY cm', s.id).map(r => r.cm),
    sizes:   all('SELECT size FROM style_sizes WHERE style_id = ? ORDER BY size', s.id).map(r => r.size),
    variants: s.type === 'stock' ? all('SELECT size,colour,qty FROM stock_items WHERE style_id=? ORDER BY size,colour',s.id) : [],
    in_stock: s.type === 'stock'
      ? get('SELECT COALESCE(SUM(qty),0) q FROM stock_items WHERE style_id = ?', s.id).q
      : null,
  }));
  res.json({ styles: out });
});

/* ---- migration: add customer passwords to older databases ---- */
try { run('ALTER TABLE customers ADD COLUMN password_hash TEXT'); } catch (e) { /* already there */ }

/* ---- customer auth: phone + password (no SMS needed) ---- */
store.post('/auth/register', (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  const password = String(req.body.password || '');
  const name = String(req.body.name || '').trim();
  if (!/^01[0-9]{9}$/.test(phone))
    return bad(res, 400, 'bad_phone', 'رقم الموبايل لازم يبدأ بـ 01 ويكون 11 رقم');
  if (password.length < 6)
    return bad(res, 400, 'weak_password', 'الباسورد لازم ٦ حروف أو أرقام على الأقل');
  if (name.length < 2)
    return bad(res, 400, 'bad_name', 'اكتبي اسمك');
  if (get('SELECT id FROM customers WHERE phone = ?', phone))
    return bad(res, 409, 'phone_taken', 'الرقم ده متسجل قبل كده — ادخلي بالباسورد');
  const ins = run('INSERT INTO customers(phone,name,password_hash) VALUES(?,?,?)',
                  phone, name, A.hashPassword(password));
  const c = get('SELECT * FROM customers WHERE id = ?', ins.lastInsertRowid);
  const { token, expires } = A.createSession('store', c.id, 'customer', 180);
  A.setSessionCookie(res, token, 180);
  res.json({ token, expires, profile: profileOf(c) });
});

store.post('/auth/login', (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  const password = String(req.body.password || '');
  if (phone.length > 20 || password.length > 1024) return bad(res, 400, 'invalid_input', 'راجعي بيانات تسجيل الدخول');
  if (A.throttled(phone))
    return bad(res, 429, 'too_many_attempts', 'محاولات كتيرة — استني ١٠ دقايق');
  const c = get('SELECT * FROM customers WHERE phone = ?', phone);
  if (c && !c.password_hash)
    return bad(res, 409, 'needs_password',
      'الرقم مسجل بالفعل — تواصلي مع MAVI لمساعدتك في استعادة حسابك');
  if (!c) {
    A.noteFailure(phone);
    return bad(res, 401, 'bad_login', 'الرقم أو الباسورد غلط');
  }
  if (!A.verifyPassword(password, c.password_hash)) {
    A.noteFailure(phone);
    return bad(res, 401, 'bad_login', 'الرقم أو الباسورد غلط');
  }
  A.clearFailures(phone);
  const { token, expires } = A.createSession('store', c.id, 'customer', 180);
  A.setSessionCookie(res, token, 180);
  res.json({ token, expires, profile: profileOf(c) });
});

/* ---- fallback: codes the brand sends herself over WhatsApp ---- */
function await_notify(phone, code) {
  try { return require('./notify').sendCode(phone, code); }
  catch (e) { return { sent: false, channel: 'brand' }; }
}

store.post('/auth/request-code', async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  if (!/^01[0-9]{9}$/.test(phone))
    return bad(res, 400, 'bad_phone', 'رقم الموبايل لازم يبدأ بـ 01 ويكون 11 رقم');
  try {
    const code = A.issueOtp(phone);
    if (DEV_SHOW_OTP && process.env.NODE_ENV !== 'production') console.log('[OTP] development code generated');
    const r = await_notify(phone, code);
    res.json({ ok: true, expires_in_minutes: 5,
               channel: r.channel,                 // 'whatsapp' = automatic, 'brand' = we'll send it
               dev_code: DEV_SHOW_OTP ? code : undefined });
  } catch (e) {
    if (e.status === 429) return bad(res, 429, 'too_many_requests', 'بعتنالك أكواد كتير — استني شوية');
    throw e;
  }
});

store.post('/auth/verify', (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  const code = String(req.body.code || '').trim();
  const r = A.consumeOtp(phone, code);
  if (!r.ok) {
    const msg = { no_code: 'اطلبي كود جديد', expired: 'الكود انتهى — اعملي كود جديد',
                  wrong_code: 'الكود غلط', too_many_attempts: 'محاولات كتيرة — اعملي كود جديد' }[r.reason];
    return bad(res, 401, r.reason, msg);
  }
  let c = get('SELECT * FROM customers WHERE phone = ?', phone);
  if (!c) {
    const ins = run('INSERT INTO customers(phone,name) VALUES(?,?)', phone, 'عميلة جديدة');
    c = get('SELECT * FROM customers WHERE id = ?', ins.lastInsertRowid);
  }
  const { token, expires } = A.createSession('store', c.id, 'customer', 180);
  A.setSessionCookie(res, token, 180);
  res.json({ token, expires, profile: profileOf(c) });
});

function profileOf(c) {
  const m = get('SELECT * FROM measurements WHERE customer_id = ?', c.id);
  return { id: c.id, name: c.name, phone: c.phone, area: c.area,
           has_password: !!c.password_hash, measurements: m || null };
}

store.post('/auth/set-password', A.requireCustomer, (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 6)
    return bad(res, 400, 'weak_password', 'الباسورد لازم ٦ حروف أو أرقام على الأقل');
  run('UPDATE customers SET password_hash = ? WHERE id = ?',
      A.hashPassword(password), req.user.id);
  audit('customer', req.user.id, 'password_set', `customer:${req.user.id}`);
  res.json({ ok: true, profile: profileOf(get('SELECT * FROM customers WHERE id = ?', req.user.id)) });
});

store.get('/me', A.requireCustomer, (req, res) => res.json({ profile: profileOf(req.user) }));

store.patch('/me', A.requireCustomer, (req, res) => {
  const name = String(req.body.name || '').trim();
  const area = String(req.body.area || '').trim();
  if (name.length < 3) return bad(res, 400, 'bad_name', 'اكتبي اسمك بالكامل');
  run('UPDATE customers SET name = ?, area = ? WHERE id = ?', name, area || null, req.user.id);
  res.json({ profile: profileOf(get('SELECT * FROM customers WHERE id = ?', req.user.id)) });
});

store.put('/me/measurements', A.requireCustomer, (req, res) => {
  const keys = ['waist','hip','bust','length','sleeve','arm'];
  const vals = keys.map(k => toInt(req.body[k]));
  for (const v of vals) if (v !== null && (v < 20 || v > 250))
    return bad(res, 400, 'bad_measurement', 'القياسات لازم تكون بين 20 و 250 سم');
  run(`INSERT INTO measurements(customer_id,waist,hip,bust,length,sleeve,arm,updated_at)
       VALUES(?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(customer_id) DO UPDATE SET
         waist=excluded.waist, hip=excluded.hip, bust=excluded.bust,
         length=excluded.length, sleeve=excluded.sleeve, arm=excluded.arm,
         updated_at=datetime('now')`, req.user.id, ...vals);
  res.json({ measurements: get('SELECT * FROM measurements WHERE customer_id = ?', req.user.id) });
});

store.post('/auth/change-password', A.requireCustomer, (req,res)=>{
 const current=String(req.body.current||''), next=String(req.body.next||'');
 const customer=get('SELECT password_hash FROM customers WHERE id=?',req.user.id);
 if(!customer||!customer.password_hash||!A.verifyPassword(current,customer.password_hash))return bad(res,400,'wrong_password','كلمة المرور الحالية غير صحيحة');
 if(next.length<10||next.length>128)return bad(res,400,'weak_password','كلمة المرور الجديدة يجب أن تكون من 10 إلى 128 حرفًا');
 db.transaction(()=>{run('UPDATE customers SET password_hash=? WHERE id=?',A.hashPassword(next),req.user.id);run("DELETE FROM sessions WHERE realm='store' AND subject_id=? AND token_hash<>?",req.user.id,require('crypto').createHash('sha256').update(req.token).digest('hex'));audit('customer',req.user.id,'password_changed',`customer:${req.user.id}`)})();
 res.json({ok:true});
});

store.post('/auth/logout', A.requireCustomer, (req, res) => {
  A.destroySession(req.token);
  res.json({ ok: true });
});

/* ---- her own orders only ---- */
store.get('/orders', A.requireCustomer, (req, res) => {
  const rows = all('SELECT id FROM orders WHERE customer_id = ? ORDER BY id DESC', req.user.id);
  res.json({ orders: rows.map(r => D.customerOrderView(r.id, req.user.id)) });
});

store.get('/orders/:code', A.requireCustomer, (req, res) => {
  const o = get('SELECT id FROM orders WHERE code = ? AND customer_id = ?', req.params.code, req.user.id);
  if (!o) return bad(res, 404, 'not_found', 'الأوردر مش موجود');
  res.json({ order: D.customerOrderView(o.id, req.user.id) });
});

/* ---- place an order request ---- */
store.post('/orders', A.requireCustomer, (req, res) => {
  const { style_id, colour, length_cm, size, qty, delivery, note, governorate, fabric_choice } = req.body || {};
  const style = get('SELECT * FROM styles WHERE id = ? AND active = 1', String(style_id || ''));
  if (!style || style.type !== 'made') return bad(res, 400, 'bad_style', 'الموديل مش متاح');
  const gov=String(governorate||'').trim(), fabric=String(fabric_choice||'').trim();
  if (delivery && (gov.length<2 || gov.length>80 || /[<>&"'`\\]/.test(gov))) return bad(res,400,'governorate_required','اكتبي المحافظة للتوصيل');
  const allowed=catalogue.info(style.id).fabrics;
  if (fabric!=='قماش العميلة' && !allowed.includes(fabric)) return bad(res,400,'fabric_required','اختاري الخامة المتاحة أو قماشك الخاص');
  const q = Math.min(5, Math.max(1, toInt(qty, 1)));
  if (!Number.isInteger(q)) return bad(res,400,'bad_qty','العدد غير صالح');
  const colourOk = all('SELECT name FROM style_colours WHERE style_id = ?', style.id).map(r => r.name);
  if (colourOk.length && !colourOk.includes(colour))
    return bad(res, 400, 'bad_colour', 'اختاري لون من المتاح');
  const lens = all('SELECT cm FROM style_lengths WHERE style_id = ?', style.id).map(r => r.cm);
  const len = lens.length ? toInt(length_cm, lens[0]) : null;
  if (lens.length && !lens.includes(len))
    return bad(res, 400, 'bad_length', 'اختاري طول من المتاح');
  const sz = style.type === 'stock' ? String(size || '') : null;
  let stockVariant=null;
  if(style.type==='stock'){
    const variant=get('SELECT qty,buy_price FROM stock_items WHERE style_id=? AND size=? AND colour=?',style.id,sz,colour||'');
    if(!variant||variant.qty<q)return bad(res,409,'out_of_stock','المقاس أو اللون غير متاح بالكمية المطلوبة. لا يُحجز المخزون إلا عند تأكيد العربون.');
    stockVariant=variant;
  }

  if (style.type === 'made') {
    const m = get('SELECT * FROM measurements WHERE customer_id = ?', req.user.id);
    const filled = m && ['waist','hip','bust','length'].every(k => m[k] > 0);
    if (!filled) return bad(res, 422, 'measurements_required', 'التفصيل محتاج مقاساتك الأول');
  }

  const fee = 0; // Shipping is quoted by the owner, never guessed.
  const created = db.transaction(() => {
    const code = D.nextOrderCode();
    const promise = new Date(Date.now() + (style.lead_days || 7) * 864e5).toISOString().slice(0, 10);
    const r = run(`INSERT INTO orders(code,customer_id,channel,status,promise_date,delivery_fee,note,governorate,delivery_requested,shipping_quoted,fabric_choice)
                   VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
                  code, req.user.id, 'online', 'new', promise, fee, note || null, delivery?gov:null, delivery?1:0, delivery?0:1, fabric);
    const oid = r.lastInsertRowid;
    run('INSERT INTO order_deposits(order_id) VALUES(?)', oid);
    run(`INSERT INTO order_items(order_id,style_id,qty,colour,length_cm,size,unit_price,unit_cost)
         VALUES(?,?,?,?,?,?,?,?)`, oid, style.id, q, colour || null, len, sz, style.sale_price ?? style.price,stockVariant?stockVariant.buy_price:0);
    audit('order', code, 'created_online', `customer:${req.user.id}`, { style: style.id, qty: q, fee });
    return code;
  })();
  res.status(201).json({ order: D.customerOrderView(
    get('SELECT id FROM orders WHERE code = ?', created).id, req.user.id) });
});

// Multi-item checkout. Prices and available options are always checked on the server.
store.post('/cart-checkout', A.requireCustomer, (req,res)=>{
 const {items,delivery,governorate,note,request_id}=req.body||{};
 if(typeof request_id!=='string'||!/^[a-zA-Z0-9-]{16,80}$/.test(request_id)) return bad(res,400,'bad_request_id','تعذر التحقق من الطلب');
 const previous=get('SELECT order_id FROM cart_checkout_requests WHERE customer_id=? AND request_id=?',req.user.id,request_id);
 if(previous) return res.json({order:D.customerOrderView(previous.order_id,req.user.id)});
 if(!Array.isArray(items)||items.length<1||items.length>30) return bad(res,400,'bad_cart','السلة فارغة أو عدد القطع كبير');
 if(typeof delivery!=='boolean')return bad(res,400,'bad_delivery','اختاري طريقة الاستلام');
 const gov=String(governorate||'').trim(), message=String(note||'').trim();
 if(delivery&&(gov.length<2||gov.length>80||/[<>&"'`\\]/.test(gov)))return bad(res,400,'governorate_required','اكتبي المحافظة للتوصيل');
 if(message.length>1000)return bad(res,400,'bad_note','الملاحظة طويلة');
 const m=get('SELECT * FROM measurements WHERE customer_id=?',req.user.id);
 if(!m||!['waist','hip','bust','length'].every(k=>m[k]>0))return bad(res,422,'measurements_required','التفصيل محتاج مقاساتك الأول');
 const clean=[];
 for(const item of items){
  if(!item||typeof item!=='object')return bad(res,400,'bad_item','قطعة غير صالحة');
  if(item.type==='custom'){
   const draft=get('SELECT * FROM cart_custom_drafts WHERE id=? AND customer_id=? AND order_item_id IS NULL',Number(item.draft_id),req.user.id);
   if(!draft||clean.some(x=>x.draft&&x.draft.id===draft.id))return bad(res,400,'bad_custom','أحد التصميمات غير موجود أو مكرر');
   if(!get('SELECT count(*) n FROM cart_custom_images WHERE draft_id=?',draft.id).n)return bad(res,400,'no_image','التصميم الخاص يحتاج صورة');
   const qty=Number(item.qty);if(!Number.isInteger(qty)||qty<1||qty>5)return bad(res,400,'bad_qty','العدد غير صالح');
   clean.push({draft,qty});continue;
  }
  const style=get("SELECT * FROM styles WHERE id=? AND active=1 AND type='made'",String(item.style_id||''));
  if(!style)return bad(res,400,'bad_style','أحد الموديلات لم يعد متاحًا، راجعي السلة');
  const qty=Number(item.qty);if(!Number.isInteger(qty)||qty<1||qty>5)return bad(res,400,'bad_qty','العدد غير صالح');
  const fabric=String(item.fabric_choice||'').trim();
  if(fabric!=='قماش العميلة'&&!catalogue.info(style.id).fabrics.includes(fabric))return bad(res,400,'fabric_required','خامة أحد الموديلات لم تعد متاحة');
  const colours=all('SELECT name FROM style_colours WHERE style_id=?',style.id).map(x=>x.name);
  const colour=String(item.colour||'');if(colours.length&&!colours.includes(colour))return bad(res,400,'bad_colour','لون أحد الموديلات لم يعد متاحًا');
  const lens=all('SELECT cm FROM style_lengths WHERE style_id=?',style.id).map(x=>x.cm);
  const length=lens.length?Number(item.length_cm):null;
  if(lens.length&&(!Number.isInteger(length)||!lens.includes(length)))return bad(res,400,'bad_length','طول أحد الموديلات لم يعد متاحًا');
  const itemNote=String(item.note||'').trim(); if(itemNote.length>500)return bad(res,400,'bad_note','ملاحظة القطعة طويلة');
  clean.push({style,qty,colour:colour||null,length,fabric,itemNote});
 }
 const result=db.transaction(()=>{
  const old=get('SELECT order_id FROM cart_checkout_requests WHERE customer_id=? AND request_id=?',req.user.id,request_id);if(old)return old.order_id;
  const code=D.nextOrderCode(), days=Math.max(...clean.map(x=>x.draft?7:Number(x.style.lead_days)||7));
  const promise=clean.some(x=>x.draft)?null:new Date(Date.now()+days*864e5).toISOString().slice(0,10);
  const oid=run(`INSERT INTO orders(code,customer_id,channel,status,promise_date,delivery_fee,note,governorate,delivery_requested,shipping_quoted) VALUES(?,?,?,?,?,?,?,?,?,?)`,code,req.user.id,'online','new',promise,0,message||null,delivery?gov:null,delivery?1:0,delivery?0:1).lastInsertRowid;
  run('INSERT INTO order_deposits(order_id) VALUES(?)',oid);
  for(const x of clean){
   if(x.draft){
    run("INSERT OR IGNORE INTO styles(id,name,type,price,cost,active) VALUES('CUSTOM-DESIGN','تصميم خاص','made',0,0,0)");
    const it=run("INSERT INTO order_items(order_id,style_id,qty,colour,unit_price,unit_cost,fabric_choice,item_note,status) VALUES(?,'CUSTOM-DESIGN',?,?,0,0,?,?,'custom_pending')",oid,x.qty,x.draft.colour,x.draft.fabric_choice,x.draft.details).lastInsertRowid;
    const updated=run('UPDATE cart_custom_drafts SET order_item_id=? WHERE id=? AND customer_id=? AND order_item_id IS NULL',it,x.draft.id,req.user.id);if(!updated.changes)throw Error('التصميم مستخدم بالفعل');
   } else run('INSERT INTO order_items(order_id,style_id,qty,colour,length_cm,unit_price,unit_cost,fabric_choice,item_note) VALUES(?,?,?,?,?,?,?,?,?)',oid,x.style.id,x.qty,x.colour,x.length,x.style.sale_price??x.style.price,0,x.fabric,x.itemNote||null);
  }
  run('INSERT INTO cart_checkout_requests(customer_id,request_id,order_id) VALUES(?,?,?)',req.user.id,request_id,oid);
  audit('order',code,'created_online_cart',`customer:${req.user.id}`,{items:clean.length});return oid;
 })();
 res.status(201).json({order:D.customerOrderView(result,req.user.id)});
});

store.get('/notifications', A.requireCustomer, (req,res)=>{
 const notifications=all(`SELECT n.id,n.message,n.status,n.created_at,n.read_at,o.code FROM customer_notifications n JOIN orders o ON o.id=n.order_id WHERE n.customer_id=? ORDER BY n.id DESC LIMIT 50`,req.user.id);
 const unread=get('SELECT COUNT(*) n FROM customer_notifications WHERE customer_id=? AND read_at IS NULL',req.user.id).n;
 res.json({notifications,unread});
});
store.post('/notifications/read-all', A.requireCustomer, (req,res)=>{
 run("UPDATE customer_notifications SET read_at=datetime('now') WHERE customer_id=? AND read_at IS NULL",req.user.id);res.json({ok:true});
});
store.post('/notifications/:id/read', A.requireCustomer, (req,res)=>{
 const id=Number(req.params.id); if(!Number.isSafeInteger(id)||id<=0)return bad(res,400,'bad_id','الإشعار غير صالح');
 const result=run("UPDATE customer_notifications SET read_at=COALESCE(read_at,datetime('now')) WHERE id=? AND customer_id=?",id,req.user.id);
 if(!result.changes)return bad(res,404,'not_found','الإشعار غير موجود');
 res.json({ok:true});
});

app.use('/api/store', store);

/* ============================================================
   ADMIN API — staff + owner. Costs are nested under /money (owner only).
   ============================================================ */
const admin = express.Router();

/* ---- auth ---- */
admin.post('/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (email.length > 254 || password.length > 1024) return bad(res, 400, 'invalid_input', 'راجعي بيانات تسجيل الدخول');
  if (A.adminThrottled(email))
    return bad(res, 429, 'too_many_attempts', 'محاولات كتيرة — استني ١٥ دقيقة');
  const u = get('SELECT * FROM users WHERE email = ? AND active = 1', email);
  if (!u || !A.verifyPassword(password, u.password_hash)) {
    A.adminFailure(email);
    return bad(res, 401, 'bad_credentials', 'الإيميل أو الباسورد غلط');
  }
  A.adminClear(email);
  const days = req.body.remember === false ? 1 : 90;      // phone stays signed in
  const { token, expires } = A.createSession('admin', u.id, u.role, days);
  A.setSessionCookie(res, token, days);
  res.json({ token, expires, user: { id: u.id, name: u.name, email: u.email, role: u.role } });
});
admin.post('/auth/logout', A.requireStaff, (req, res) => {
  A.destroySession(req.token); A.clearSessionCookie(res); res.json({ ok: true });
});
admin.get('/me', A.requireStaff, (req, res) => res.json({ user: req.user }));

/* ---- styles: selling price is fine for staff, cost is not ---- */
admin.get('/styles', A.requireStaff, (req, res) => {
  const isOwner = req.user.role === 'owner';
  const rows = all("SELECT * FROM styles WHERE id <> 'MANUAL-CUSTOM' ORDER BY type DESC, id");
  res.json({ styles: list(rows, s => {
    const base = {
      ...catalogue.info(s.id), id: s.id, name: s.name, type: s.type, price: s.price, sale_price: s.sale_price, lead_days: s.lead_days,
      note: s.note, active: !!s.active,
      colours: all('SELECT name, hex FROM style_colours WHERE style_id = ? ORDER BY sort', s.id),
      lengths: all('SELECT cm FROM style_lengths WHERE style_id = ? ORDER BY cm', s.id).map(r => r.cm),
      sizes: all('SELECT size FROM style_sizes WHERE style_id = ?', s.id).map(r => r.size),
    };
    if (isOwner) base.cost = s.cost;          // ← only the owner ever sees this field
    return base;
  }) });
});

/* ---- reference data staff needs to run production ---- */
admin.get('/fabric', A.requireStaff, (_req, res) => {
  // The legacy stock/price columns remain in SQLite only to preserve history.
  res.json({ fabric: all('SELECT id,name,colour,details FROM fabric ORDER BY name,id') });
});
// Use the same fabric creation validation as the inventory section.
admin.post('/fabric', A.requireOwner, (req, res, next) => { req.url='/fabric'; require('./inventory-admin')(req,res,next); });

admin.get('/tailors', A.requireStaff, (req, res) => {
  const isOwner = req.user.role === 'owner';
  res.json({ tailors: all('SELECT * FROM tailors WHERE active = 1').map(t => ({
    id: t.id, name: t.name, phone: t.phone, address:t.address, notes:t.notes,
    ...(isOwner ? { rate_per_piece: t.rate_per_piece } : {}),
  })) });
});

admin.post('/tailors', A.requireOwner, (req,res)=>{
 const name=String(req.body.name||'').trim(),phone=String(req.body.phone||'').trim(),address=String(req.body.address||'').trim(),notes=String(req.body.notes||'').trim();
 const raw=req.body.rate_per_piece,rate=(raw===undefined||raw===null||String(raw).trim()==='')?0:Number(raw);
 if(name.length<2||name.length>80||phone.length>30||address.length>200||notes.length>500||/[<>&"'`\\]/.test(name+phone+address+notes)||!Number.isFinite(rate)||rate<0||rate>1e7)return bad(res,400,'bad_workshop','أدخلي اسم الورشة وراجعي البيانات الأخرى');
 const item=run('INSERT INTO tailors(name,phone,address,notes,rate_per_piece) VALUES(?,?,?,?,?)',name,phone||null,address||null,notes||null,rate);
 audit('tailor',item.lastInsertRowid,'created',`user:${req.user.id}`);res.status(201).json({id:Number(item.lastInsertRowid)});
});

admin.patch('/tailors/:id',A.requireOwner,(req,res)=>{
 const id=Number(req.params.id),old=get('SELECT * FROM tailors WHERE id=?',id);if(!old)return res.sendStatus(404);
 const b=req.body||{},field=k=>Object.prototype.hasOwnProperty.call(b,k)?b[k]:old[k];
 const name=String(field('name')??'').trim(),phone=String(field('phone')??'').trim(),address=String(field('address')??'').trim(),notes=String(field('notes')??'').trim(),raw=field('rate_per_piece'),rate=raw===undefined||raw===null||String(raw).trim()===''?0:Number(raw);
 if(name.length<2||name.length>80||phone.length>30||address.length>200||notes.length>500||/[<>&"'`\\]/.test(name+phone+address+notes)||!Number.isFinite(rate)||rate<0||rate>1e7)return bad(res,400,'bad_workshop','أدخلي اسم الورشة وراجعي البيانات');
 run('UPDATE tailors SET name=?,phone=?,address=?,notes=?,rate_per_piece=? WHERE id=?',name,phone||null,address||null,notes||null,rate,id);audit('tailor',id,'updated',`user:${req.user.id}`);res.json({ok:true});
});

admin.get('/stock', A.requireStaff, (req, res) => {
  const rows=all(`SELECT si.id,si.style_id,si.size,si.colour,si.qty,si.buy_price,s.name AS style_name,s.price AS sale_price FROM stock_items si JOIN styles s ON s.id=si.style_id ORDER BY s.name,si.size`);
  if(req.user.role!=='owner')rows.forEach(x=>delete x.buy_price);
  res.json({stock:rows});
});

/* ---- customers (staff can see contact details + measurements, per the matrix) ---- */
/* Owner help: hand a customer a login code (when they forgot their password
   and WhatsApp automation isn't connected). Owner only — never staff. */
admin.get('/customers/:id/login-code', A.requireOwner, (req, res) => {
  const c = get('SELECT * FROM customers WHERE id = ?', Number(req.params.id));
  if (!c) return bad(res, 404, 'not_found', 'العميلة مش موجودة');
  const row = A.latestCodeFor(c.phone);
  if (!row) return bad(res, 404, 'no_code', 'مفيش كود صالح — خليها تضغط «نسيت الپاسورد» الأول');
  audit('customer', c.id, 'login_code_viewed', `user:${req.user.id}`);
  res.json({ phone: c.phone, expires_at: row.expires_at });
});

// Only the owner may reset a customer's password after checking identity offline.
admin.post('/customers/:id/reset-password', A.requireOwner, (req, res) => {
  const id = Number(req.params.id), password = String(req.body?.password || '');
  if (!Number.isSafeInteger(id) || id < 1) return bad(res,400,'bad_customer','العميلة غير صالحة');
  if (password.length < 10 || password.length > 128) return bad(res,400,'weak_password','كلمة المرور يجب أن تكون من 10 إلى 128 حرفًا');
  if (!get('SELECT id FROM customers WHERE id=?', id)) return bad(res,404,'not_found','العميلة غير موجودة');
  db.transaction(() => {
    run('UPDATE customers SET password_hash=? WHERE id=?', A.hashPassword(password), id);
    run("DELETE FROM sessions WHERE realm='store' AND subject_id=?", id);
    audit('customer', id, 'password_reset_by_owner', `user:${req.user.id}`);
  })();
  res.json({ok:true});
});

admin.get('/customers', A.requireStaff, (req, res) => {
  res.json({ customers: all(`
    SELECT c.id,c.name,c.phone,c.area,c.created_at, m.waist, m.hip, m.bust, m.length, m.sleeve, m.arm,
           (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS orders_count
    FROM customers c LEFT JOIN measurements m ON m.customer_id = c.id
    ORDER BY c.id DESC`) });
});

/* ---- orders ---- */
function adminOrderRow(o) {
  const items = all(`SELECT oi.*, COALESCE(NULLIF(oi.description,''),s.name) AS style_name, s.type AS style_type,
                            f.name AS legacy_fabric_name, t.name AS legacy_tailor_name
                     FROM order_items oi JOIN styles s ON s.id = oi.style_id
                     LEFT JOIN fabric f ON f.id=oi.fabric_id LEFT JOIN tailors t ON t.id=oi.tailor_id
                     WHERE oi.order_id = ?`, o.id);
  // Names and metres are operational data; rates and purchase amounts remain owner-only.
  const purchasedFabrics=all('SELECT fabric_name,metres FROM order_fabric_purchases WHERE order_id=? ORDER BY id',o.id);
  const assignedWorkshops=all('SELECT order_item_id,tailor_name FROM order_workshop_costs WHERE order_id=? ORDER BY id',o.id);
  const c = get('SELECT id,name,phone,area FROM customers WHERE id = ?', o.customer_id);
  const t = D.orderTotals(o.id);
  return {
    id: o.id, code: o.code, channel: o.channel, status: o.status,
    promise_date: o.promise_date, created_at: o.created_at, note: o.note,
    delivery_fee: o.delivery_fee, governorate:o.governorate, delivery_requested:!!o.delivery_requested, shipping_quoted:!!o.shipping_quoted, fabric_choice:o.fabric_choice, manual_entry:!!o.manual_entry, discount: o.discount,
    customer: c, custom_price_pending:items.some(i=>i.status==='custom_pending'),
    measurements: get('SELECT * FROM measurements WHERE customer_id = ?', o.customer_id),
    purchased_fabrics: purchasedFabrics,
    items: items.map(i => ({
      id: i.id, style_id: i.style_id, style_name: i.style_name, style_type: i.style_type,
      qty: i.qty, colour: i.colour, length_cm: i.length_cm, size: i.size, fabric_choice:i.fabric_choice, item_note:i.item_note, status:i.status,
      unit_price: i.unit_price, fabric_id: i.fabric_id, metres_used: i.metres_used, legacy_fabric_name: i.legacy_fabric_name,
      tailor_id: i.tailor_id, workshop_names: [...new Set([i.legacy_tailor_name,...assignedWorkshops.filter(w=>w.order_item_id===i.id).map(w=>w.tailor_name)].filter(Boolean))],
    })),
    totals: t,   // staff get totals; the field NAME 'cost/profit' inside is stripped below
    late: o.status !== 'delivered' && o.status !== 'cancelled' &&
          o.promise_date && new Date(o.promise_date) < new Date(new Date().toDateString()),
  };
}

admin.get('/orders', A.requireStaff, (req, res) => {
  const status = req.query.status;
  const rows = status && status !== 'all'
    ? all('SELECT * FROM orders WHERE status = ? ORDER BY id DESC', status)
    : all('SELECT * FROM orders ORDER BY id DESC');
  const isOwner = req.user.role === 'owner';
  const orders = rows.map(o => {
    const r = adminOrderRow(o);
    if (!isOwner) { delete r.totals.cost; delete r.totals.profit; delete r.totals.margin; }
    return r;
  });
  res.json({ orders, counts: statusCounts() });
});

function statusCounts() {
  const rows = all('SELECT status, COUNT(*) n FROM orders GROUP BY status');
  const out = { all: 0 };
  for (const s of D.INTERNAL_STATUSES) out[s] = 0;
  rows.forEach(r => { out[r.status] = r.n; out.all += r.n; });
  return out;
}

admin.get('/orders/:code', A.requireStaff, (req, res) => {
  const o = get('SELECT * FROM orders WHERE code = ?', req.params.code);
  if (!o) return bad(res, 404, 'not_found', 'الأوردر مش موجود');
  const r = adminOrderRow(o);
  const isOwner = req.user.role === 'owner';
  if (!isOwner) { delete r.totals.cost; delete r.totals.profit; delete r.totals.margin; }
  else {
    r.payments=all('SELECT id,amount,method,created_at,note FROM payments WHERE order_id=? ORDER BY id DESC',o.id);
    r.items.forEach(i => Object.assign(i,get('SELECT unit_cost,cost_material,cost_tailoring,cost_other_base FROM order_items WHERE id=?',i.id)));
    const custom=get(`SELECT c.id,c.details,c.measurements,c.date_needed FROM custom_order_links l JOIN custom_requests c ON c.id=l.request_id WHERE l.order_id=?`,o.id);
    if(custom)r.custom_request={...custom,measurements:JSON.parse(custom.measurements)};
  }
  res.json({ order: r, message: D.buildMessage(o.id), role: req.user.role });
});

/* status change — staff allowed; money fields are NOT touched here */
admin.patch('/orders/:code/status', A.requireStaff, (req, res) => {
  const { status } = req.body || {};
  if (!D.INTERNAL_STATUSES.includes(status)) return bad(res, 400, 'bad_status', 'حالة غير معروفة');
  const o = get('SELECT * FROM orders WHERE code = ?', req.params.code);
  if (!o) return bad(res, 404, 'not_found', 'الأوردر مش موجود');
  const deposit = get('SELECT status FROM order_deposits WHERE order_id=?', o.id);
  if (deposit && deposit.status !== 'approved' && !['new','cancelled'].includes(status)) return bad(res,409,'deposit_required','لا يمكن بدء الطلب قبل تأكيد استلام العربون');
  if(o.status==='cancelled' && status!=='cancelled')return bad(res,409,'cancelled_order','الطلب الملغي لا يُعاد تشغيله؛ أنشئي طلبًا جديدًا');
  if(o.status==='delivered' && status==='cancelled' && get('SELECT COUNT(*) n FROM stock_reservations r JOIN order_items i ON i.id=r.order_item_id WHERE i.order_id=? AND r.released=0',o.id).n) return bad(res,409,'delivered_order','لا يمكن إلغاء طلب تم تسليمه تلقائيًا؛ راجعي المرتجع والمخزون يدويًا');
  db.transaction(()=>{if(status==='cancelled' && o.status!=='cancelled')inventory.release(o.id,`user:${req.user.id}`);if(status!==o.status){run("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?", status, o.id);Notifications.statusChanged(o,status);audit('order', o.code, 'status:' + status, `user:${req.user.id}`, { from: o.status });}})();
  const updated=adminOrderRow(get('SELECT * FROM orders WHERE id = ?', o.id));
  if(req.user.role!=='owner'){delete updated.totals.cost;delete updated.totals.profit;delete updated.totals.margin;}
  res.json({ order: updated, message: D.buildMessage(o.id) });
});

// Owner-only purchase and workshop-cost routes.
admin.use(orderCosts.router);

/* production details on an item: fabric, metres, tailor → this changes COST.
   Owner only, because it writes money. Staff can still move status. */
admin.patch('/order-items/:id/production', A.requireOwner, (req,res)=>{
 return bad(res,410,'production_moved','تم نقل مشتريات الخامات والورش إلى تفاصيل الأوردر. حدّثي الصفحة لإدخالها بدون مخزون.');
});

/* Flexible per-piece cost breakdown, visible and editable by the owner only. */
admin.get('/order-items/:id/cost-lines', A.requireOwner, (req,res) => {
 const i=get('SELECT id,unit_cost FROM order_items WHERE id=?',toInt(req.params.id));
 if(!i)return bad(res,404,'not_found','القطعة غير موجودة');
 res.json({unit_cost:i.unit_cost,lines:all('SELECT label,quantity,unit_cost FROM item_cost_lines WHERE item_id=? ORDER BY id',i.id)});
});
admin.put('/order-items/:id/cost-lines', A.requireOwner, (req,res) => {
 const i=get('SELECT * FROM order_items WHERE id=?',toInt(req.params.id));if(!i)return bad(res,404,'not_found','القطعة غير موجودة');
 const lines=req.body?.lines;if(!Array.isArray(lines)||lines.length>30)return bad(res,400,'bad_lines','راجعي بنود التكلفة');
 const clean=[];
 for(const line of lines){
  if(!line||typeof line!=='object'||line.quantity===null||line.unit_cost===null||String(line.quantity??'').trim()===''||String(line.unit_cost??'').trim()==='')return bad(res,400,'bad_line','راجعي اسم البند والكمية والتكلفة');
  const label=String(line.label||'').trim(),quantity=Number(line.quantity),unit=Number(line.unit_cost);
  if(!label||label.length>100||!Number.isFinite(quantity)||quantity<=0||quantity>100000||!Number.isFinite(unit)||unit<0||unit>10000000)return bad(res,400,'bad_line','راجعي اسم البند والكمية والتكلفة');
  clean.push({label,quantity,unit});
 }
 const oldExtra=get('SELECT COALESCE(SUM(quantity*unit_cost),0) n FROM item_cost_lines WHERE item_id=?',i.id).n;
 // Preserve the exact recorded historical total, including any unexplained
 // discrepancy in old classified snapshots. Only the explicit line delta changes it.
 let sum=i.unit_cost+(clean.reduce((a,x)=>a+x.quantity*x.unit,0)-oldExtra);
 if(sum < -1e-9)return bad(res,409,'legacy_inconsistent','التكلفة القديمة وبنودها غير متسقة؛ راجعيها قبل الحذف أو التخفيض حتى لا تصبح سالبة.');
 if(Math.abs(sum)<1e-9)sum=0;
 db.transaction(()=>{run('DELETE FROM item_cost_lines WHERE item_id=?',i.id);for(const x of clean)run('INSERT INTO item_cost_lines(item_id,label,quantity,unit_cost) VALUES(?,?,?,?)',i.id,x.label,x.quantity,x.unit);run('UPDATE order_items SET unit_cost=? WHERE id=?',sum,i.id);audit('order_item',i.id,'cost_lines',`user:${req.user.id}`,{total:sum})})();res.json({unit_cost:sum});
});

/* ---- payments: money out/in is owner-only ---- */
admin.post('/orders/:code/payments', A.requireOwner, (req, res) => {
  const o = get('SELECT * FROM orders WHERE code = ?', req.params.code);
  if (!o) return bad(res, 404, 'not_found', 'الأوردر مش موجود');
  if(get("SELECT count(*) n FROM order_items WHERE order_id=? AND status='custom_pending'",o.id).n)return bad(res,409,'price_pending','سعّري التصميمات الخاصة قبل تسجيل الدفع');
  const amount = Number(req.body.amount);
  if (!(amount > 0)) return bad(res, 400, 'bad_amount', 'المبلغ لازم يكون أكبر من صفر');
  const method = String(req.body.method || 'cash');
  run('INSERT INTO payments(order_id,amount,method,note) VALUES(?,?,?,?)',
      o.id, amount, method, req.body.note || null);
  audit('order', o.code, 'payment', `user:${req.user.id}`, { amount, method });
  res.status(201).json({ totals: D.orderTotals(o.id) });
});

/* ---- money zone: owner only, one prefix, one guard ---- */
admin.get('/money/summary', A.requireOwner, (_req, res) => {
  const orders = all("SELECT * FROM orders o WHERE status != 'cancelled' AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending')");
  let revenue = 0, cost = 0, outstanding = 0, overpaid = 0;
  for (const o of orders) {
    const t = D.orderTotals(o.id);
    revenue += t.total; cost += t.cost; outstanding += Math.max(0,t.due); overpaid += Math.max(0,-t.due);
  }
  const expenses = get('SELECT COALESCE(SUM(amount),0) t FROM expenses').t;
  const paid = get("SELECT COALESCE(SUM(amount),0) t FROM payments").t;
  const cancelledPaid = get("SELECT COALESCE(SUM(p.amount),0) t FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.status='cancelled'").t;
  const cancelled=all("SELECT id FROM orders WHERE status='cancelled'");
  const pending=all("SELECT id FROM orders o WHERE status!='cancelled' AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending')");
  const recordedCost=list=>list.reduce((sum,o)=>sum+D.orderTotals(o.id).cost,0);
  res.json({
    revenue, cost, gross_profit: revenue - cost, expenses,
    net_profit: revenue - cost - expenses, collected: paid, cancelled_paid: cancelledPaid,
    outstanding, overpaid, orders: orders.length, pending_unpriced:pending.length,
    excluded_cancelled_cost:recordedCost(cancelled), excluded_unpriced_cost:recordedCost(pending),
  });
});

admin.get('/money/period', A.requireOwner, (req,res) => {
 const from=String(req.query.from||''),to=String(req.query.to||'');
 if(!validDate(from)||!validDate(to)||from>to)return bad(res,400,'bad_dates','اختاري فترة صحيحة');
 const orders=all("SELECT * FROM orders o WHERE status != 'cancelled' AND mavi_cairo_date(created_at) BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending')",from,to);
 let sales=0,cost=0,outstanding=0,overpaid=0;for(const o of orders){const t=D.orderTotals(o.id);sales+=t.total;cost+=t.cost;outstanding+=Math.max(0,t.due);overpaid+=Math.max(0,-t.due);}
 const expenses=get('SELECT COALESCE(SUM(amount),0) total FROM expenses WHERE date(spent_on) BETWEEN ? AND ?',from,to).total;
 const cash=get("SELECT COALESCE(SUM(p.amount),0) total FROM payments p JOIN orders o ON o.id=p.order_id WHERE mavi_cairo_date(p.created_at) BETWEEN ? AND ?",from,to).total;
 res.json({from,to,orders:orders.length,sales,cost,expenses,profit:sales-cost-expenses,collected_in_period:cash,outstanding_for_period_orders:outstanding,overpaid_for_period_orders:overpaid});
});

admin.get('/money/cost-detail', A.requireOwner, (req, res) => {
  const from=String(req.query.from||''), to=String(req.query.to||'');
  if(!validDate(from)||!validDate(to)||from>to)
    return bad(res,400,'bad_dates','اختاري فترة صحيحة');
  res.json(orderCosts.costDetail(from,to));
});

admin.get('/money/outstanding', A.requireOwner, (_req, res) => {
  res.json({ rows: all(`SELECT * FROM orders o WHERE status NOT IN ('cancelled') AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending')`).map(o => {
    const t = D.orderTotals(o.id);
    return { code: o.code, customer: get('SELECT name FROM customers WHERE id = ?', o.customer_id)?.name,
             total: t.total, paid: t.paid, due: t.due };
  }).filter(r => r.due > 0) });
});

admin.get('/money/reports', A.requireOwner, (_req, res) => {
  const byStyle = {}, colours = {};
  const orders=all("SELECT id FROM orders o WHERE status != 'cancelled' AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending')");
  for (const order of orders) {
    for (const item of all('SELECT style_id,qty,unit_price,colour FROM order_items WHERE order_id=?',order.id)) {
      const row=byStyle[item.style_id] ||= { style_id:item.style_id, qty:0, revenue:0 };
      row.qty += item.qty;
      row.revenue += item.unit_price * item.qty; // before order-level discount and customer delivery
      if(item.colour)colours[item.colour]=(colours[item.colour]||0)+item.qty;
    }
  }
  res.json({
    // The order-level purchases cannot be reliably attributed to individual designs.
    // Null means unknown, not zero; do not advertise a fictitious product profit.
    by_style: Object.values(byStyle).map(row=>({ ...row,
      name:get('SELECT name FROM styles WHERE id=?',row.style_id)?.name,
      cost:null,profit:null,margin:null,profit_available:false,
    })).sort((a,b)=>b.revenue-a.revenue),
    colours:Object.entries(colours).sort((a,b)=>b[1]-a[1]).map(([colour,qty])=>({colour,qty})),
    expenses:all('SELECT * FROM expenses ORDER BY spent_on DESC'),
  });
});

admin.get('/money/expenses', A.requireOwner, (_req, res) =>
  res.json({ expenses: all('SELECT * FROM expenses ORDER BY spent_on DESC') }));
admin.post('/money/expenses', A.requireOwner, (req, res) => {
  const { category, amount, spent_on, note } = req.body || {};
  if (!category || !(Number(amount) > 0)) return bad(res, 400, 'bad_input', 'البند والمبلغ مطلوبين');
  const r = run('INSERT INTO expenses(category,amount,spent_on,note) VALUES(?,?,?,?)',
                category, Number(amount), spent_on || new Date().toISOString().slice(0, 10), note || null);
  res.status(201).json({ id: r.lastInsertRowid });
});

/* ---- dashboard: shared shape, money fields stripped for staff ---- */
admin.get('/dashboard', A.requireStaff, (req, res) => {
  const isOwner = req.user.role === 'owner';
  const open = all("SELECT * FROM orders WHERE status NOT IN ('delivered','cancelled')");
  const late = open.filter(o => o.promise_date && new Date(o.promise_date) < new Date(new Date().toDateString()));
  const out = {
    counts: statusCounts(),
    open_orders: open.length,
    late_orders: late.length,
    ready: get("SELECT COUNT(*) n FROM orders WHERE status='ready'").n,
    today: new Date().toISOString().slice(0, 10),
  };
  if (isOwner) {
    const s = all("SELECT * FROM orders o WHERE status != 'cancelled' AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending')").reduce((acc, o) => {
      const t = D.orderTotals(o.id); acc.rev += t.total; acc.cost += t.cost; acc.due += Math.max(0,t.due); return acc;
    }, { rev: 0, cost: 0, due: 0 });
    out.money = { revenue: s.rev, cost: s.cost, gross_profit: s.rev - s.cost, outstanding: s.due, pending_unpriced:get("SELECT count(*) n FROM orders o WHERE o.status!='cancelled' AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending')").n };
  }
  res.json(out);
});

/* ---- backups + account safety: owner only ---- */
admin.get('/system/backup', A.requireOwner, async (req, res) => {
  // SQLite's backup API captures committed WAL changes in a consistent snapshot.
  const fs = require('fs');
  const os = require('os');
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-backup-'));
    const file = path.join(dir, 'snapshot.db');
    audit('system', 'backup', 'download', `user:${req.user.id}`, {});
    await db.backup(file);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.download(file, `mavi-backup-${stamp}.db`, err => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (err && !res.headersSent) res.status(500).json({ error: 'backup_failed' });
    });
  } catch (err) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    if (!res.headersSent) res.status(500).json({ error: 'backup_failed' });
  }
});

admin.post('/system/public-url', A.requireOwner, (req, res) => {
  const url = String(req.body.url || '').trim().replace(/\/+$/, '');
  if (url && !/^https?:\/\/[^\s]+$/.test(url))
    return bad(res, 400, 'bad_url', 'لازم يبدأ بـ https://');
  run("INSERT INTO settings(key,value) VALUES('public_url',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", url);
  audit('system', 'public_url', 'updated', `user:${req.user.id}`, { url });
  res.json({ ok: true, public_url: url });
});

/* Owner-only QR + printable share card so customers can reach the shop. */
/* Owner-only QR + share card. Accepts the session cookie as well as the bearer
   token, so a plain <img>/<a> in the dashboard works without JS header tricks. */
const ownerByCookie = (req, res, next) => {
  if (!req.user && A.readToken(req)) {
    const row = A.resolve(A.readToken(req));
    if (row && row.realm === 'admin' && row.role === 'owner') { req.user = row; return next(); }
  }
  if (req.user && req.user.role === 'owner') return next();
  return bad(res, 401, 'unauthorized', 'محتاج تسجيل دخول المالكة');
};

admin.get('/system/qr', ownerByCookie, (req, res) => {
  const base = (setting('public_url', '') || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  const shopUrl = `${base}/store/`;
  const size = Math.min(Math.max(Number(req.query.size) || 8, 3), 20);
  const px = size * 40;
  try {
    require('qrcode').toBuffer(shopUrl, {
      type: 'png', width: px, margin: 2,
      color: { dark: '#121E48FF', light: '#FFFFFFFF' },
    }).then((buf) => { res.type('image/png').send(buf); })
      .catch(() => res.status(500).json({ error: 'qr_failed' }));
  } catch (e) {
    res.redirect(`https://api.qrserver.com/v1/create-qr-code/?size=${px}x${px}&data=${encodeURIComponent(shopUrl)}`);
  }
});

admin.get('/system/share-card', ownerByCookie, (req, res) => {
  const base = (setting('public_url', '') || '').replace(/\/+$/, '') || `${req.protocol}://${req.get('host')}`;
  const shop = `${base}/store/`;
  res.type('html').send(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<title>MAVI — كارت المتجر</title>
<style>
  body{margin:0;font-family:"Segoe UI",Tahoma,sans-serif;background:#F6F0EA;display:grid;place-items:center;min-height:100vh}
  .card{width:340px;background:#fff;border-radius:20px;padding:26px 22px;text-align:center;
        box-shadow:0 14px 34px rgba(18,30,72,.16);border:1px solid #EADFD2}
  h1{font-size:24px;letter-spacing:.16em;color:#121E48;margin:12px 0 2px}
  .tag{font-size:9.5px;letter-spacing:.32em;color:#B08D57;font-weight:600}
  .ar{font-size:12.5px;color:#1D2F6F;margin:10px 0 16px;font-weight:700}
  img.qr{width:190px;height:190px}
  .link{font-size:10.5px;color:#7A8299;direction:ltr;margin-top:8px;word-break:break-all}
  .wa{display:inline-block;margin-top:14px;background:#121E48;color:#fff;border-radius:11px;
      padding:9px 16px;font-size:12px;font-weight:700;text-decoration:none}
  @media print{body{background:#fff} .card{box-shadow:none}}
</style></head><body>
  <div class="card">
    <img src="/brand/emblem.png" style="width:74px;height:74px;border-radius:50%">
    <h1>MAVI</h1><div class="tag">TAILOR YOUR DESIGN</div>
    <div class="ar">فصّلي على مقاسك — امسحي الكود واطلبي من موبايلك</div>
    <img class="qr" src="/api/admin/system/qr?size=10" alt="QR">
    <div class="link">${shop}</div>
    <a class="wa" href="https://wa.me/201013979358?text=${encodeURIComponent('أهلاً Mavi 🤍 عايزة أطلب — ' + shop)}">ابعتيها على واتساب</a>
  </div>
  <script>if(location.search.includes('print'))window.print();</script>
</body></html>`);
});

admin.get('/system/info/status', A.requireOwner, (_req, res) => {
  res.json({
    database: (process.env.DB_PATH || 'data/mavi.db').split(/[\\/]/).pop(),
    persistent_disk: /^\/data\//.test(process.env.DB_PATH || '') || !!process.env.DB_PATH,
    orders: get('SELECT COUNT(*) n FROM orders').n,
    customers: get('SELECT COUNT(*) n FROM customers').n,
    public_url: (setting('public_url', '') || '').replace(/\/+$/, ''),
    last_backup: get("SELECT created_at FROM events WHERE action='download' AND entity='system' ORDER BY id DESC LIMIT 1")?.created_at || null,
  });
});

admin.post('/system/change-password', A.requireOwner, (req, res) => {
  const { current, next } = req.body || {};
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!A.verifyPassword(String(current || ''), u.password_hash))
    return bad(res, 401, 'bad_password', 'الباسورد الحالي غلط');
  if (String(next || '').length < 8)
    return bad(res, 400, 'weak_password', 'الباسورد الجديد لازم ٨ حروف على الأقل');
  run('UPDATE users SET password_hash = ? WHERE id = ?', A.hashPassword(String(next)), req.user.id);
  audit('user', u.id, 'password_changed', `user:${req.user.id}`);
  res.json({ ok: true });
});

app.use('/api/admin', admin);

/* ============================================================
   static faces
   ============================================================ */
app.use(require('./store-search-pages')({get, all}));
// Force current admin HTML/JS after a release; old stock-based forms are incompatible.
app.use('/admin', (_req, res, next) => { res.set('Cache-Control','no-store, max-age=0'); next(); });
app.use(express.static(path.join(__dirname, '..', 'public'), { index: false }));
/* ---- installable app (PWA): manifest + service worker ----
   Gives an app icon on the phone home screen without any app store. */
app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json').json({
    name: 'MAVI — فصّلي على مقاسك',
    short_name: 'MAVI',
    description: 'عبايات وفساتين بمقاسك · طلباتك ومتابعتها',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#F6F0EA',
    theme_color: '#121E48',
    lang: 'ar',
    dir: 'rtl',
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  });
});

app.get('/sw.js', (_req, res) => {
  res.type('application/javascript').send(`
    const CACHE = 'mavi-v1';
    self.addEventListener('install', e => { self.skipWaiting(); });
    self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
    self.addEventListener('push', e => {
      let realm='store',lang='ar',eventId=null; try { const data=e.data ? e.data.json() : {}; if(data.realm==='admin')realm='admin'; if(data.lang==='en')lang='en'; if(Number.isSafeInteger(data.event_id)&&data.event_id>0)eventId=data.event_id; } catch(_) {}
      e.waitUntil(self.registration.showNotification('MAVI', {body:lang==='en'?'You have a new MAVI update. Open your account for details.':'لديك تحديث جديد في MAVI. افتحي حسابك للتفاصيل.',icon:'/brand/icon-192.png',badge:'/brand/icon-192.png',data:{realm,eventId}}));
    });
    self.addEventListener('notificationclick', e => {
      e.notification.close();
      let url=e.notification.data && e.notification.data.realm==='admin' ? '/admin/?view=orders' : '/store/?view=mine'; const id=e.notification.data && e.notification.data.eventId; if(Number.isSafeInteger(id)&&id>0)url+='&alert='+encodeURIComponent(id);
      e.waitUntil(clients.openWindow(url));
    });
    // network-first: never serve stale prices or stale order status
    self.addEventListener('fetch', e => {
      if (e.request.method !== 'GET') return;
      e.respondWith(
        fetch(e.request).catch(() => caches.match(e.request))
      );
    });
  `);
});

/* Landing page: two doors. Served at '/' so a beginner who opens the site
   without a path can reach BOTH the shop and the admin panel.
   Works from the filesystem root too (GitHub Pages, shared hosting). */
const LANDING = path.join(__dirname, '..', 'public', 'index.html');
app.get('/', (_req, res) => res.sendFile(LANDING));

app.get('/store/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'store', 'index.html')));
/* the page route must never be handled by the static mount above */
app.get('/admin/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));
app.get('/admin', (_req, res) => res.redirect('/admin/'));

/* error handler */
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error', message: 'حصل خطأ غير متوقع' });
});

/* housekeeping once an hour */
setInterval(() => { try { A.pruneExpired(); } catch (e) { console.error('prune', e); } }, 3600e3);

if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Mavi ERP  →  http://localhost:${PORT}/store/   (customer)`);
    console.log(`            →  http://localhost:${PORT}/admin/   (staff & owner)`);
  });
}

module.exports = app;
