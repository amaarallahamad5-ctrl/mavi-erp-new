'use strict';
/* Alibaba Cloud Model Studio (Qwen) second provider:
   - validate() BEFORE any claim/network (staging/disabled/bad key/non-qwen model)
   - same gated draft pipeline: public-catalogue facts only, human review, routing block omitted
   - local token guard hard-stops BEFORE the request when the trial allowance is spent
   - aiFirstPrepare/regenerate use it ONLY as a fallback behind OpenRouter
   - owner-only config endpoints; staff never (403) */
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

test('Alibaba Qwen second provider: gates, guarded trial, fallback order, owner-only config', async () => {
  const clientSrc = fs.readFileSync(path.join(ROOT, 'src/alibaba-client.js'), 'utf8');
  assert.ok(clientSrc.includes('alibaba_quota_guard_reached'), 'token guard must exist');
  assert.ok(clientSrc.includes('guardBeforeRequest'), 'pre-request guard hook must exist');

  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');
  assert.ok(uiSrc.includes('of-ai2-key'), 'settings modal must expose the Alibaba key field');
  assert.ok(uiSrc.includes('officeTestAi2'), 'Alibaba connection test handler must exist');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-alibaba-'));
  const unitScript = `process.env.DB_PATH = ${JSON.stringify(path.join(tmpDir, 'unit.db'))};
process.env.AUTO_SEED = '0';
const assert = require('assert');
const path = require('path');
const ROOTP = ${JSON.stringify(ROOT)};
const { OfficeEngine, makeActor } = require(path.join(ROOTP, 'src/office-engine'));
require(path.join(ROOTP, 'src/office-cases'));
const ali = require(path.join(ROOTP, 'src/alibaba-client'));
const { run } = require(path.join(ROOTP, 'src/db'));
const engine = new OfficeEngine({});
const owner = makeActor('user:1', 'owner');
const okQwen = async () => ({ status: 200, raw: Buffer.from(JSON.stringify({
  choices: [{ message: { content: JSON.stringify({ title: 'مسودة كوين', text: 'نص كوين للمراجعة.', review_checklist: ['x'] }) }, finish_reason: 'stop' }],
  model: 'qwen-plus', usage: { total_tokens: 120 },
})) });

(async () => {
  run("INSERT OR IGNORE INTO styles(id,name,type,price,lead_days,active) VALUES('DRESS1','فستان سواريه','made',900,7,1)");

  // A. Gates fire BEFORE any claim/network
  const jGate = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'ali-gate-1', owner);
  let transportCalled = false;
  const notCalled = async () => { transportCalled = true; return { status: 200, raw: Buffer.from('{}') }; };
  console.error('M1'); await assert.rejects(() => engine.runOnce({ provider: 'alibaba', transport: notCalled }), err => err.code === 'openrouter_disabled', 'disabled by default'); console.error('M1ok');
  process.env.MAVI_STAGING_MODE = '1';
  run("INSERT INTO settings(key,value) VALUES('office_ds_api_key','sk-valid-key-123456789') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  run("INSERT INTO settings(key,value) VALUES('office_ds_enabled','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  console.error('M2'); await assert.rejects(() => engine.runOnce({ provider: 'alibaba', transport: notCalled }), err => err.code === 'openrouter_disabled_in_staging', 'staging blocks the trial layer too'); console.error('M2ok');
  delete process.env.MAVI_STAGING_MODE;
  run("UPDATE settings SET value='sk-short' WHERE key='office_ds_api_key'");
  console.error('M3'); await assert.rejects(() => engine.runOnce({ provider: 'alibaba', transport: notCalled }), err => err.code === 'missing_or_invalid_server_key'); console.error('M3ok');
  run("UPDATE settings SET value='sk-valid-key-123456789' WHERE key='office_ds_api_key'");
  run("INSERT INTO settings(key,value) VALUES('office_ds_model','gpt-4o') ON CONFLICT(key) DO UPDATE SET value=excluded.value");
  console.error('M4'); await assert.rejects(() => engine.runOnce({ provider: 'alibaba', transport: notCalled }), err => err.code === 'only_qwen_model_ids_are_allowed', 'non-qwen model rejected'); console.error('M4ok');
  run("UPDATE settings SET value='qwen-plus' WHERE key='office_ds_model'");
  assert.strictEqual(engine.get(jGate.id, owner).status, 'queued', 'gate failures must not claim the job');

  // B. Success path: same gated pipeline, alibaba provenance, routing block omitted
  const step = await engine.runOnce({ provider: 'alibaba', jobId: jGate.id, transport: async (body, secret) => {
    assert.strictEqual(body.model, 'qwen-plus');
    assert.ok(secret.startsWith('sk-'), 'dashscope bearer secret');
    assert.strictEqual(body.provider, undefined, 'the OpenRouter routing block must be omitted on DashScope');
    assert.ok(!JSON.stringify(body.messages).includes('price'), 'no price fields in the prompt');
    return okQwen();
  }});
  assert.strictEqual(step.status, 'review');
  assert.strictEqual(step.mode, 'alibaba');
  const done = engine.get(jGate.id, owner);
  assert.strictEqual(done.status, 'review');
  assert.strictEqual(done.result.provenance.source, 'alibaba_qwen_draft');
  assert.strictEqual(done.result.provenance.trial_guarded, true);
  const usedAfter = Number(require('child_process') && 0) || 0;

  // C. Token guard: reaching the cap hard-stops a QUEUED job BEFORE the request
  const { setSetting } = require(path.join(ROOTP, 'src/db'));
  setSetting('office_ds_tokens_used', '900000');
  assert.strictEqual(engine.get(jGate.id, owner).status, 'review', 'the guard must not touch an already-finished job');
  const jGuard = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'facebook' }, 'ali-guard-1', owner);
  console.error('M5');
  const guardStep = await engine.runOnce({ provider: 'alibaba', jobId: jGuard.id, transport: async () => { transportCalled = true; return okQwen(); } });
  assert.strictEqual(guardStep.status, 'failed');
  assert.strictEqual(guardStep.error_code, 'alibaba_quota_guard_reached', 'the guard must surface its own code: ' + guardStep.error_code);
  assert.strictEqual(transportCalled, false, 'zero network when the guard trips');
  assert.strictEqual(transportCalled, false, 'zero network when the guard trips');
  setSetting('office_ds_tokens_used', '0');

  // D. Fallback order: OpenRouter not ready + Alibaba ready -> the trial layer backs up
  setSetting('office_ds_tokens_used', '0');
  process.env.MAVI_OPENROUTER_ENABLED = '0';
  const jFb = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'ali-fb-1', owner);
  const sum = await engine.aiFirstPrepare({ max: 1, jobId: jFb.id, transport: async (body, secret, meta) => {
    assert.ok(String(meta && meta.host || '').includes('dashscope'), 'fallback must hit the dashscope endpoint');
    return okQwen();
  }});
  assert.strictEqual(sum.ai_succeeded, 1, 'the ready secondary must carry the attempt');
  assert.strictEqual(sum.steps[0].provider, 'alibaba');
  assert.strictEqual(sum.steps[0].mode, 'ai');
  assert.strictEqual(engine.get(jFb.id, owner).result.provenance.source, 'alibaba_qwen_draft');

  // E. Activity stats count both sources
  const stats = engine.aiActivityStats(owner);
  assert.ok(stats.last_24h.ai_ok >= 2, 'both providers drafts count as AI');
  delete process.env.MAVI_OPENROUTER_ENABLED;

  console.log('UNIT-ALIBABA-OK');
})().catch(e => { console.error('UNIT-ALI-ERR', e && e.code, e && e.message); process.exit(1); });
`;

  const unitPath = path.join(tmpDir, 'unit-ali.js');
  fs.writeFileSync(unitPath, unitScript);
  const run = spawnSync(process.execPath, [unitPath], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(run.status, 0, (run.stderr || '') + ' | stdout: ' + (run.stdout || ''));
  assert.ok(run.stdout.includes('UNIT-ALIBABA-OK'));

  /* Route-level gating: staff 403 on save/test, no-session 401 */
  const { spawn } = require('child_process');
  const net = require('net');
  const PORT = 3078;
  const BASE = `http://127.0.0.1:${PORT}`;
  const dbPath = path.join(tmpDir, 'routes.db');
  const seeded = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
  });
  assert.strictEqual(seeded.status, 0, seeded.stderr);
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: dbPath, PORT: String(PORT), MAVI_OPENROUTER_ENABLED: '0' },
    stdio: 'ignore',
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start')), 20000);
      const poll = async () => {
        try { const r = await fetch(`${BASE}/store/`); if (r.status < 502) return resolve(); } catch (_) {}
        setTimeout(poll, 250);
      };
      poll();
    });
    const login = async (email, password) => {
      const r = await fetch(`${BASE}/api/admin/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      assert.strictEqual(r.status, 200);
      return (await r.json()).token;
    };
    const ownerT = await login('owner@mavi.eg', 'mavi-owner');
    const staffT = await login('staff@mavi.eg', 'mavi-staff');
    const api = (method, p, token, body) => fetch(`${BASE}/api/admin/office${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Mavi-Token': token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const staffCfg = await api('POST', '/ai/alibaba/config', staffT, { api_key: 'sk-abcdefghijklmnopqrst', model: 'qwen-plus', enabled: true, region: 'intl' });
    assert.strictEqual(staffCfg.status, 403);
    const staffTest = await api('POST', '/ai/alibaba/test', staffT, {});
    assert.strictEqual(staffTest.status, 403);
    const ownerCfg = await api('POST', '/ai/alibaba/config', ownerT, { api_key: 'sk-abcdefghijklmnopqrst', model: 'qwen-plus', enabled: false, region: 'intl' });
    assert.strictEqual(ownerCfg.status, 200);
    const cfgJson = await ownerCfg.json();
    assert.strictEqual(cfgJson.alibaba.enabled, false);
    const badModel = await api('POST', '/ai/alibaba/config', ownerT, { api_key: 'sk-abcdefghijklmnopqrst', model: 'gpt-4o', enabled: true, region: 'intl' });
    assert.strictEqual(badModel.status, 400);
    const cfgRes = await api('GET', '/ai/config', ownerT, undefined);
    const cfgBody = await cfgRes.json();
    assert.ok(cfgBody.alibaba && cfgBody.alibaba.model === 'qwen-plus', 'GET /ai/config must include the alibaba summary');
    // Paste artifacts (console Copy with quotes, wrapped lines, BiDi chars) must
    // be cleaned server-side so a real key survives an imperfect paste.
    const messy = await api('POST', '/ai/alibaba/config', ownerT, { api_key: ' \u201Csk-abcdefghijklmnopqrst\u201D\n', model: 'qwen-plus', enabled: false, region: 'intl' });
    assert.strictEqual(messy.status, 200, 'quoted/wrapped key paste must still save');
    const messyJson = await messy.json();
    assert.strictEqual(messyJson.alibaba.key_tail, 'qrst', 'quotes/spaces must be stripped before saving');
    const wrongPrefix = await api('POST', '/ai/alibaba/config', ownerT, { api_key: 'workspace-123456789', model: 'qwen-plus', enabled: false, region: 'intl' });
    assert.strictEqual(wrongPrefix.status, 400, 'a non-sk- value must be rejected with the honest sk- message');
    const wrongPrefixJson = await wrongPrefix.json();
    assert.strictEqual(wrongPrefixJson.error, 'missing_or_invalid_server_key');
    assert.ok(wrongPrefixJson.message.includes('sk-'), 'the rejection message must point at the sk- format, not a generic invalid key');
    const dirtyBody = await api('POST', '/ai/alibaba/config', ownerT, { api_key: 'sk-abc def__ghi\t1234567890', model: 'qwen-plus', enabled: false, region: 'intl' });
    assert.strictEqual(dirtyBody.status, 200, 'internal whitespace must be stripped, not rejected');
    const dirtyJson = await dirtyBody.json();
    assert.strictEqual(dirtyJson.alibaba.key_tail, '7890', 'whitespace-stripped key must be the saved one');
    // Copying the console's MASKED display yields sk- + bullets — must be named
    // as "you copied the hidden text, not the key", not a generic invalid key.
    const masked = await api('POST', '/ai/alibaba/config', ownerT, { api_key: 'sk-••••••••••••••••••••', model: 'qwen-plus', enabled: false, region: 'intl' });
    assert.strictEqual(masked.status, 400);
    const maskedJson = await masked.json();
    assert.ok(maskedJson.message.includes('نقط إخفاء'), 'masked-display copy must be called out explicitly, got: ' + maskedJson.message);
    const placeholder = await api('POST', '/ai/alibaba/config', ownerT, { api_key: 'sk-xxx', model: 'qwen-plus', enabled: false, region: 'intl' });
    assert.strictEqual(placeholder.status, 400);
    const placeholderJson = await placeholder.json();
    assert.ok(placeholderJson.message.includes('مثال'), 'doc placeholder (sk-xxx) must be called out as an example, got: ' + placeholderJson.message);
  } finally {
    child.kill('SIGKILL');
  }
});
