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
const lifecycle = require('./order-lifecycle');
const reports = require('./reporting');
const { validDate } = require('./business-date');
const publicCache = require('./public-cache');
const { stagingMiddleware, isStagingMode } = require('./staging-guard');

const app = express();
// Health checks do not parse user cookies or depend on authentication.
// The database is still tested; do not report success when it fails.
app.get('/healthz', (_req, res) => {
  res.set('Cache-Control','no-store');
  if (isStagingMode()) res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  try { get('SELECT 1'); res.json({ ok:true, uptime:Math.round(process.uptime()) }); }
  catch (e) { console.error('[mavi-health] sqlite check failed'); res.status(503).json({ok:false}); }
});
require('./health-monitor').startLocalHealthProbe();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const PORT = process.env.PORT || 3000;
const DEV_SHOW_OTP = process.env.SHOW_OTP === '1' && process.env.NODE_ENV !== 'production';
if (process.env.NODE_ENV === 'production' && process.env.SHOW_OTP === '1') {
  console.error('[SECURITY] SHOW_OTP=1 is ignored in production — login codes are never returned in the API.');
}
const CUSTOMER_SESSION_DAYS = 60;
const ADMIN_SESSION_DAYS = 30;
const BAD_TEXT = /[<>&"'`\\\x00-\x1f\x7f]/;
const escHtml = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const maskIdentifier = (s) => {
  const v = String(s || '').trim();
  if (!v) return 'empty';
  if (v.includes('@')) { const [u, d] = v.split('@'); return `${u.slice(0, 2)}***@${d || ''}`; }
  return v.length <= 4 ? '***' : `${v.slice(0, 3)}***${v.slice(-3)}`;
};
function auditAuthFailure(realm, target, reason) {
  try { audit('auth', realm, reason, 'anon', { target: maskIdentifier(target) }); } catch (_) {}
  if (reason === 'rate_limited') console.warn(`[SECURITY] ${realm} rate_limited target=${maskIdentifier(target)}`);
}
const DEFAULT_CSP = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com; connect-src 'self' https://www.google-analytics.com https://region1.google-analytics.com https://*.google-analytics.com https://www.googletagmanager.com https://analytics.google.com https://*.analytics.google.com; worker-src 'self'; manifest-src 'self'";
const IS_SANDBOX_PREVIEW = process.env.MAVI_SANDBOX_PREVIEW === '1' && process.env.NODE_ENV !== 'production';
const PREVIEW_CSP = DEFAULT_CSP.replace("frame-ancestors 'none'", 'frame-ancestors *');

app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.path !== '/healthz' && req.get('x-forwarded-proto') === 'http') {
    const host = String(req.get('host') || '').replace(/[^A-Za-z0-9.:-]/g, '');
    if (host) return res.redirect(301, `https://${host}${req.originalUrl}`);
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!IS_SANDBOX_PREVIEW) {
    res.setHeader('X-Frame-Options', 'DENY');
  }
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', IS_SANDBOX_PREVIEW ? PREVIEW_CSP : DEFAULT_CSP);
  if (process.env.NODE_ENV === 'production' && (req.secure || req.get('x-forwarded-proto') === 'https')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  if (req.path.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (origin) {
      try {
        if (new URL(origin).host !== req.get('host')) {
          return res.status(403).json({ error: 'csrf_blocked', message: 'طلب غير مصرح به من مصدر خارجي' });
        }
      } catch {
        return res.status(403).json({ error: 'csrf_blocked', message: 'طلب غير مصرح به من مصدر خارجي' });
      }
    }
  }
  next();
});
app.use(stagingMiddleware);

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
for (const p of ['/api/store/custom-requests','/api/store/cart-custom','/api/admin/catalogue','/api/store/order-deposits','/api/admin/order-deposits','/api/admin/custom-requests']) app.use(p,limitLargeUpload);
app.use('/api/store/custom-requests', express.json({limit:'3mb'}));
app.use('/api/store/cart-custom', express.json({limit:'3mb'}));
app.use('/api/admin/catalogue', express.json({limit:'3mb'}));
app.use('/api/store/order-deposits', express.json({limit:'3mb'}));
app.use('/api/admin/order-deposits', express.json({limit:'3mb'}));
app.use('/api/admin/custom-requests', express.json({limit:'3mb'}));
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
store.get('/catalogue', (req, res) => {
  const cached = publicCache.getOrCompute('catalogue_json', 30000, () => {
    const styles = all(`SELECT id, name, type, price, sale_price, lead_days, note FROM styles
                        WHERE active = 1 AND type = 'made' ORDER BY id`);
    const details = catalogue.detailsBatch(styles.map(s => s.id));
    const out = list(styles, s => {
      const d = details.get(s.id) || { images: [], fabrics: [], sections: [], colours: [], lengths: [], sizes: [], variants: [], in_stock: 0 };
      return {
        images: d.images, fabrics: d.fabrics, sections: d.sections,
        id: s.id, name: s.name, type: s.type, price: s.sale_price ?? s.price, original_price: s.sale_price !== null ? s.price : null,
        lead_days: s.lead_days, note: s.note,
        colours: d.colours,
        lengths: d.lengths,
        sizes:   d.sizes,
        variants: s.type === 'stock' ? d.variants : [],
        in_stock: s.type === 'stock' ? d.in_stock : null,
      };
    });
    return JSON.stringify({ styles: out });
  });
  res.set('Cache-Control', 'public, max-age=60');
  res.set('ETag', cached.etag);
  if (req.headers['if-none-match'] === cached.etag) return res.sendStatus(304);
  res.type('application/json').send(cached.value);
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
  if (password.length < 8 || password.length > 128)
    return bad(res, 400, 'weak_password', 'الباسورد لازم ٨ حروف أو أرقام على الأقل');
  if (name.length < 2 || name.length > 80 || BAD_TEXT.test(name))
    return bad(res, 400, 'bad_name', 'اكتبي اسمك بدون رموز غير صالحة');
  if (get('SELECT id FROM customers WHERE phone = ?', phone))
    return bad(res, 409, 'phone_taken', 'الرقم ده متسجل قبل كده — ادخلي بالباسورد');
  const ins = run('INSERT INTO customers(phone,name,password_hash) VALUES(?,?,?)',
                  phone, name, A.hashPassword(password));
  const c = get('SELECT * FROM customers WHERE id = ?', ins.lastInsertRowid);
  const { token, expires } = A.createSession('store', c.id, 'customer', CUSTOMER_SESSION_DAYS);
  A.setSessionCookie(res, token, CUSTOMER_SESSION_DAYS, 'store');
  res.json({ token, expires, profile: profileOf(c) });
});

store.post('/auth/login', (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  const password = String(req.body.password || '');
  if (phone.length > 20 || password.length > 1024) return bad(res, 400, 'invalid_input', 'راجعي بيانات تسجيل الدخول');
  if (A.throttled(phone)) {
    auditAuthFailure('store', phone, 'rate_limited');
    return bad(res, 429, 'too_many_attempts', 'محاولات كتيرة — استني ١٠ دقايق');
  }
  const c = get('SELECT * FROM customers WHERE phone = ?', phone);
  if (c && !c.password_hash)
    return bad(res, 409, 'needs_password',
      'الرقم مسجل بالفعل — تواصلي مع MAVI لمساعدتك في استعادة حسابك');
  if (!c) {
    A.noteFailure(phone);
    auditAuthFailure('store', phone, 'login_failed');
    return bad(res, 401, 'bad_login', 'الرقم أو الباسورد غلط');
  }
  if (!A.verifyPassword(password, c.password_hash)) {
    A.noteFailure(phone);
    auditAuthFailure('store', phone, 'login_failed');
    return bad(res, 401, 'bad_login', 'الرقم أو الباسورد غلط');
  }
  A.clearFailures(phone);
  const { token, expires } = A.createSession('store', c.id, 'customer', CUSTOMER_SESSION_DAYS);
  A.setSessionCookie(res, token, CUSTOMER_SESSION_DAYS, 'store');
  res.json({ token, expires, profile: profileOf(c) });
});

/* ---- fallback: codes the brand sends herself over WhatsApp ---- */
async function await_notify(phone, code) {
  try { return await require('./notify').sendCode(phone, code); }
  catch (e) { return { sent: false, channel: 'brand' }; }
}

store.post('/auth/request-code', async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  if (!/^01[0-9]{9}$/.test(phone))
    return bad(res, 400, 'bad_phone', 'رقم الموبايل لازم يبدأ بـ 01 ويكون 11 رقم');
  try {
    const code = A.issueOtp(phone);
    if (DEV_SHOW_OTP && process.env.NODE_ENV !== 'production') console.log('[OTP] development code generated');
    const r = await await_notify(phone, code);
    res.json({ ok: true, expires_in_minutes: 5,
               channel: r.channel,                 // 'whatsapp' = automatic, 'brand' = we'll send it
               dev_code: DEV_SHOW_OTP ? code : undefined });
  } catch (e) {
    if (e.status === 429) {
      auditAuthFailure('store', phone, 'rate_limited');
      return bad(res, 429, 'too_many_requests', 'بعتنالك أكواد كتير — استني شوية');
    }
    throw e;
  }
});

store.post('/auth/verify', (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  const code = String(req.body.code || '').trim();
  const r = A.consumeOtp(phone, code);
  if (!r.ok) {
    auditAuthFailure('store', phone, r.reason === 'too_many_attempts' ? 'rate_limited' : 'otp_failed');
    const msg = { no_code: 'اطلبي كود جديد', expired: 'الكود انتهى — اعملي كود جديد',
                  wrong_code: 'الكود غلط', too_many_attempts: 'محاولات كتيرة — اعملي كود جديد' }[r.reason];
    return bad(res, 401, r.reason, msg);
  }
  let c = get('SELECT * FROM customers WHERE phone = ?', phone);
  if (!c) {
    const ins = run('INSERT INTO customers(phone,name) VALUES(?,?)', phone, 'عميلة جديدة');
    c = get('SELECT * FROM customers WHERE id = ?', ins.lastInsertRowid);
  }
  const { token, expires } = A.createSession('store', c.id, 'customer', CUSTOMER_SESSION_DAYS);
  A.setSessionCookie(res, token, CUSTOMER_SESSION_DAYS, 'store');
  res.json({ token, expires, profile: profileOf(c) });
});

function profileOf(c) {
  const m = get('SELECT * FROM measurements WHERE customer_id = ?', c.id);
  return { id: c.id, name: c.name, phone: c.phone, area: c.area,
           has_password: !!c.password_hash, measurements: m || null };
}

store.post('/auth/set-password', A.requireCustomer, (req, res) => {
  const password = String(req.body.password || '');
  if (password.length < 8 || password.length > 128)
    return bad(res, 400, 'weak_password', 'الباسورد لازم ٨ حروف أو أرقام على الأقل');
  db.transaction(() => {
    run('UPDATE customers SET password_hash = ? WHERE id = ?',
        A.hashPassword(password), req.user.id);
    if (req.token) run("DELETE FROM sessions WHERE realm='store' AND subject_id=? AND token_hash<>?", req.user.id, A.sha256(req.token));
    audit('customer', req.user.id, 'password_set', `customer:${req.user.id}`);
  })();
  res.json({ ok: true, profile: profileOf(get('SELECT * FROM customers WHERE id = ?', req.user.id)) });
});

store.get('/me', A.requireCustomer, (req, res) => res.json({ profile: profileOf(req.user) }));

store.patch('/me', A.requireCustomer, (req, res) => {
  const name = String(req.body.name || '').trim();
  const area = String(req.body.area || '').trim();
  if (name.length < 3 || name.length > 80 || (name !== req.user.name && BAD_TEXT.test(name)))
    return bad(res, 400, 'bad_name', 'اكتبي اسمك بالكامل بدون رموز غير صالحة');
  if (area.length > 120 || (area && area !== (req.user.area || '') && BAD_TEXT.test(area)))
    return bad(res, 400, 'bad_area', 'اسم المنطقة طويل أو فيه رموز غير مسموحة');
  run('UPDATE customers SET name = ?, area = ? WHERE id = ?', name, area || null, req.user.id);
  res.json({ profile: profileOf(get('SELECT * FROM customers WHERE id = ?', req.user.id)) });
});

store.put('/me/measurements', A.requireCustomer, (req, res) => {
  const keys = ['waist','hip','bust','shoulder','length','sleeve','arm'];
  const vals = keys.map(k => toInt(req.body[k]));
  for (const v of vals) if (v !== null && (v < 20 || v > 250))
    return bad(res, 400, 'bad_measurement', 'القياسات لازم تكون بين 20 و 250 سم');
  run(`INSERT INTO measurements(customer_id,waist,hip,bust,shoulder,length,sleeve,arm,updated_at)
       VALUES(?,?,?,?,?,?,?,?,datetime('now'))
       ON CONFLICT(customer_id) DO UPDATE SET
         waist=excluded.waist, hip=excluded.hip, bust=excluded.bust,
         shoulder=excluded.shoulder, length=excluded.length,
         sleeve=excluded.sleeve, arm=excluded.arm,
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
  A.clearSessionCookie(res, 'store');
  res.json({ ok: true });
});

/* ---- her own orders only ---- */
store.get('/orders', A.requireCustomer, (req, res) => {
  const rows = all('SELECT id FROM orders WHERE customer_id = ? ORDER BY id DESC', req.user.id);
  res.json({ orders: rows.map(r => D.customerOrderView(r.id, req.user.id)) });
});

store.get('/orders/:code', A.requireCustomer, (req, res) => {
  const o = D.orderByCode(req.params.code);
  if (!o || o.customer_id !== req.user.id) return bad(res, 404, 'not_found', 'الأوردر مش موجود');
  res.json({ order: D.customerOrderView(o.id, req.user.id) });
});

/* ---- place an order request ---- */
store.post('/orders', A.requireCustomer, (req, res) => {
  const { style_id, colour, length_cm, size, qty, delivery, note, governorate, fabric_choice } = req.body || {};
  const style = get('SELECT * FROM styles WHERE id = ? AND active = 1', String(style_id || ''));
  if (!style || style.type !== 'made') return bad(res, 400, 'bad_style', 'الموديل مش متاح');
  const gov=String(governorate||'').trim(), fabric=String(fabric_choice||'').trim();
  const orderNote = note === undefined || note === null ? '' : (typeof note === 'string' ? note.trim() : null);
  if (orderNote === null || orderNote.length > 1000) return bad(res,400,'bad_note','الملاحظة طويلة أو غير صالحة');
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
                  code, req.user.id, 'online', 'new', promise, fee, orderNote || null, delivery?gov:null, delivery?1:0, delivery?0:1, fabric);
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
admin.use(lifecycle.router);
admin.use(require('./financial-corrections').router);

/* ---- auth ---- */
admin.post('/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (email.length > 254 || password.length > 1024) return bad(res, 400, 'invalid_input', 'راجعي بيانات تسجيل الدخول');
  if (A.adminThrottled(email)) {
    auditAuthFailure('admin', email, 'rate_limited');
    return bad(res, 429, 'too_many_attempts', 'محاولات كتيرة — استني ١٥ دقيقة');
  }
  const u = get('SELECT * FROM users WHERE email = ? AND active = 1', email);
  if (!u || !A.verifyPassword(password, u.password_hash)) {
    A.adminFailure(email);
    auditAuthFailure('admin', email, 'login_failed');
    return bad(res, 401, 'bad_credentials', 'الإيميل أو الباسورد غلط');
  }
  A.adminClear(email);
  const days = req.body.remember === false ? 1 : ADMIN_SESSION_DAYS;
  const { token, expires } = A.createSession('admin', u.id, u.role, days);
  A.setSessionCookie(res, token, days, 'admin');
  res.json({ token, expires, user: { id: u.id, name: u.name, email: u.email, role: u.role } });
});
admin.post('/auth/logout', A.requireStaff, (req, res) => {
  A.destroySession(req.token); A.clearSessionCookie(res, 'admin'); res.json({ ok: true });
});
admin.get('/me', A.requireStaff, (req, res) => res.json({ user: req.user }));

/* ---- styles: selling price is fine for staff, cost is not ---- */
admin.get('/styles', A.requireStaff, (req, res) => {
  const isOwner = req.user.role === 'owner';
  const rows = all("SELECT * FROM styles WHERE id <> 'MANUAL-CUSTOM' ORDER BY type DESC, id");
  const details = catalogue.detailsBatch(rows.map(s => s.id));
  res.json({ styles: list(rows, s => {
    const d = details.get(s.id) || { images: [], fabrics: [], sections: [], colours: [], lengths: [], sizes: [] };
    const base = {
      images: d.images, fabrics: d.fabrics, sections: d.sections, id: s.id, name: s.name, type: s.type, price: s.price, sale_price: s.sale_price, lead_days: s.lead_days,
      note: s.note, active: !!s.active,
      colours: d.colours,
      lengths: d.lengths,
      sizes: d.sizes,
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
  const hasLimit = req.query.limit !== undefined && String(req.query.limit).trim() !== '';
  const limit = hasLimit ? Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500) : null;
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const baseSql = `
    SELECT c.id,c.name,c.phone,c.area,c.created_at, m.waist, m.hip, m.bust, m.shoulder, m.length, m.sleeve, m.arm,
           (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS orders_count
    FROM customers c LEFT JOIN measurements m ON m.customer_id = c.id
    ORDER BY c.id DESC`;
  const customers = limit !== null ? all(`${baseSql} LIMIT ? OFFSET ?`, limit, offset) : all(baseSql);
  if (limit !== null) {
    const total = get('SELECT COUNT(*) n FROM customers').n;
    return res.json({ customers, total, limit, offset, has_more: offset + customers.length < total });
  }
  res.json({ customers });
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
  const c = D.orderContact(o);
  const depositStatus = get('SELECT status FROM order_deposits WHERE order_id=?',o.id)?.status || null;
  const t = D.orderTotals(o.id);
  return {
    id: o.id, code: o.code, channel: o.channel, status: o.status, deposit_status:depositStatus,
    cancelled_from_status:o.cancelled_from_status,
    promise_date: o.promise_date, created_at: o.created_at, note: o.note,
    delivery_fee: o.delivery_fee, governorate:o.governorate, delivery_requested:!!o.delivery_requested, shipping_quoted:!!o.shipping_quoted, fabric_choice:o.fabric_choice, manual_entry:!!o.manual_entry, discount: o.discount,
    customer: c, custom_price_pending:items.some(i=>i.status==='custom_pending'),
    measurements: D.orderMeasurements(o),
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
  const filtered = status && status !== 'all';
  const hasLimit = req.query.limit !== undefined && String(req.query.limit).trim() !== '';
  const limit = hasLimit ? Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200) : null;
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const counts = statusCounts();
  const total = filtered ? (counts[status] || 0) : counts.all;
  const rows = filtered
    ? (limit !== null ? all('SELECT * FROM orders WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?', status, limit, offset) : all('SELECT * FROM orders WHERE status = ? ORDER BY id DESC', status))
    : (limit !== null ? all('SELECT * FROM orders ORDER BY id DESC LIMIT ? OFFSET ?', limit, offset) : all('SELECT * FROM orders ORDER BY id DESC'));
  const isOwner = req.user.role === 'owner';
  const orders = rows.map(o => {
    const r = adminOrderRow(o);
    if (!isOwner) { delete r.totals.cost; delete r.totals.profit; delete r.totals.margin; }
    return r;
  });
  res.json(limit !== null ? { orders, counts, total, limit, offset, has_more: offset + orders.length < total } : { orders, counts });
});

function statusCounts() {
  const rows = all('SELECT status, COUNT(*) n FROM orders GROUP BY status');
  const out = { all: 0 };
  for (const s of D.INTERNAL_STATUSES) out[s] = 0;
  rows.forEach(r => { out[r.status] = r.n; out.all += r.n; });
  return out;
}

admin.get('/orders/:code', A.requireStaff, (req, res) => {
  const o = D.orderByCode(req.params.code);
  if (!o) return bad(res, 404, 'not_found', 'الأوردر مش موجود');
  const r = adminOrderRow(o);
  const isOwner = req.user.role === 'owner';
  if (!isOwner) { delete r.totals.cost; delete r.totals.profit; delete r.totals.margin; }
  else {
    r.payments=all('SELECT id,amount,method,created_at,note FROM payments WHERE order_id=? ORDER BY id DESC',o.id);
    r.refunds=all('SELECT id,amount,method,refunded_on,note,created_at,voided_at,void_reason FROM order_refunds WHERE order_id=? ORDER BY id DESC',o.id);
    r.financial_revision=lifecycle.financialRevision(o.id);
    r.items.forEach(i => Object.assign(i,get('SELECT unit_cost,cost_material,cost_tailoring,cost_other_base FROM order_items WHERE id=?',i.id)));
    const custom=get(`SELECT c.id,c.details,c.measurements,c.date_needed FROM custom_order_links l JOIN custom_requests c ON c.id=l.request_id WHERE l.order_id=?`,o.id);
    if(custom)r.custom_request={...custom,measurements:JSON.parse(custom.measurements)};
  }
  res.json({ order: r, message: D.buildMessage(o.id), role: req.user.role });
});

/* Status change — operational staff may still cancel. Financial records are
   preserved; the report queries exclude cancelled orders by current status. */
admin.patch('/orders/:code/status', A.requireStaff, (req, res) => {
  const { status } = req.body || {};
  if (!D.INTERNAL_STATUSES.includes(status)) return bad(res, 400, 'bad_status', 'حالة غير معروفة');
  try {
    const result=db.transaction(()=>{
      const o=D.orderByCode(req.params.code);
      if(!o)return {status:404,error:'not_found',message:'الأوردر مش موجود'};
      if(req.body?.expected_status!==undefined&&req.body.expected_status!==o.status)
        return {status:409,error:'stale_status',message:'تغيّرت حالة الأوردر؛ افتحيه من جديد وراجعيها قبل الإلغاء'};
      const deposit=get('SELECT status FROM order_deposits WHERE order_id=?',o.id);
      if(o.status==='cancelled'&&status!=='cancelled')return {status:409,error:'cancelled_order',message:'استخدمي زر إعادة تشغيل الأوردر لإرجاع مرحلته وفحص المخزون'};
      // Delivered goods have physically left: cancellation is allowed for
      // accounting, but never places those goods back into available stock.
      // Other backwards moves would otherwise bypass that protection.
      if(o.status==='delivered'&&!['delivered','cancelled'].includes(status))return {status:409,error:'delivered_order',message:'الطلب تم تسليمه؛ راجعي المرتجع والمخزون يدويًا قبل تغيير حالته'};
      if(status!==o.status&&deposit&&deposit.status!=='approved'&&!['new','cancelled'].includes(status))return {status:409,error:'deposit_required',message:'لا يمكن بدء الطلب قبل تأكيد استلام العربون'};
      if(status!==o.status){
        if(status==='cancelled'&&o.status!=='delivered')inventory.release(o.id,`user:${req.user.id}`);
        run("UPDATE orders SET status=?,cancelled_from_status=CASE WHEN ?='cancelled' THEN ? ELSE cancelled_from_status END,updated_at=datetime('now') WHERE id=?",status,status,o.status,o.id);
        Notifications.statusChanged(o,status);
        audit('order',o.id,'status:'+status,`user:${req.user.id}`,{from:o.status});
      }
      return {id:o.id};
    }).immediate();
    if(result.status)return bad(res,result.status,result.error,result.message);
    const updated=adminOrderRow(get('SELECT * FROM orders WHERE id=?',result.id));
    if(req.user.role!=='owner'){delete updated.totals.cost;delete updated.totals.profit;delete updated.totals.margin;}
    res.json({order:updated,message:D.buildMessage(result.id)});
  }catch(e){return bad(res,409,'status_error','تعذر تغيير حالة الأوردر؛ راجعي المخزون وحاولي مرة أخرى');}
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
  const body=req.body||{},amount=Number(body.amount),method=String(body.method||'cash');
  if (!Number.isFinite(amount) || !(amount > 0) || amount > 1e8) return bad(res,400,'bad_amount','المبلغ لازم يكون أكبر من صفر');
  const tokenPresent=Object.prototype.hasOwnProperty.call(body,'request_id');
  const note=typeof body.note==='string'?body.note.trim():'';
  if(tokenPresent&&(typeof body.request_id!=='string'||!/^[A-Za-z0-9_-]{8,100}$/.test(body.request_id)||body.confirm_actual!==true||
    !['string','number'].includes(typeof body.amount)||String(body.amount).trim()===''||typeof body.method!=='string'||
    !['cash','wallet','instapay','other'].includes(method)||Math.abs(amount*100-Math.round(amount*100))>0.00001||
    (body.note!==undefined&&typeof body.note!=='string')||note.length>300||/[<>&"'`\\\x00-\x1f]/.test(note)))
    return bad(res,400,'invalid_payment','راجعي المبلغ والطريقة وأكدي استلام المبلغ بالفعل');
  const result=db.transaction(()=>{
    const o = D.orderByCode(req.params.code);
    if (!o) return {status:404,error:'not_found',message:'الأوردر مش موجود'};
    if(tokenPresent){
      const old=get('SELECT * FROM payment_record_requests WHERE order_id=? AND request_id=?',o.id,body.request_id);
      if(old){
        if(old.amount!==amount||old.method!==method||old.note!==note)return {status:409,error:'token_reused',message:'رمز العملية استُخدم ببيانات مختلفة؛ راجعي سجل الدفع'};
        if(!old.payment_id)return {status:409,error:'payment_deleted',message:'حُذفت الدفعة السابقة؛ راجعي السجل قبل تسجيل أخرى'};
        return {totals:D.orderTotals(o.id),replay:true};
      }
      if(body.management_revision!==require('./financial-corrections').orderState(o).revision)
        return {status:409,error:'stale_finance',message:'تغيّرت بيانات الأوردر أو الدفعات؛ افتحي النموذج وراجعي الرصيد من جديد'};
    }
    if(o.status==='cancelled')return {status:409,error:'cancelled_order',message:'لا تسجلي دفعة جديدة لأوردر ملغي؛ أعيدي تشغيله أولًا'};
    if(get("SELECT count(*) n FROM order_items WHERE order_id=? AND status='custom_pending'",o.id).n)
      return {status:409,error:'price_pending',message:'سعّري التصميمات الخاصة قبل تسجيل الدفع'};
    const deposit=get('SELECT status FROM order_deposits WHERE order_id=?',o.id);
    // Existing historical payments remain untouched and may be linked during
    // review. New manual payments wait until the deposit is confirmed.
    if(deposit && deposit.status!=='approved')
      return {status:409,error:'deposit_required',message:'راجعي الإيصال وأكدي استلام العربون أولًا قبل تسجيل دفعة جديدة'};
    const payment=run('INSERT INTO payments(order_id,amount,method,note) VALUES(?,?,?,?)',o.id,amount,method,tokenPresent?note||null:body.note||null);
    if(tokenPresent){
      run('INSERT INTO payment_record_requests(order_id,request_id,payment_id,amount,method,note) VALUES(?,?,?,?,?,?)',o.id,body.request_id,payment.lastInsertRowid,amount,method,note);
      run("INSERT INTO web_alert_events(realm,subject_id,kind,order_id) VALUES('store',?,'order_update',?)",o.customer_id,o.id);
    }
    audit('order', o.code, 'payment', `user:${req.user.id}`, { amount, method });
    return {totals:D.orderTotals(o.id),replay:false};
  }).immediate();
  if(result.status)return bad(res,result.status,result.error,result.message);
  res.status(result.replay?200:201).json(result);
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
  const paid = get("SELECT COALESCE(SUM(p.amount),0) t FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.status!='cancelled'").t;
  const refunded = get("SELECT COALESCE(SUM(r.amount),0) t FROM order_refunds r JOIN orders o ON o.id=r.order_id WHERE o.status!='cancelled' AND r.voided_at IS NULL").t;
  const pending=all("SELECT id FROM orders o WHERE status!='cancelled' AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending')");
  const recordedCost=list=>list.reduce((sum,o)=>sum+D.orderTotals(o.id).cost,0);
  res.json({
    revenue, cost, gross_profit: revenue - cost, expenses,
    net_profit: revenue - cost - expenses, collected: paid-refunded, gross_collected:paid, refunded,
    outstanding, overpaid, orders: orders.length, pending_unpriced:pending.length,
    excluded_unpriced_cost:recordedCost(pending),
  });
});

admin.get('/money/period', A.requireOwner, (req,res) => {
 const from=String(req.query.from||''),to=String(req.query.to||'');
 if(!validDate(from)||!validDate(to)||from>to)return bad(res,400,'bad_dates','اختاري فترة صحيحة');
 const orders=all("SELECT * FROM orders o WHERE status != 'cancelled' AND mavi_cairo_date(created_at) BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending')",from,to);
 let sales=0,cost=0,outstanding=0,overpaid=0;for(const o of orders){const t=D.orderTotals(o.id);sales+=t.total;cost+=t.cost;outstanding+=Math.max(0,t.due);overpaid+=Math.max(0,-t.due);}
 const expenses=get('SELECT COALESCE(SUM(amount),0) total FROM expenses WHERE date(spent_on) BETWEEN ? AND ?',from,to).total;
 const cash=get("SELECT COALESCE(SUM(p.amount),0) total FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.status!='cancelled' AND mavi_cairo_date(p.created_at) BETWEEN ? AND ?",from,to).total;
 const refunds=get("SELECT COALESCE(SUM(r.amount),0) total FROM order_refunds r JOIN orders o ON o.id=r.order_id WHERE o.status!='cancelled' AND r.voided_at IS NULL AND r.refunded_on BETWEEN ? AND ?",from,to).total;
 res.json({from,to,orders:orders.length,sales,cost,expenses,profit:sales-cost-expenses,collected_in_period:cash-refunds,gross_collected_in_period:cash,refunded_in_period:refunds,outstanding_for_period_orders:outstanding,overpaid_for_period_orders:overpaid});
});

admin.get('/money/cost-detail', A.requireOwner, (req, res) => {
  const from=String(req.query.from||''), to=String(req.query.to||'');
  if(!validDate(from)||!validDate(to)||from>to)
    return bad(res,400,'bad_dates','اختاري فترة صحيحة');
  res.json(orderCosts.costDetail(from,to));
});

// One consistent snapshot for the report centre, scoped by business dates.
admin.get('/money/report-hub', A.requireOwner, (req,res) => {
 const from=String(req.query.from||''),to=String(req.query.to||'');
 if(!validDate(from)||!validDate(to)||from>to)return bad(res,400,'bad_dates','اختاري فترة صحيحة');
 res.json(reports.reportHub(from,to));
});

admin.get('/money/outstanding', A.requireOwner, (_req, res) => {
  res.json({ rows: all(`SELECT * FROM orders o WHERE status NOT IN ('cancelled') AND NOT EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending')`).map(o => {
    const t = D.orderTotals(o.id);
    return { code: o.code, customer: D.orderContact(o)?.name,
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

// Owner-only overhead uses the existing expenses table and profit formula.
// It is deliberately separate from order and per-dress costs.
admin.use(require('./expenses').router);

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
    const expenses = get('SELECT COALESCE(SUM(amount),0) n FROM expenses').n;
    out.money = { revenue: s.rev, cost: s.cost, gross_profit: s.rev - s.cost,
      expenses, net_profit: s.rev - s.cost - expenses, outstanding: s.due,
      pending_unpriced:get("SELECT count(*) n FROM orders o WHERE o.status!='cancelled' AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id=o.id AND i.status='custom_pending')").n };
  }
  res.json(out);
});

/* ---- backups + account safety: owner only ---- */
function hashFileReusableBuffer(filePath) {
  const fs = require('fs');
  const crypto = require('crypto');
  return new Promise((resolve, reject) => {
    fs.open(filePath, 'r', (openErr, fd) => {
      if (openErr) return reject(openErr);
      const hash = crypto.createHash('sha256');
      const buf = Buffer.allocUnsafe(65536);
      let total = 0;
      const next = () => {
        fs.read(fd, buf, 0, buf.length, null, (readErr, bytesRead) => {
          if (readErr) {
            return fs.close(fd, () => reject(readErr));
          }
          if (bytesRead === 0) {
            return fs.close(fd, (closeErr) => {
              if (closeErr) return reject(closeErr);
              resolve({ bytes: total, sha256: hash.digest('hex') });
            });
          }
          total += bytesRead;
          hash.update(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
          next();
        });
      };
      next();
    });
  });
}

// Clean up any orphaned temporary backup directories from a prior hard crash on startup
try {
  const fsStartup = require('fs');
  const dbDirStartup = path.dirname(path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'mavi.db')));
  if (fsStartup.existsSync(dbDirStartup)) {
    for (const entry of fsStartup.readdirSync(dbDirStartup)) {
      if (entry.startsWith('.mavi-backup-tmp-')) {
        try { fsStartup.rmSync(path.join(dbDirStartup, entry), { recursive: true, force: true }); } catch (_) {}
      }
    }
  }
} catch (_) {}

let backupBusy = false;
admin.get('/system/backup', A.requireOwner, async (req, res) => {
  // SQLite's backup API captures committed WAL changes in a consistent snapshot.
  // Stage snapshot on the persistent DB volume (not RAM-backed /tmp tmpfs) when writable,
  // serialize concurrent requests, and never record `last_backup` unless streaming completes.
  if (backupBusy) {
    return res.status(429).json({ error: 'backup_in_progress', message: 'يوجد نسخ احتياطي جارٍ حالياً؛ انتظري ثواني ثم أعيدي المحاولة' });
  }
  backupBusy = true;
  const fs = require('fs');
  const os = require('os');
  const actor = `user:${req.user.id}`;
  let dir;
  let released = false;
  const releaseBusy = () => {
    if (released) return;
    released = true;
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      dir = null;
    }
    try { db.pragma('shrink_memory'); } catch (_) {}
    backupBusy = false;
  };
  let clientClosedEarly = false;
  const onReqClose = () => {
    if (!res.writableFinished) clientClosedEarly = true;
  };
  req.on('aborted', () => { clientClosedEarly = true; });
  res.on('close', onReqClose);
  try {
    audit('system', 'backup', 'backup_started', actor, {});
    const dbDir = path.dirname(path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'mavi.db')));
    try {
      dir = fs.mkdtempSync(path.join(dbDir, '.mavi-backup-tmp-'));
    } catch (_) {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-backup-'));
    }
    const file = path.join(dir, 'snapshot.db');
    await db.backup(file);
    const { bytes, sha256 } = await hashFileReusableBuffer(file);
    audit('system', 'backup', 'backup_snapshot_created', actor, { bytes, sha256 });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Mavi-Backup-Sha256', sha256);
    res.setHeader('X-Mavi-Backup-Bytes', String(bytes));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    let finalized = false;
    res.download(file, `mavi-backup-${stamp}.db`, (err) => {
      if (finalized) return;
      finalized = true;
      res.off('close', onReqClose);
      releaseBusy();
      if (err || clientClosedEarly || req.aborted || !res.writableFinished) {
        try { audit('system', 'backup', 'backup_stream_aborted', actor, { bytes, sha256 }); } catch (_) {}
        if (err && !res.headersSent) res.status(500).json({ error: 'backup_failed' });
        return;
      }
      try { audit('system', 'backup', 'backup_response_completed', actor, { bytes, sha256 }); } catch (_) {}
    });
  } catch (err) {
    res.off('close', onReqClose);
    releaseBusy();
    try { audit('system', 'backup', 'backup_failed', actor, { code: err && err.code ? String(err.code) : 'snapshot_error' }); } catch (_) {}
    if (!res.headersSent) res.status(500).json({ error: 'backup_failed' });
  }
});

admin.post('/system/public-url', A.requireOwner, (req, res) => {
  const url = String(req.body.url || '').trim().replace(/\/+$/, '');
  if (url && (!/^https?:\/\/[^\s]+$/.test(url) || BAD_TEXT.test(url)))
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
  require('qrcode').toBuffer(shopUrl, {
    type: 'png', width: px, margin: 2,
    color: { dark: '#121E48FF', light: '#FFFFFFFF' },
  }).then((buf) => { res.type('image/png').send(buf); })
    .catch(() => res.status(500).json({ error: 'qr_failed' }));
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
    <picture><source srcset="/brand/emblem.webp" type="image/webp"><img src="/brand/emblem.png" alt="MAVI" style="width:74px;height:74px;border-radius:50%"></picture>
    <h1>MAVI</h1><div class="tag">TAILOR YOUR DESIGN</div>
    <div class="ar">فصّلي على مقاسك — امسحي الكود واطلبي من موبايلك</div>
    <img class="qr" src="/api/admin/system/qr?size=10" alt="QR">
    <div class="link">${escHtml(shop)}</div>
    <a class="wa" href="https://wa.me/201013979358?text=${encodeURIComponent('أهلاً Mavi 🤍 عايزة أطلب — ' + shop)}">ابعتيها على واتساب</a>
  </div>
  <script>if(location.search.includes('print'))window.print();</script>
</body></html>`);
});

admin.get('/system/info/status', A.requireOwner, (_req, res) => {
  const completed = get(
    "SELECT created_at, detail FROM events WHERE entity='system' AND entity_id='backup' AND action IN ('backup_response_completed','download') ORDER BY id DESC LIMIT 1"
  );
  const failed = get(
    "SELECT created_at FROM events WHERE entity='system' AND entity_id='backup' AND action='backup_failed' ORDER BY id DESC LIMIT 1"
  );
  const aborted = get(
    "SELECT created_at FROM events WHERE entity='system' AND entity_id='backup' AND action='backup_stream_aborted' ORDER BY id DESC LIMIT 1"
  );
  let completedMeta = {};
  if (completed && completed.detail) {
    try { completedMeta = JSON.parse(completed.detail) || {}; } catch (_) {}
  }
  res.json({
    database: (process.env.DB_PATH || 'data/mavi.db').split(/[\\/]/).pop(),
    persistent_disk: /^\/data\//.test(process.env.DB_PATH || '') || !!process.env.DB_PATH,
    orders: get('SELECT COUNT(*) n FROM orders').n,
    customers: get('SELECT COUNT(*) n FROM customers').n,
    public_url: (setting('public_url', '') || '').replace(/\/+$/, ''),
    last_backup: completed?.created_at || null,
    backup_status: {
      last_response_completed_at: completed?.created_at || null,
      last_snapshot_sha256: typeof completedMeta.sha256 === 'string' ? completedMeta.sha256 : null,
      last_snapshot_bytes: Number.isInteger(completedMeta.bytes) ? completedMeta.bytes : null,
      last_failed_at: failed?.created_at || null,
      last_aborted_at: aborted?.created_at || null,
      client_storage_verified: false,
    },
    security: {
      failed_logins_24h: get("SELECT COUNT(*) n FROM events WHERE entity='auth' AND action IN ('login_failed','otp_failed') AND created_at > datetime('now','-1 day')").n,
      rate_limits_24h: get("SELECT COUNT(*) n FROM events WHERE entity='auth' AND action='rate_limited' AND created_at > datetime('now','-1 day')").n,
    },
  });
});

admin.post('/system/change-password', A.requireOwner, (req, res) => {
  const { current, next } = req.body || {};
  const nextPw = String(next || '');
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!A.verifyPassword(String(current || ''), u.password_hash))
    return bad(res, 401, 'bad_password', 'الباسورد الحالي غلط');
  if (nextPw.length < 8 || nextPw.length > 128)
    return bad(res, 400, 'weak_password', 'الباسورد الجديد لازم ٨ حروف على الأقل');
  db.transaction(() => {
    run('UPDATE users SET password_hash = ? WHERE id = ?', A.hashPassword(nextPw), req.user.id);
    if (req.token) run("DELETE FROM sessions WHERE realm='admin' AND subject_id=? AND token_hash<>?", req.user.id, A.sha256(req.token));
    audit('user', u.id, 'password_changed', `user:${req.user.id}`);
  })();
  res.json({ ok: true });
});

admin.use('/office', require('./office-routes'));
app.use('/api/admin', admin);

/* ============================================================
   static faces
   ============================================================ */
app.use(require('./store-search-pages')({get, all}));
// Force current admin HTML/JS after a release; old stock-based forms are incompatible.
app.use('/admin', (_req, res, next) => { res.set('Cache-Control','no-store, max-age=0'); next(); });
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir, {
  index: false,
  dotfiles: 'deny',
  setHeaders(res, filePath) {
    const rel = path.relative(publicDir, filePath).replace(/\\/g, '/');
    if (rel === 'sw.js') res.setHeader('Cache-Control', 'no-cache');
    else if (rel.startsWith('brand/')) res.setHeader('Cache-Control', 'public, max-age=86400');
    else if (!rel.startsWith('admin/')) res.setHeader('Cache-Control', 'public, max-age=300');
  },
}));
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
app.get('/', (_req, res) => {
  if (!IS_SANDBOX_PREVIEW) return res.redirect(301, '/store/');
  res.set('Cache-Control', 'no-store');
  res.type('html').send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MAVI — بوابة المعاينة التجريبية (الشركة الافتراضية + المتجر)</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:Tahoma,system-ui,-apple-system,sans-serif;background:linear-gradient(155deg,#0f2347 0%,#1a386d 55%,#224684 100%);color:#132546;min-height:100vh;display:grid;place-items:center;padding:20px}
  .wrap{width:min(760px,100%);background:#fff;border-radius:22px;padding:28px;box-shadow:0 22px 60px rgba(7,16,36,.38);border:1px solid #e4dccf}
  .badge{display:inline-flex;align-items:center;gap:6px;background:#fbf5e8;color:#835f2b;border:1px solid #ead8b8;border-radius:99px;padding:6px 13px;font-size:12px;font-weight:700}
  h1{margin:12px 0 6px;font-size:24px;color:#122549}
  p.lead{margin:0 0 20px;color:#55687e;font-size:14px;line-height:1.8}
  .doors{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin-bottom:18px}
  .door{display:flex;flex-direction:column;justify-content:space-between;gap:12px;padding:18px;border-radius:16px;border:1px solid #dde5f0;background:#f8fafd;text-decoration:none;color:inherit;transition:transform .15s,border-color .15s,box-shadow .15s}
  .door:hover{transform:translateY(-2px);border-color:#b8945f;box-shadow:0 10px 24px rgba(18,37,73,.09)}
  .door.primary{background:linear-gradient(145deg,#163263,#0e2246);color:#fff;border-color:#163263}
  .door.primary small,.door.primary .sub{color:#cdd9ec}
  .door h2{margin:0;font-size:17px}
  .door .sub{font-size:12.5px;line-height:1.7;color:#5a6d84}
  .cta{display:inline-block;text-align:center;padding:10px 14px;border-radius:10px;font-weight:700;font-size:13.5px;background:#d6b580;color:#102244}
  .door:not(.primary) .cta{background:#163263;color:#fff}
  .creds{background:#f5f8fc;border:1px dashed #cad6e6;border-radius:14px;padding:14px 16px;font-size:12.5px;line-height:1.9;color:#344861}
  code{font-family:ui-monospace,Consolas,monospace;background:#fff;border:1px solid #dce4ef;padding:2px 7px;border-radius:6px;direction:ltr;display:inline-block;color:#122549;font-weight:700}
</style>
</head>
<body>
  <main class="wrap">
    <span class="badge">وضع معاينة تجريبي معزول · بدون إرسال آلي أو صرف مالي · AI_ENABLED=0</span>
    <h1>MAVI ERP + الشركة الافتراضية الموحدة (١٧ مسؤولية)</h1>
    <p class="lead">اختاري البوابة المطلوبة للمعاينة الفورية على قاعدة البيانات التجريبية المعزولة:</p>
    <div class="doors">
      <a class="door primary" href="/admin/">
        <div>
          <small style="font-weight:700;letter-spacing:.4px">للمالكة وفريق التشغيل</small>
          <h2 style="margin-top:4px">لوحة الإدارة والشركة الافتراضية</h2>
          <div class="sub" style="margin-top:6px">ملخص يومك بالأولوية، ١٨ قالب مسودات وفحص عبر ١٧ دورًا، تحضير دورة اليوم بضغطة واحدة، واعتماد المسودات وسجل المراجعة.</div>
        </div>
        <span class="cta">فتح لوحة الإدارة (/admin/) ›</span>
      </a>
      <a class="door" href="/store/">
        <div>
          <small style="font-weight:700;color:#8a6531">واجهة العميلات</small>
          <h2 style="margin-top:4px">متجر MAVI والتصميم الخاص</h2>
          <div class="sub" style="margin-top:6px">استعراض الموديلات، جدول المقاسات، سلة المشتريات، وطلبات التفصيل والتصميم الخاص.</div>
        </div>
        <span class="cta">فتح واجهة المتجر (/store/) ›</span>
      </a>
    </div>
    <div class="creds">
      <strong>بيانات الدخول التجريبية الجاهزة للوحة الإدارة (بيانات وهمية للمعاينة فقط):</strong><br>
      • حساب المالكة (يرى كل الـ ١٧ مسؤولية والماليات والاعتماد): <code>owner@mavi.eg</code> / كلمة المرور: <code>mavi-owner</code><br>
      • حساب الموظف (تشغيلي فقط — صفر بيانات مالية أو اعتماد): <code>staff@mavi.eg</code> / كلمة المرور: <code>mavi-staff</code>
    </div>
  </main>
</body>
</html>`);
});

app.get('/store/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'store', 'index.html')));
/* the page route must never be handled by the static mount above */
app.get('/admin/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));
app.get('/admin', (_req, res) => res.redirect('/admin/'));

/* error handler */
app.use((err, _req, res, _next) => {
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    return res.status(400).json({ error: 'bad_json', message: 'بيانات الطلب غير صالحة' });
  }
  console.error('[server_error]', err && err.message ? err.message : 'unexpected');
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
