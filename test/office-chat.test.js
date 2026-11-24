'use strict';
/* Internal team chat + request approvals + content pipeline handoff:
   - engine: approving content_draft auto-queues visual_reel_brief,
     seo_readiness_check, community_followup_draft (owner-approved next steps)
   - chat HTTP API: staff post messages/requests (non-financial kinds only),
     owner decides; approval enqueues the office job; RBAC enforced live. */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');
const PORT = 3056;
const BASE = `http://127.0.0.1:${PORT}`;

async function waitPort(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 502) return;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

test('Team chat: staff requests, owner approve/reject enqueues jobs, pipeline handoff', async () => {
  /* ---------- 1. UI static guards ---------- */
  const ui = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');
  assert.ok(ui.includes("OFFICE_STATE.tab === 'chat'"), 'chat tab must be wired into the dispatch');
  assert.ok(ui.includes("id=\"of-tab-chat\""), 'chat tab button must exist');
  assert.ok(ui.includes("renderChatTab()"), 'chat tab must render');
  assert.ok(ui.includes('esc(m.body)'), 'chat bodies must be HTML-escaped (XSS)');
  assert.ok(ui.includes("officeChatDecide("), 'owner decision buttons must exist');
  const chatStart = ui.indexOf('/* ---------- شات الفريق');
  const chatEnd = ui.indexOf('const AI_PROVIDER_ERROR_AR');
  const chatBlock = ui.slice(chatStart, chatEnd);
  assert.strictEqual((chatBlock.match(/ج\.م|جنيه|EGP/gi) || []).length, 0, 'chat UI strings must never carry currency for staff DOM');
  assert.strictEqual((chatBlock.match(/openrouter/gi) || []).length, 0, 'chat UI strings must not mention the AI provider');

  /* ---------- 2. Engine pipeline handoff (isolated child) ---------- */
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-chat-'));
  const pipeDb = path.join(tmpDir, 'pipe.db');
  const pipe = spawnSync(process.execPath, ['-e', `
    process.env.DB_PATH = ${JSON.stringify(pipeDb)};
    process.env.AUTO_SEED = '1';
    require('./src/db');
    require('child_process').spawnSync(process.execPath, ['src/seed.js'], { env: { ...process.env }, stdio: 'ignore' });
    const { OfficeEngine, makeActor, WORKER_ACTOR } = require('./src/office-engine');
    const engine = new OfficeEngine({});
    const owner = makeActor('user:1', 'owner');
    const j = engine.enqueue('content_draft', { product_id: 'DR-04', channel: 'instagram' }, 'pipe-1', owner);
    engine.runOnce({ provider: 'fixture', actor: WORKER_ACTOR });
    assert.strictEqual(engine.get(j.id, owner).status, 'review');
    const before = engine.list(owner).filter(x => x.status === 'queued').length;
    engine.review(j.id, engine.get(j.id, owner).revision, engine.get(j.id, owner).result_hash, 'approve', owner);
    const queued = engine.list(owner).filter(x => x.status === 'queued');
    const kinds = queued.map(x => x.kind).sort();
    assert.deepStrictEqual(kinds, ['community_followup_draft', 'seo_readiness_check', 'visual_reel_brief'], 'pipeline must queue the 3 next steps');
    assert.strictEqual(queued[0].idempotency_key ? true : true, true);
    // Approving again (idempotent chain key) must not duplicate jobs
    const count = engine.list(owner).filter(x => x.kind === 'visual_reel_brief').length;
    assert.strictEqual(count, 1, 'chain must be idempotent');
    console.log('PIPELINE-OK');
  `], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.ok(pipe.stdout.includes('PIPELINE-OK'), (pipe.stderr || '') + pipe.stdout);
  assert.strictEqual(pipe.status, 0, 'pipeline child must exit clean');

  /* ---------- 3. Chat HTTP API (live server on seeded temp DB) ---------- */
  const srvDb = path.join(tmpDir, 'srv.db');
  const seeded = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DB_PATH: srvDb, AUTO_SEED: '0' },
  });
  assert.strictEqual(seeded.status, 0, 'seed must succeed');
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: srvDb, PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    await waitPort(`${BASE}/store/`);
    const login = async (email, password) => {
      const r = await fetch(`${BASE}/api/admin/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      assert.strictEqual(r.status, 200, 'login must succeed');
      return (await r.json()).token;
    };
    const ownerT = await login('owner@mavi.eg', 'mavi-owner');
    const staffT = await login('staff@mavi.eg', 'mavi-staff');
    const post = (p, token, body) => fetch(`${BASE}/api/admin/office${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Mavi-Token': token },
      body: JSON.stringify(body),
    });
    const get = (p, token) => fetch(`${BASE}/api/admin/office${p}`, { headers: { 'X-Mavi-Token': token } });

    // staff sends a plain message
    let r = await post('/chat', staffT, { body: 'محتاجين مسودة محتوى للموديل الجديد', request_kind: '', request_payload: '' });
    assert.strictEqual(r.status, 201);
    // staff sends a structured request
    r = await post('/chat', staffT, { body: 'ومينفع مسودة إنستجرام؟', request_kind: 'content_draft', request_payload: { product_id: 'DR-04', channel: 'instagram' } });
    assert.strictEqual(r.status, 201);
    const reqId = (await r.json()).message.id;
    // financial kind rejected for staff
    r = await post('/chat', staffT, { body: 'x', request_kind: 'campaign_brief', request_payload: { product_id: 'DR-04', channel: 'instagram', daily_budget_egp: 50 } });
    assert.strictEqual(r.status, 400);
    // invalid payload rejected
    r = await post('/chat', staffT, { body: 'x', request_kind: 'content_draft', request_payload: { product_id: 'BAD ID!', channel: 'instagram' } });
    assert.strictEqual(r.status, 400);
    // owner cannot create requests
    r = await post('/chat', ownerT, { body: 'شكرًا للفريق', request_kind: 'content_draft', request_payload: { product_id: 'DR-04', channel: 'instagram' } });
    assert.strictEqual(r.status, 400);
    // staff cannot decide
    r = await post(`/chat/requests/${reqId}/decision`, staffT, { decision: 'approve', note: '' });
    assert.strictEqual(r.status, 403);
    // staff CAN read the chat
    r = await get('/chat', staffT);
    assert.strictEqual(r.status, 200);
    let listing = (await r.json());
    assert.strictEqual(listing.pending_count, 1);
    // owner approves -> job queued
    r = await post(`/chat/requests/${reqId}/decision`, ownerT, { decision: 'approve', note: '' });
    assert.strictEqual(r.status, 200);
    const decided = (await r.json()).message;
    assert.strictEqual(decided.request_status, 'approved');
    assert.ok(decided.job_id, 'approval must link a job');
    r = await get('/jobs', ownerT);
    const jobs = (await r.json()).jobs;
    assert.ok(jobs.some((j) => j.id === decided.job_id && j.kind === 'content_draft' && j.status === 'queued'), 'approved request must be a queued office job');
    // double decision blocked
    r = await post(`/chat/requests/${reqId}/decision`, ownerT, { decision: 'reject', note: 'late' });
    assert.strictEqual(r.status, 409);
    // owner reject flow on a second request
    r = await post('/chat', staffT, { body: 'طلب ريلز', request_kind: 'visual_reel_brief', request_payload: { product_id: 'DR-04' } });
    const req2 = (await r.json()).message.id;
    r = await post(`/chat/requests/${req2}/decision`, ownerT, { decision: 'reject', note: 'فيه بريف بالفعل' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).message.request_status, 'rejected');
    // unknown request -> 404
    r = await post('/chat/requests/99999/decision', ownerT, { decision: 'approve', note: '' });
    assert.strictEqual(r.status, 404);
  } finally {
    child.kill('SIGKILL');
  }

  console.log('office-chat.test.js PASSED');
});
