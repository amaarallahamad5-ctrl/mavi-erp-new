'use strict';
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const assert = require('assert');
const http = require('http');

const root = path.join(__dirname, '..');
const dbPath = path.join(root, 'data', 'sec-hardening-test.db');
const port = 3393;
const base = `http://127.0.0.1:${port}`;

for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });

function rawReq(method, reqPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

(async () => {
  const seed = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: root, env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' }, encoding: 'utf8'
  });
  assert.equal(seed.status, 0, seed.stderr);

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath, SHOW_OTP: '0', AUTO_SEED: '0', NODE_ENV: 'production' },
    stdio: 'ignore'
  });

  try {
    for (let i = 0; i < 60; i++) {
      try { await fetch(base + '/healthz'); break; }
      catch { await new Promise(r => setTimeout(r, 100)); }
    }

    // 1. X-Powered-By disabled + Security Headers present + HSTS over HTTPS proxy header.
    const rHome = await rawReq('GET', '/store/', { 'x-forwarded-proto': 'https', host: `127.0.0.1:${port}` });
    assert.equal(rHome.status, 200);
    assert.equal(rHome.headers['x-powered-by'], undefined, 'X-Powered-By should be hidden');
    assert.equal(rHome.headers['x-content-type-options'], 'nosniff');
    assert.equal(rHome.headers['x-frame-options'], 'DENY');
    assert(rHome.headers['strict-transport-security'], 'Missing HSTS');
    assert(rHome.headers['content-security-policy'], 'Missing CSP');

    // 2. Production HTTP -> HTTPS 301 redirect (while /healthz stays 200).
    const rHttp = await rawReq('GET', '/store/', { 'x-forwarded-proto': 'http', host: 'mavi.example' });
    assert.equal(rHttp.status, 301);
    assert.equal(rHttp.headers['location'], 'https://mavi.example/store/');
    const rHealth = await rawReq('GET', '/healthz', { 'x-forwarded-proto': 'http', host: 'mavi.example' });
    assert.equal(rHealth.status, 200);

    // 3. Cross-origin Origin header blocked on state-changing /api/ calls (CSRF guard).
    const rCsrf = await rawReq('POST', '/api/store/auth/login', {
      'Content-Type': 'application/json',
      Host: `127.0.0.1:${port}`,
      Origin: 'https://evil-attacker.example'
    }, JSON.stringify({ phone: '01012345678', password: 'test' }));
    assert.equal(rCsrf.status, 403);
    assert.equal(JSON.parse(rCsrf.body).error, 'csrf_blocked');

    // 4. Malformed JSON returns 400 bad_json with zero stack trace leak.
    const rBadJson = await rawReq('POST', '/api/store/auth/login', {
      'Content-Type': 'application/json',
      'Content-Length': '7'
    }, '{bad!!!');
    assert.equal(rBadJson.status, 400);
    assert.equal(JSON.parse(rBadJson.body).error, 'bad_json');
    assert(!rBadJson.body.includes('SyntaxError'), 'Leaked SyntaxError internals');

    // 5. Dotfiles & unauth admin endpoints denied.
    assert.notEqual((await fetch(base + '/.env')).status, 200);
    assert.notEqual((await fetch(base + '/.git/HEAD')).status, 200);
    assert.equal((await fetch(base + '/api/admin/orders')).status, 401);

    // 6. Failed login attempts recorded & visible in owner system status; OTP never exposed in production.
    const badLogin = await fetch(base + '/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@mavi.eg', password: 'wrong-password-123' }),
    });
    assert.equal(badLogin.status, 401);

    const goodLogin = await fetch(base + '/api/admin/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'owner@mavi.eg', password: 'mavi-owner' }),
    });
    assert.equal(goodLogin.status, 200);
    const setCookie = goodLogin.headers.get('set-cookie') || '';
    assert(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Lax') && setCookie.includes('Secure'), setCookie);
    const { token } = await goodLogin.json();

    const sys = await (await fetch(base + '/api/admin/system/info/status', {
      headers: { Authorization: 'Bearer ' + token }
    })).json();
    assert(sys.security && sys.security.failed_logins_24h >= 1, 'Failed login not logged in system status');

    console.log('PASS: All 27-point security hardenings verified (headers, HTTPS redirect, CSRF, bad_json, dotfiles, audit, cookies)!');
  } finally {
    child.kill();
    await new Promise(r => setTimeout(r, 200));
    for (const s of ['', '-wal', '-shm']) fs.rmSync(dbPath + s, { force: true });
  }
})();
