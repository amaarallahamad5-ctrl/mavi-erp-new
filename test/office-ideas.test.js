'use strict';
/* 💡 Marketing ideas — the owner-decided SINGLE role of AI on the site.
   Also locks the owner's removal decisions:
   - team chat fully removed (UI + routes + backend module)
   - marketing team UI retired (no AI draft buttons, no marketing roles in
     the الأدوار tab, no marketing kinds in the desk composer)
   - OpenRouter key config + smart setup survive (they feed the ideas button)
   - operational follow-up drafts (real order data, no AI) stay */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

test('Marketing ideas: the single AI role + the chat/marketing-team removals hold', async () => {
  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');
  assert.ok(uiSrc.includes('officeOpenIdeasModal') && uiSrc.includes('officeGenIdeas'), 'the ideas modal + generator must exist');
  assert.ok(uiSrc.includes("officeApi('/ai/ideas'"), 'the ideas flow must call the ideas endpoint');
  assert.ok(uiSrc.includes('💡 أفكار تسويق'), 'the ideas button must be visible');
  assert.ok(uiSrc.includes('دور الذكاء الاصطناعي في الموقع — دور واحد بس'), 'the AI role must be defined in the settings modal');
  assert.ok(uiSrc.includes('قسم التسويق اتشال بقرار المالكة'), 'the roles tab must carry the retirement note');
  assert.ok(uiSrc.includes('MARKETING_KINDS'), 'the marketing-kind filter must exist');
  assert.ok(uiSrc.includes('officeSmartSetup') && uiSrc.includes('officeSaveAiConfig'), 'key config + smart setup must survive');
  // removals
  assert.ok(!uiSrc.includes('renderChatTab') && !uiSrc.includes('officeChatSend') && !uiSrc.includes("'/chat'"), 'zero chat UI references may remain');
  assert.ok(!uiSrc.includes('officeRunAiStep') && !uiSrc.includes('officeRunAiBatch') && !uiSrc.includes('officeRunAiDemo'), 'AI draft buttons must be gone');
  assert.ok(!uiSrc.includes('🧪'), 'the AI demo button must be gone');
  assert.ok(!uiSrc.includes('أعد التوليد بالذكاء الاصطناعي'), 'the regenerate-AI button must be gone');
  assert.ok(!uiSrc.includes('officeRenderAiActivity'), 'the draft activity panel must be gone');

  const clientSrc = fs.readFileSync(path.join(ROOT, 'src/openrouter-client.js'), 'utf8');
  assert.ok(clientSrc.includes('async function generateMarketingIdeas'), 'the ideas generator must exist');
  assert.ok(clientSrc.includes('مستشار تسويق عملي لبراند MAVI'), 'the honest ideas prompt must exist');
  assert.ok(clientSrc.includes('ممنوع تمامًا اختراع أسعار'), 'the no-invented-facts contract must be in the prompt');

  const routesSrc = fs.readFileSync(path.join(ROOT, 'src/office-routes.js'), 'utf8');
  assert.ok(routesSrc.includes("router.post('/ai/ideas'"), 'the ideas route must exist');
  assert.ok(!routesSrc.includes('office-chat'), 'the chat module must be unlinked from the routes');
  assert.ok(fs.existsSync(path.join(ROOT, 'src/office-chat.js')) === false, 'office-chat.js must be deleted');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'src/server.js'), 'utf8');
  assert.ok(!serverSrc.includes('/office/chat'), 'the chat router must be unmounted');

  /* Unit: the ideas generator parses a mocked provider answer leniently */
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-ideas-'));
  // The mocked provider answer is pre-serialized HERE so the nested template
  // never has to interpolate Arabic object literals.
  const ideasInner = JSON.stringify({ ideas: [
    { title: 'بوست قبل/بعد لفستان حقيقي', channel: 'إنستجرام', steps: '1) صوري فستان معتمد 2) انشري قبل/بعد 3) ردي على التعليقات', why: 'يرفع الثقة بالتفصيل على المقاس' },
    { title: 'رسالة عروض الموسم للعميلات القدام', channel: 'واتساب', steps: '1) اختاري قايمة العميلات 2) ابعتيلها رسالة قصيرة', why: 'بيعات أسهل من عميلات سابقات' },
  ] });
  const ideasPayloadStr = JSON.stringify({
    choices: [{ message: { content: '<think>تفكير</think>' + ideasInner } }],
  });
  const unitScript = `process.env.DB_PATH = ${JSON.stringify(path.join(tmpDir, 'unit.db'))};
process.env.AUTO_SEED = '0';
const assert = require('assert');
const path = require('path');
const ROOTP = ${JSON.stringify(ROOT)};
const orc = require(path.join(ROOTP, 'src/openrouter-client'));
const envCfg = { OPENROUTER_API_KEY: 'unit-test-key-0000000000', MAVI_OPENROUTER_ENABLED: '1' };
const ideasPayload = ${JSON.stringify(ideasPayloadStr)};
(async () => {
  const cfg = orc.createConfig(envCfg);
  cfg.validate();
  const ideas = await orc.generateMarketingIdeas(cfg, { transport: async () => ({ status: 200, raw: Buffer.from(ideasPayload) }) });
  assert.strictEqual(ideas.length, 2, 'the think block is stripped and both ideas survive');
  assert.strictEqual(ideas[0].title, 'بوست قبل/بعد لفستان حقيقي');
  assert.ok(ideas[0].steps.includes('انشري'));
  await assert.rejects(async () => orc.generateMarketingIdeas(cfg, { transport: async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: 'مفيش JSON هنا' } }] })) }) }), err => err.code === 'invalid_or_incomplete_draft_response');
  await assert.rejects(async () => orc.generateMarketingIdeas(cfg, { transport: async () => ({ status: 401, raw: Buffer.from('{}') }) }), err => err.code === 'provider_auth_failed');
  console.log('UNIT-IDEAS-OK');
})().catch(e => { console.error('UNIT-IDEAS-ERR', e && e.code, e && e.message); process.exit(1); });
`;
  const unitPath = path.join(tmpDir, 'unit-ideas.js');
  fs.writeFileSync(unitPath, unitScript);
  const run = spawnSync(process.execPath, [unitPath], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(run.status, 0, (run.stderr || '') + ' | stdout: ' + (run.stdout || ''));
  assert.ok(run.stdout.includes('UNIT-IDEAS-OK'));

  /* Route: staff 403; owner with the provider off gets an honest in-band no */
  const PORT = 3090;
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
    const staffRes = await api('POST', '/ai/ideas', staffT, {});
    assert.strictEqual(staffRes.status, 403, 'staff must never request ideas');
    const ownerRes = await api('POST', '/ai/ideas', ownerT, {});
    assert.strictEqual(ownerRes.status, 200);
    const ownerBody = await ownerRes.json();
    assert.strictEqual(ownerBody.ok, false, 'with the provider off the answer is honest, not a fake');
    assert.strictEqual(ownerBody.error_code, 'openrouter_disabled');
    // the chat endpoints are gone entirely
    const chatRes = await api('GET', '/chat', ownerT, undefined);
    assert.strictEqual(chatRes.status, 404, 'the chat route must answer 404 after removal');
  } finally {
    child.kill('SIGKILL');
  }

  console.log('IDEAS-OK');
});
