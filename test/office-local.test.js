'use strict';
/* The owner's LOCAL layer: a model executed on her own machine via Docker
   Model Runner (e.g. hf.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2) — free,
   unlimited, no key, no cloud, no 401.
   - validate(): disabled by default; staging blocks it like every provider
   - the model id is used verbatim (no :free contract, no OpenRouter resolution)
   - no provider routing block, no enable_thinking, '/no_think' switch appended
     (Nemotron v2 documented control) so reasoning stays off
   - <think>...</think> reasoning blocks are stripped before JSON extraction
   - last in the honest fallback chain (openrouter -> alibaba -> local)
   - owner-only config/test endpoints; staff never (403) */
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

test('Local Docker model layer: gates, verbatim model id, think-strip, last fallback, owner-only config', async () => {
  const clientSrc = fs.readFileSync(path.join(ROOT, 'src/openrouter-client.js'), 'utf8');
  assert.ok(clientSrc.includes('createLocalConfig'), 'the local config factory must exist');
  assert.ok(clientSrc.includes('/no_think'), 'the Nemotron reasoning-off switch must be documented in code');

  const engineSrc = fs.readFileSync(path.join(ROOT, 'src/office-engine.js'), 'utf8');
  assert.ok(engineSrc.includes("local_model_draft"), 'the local provenance source must exist');

  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');
  assert.ok(uiSrc.includes('officeSmartSetup'), 'the one-button smart setup must exist');
  assert.ok(uiSrc.includes("'/ai/local/test'"), 'the smart setup must test the local layer too');
  assert.ok(uiSrc.includes('زر واحد: فعّلي كل الطرق المجانية'), 'the smart button label must be visible in the settings modal');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-local-'));
  const unitScript = `process.env.DB_PATH = ${JSON.stringify(path.join(tmpDir, 'unit.db'))};
process.env.AUTO_SEED = '0';
const assert = require('assert');
const path = require('path');
const ROOTP = ${JSON.stringify(ROOT)};
const { OfficeEngine, makeActor } = require(path.join(ROOTP, 'src/office-engine'));
require(path.join(ROOTP, 'src/office-cases'));
const orc = require(path.join(ROOTP, 'src/openrouter-client'));
const { setSetting: ss } = require(path.join(ROOTP, 'src/db'));
const engine = new OfficeEngine({});
const owner = makeActor('user:1', 'owner');
const okLocal = () => ({ status: 200, raw: Buffer.from(JSON.stringify({
  choices: [{ message: { content: '<think>النموذج بيفكر...</think>' + JSON.stringify({ title: 'مسودة محلية', text: 'نص من الموديل المحلي على الجهاز.', review_checklist: ['تم'] }) }, finish_reason: 'stop' }],
  model: 'hf.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2', usage: { total_tokens: 90 },
})) });

(async () => {
  require(path.join(ROOTP, 'src/db')).run("INSERT OR IGNORE INTO styles(id,name,type,price,lead_days,active) VALUES('DRESS1','فستان سواريه','made',900,7,1)");

  // A. Default state: disabled — no silent local inference
  await assert.rejects(() => engine.runOnce({ provider: 'local', transport: async () => okLocal() }), err => err.code === 'local_disabled', 'disabled by default');

  // B. Staging blocks the local layer like every network provider
  ss('office_local_enabled', '1');
  process.env.MAVI_STAGING_MODE = '1';
  await assert.rejects(() => engine.runOnce({ provider: 'local', transport: async () => okLocal() }), err => err.code === 'openrouter_disabled_in_staging', 'staging blocks the local layer too');
  delete process.env.MAVI_STAGING_MODE;

  // C. Enabled: verbatim model id, no routing block, no enable_thinking,
  //    '/no_think' switch on the system prompt, <think> stripped, review landing
  const cfg = orc.createLocalConfig();
  cfg.validate();
  assert.strictEqual(cfg.getModel(), 'hf.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2', 'the Nemotron default model id');
  assert.strictEqual(cfg.omitProviderRouting, true, 'no OpenRouter routing block');
  assert.strictEqual(cfg.providerName, 'local', 'the provider name flows into the draft mode');
  const jLoc = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'loc-1', owner);
  let bodyLoc = null;
  await engine.runOnce({ provider: 'local', jobId: jLoc.id, transport: async (body) => { bodyLoc = body; return okLocal(); } });
  assert.ok(bodyLoc, 'the local draft must reach the transport');
  assert.strictEqual(bodyLoc.model, 'hf.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2', 'the model id is used verbatim');
  assert.strictEqual(bodyLoc.provider, undefined, 'no provider routing block is sent');
  assert.strictEqual('enable_thinking' in bodyLoc, false, 'thinking is never sent');
  assert.ok(bodyLoc.messages[0].content.endsWith('/no_think'), 'the system prompt carries the /no_think switch');
  const jobLoc = engine.get(jLoc.id, owner);
  assert.strictEqual(jobLoc.status, 'review', 'a local success lands in review');
  assert.strictEqual(jobLoc.result.provenance.source, 'local_model_draft');
  assert.strictEqual(jobLoc.result.provenance.free_model_only, false, 'the free-contract flag belongs to OpenRouter only');
  assert.ok(jobLoc.result.text.includes('نص من الموديل المحلي'), 'the <think> block was stripped and the draft parsed');

  // D. Last fallback: openrouter + alibaba not ready -> local carries the attempt
  process.env.MAVI_OPENROUTER_ENABLED = '0';
  const jFb = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'loc-fb-1', owner);
  const sum = await engine.aiFirstPrepare({ max: 1, jobId: jFb.id, transport: async () => okLocal() });
  assert.strictEqual(sum.ai_succeeded, 1, 'the local layer must carry the attempt when the cloud is down');
  assert.strictEqual(sum.steps[0].provider, 'local');
  process.env.MAVI_OPENROUTER_ENABLED = '';

  // E. The whitelist stays honest: an unknown provider still fails loudly
  // runOnce throws the whitelist error SYNCHRONOUSLY — an async wrapper is
  // required or the throw escapes assert.rejects entirely.
  await assert.rejects(async () => engine.runOnce({ provider: 'nope', transport: async () => okLocal() }), err => err.code === 'provider_not_implemented_no_network_call_made');

  console.log('UNIT-LOCAL-OK');
})().catch(e => { console.error('UNIT-LOCAL-ERR', e && e.code, e && e.message); process.exit(1); });
`;

  const unitPath = path.join(tmpDir, 'unit-local.js');
  fs.writeFileSync(unitPath, unitScript);
  const run = spawnSync(process.execPath, [unitPath], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(run.status, 0, (run.stderr || '') + ' | stdout: ' + (run.stdout || ''));
  assert.ok(run.stdout.includes('UNIT-LOCAL-OK'));

  /* Route-level: staff 403 on save/test, owner saves + summary round-trips */
  const { spawn } = require('child_process');
  const PORT = 3082;
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
    const staffCfg = await api('POST', '/ai/local/config', staffT, { enabled: true, model: '', base_url: '' });
    assert.strictEqual(staffCfg.status, 403, 'staff must never configure the local layer');
    const staffTest = await api('POST', '/ai/local/test', staffT, {});
    assert.strictEqual(staffTest.status, 403, 'staff must never test the local layer');
    const ownerCfg = await api('POST', '/ai/local/config', ownerT, { enabled: true, model: 'hf.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2', base_url: 'http://127.0.0.1:12434/engines/v1' });
    assert.strictEqual(ownerCfg.status, 200, 'the owner saves the local layer');
    const ownerCfgJson = await ownerCfg.json();
    assert.strictEqual(ownerCfgJson.local.enabled, true);
    assert.strictEqual(ownerCfgJson.local.model, 'hf.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2');
    const badUrl = await api('POST', '/ai/local/config', ownerT, { enabled: false, model: '', base_url: 'ftp://nope' });
    assert.strictEqual(badUrl.status, 400, 'a non-http(s) base URL must be rejected');
    const badModel = await api('POST', '/ai/local/config', ownerT, { enabled: false, model: 'has space', base_url: '' });
    assert.strictEqual(badModel.status, 400, 'an invalid model id must be rejected');
    const cfgRes = await api('GET', '/ai/config', ownerT, undefined);
    const cfgBody = await cfgRes.json();
    assert.ok(cfgBody.local && cfgBody.local.model === 'hf.co/nvidia/NVIDIA-Nemotron-Nano-9B-v2', 'GET /ai/config must include the local summary');
    assert.strictEqual(cfgBody.local.base_ok, true, 'the default base URL must parse');
  } finally {
    child.kill('SIGKILL');
  }

  console.log('ROUTES-LOCAL-OK');
});
