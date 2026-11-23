'use strict';
// One-time, opt-in migration utility. Never enabled by default.
if (process.env.MAVI_RESTORE_MODE === '1') { require('./migration-import').start(); return; }
/* Startup: create an owner only for an empty DB and only from private host settings
   or a secret file (`INITIAL_ADMIN_PASSWORD_FILE`). Supports `MAVI_INIT_OWNER_ONLY=1`
   so one-shot initialization exits before starting the long-lived HTTP server process
   (keeping the server process's OS `/proc/<pid>/environ` free of bootstrap secrets). */
const fs = require('fs');
const { db, get, run } = require('./db');
const { hashPassword } = require('./auth');

const AUTO_SEED = process.env.AUTO_SEED === '1';
const INIT_ONLY = process.env.MAVI_INIT_OWNER_ONLY === '1';
const email = String(process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
const pwFile = String(process.env.INITIAL_ADMIN_PASSWORD_FILE || '').trim();
const hasEnvPw = Object.prototype.hasOwnProperty.call(process.env, 'INITIAL_ADMIN_PASSWORD') &&
  String(process.env.INITIAL_ADMIN_PASSWORD || '').length > 0;

function readPasswordBuffer() {
  if (pwFile) {
    const raw = fs.readFileSync(pwFile);
    let end = raw.length;
    while (end > 0 && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d)) end--;
    return { raw, slice: raw.subarray(0, end), fromEnv: false };
  }
  if (hasEnvPw) {
    const raw = Buffer.from(String(process.env.INITIAL_ADMIN_PASSWORD), 'utf8');
    return { raw, slice: raw, fromEnv: true };
  }
  return null;
}

function isDisallowedDefault(buf) {
  return buf.equals(Buffer.from('mavi-owner', 'utf8')) || buf.equals(Buffer.from('mavi-staff', 'utf8'));
}

function utf8CodePointLength(buf) {
  // Count Unicode scalar values without materializing a long-lived JS string when reading from a secret file
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    if ((buf[i] & 0xc0) !== 0x80) count++;
  }
  return count;
}

const userCount = () => get('SELECT COUNT(*) n FROM users').n;

if (userCount() === 0) {
  if (AUTO_SEED) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[bootstrap] Demo seeding is disabled in production.');
      process.exit(1);
    }
    console.log('[bootstrap] Creating demo data for local testing.');
    require('./seed');
  } else if (email || pwFile || hasEnvPw) {
    let pwObj = null;
    try {
      pwObj = readPasswordBuffer();
      const charLen = pwObj ? utf8CodePointLength(pwObj.slice) : 0;
      if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        email.length > 254 ||
        !pwObj ||
        charLen < 16 ||
        charLen > 128 ||
        isDisallowedDefault(pwObj.slice)
      ) {
        console.error('[bootstrap] Invalid initial owner settings; use a valid email and a private password of 16–128 characters.');
        process.exit(1);
      }
      const pwHash = hashPassword(pwObj.slice);
      db.transaction(() => {
        if (userCount() === 0) {
          run("INSERT INTO users(email,name,role,password_hash) VALUES(?,?,'owner',?)", email, 'إدارة Mavi', pwHash);
          for (const [key, value] of Object.entries({
            brand_name: 'MAVI',
            slogan: 'Tailor Your Design',
            whatsapp: '201013979358',
            delivery_fee: '60',
            currency: 'EGP',
          })) {
            run('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)', key, value);
          }
        }
      })();
      if (pwObj.fromEnv) {
        console.log('[bootstrap] Owner created from INITIAL_ADMIN_PASSWORD. Remove it from host settings and restart a fresh process so OS /proc/<pid>/environ no longer retains it.');
      } else {
        console.log('[bootstrap] Owner created from INITIAL_ADMIN_PASSWORD_FILE. Remove the secret mount/file before normal operation.');
      }
    } catch (err) {
      console.error('[bootstrap] Failed to read initial owner credentials:', err && err.code ? err.code : 'bootstrap_error');
      process.exit(1);
    } finally {
      if (pwObj && pwObj.raw) pwObj.raw.fill(0);
    }
  } else {
    console.log('[bootstrap] Empty database: configure INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD_FILE (or INITIAL_ADMIN_PASSWORD) before signing in.');
  }
}

// Remove from Node's runtime env map (note: OS /proc/<pid>/environ is only cleared by starting a new process without the env var).
delete process.env.INITIAL_ADMIN_PASSWORD;
delete process.env.INITIAL_ADMIN_PASSWORD_FILE;

if (INIT_ONLY) {
  if (userCount() === 0) {
    console.error('[bootstrap] MAVI_INIT_OWNER_ONLY=1 ran, but no owner exists in database.');
    process.exit(1);
  }
  try { db.close(); } catch (_) {}
  console.log('[bootstrap] One-shot owner initialization complete; exiting cleanly.');
  process.exit(0);
}

const app = require('./server');
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Mavi ERP ready on port ${PORT}`));
