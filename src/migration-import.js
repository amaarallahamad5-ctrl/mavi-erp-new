'use strict';
// One-time streaming upload into a NEW database path; the active DB_PATH is never opened or replaced.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'utf8');
const DISK_SAFETY_MARGIN = 16 * 1024 * 1024; // 16 MiB headroom for WAL/SHM after cutover

function equal(a, b) {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(a).digest(),
    crypto.createHash('sha256').update(b).digest()
  );
}

function resolveMaxBytes() {
  const raw = process.env.MAVI_RESTORE_MAX_MIB;
  if (raw === undefined || raw === '') return 128 * 1024 * 1024;
  const mib = Number(raw);
  if (!Number.isInteger(mib) || mib < 1 || mib > 512) {
    console.error('[migration] MAVI_RESTORE_MAX_MIB must be an integer between 1 and 512');
    process.exit(1);
  }
  return mib * 1024 * 1024;
}

function resolveTargetPaths() {
  const activeDbPath = path.resolve(process.env.DB_PATH || '/data/mavi.db');
  const dir = path.dirname(activeDbPath);
  const targetName = (process.env.MAVI_RESTORE_TARGET_NAME || 'mavi-restored.db').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,62}\.(?:db|sqlite|sqlite3)$/.test(targetName)) {
    console.error('[migration] Invalid MAVI_RESTORE_TARGET_NAME; use a simple .db/.sqlite/.sqlite3 filename');
    process.exit(1);
  }
  const dest = path.resolve(dir, targetName);
  if (dest === activeDbPath) {
    console.error('[migration] Refusing to target active DB_PATH; choose a distinct MAVI_RESTORE_TARGET_NAME');
    process.exit(1);
  }
  return { activeDbPath, dir, targetName, dest };
}

function hasEnoughDiskSpace(dir, requiredBytes) {
  if (typeof fs.statfsSync !== 'function') return true;
  try {
    const st = fs.statfsSync(dir);
    const avail = BigInt(st.bavail) * BigInt(st.bsize);
    return avail >= BigInt(requiredBytes) + BigInt(DISK_SAFETY_MARGIN);
  } catch (_) {
    return true;
  }
}

function cleanupTemp(tmp) {
  if (!tmp) return;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { fs.unlinkSync(tmp + suffix); } catch (_) {}
  }
}

function start() {
  const token = process.env.MAVI_RESTORE_SECRET || '';
  const port = process.env.PORT || 3000;
  const maxBytes = resolveMaxBytes();
  const maxMib = Math.round(maxBytes / (1024 * 1024));
  const { dir, targetName, dest } = resolveTargetPaths();

  if (Buffer.byteLength(token) < 32) {
    console.error('[migration] Set MAVI_RESTORE_SECRET to at least 32 bytes');
    process.exit(1);
  }

  let busy = false;
  let attempts = 0;
  let windowStart = Date.now();

  const page = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>استعادة MAVI</title><style>body{font-family:Arial;margin:3em auto;max-width:34em;padding:1em;line-height:1.8} input,button{display:block;margin:.8em 0;padding:.8em;max-width:100%}button{background:#382c42;color:white;border:0;border-radius:6px}.mono{font-family:monospace;direction:ltr;display:inline-block}</style><h1>استعادة نسخة MAVI</h1><p>اختاري ملف النسخة الاحتياطية من جهازك (حتى ${maxMib} ميجابايت). الملف يُفحص ويُحفظ كملف جديد مستقل باسم <span class="mono">${targetName}</span> دون استبدال الملف الحالي.</p><label>رمز الاستعادة<input id="secret" type="password" autocomplete="off"></label><label>ملف قاعدة البيانات<input id="file" type="file" accept=".db,.sqlite,.sqlite3"></label><button id="go">رفع النسخة وفحصها</button><p id="msg"></p><script>document.getElementById('go').onclick=async()=>{const b=document.getElementById('go'),f=document.getElementById('file').files[0],s=document.getElementById('secret').value,m=document.getElementById('msg');if(!f||!s){m.textContent='اختاري الملف وأدخلي الرمز';return}b.disabled=true;m.textContent='جارٍ الرفع والفحص...';try{let r=await fetch('/import',{method:'POST',headers:{'Authorization':'Bearer '+s,'Content-Type':'application/octet-stream'},body:f,cache:'no-store'});let t=await r.text();let sha=r.headers.get('x-mavi-restored-sha256')||'';let dst=r.headers.get('x-mavi-restored-file')||'${targetName}';m.textContent=r.ok?('تم حفظ النسخة وفحصها في '+dst+(sha?' (SHA-256: '+sha.slice(0,16)+'…)':'')+'. لا تضغطي مرة أخرى؛ ارجعي للتعليمات لتفعيلها.'):'لم تكتمل العملية: '+t}catch(e){m.textContent='تعذر الاتصال؛ لا تعيدي المحاولة قبل مراجعة السجلات.'}finally{b.disabled=false}};</script></html>`;

  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'"
    );

    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(page);
    }
    if (req.method !== 'POST' || req.url !== '/import') {
      res.writeHead(404);
      return res.end('Not found');
    }
    if (Date.now() - windowStart > 600000) {
      attempts = 0;
      windowStart = Date.now();
    }
    if (++attempts > 12) {
      res.writeHead(429);
      return res.end('Too many attempts');
    }
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ') || !equal(header.slice(7), token)) {
      res.writeHead(403);
      req.resume();
      return res.end('Invalid code');
    }
    if (busy || fs.existsSync(dest)) {
      res.writeHead(409);
      req.resume();
      return res.end('Already in progress or destination exists; no changes made');
    }
    const n = Number(req.headers['content-length']);
    if (!Number.isSafeInteger(n) || n < 512 || n > maxBytes) {
      res.writeHead(413);
      req.resume();
      return res.end(`Invalid size; maximum ${maxMib} MiB`);
    }

    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (_) {
      res.writeHead(500);
      req.resume();
      return res.end('Storage directory unavailable');
    }
    if (!hasEnoughDiskSpace(dir, n)) {
      res.writeHead(507);
      req.resume();
      return res.end('Insufficient free disk space for safe restore');
    }

    busy = true;
    const tmp = path.join(dir, '.mavi-import-' + crypto.randomBytes(16).toString('hex'));
    const sha = crypto.createHash('sha256');
    let headBuf = Buffer.alloc(0);
    let headerChecked = false;
    let size = 0;
    let failed = false;
    let settled = false;
    let outStream = null;

    const failAndClean = (status, msg, logCode) => {
      if (settled) return;
      settled = true;
      failed = true;
      const done = () => {
        cleanupTemp(tmp);
        busy = false;
        if (logCode) console.error('[migration] Import rejected:', logCode);
        if (!res.headersSent) {
          res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end(msg);
        }
      };
      if (outStream) {
        outStream.destroy();
        outStream = null;
      }
      done();
    };

    try {
      outStream = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600, highWaterMark: 65536 });
    } catch (e) {
      return failAndClean(500, 'Could not allocate temporary restore file', e.code || 'tmp_open_failed');
    }

    outStream.on('error', (e) => {
      req.resume();
      failAndClean(500, 'Temporary storage write failed; no database replaced.', e.code || 'tmp_write_failed');
    });

    req.on('data', (chunk) => {
      if (failed || settled) return;
      size += chunk.length;
      if (size > maxBytes || size > n) {
        req.destroy();
        return failAndClean(413, `Invalid size; maximum ${maxMib} MiB`, 'size_exceeded');
      }
      if (!headerChecked) {
        headBuf = headBuf.length === 0 ? chunk.subarray(0, 16) : Buffer.concat([headBuf, chunk], Math.min(16, headBuf.length + chunk.length));
        if (headBuf.length >= 16) {
          headerChecked = true;
          if (!headBuf.subarray(0, 16).equals(SQLITE_MAGIC)) {
            req.resume();
            return failAndClean(400, 'Invalid file, storage issue, or existing destination; no database replaced.', 'invalid_sqlite_magic');
          }
        }
      }
      sha.update(chunk);
      if (!outStream.write(chunk)) {
        req.pause();
        outStream.once('drain', () => {
          if (!failed && !settled) req.resume();
        });
      }
    });

    req.on('aborted', () => {
      failAndClean(400, 'Upload aborted', 'upload_aborted');
    });
    req.on('error', () => {
      failAndClean(400, 'Upload stream error', 'upload_error');
    });

    req.on('end', () => {
      if (failed || settled) return;
      if (size !== n || !headerChecked) {
        return failAndClean(400, 'Invalid file, storage issue, or existing destination; no database replaced.', 'incomplete_upload');
      }
      outStream.end(() => {
        if (failed || settled) return;
        outStream = null;
        let db = null;
        try {
          db = new Database(tmp, { readonly: true, fileMustExist: true });
          // Bound SQLite page cache to ~4 MiB during integrity/FK checks so 128 MiB containers stay well below ceiling.
          db.pragma('mmap_size = 0');
          db.pragma('cache_size = -4096');
          db.pragma('temp_store = FILE');
          db.pragma('query_only = ON');
          if (db.pragma('integrity_check', { simple: true }) !== 'ok') {
            throw new Error('integrity check failed');
          }
          const names = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name));
          for (const name of ['users', 'customers', 'orders', 'styles']) {
            if (!names.has(name)) throw new Error('not a MAVI backup');
          }
          if (db.pragma('foreign_key_check').length) {
            throw new Error('foreign key check failed');
          }
          db.close();
          db = null;

          fs.linkSync(tmp, dest);
          cleanupTemp(tmp);
          const digest = sha.digest('hex');
          settled = true;
          busy = false;
          console.log(`[migration] Backup validated and staged as ${targetName} (${size} bytes, sha256=${digest.slice(0, 16)}...)`);
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'X-Mavi-Restored-File': targetName,
            'X-Mavi-Restored-Bytes': String(size),
            'X-Mavi-Restored-Sha256': digest,
          });
          res.end('ok');
        } catch (e) {
          if (db) {
            try { db.close(); } catch (_) {}
          }
          failAndClean(400, 'Invalid file, storage issue, or existing destination; no database replaced.', e.code || 'validation_failed');
        }
      });
    });
  });

  server.requestTimeout = 300000;
  server.headersTimeout = 15000;
  server.listen(port, '0.0.0.0', () => console.log(`[migration] One-time import service listening (target=${targetName}, max=${maxMib}MiB)`));
}

module.exports = { start };
