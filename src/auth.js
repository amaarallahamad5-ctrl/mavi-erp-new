'use strict';
/* Two auth realms, deliberately separate:
     realm 'store'  → customers (phone + password; WhatsApp code as fallback)
     realm 'admin'  → staff / owner (email + password)
   A store token can never satisfy an admin guard, and vice versa. */
const crypto = require('crypto');
const { get, run, all } = require('./db');

const SESSION_DAYS = 14;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

/* ---------- password hashing (scrypt, no external deps) ---------- */
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, stored) {
  const [kind, salt, hash] = String(stored).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
}

/* ---------- customer password login throttling ---------- */
const attempts = new Map();   // phone -> {n, until}
const LOCK_AFTER = 6, LOCK_MS = 10 * 60 * 1000;
// Bounded per-process tables: reject new keys at capacity rather than evicting
// active lockouts (which would allow bypassing the password-attempt limit).
const MAX_ATTEMPTS = 2048;
function clearExpired(map, now = Date.now()) {
  for (const [key, entry] of map) if (now > entry.until) map.delete(key);
}
function atCapacity(map, key) {
  if (map.has(key) || map.size < MAX_ATTEMPTS) return false;
  clearExpired(map);
  return map.size >= MAX_ATTEMPTS;
}

function throttled(phone) {
  const a = attempts.get(phone);
  if (!a) return atCapacity(attempts, phone);
  if (Date.now() > a.until) { attempts.delete(phone); return false; }
  return a.n >= LOCK_AFTER;
}
function noteFailure(phone) {
  const a = attempts.get(phone) || { n: 0, until: Date.now() + LOCK_MS };
  a.n += 1; a.until = Date.now() + LOCK_MS;
  attempts.set(phone, a);
}
function clearFailures(phone) { attempts.delete(phone); }

/* ---------- owner/staff lockout (separate key space) ---------- */
const adminAttempts = new Map();
function adminThrottled(email) {
  const a = adminAttempts.get(email);
  if (!a) return atCapacity(adminAttempts, email);
  if (Date.now() > a.until) { adminAttempts.delete(email); return false; }
  return a.n >= 8;
}
function adminFailure(email) {
  const a = adminAttempts.get(email) || { n: 0, until: Date.now() + 15 * 60 * 1000 };
  a.n += 1; a.until = Date.now() + 15 * 60 * 1000;
  adminAttempts.set(email, a);
}
function adminClear(email) { adminAttempts.delete(email); }
// Do not keep the process alive solely for cleanup.
setInterval(() => { clearExpired(attempts); clearExpired(adminAttempts); }, 60 * 1000).unref();

/* ---------- "keep me signed in" ----------
   A phone that stays logged in for months is how you actually use this daily,
   so the session lives longer and the cookie carries it into the installed app. */
function createSession(realm, subjectId, role, days) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + (days || SESSION_DAYS) * 864e5).toISOString();
  run('INSERT INTO sessions(token_hash,realm,subject_id,role,expires_at) VALUES(?,?,?,?,?)',
      sha256(token), realm, subjectId, role, expires);
  return { token, expires };
}

/* ---------- sessions ---------- */
const STORE_COOKIE = 'mavi_session';
const ADMIN_COOKIE = 'mavi_admin_session';
const IS_SANDBOX_PREVIEW = (process.env.MAVI_SANDBOX_PREVIEW === '1' || process.env.MAVI_PREVIEW_AUTO_ADMIN === '1') && process.env.NODE_ENV !== 'production';
const cookieNameFor = (realm) => (realm === 'admin' ? ADMIN_COOKIE : STORE_COOKIE);
function setSessionCookie(res, token, days, realm = 'store') {
  const isHttpsReq = Boolean(res.req && (res.req.secure || (typeof res.req.get === 'function' && res.req.get('x-forwarded-proto') === 'https')));
  const crossSitePreview = IS_SANDBOX_PREVIEW && isHttpsReq;
  res.cookie(cookieNameFor(realm), token, {
    httpOnly: true,
    sameSite: crossSitePreview ? 'none' : 'lax',
    partitioned: crossSitePreview,
    path: '/',
    secure: process.env.NODE_ENV === 'production' || crossSitePreview,
    maxAge: (days || 30) * 864e5,
  });
}
function clearSessionCookie(res, realm = 'store') {
  const isHttpsReq = Boolean(res.req && (res.req.secure || (typeof res.req.get === 'function' && res.req.get('x-forwarded-proto') === 'https')));
  const crossSitePreview = IS_SANDBOX_PREVIEW && isHttpsReq;
  res.clearCookie(cookieNameFor(realm), {
    path: '/',
    httpOnly: true,
    sameSite: crossSitePreview ? 'none' : 'lax',
    partitioned: crossSitePreview,
    secure: process.env.NODE_ENV === 'production' || crossSitePreview,
  });
}

function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}
function readToken(req) {
  const xm = req.headers['x-mavi-token'];
  if (typeof xm === 'string' && xm.trim()) return xm.trim();
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  const url = String(req.originalUrl || req.path || '');
  const isAdmin = url === '/api/admin' || url.startsWith('/api/admin/');
  const name = isAdmin ? ADMIN_COOKIE : STORE_COOKIE;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${escaped}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function resolve(token) {
  if (!token) return null;
  const row = get('SELECT * FROM sessions WHERE token_hash = ?', sha256(token));
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    run('DELETE FROM sessions WHERE token_hash = ?', row.token_hash);
    return null;
  }
  return row;
}

/* ---------- guards ---------- */
function attachUser(req, _res, next) {
  const token = readToken(req);
  req.session = resolve(token);
  req.token = token;
  req.user = null;
  if (req.session && req.session.realm === 'store') {
    req.user = get('SELECT id, phone, name, area FROM customers WHERE id = ?', req.session.subject_id) || null;
    if (!req.user) req.session = null;
  }
  if (req.session && req.session.realm === 'admin') {
    req.user = get('SELECT id, email, name, role FROM users WHERE id = ? AND active = 1', req.session.subject_id) || null;
    if (!req.user) req.session = null;
  }
  next();
}

/** store realm: any logged-in customer */
function requireCustomer(req, res, next) {
  if (!req.session || req.session.realm !== 'store' || !req.user)
    return res.status(401).json({ error: 'login_required', message: 'محتاجة تسجّلي دخول الأول' });
  next();
}

/** admin realm: staff or owner */
function requireStaff(req, res, next) {
  if (!req.session || req.session.realm !== 'admin' || !req.user)
    return res.status(401).json({ error: 'login_required', message: 'Admin login required' });
  if (!['owner', 'staff'].includes(req.user.role))
    return res.status(403).json({ error: 'forbidden' });
  next();
}

/** admin realm: owner only — cost, margin, profit, expenses, reports */
function requireOwner(req, res, next) {
  if (!req.session || req.session.realm !== 'admin' || !req.user)
    return res.status(401).json({ error: 'login_required', message: 'Admin login required' });
  if (req.user.role !== 'owner')
    return res.status(403).json({ error: 'forbidden', message: 'الأرقام المالية للإدارة العليا فقط' });
  next();
}

/* ---------- OTP ---------- */
const OTP_TTL_MIN = 5;
const OTP_MAX_ATTEMPTS = 5;

function issueOtp(phone) {
  // throttle: max 3 codes per phone per 15 minutes
  const recent = get(`SELECT COUNT(*) n FROM otp_codes
                      WHERE phone = ? AND created_at > datetime('now','-15 minutes')`, phone).n;
  if (recent >= 3) {
    const err = new Error('too_many_requests');
    err.status = 429;
    throw err;
  }
  const code = String(crypto.randomInt(100000, 1000000));
  run('INSERT INTO otp_codes(phone,code_hash,expires_at) VALUES(?,?,datetime(\'now\', ?))',
      phone, sha256(code), `+${OTP_TTL_MIN} minutes`);
  return code;
}

/* Issue a code for a phone that already has an account (forgotten password).
   The owner can read the newest unused code from the dashboard. */
function latestCodeFor(phone) {
  return get(`SELECT * FROM otp_codes WHERE phone = ? AND used = 0
              AND expires_at > datetime('now') ORDER BY id DESC LIMIT 1`, phone);
}

function consumeOtp(phone, code) {
  const row = get(`SELECT * FROM otp_codes WHERE phone = ? AND used = 0
                   ORDER BY id DESC LIMIT 1`, phone);
  if (!row) return { ok: false, reason: 'no_code' };
  if (new Date(row.expires_at + 'Z') < new Date()) return { ok: false, reason: 'expired' };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };
  if (sha256(code) !== row.code_hash) {
    run('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', row.id);
    return { ok: false, reason: 'wrong_code' };
  }
  run('UPDATE otp_codes SET used = 1 WHERE id = ?', row.id);
  return { ok: true };
}

function pruneExpired() {
  run("DELETE FROM sessions WHERE expires_at < datetime('now')");
  run("DELETE FROM otp_codes WHERE expires_at < datetime('now','-1 day')");
}

module.exports = { latestCodeFor, throttled, noteFailure, clearFailures,
                   adminThrottled, adminFailure, adminClear, setSessionCookie, clearSessionCookie,
  hashPassword, verifyPassword, createSession, destroySession, readToken, resolve,
  attachUser, requireCustomer, requireStaff, requireOwner,
  issueOtp, consumeOtp, pruneExpired, sha256,
};
