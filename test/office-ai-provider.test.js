'use strict';
/* Gated OpenRouter AI provider verification (offline, mock transports only — this sandbox
   and CI never reach openrouter.ai):
   - Engine runOnce(provider:'openrouter'): config validated BEFORE claiming (disabled /
     staging / bad key -> throw, zero claim, zero network); only content_draft /
     campaign_brief supported; other kinds fail with ai_provider_kind_not_supported and no
     transport call; success completes the job into 'review' with ai_generated provenance,
     human-review checklist, allowlisted public facts, and network_calls: 1.
   - Client: per-kind payload allowlists (content_draft = product_id+channel,
     campaign_brief adds 1-100 budget), real-catalogue public facts accepted ONLY as
     {id,name,note} strings (never price/cost/customer data), free-model IDs enforced,
     0-cost usage enforced, live transport exists but is never exercised here.
   - UI: the AI step button renders for the owner only when the provider is configured
     and a queued marketing job exists; staff never see it (owner-only toolbar). */
const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

function mockOk(title, text, model) {
  return async () => {
    const draft = JSON.stringify({
      title: title || 'مسودة AI تجريبية',
      text: text || 'نص تجريبي قصير للمراجعة البشرية.',
      review_checklist: ['راجعي النص قبل الاعتماد'],
    });
    return {
      status: 200,
      raw: Buffer.from(JSON.stringify({
        choices: [{ message: { content: draft }, finish_reason: 'stop' }],
        model: model || 'test/vendor:free',
        usage: { cost: 0, total_tokens: 42 },
      })),
    };
  };
}

test('Gated OpenRouter AI provider: engine flow, client contracts, and owner-only UI gating', async () => {
  /* ---------------- 1. Static guards ---------------- */
  const clientSrc = fs.readFileSync(path.join(ROOT, 'src/openrouter-client.js'), 'utf8');
  assert.ok(clientSrc.includes('createLiveTransport'), 'client must expose a real HTTPS transport factory');
  assert.ok(clientSrc.includes('generateMarketingDraft'), 'client must expose the gated draft generation');
  assert.ok(clientSrc.includes("max_price: { prompt: 0, completion: 0 }"), '0-cost enforcement must stay in the request body');
  assert.ok(clientSrc.includes("data_collection: 'deny'"), 'provider data collection must stay denied');

  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');
  assert.ok(uiSrc.includes('officeRunAiStep'), 'UI must have an AI step handler');
  assert.ok(uiSrc.includes('of-ai-step-btn'), 'UI must have the AI step button');
  assert.ok(uiSrc.includes("body: { provider: 'openrouter', job_id: jobId }"), 'AI step must request the gated provider explicitly');
  // The AI button must live inside the owner-only toolbar block (staff can never reach it)
  const ownerBlockStart = uiSrc.indexOf("${isOwner() ? `\n          <div class=\"of-sec-head\">");
  assert.ok(ownerBlockStart > 0, 'drafts toolbar owner block must exist');
  const aiBtnIdx = uiSrc.indexOf('of-ai-step-btn');
  const staffElseIdx = uiSrc.indexOf('مسودات المتابعة والتشغيل', ownerBlockStart);
  assert.ok(aiBtnIdx > ownerBlockStart && aiBtnIdx < staffElseIdx, 'AI button must be inside the owner-only branch, before the staff branch');

  /* ---------------- 2. Engine unit flow on isolated temp DB ---------------- */
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-ai-provider-'));
  const unitDbPath = path.join(tmpDir, 'unit-ai.db');
  const unitScript = `process.env.DB_PATH = ${JSON.stringify(unitDbPath)};
process.env.AUTO_SEED = '0';
const assert = require('assert');
const path = require('path');
const ROOTP = ${JSON.stringify(ROOT)};
const { OfficeEngine, makeActor } = require(path.join(ROOTP, 'src/office-engine'));
require(path.join(ROOTP, 'src/office-cases'));
const { ProviderError } = require(path.join(ROOTP, 'src/openrouter-client'));
const engine = new OfficeEngine({});
const owner = makeActor('user:1', 'owner');
(async () => {
  // A. Provider gates fire BEFORE claiming: disabled / staging / bad key -> throw, zero claim
  const jGate = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'gate-1', owner);
  let transportCalled = false;
  const notCalled = async () => { transportCalled = true; return { status: 200, raw: Buffer.from('{}') }; };
  await assert.rejects(() => engine.runOnce({ provider: 'openrouter', transport: notCalled }), err => err.code === 'openrouter_disabled');
  assert.strictEqual(transportCalled, false, 'no transport call when disabled');
  process.env.MAVI_OPENROUTER_ENABLED = '1';
  process.env.MAVI_STAGING_MODE = '1';
  await assert.rejects(() => engine.runOnce({ provider: 'openrouter', transport: notCalled }), err => err.code === 'openrouter_disabled_in_staging');
  delete process.env.MAVI_STAGING_MODE;
  process.env.OPENROUTER_API_KEY = 'short';
  await assert.rejects(() => engine.runOnce({ provider: 'openrouter', transport: notCalled }), err => err.code === 'missing_or_invalid_server_key');
  process.env.OPENROUTER_API_KEY = 'valid-mock-key-1234567890';
  process.env.OPENROUTER_MODEL = 'vendor/paid-model';
  await assert.rejects(() => engine.runOnce({ provider: 'openrouter', transport: notCalled }), err => err.code === 'only_free_model_ids_are_allowed');
  process.env.OPENROUTER_MODEL = 'openrouter/free';
  assert.strictEqual(engine.get(jGate.id, owner).status, 'queued', 'gate failures must not claim or mutate the job');

  // B. Non-marketing kind -> failed with ai_provider_kind_not_supported, transport untouched
  const jOps = engine.enqueue('daily_ops_triage', {}, 'gate-2', owner);
  const stepOps = await engine.runOnce({ provider: 'openrouter', jobId: jOps.id, transport: notCalled });
  assert.strictEqual(stepOps.status, 'failed');
  assert.strictEqual(stepOps.error_code, 'ai_provider_kind_not_supported');
  assert.strictEqual(stepOps.network_calls, 0);
  assert.strictEqual(transportCalled, false, 'transport must never run for unsupported kinds');
  assert.strictEqual(engine.get(jOps.id, owner).status, 'failed');

  // C. Success path: content_draft completes into review with AI provenance (reuses queued gate job)
  const step1 = await engine.runOnce({ provider: 'openrouter', jobId: jGate.id, transport: async (body, secret) => {
    assert.strictEqual(body.model, 'openrouter/free');
    assert.ok(secret && secret.length > 0, 'bearer secret must be passed to transport');
    assert.ok(!JSON.stringify(body.messages).includes('price'), 'prompt/messages must not carry price fields');
    const draft = JSON.stringify({ title: 'مسودة AI تجريبية', text: 'نص للمراجعة البشرية.', review_checklist: ['راجعي النص'] });
    return { status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: draft }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0, total_tokens: 42 } })) };
  }});
  assert.strictEqual(step1.status, 'review');
  assert.strictEqual(step1.mode, 'openrouter');
  assert.strictEqual(step1.ai_generated, true);
  assert.strictEqual(step1.network_calls, 1);
  const done = engine.get(jGate.id, owner);
  assert.strictEqual(done.status, 'review');
  assert.strictEqual(done.result.provenance.source, 'openrouter_ai_draft');
  assert.strictEqual(done.result.provenance.free_model_only, true);
  assert.ok(done.result.review_checklist[0].includes('مراجعة بشرية إلزامية'), 'first checklist item must mandate human review');
  assert.strictEqual(done.result.external_actions.length, 0, 'AI drafts must carry zero external actions');
  const audit = engine.listRecentAudit(owner, 20).filter(a => a.job_id === jGate.id).map(a => a.event);
  assert.ok(audit.includes('ai_draft_ready_for_review'), 'AI completion must be audited');

  // D. Non-zero reported cost -> hard stop
  const j2 = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'facebook' }, 'ai-2', owner);
  const draft2 = JSON.stringify({ title: 't', text: 'x', review_checklist: ['c'] });
  const resp2 = { status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: draft2 }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0.01 } })) };
  const step2 = await engine.runOnce({ provider: 'openrouter', jobId: j2.id, transport: async () => resp2 });
  assert.strictEqual(step2.status, 'failed');
  assert.strictEqual(step2.error_code, 'unexpected_reported_cost_stop_and_check_dashboard');
  assert.strictEqual(engine.get(j2.id, owner).status, 'failed');

  // E. Rate limited -> no automatic retry (single call, job failed)
  const j3 = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'ai-3', owner);
  let callCount = 0;
  const step3 = await engine.runOnce({ provider: 'openrouter', jobId: j3.id, transport: async () => { callCount++; return { status: 429, raw: Buffer.from('rate') }; } });
  assert.strictEqual(step3.error_code, 'provider_rate_limited_no_automatic_retry');
  assert.strictEqual(callCount, 1, 'no automatic retries');
  assert.strictEqual(engine.get(j3.id, owner).status, 'failed');

  // F. campaign_brief success includes the planning budget in facts
  const j4 = engine.enqueue('campaign_brief', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram', daily_budget_egp: 100 }, 'ai-4', owner);
  const step4 = await engine.runOnce({ provider: 'openrouter', jobId: j4.id, transport: async (body) => {
    assert.ok(JSON.stringify(body.messages[1].content).includes('daily_budget_egp'));
    const draft = JSON.stringify({ title: 'موجز حملة AI', text: 'موجز قصير.', review_checklist: ['x'] });
    return { status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: draft }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0 } })) };
  }});
  assert.strictEqual(step4.status, 'review');
  const done4 = engine.get(j4.id, owner);
  assert.ok(done4.result.facts_used.some(f => f.label === 'السقف التخطيطي'), 'budget fact must be surfaced for owner review');

  // G. Idle when nothing queued
  const step5 = await engine.runOnce({ provider: 'openrouter', transport: async () => ({ status: 200, raw: Buffer.from('{}') }) });
  assert.strictEqual(step5.status, 'idle');

  // H. The other product-public marketing kinds also generate with AI
  for (const kind of ['community_followup_draft', 'visual_reel_brief', 'seo_readiness_check', 'landing_page_check']) {
    const payload = kind === 'community_followup_draft'
      ? { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }
      : { product_id: 'DEMO-PUBLIC-01' };
    const jk = engine.enqueue(kind, payload, 'ai-kind-' + kind, owner);
    const stepK = await engine.runOnce({ provider: 'openrouter', jobId: jk.id, transport: async (body) => {
      assert.ok(!JSON.stringify(body.messages).includes('customer'), 'public-info prompts must not reference customers');
      const draft = JSON.stringify({ title: 'مسودة ' + kind, text: 'مسودة AI للمراجعة.\\n🎯 قراري المهني: مبنية على بيانات الموديل فقط.\\n🙋 الإذن المطلوب من المالكة: التنفيذ يدوي بعد الاعتماد.', review_checklist: ['x'] });
      return { status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: draft }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0 } })) };
    }});
    assert.strictEqual(stepK.status, 'review', kind + ' must generate with AI');
    assert.strictEqual(stepK.ai_generated, true);
    const doneK = engine.get(jk.id, owner);
    assert.ok(!JSON.stringify(doneK.result.facts_used).includes('"القناة": "undefined"'), 'product-only kinds must not show an undefined channel fact');
    assert.ok(doneK.result.facts_used.some(f => f.label === 'الموديل'), 'product fact must surface');
  }

  // I. Operational kinds (no product-public data) are NEVER sent to the provider
  const jOps2 = engine.enqueue('daily_ops_triage', {}, 'ai-ops-1', owner);
  const stepOps2 = await engine.runOnce({ provider: 'openrouter', jobId: jOps2.id, transport: notCalled });
  assert.strictEqual(stepOps2.error_code, 'ai_provider_kind_not_supported', 'customer-data kinds must stay local');
  assert.strictEqual(transportCalled, false);

  // J. Settings-based activation (no env vars): owner-saved key enables the provider
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.MAVI_OPENROUTER_ENABLED;
  const { setSetting } = require(path.join(ROOTP, 'src/db'));
  setSetting('office_ai_api_key', 'settings-saved-key-123456');
  setSetting('office_ai_model', 'openrouter/free');
  setSetting('office_ai_enabled', '1');
  const cfgSettings = require(path.join(ROOTP, 'src/openrouter-client')).createConfig({});
  assert.strictEqual(cfgSettings.summary().source, 'settings');
  cfgSettings.validate(); // must not throw
  const jSet = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'ai-settings-1', owner);
  const stepSet = await engine.runOnce({ provider: 'openrouter', jobId: jSet.id, transport: async (body, secret) => {
    assert.strictEqual(secret, 'settings-saved-key-123456', 'the settings-stored key must be used as the bearer secret');
    const draft = JSON.stringify({ title: 'مسودة بالإعدادات المحفوظة', text: 'نص.', review_checklist: ['x'] });
    return { status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: draft }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0 } })) };
  }});
  assert.strictEqual(stepSet.status, 'review', 'settings-configured provider must generate');

  // K. testConnection: real-shaped check with a mock transport
  const { testConnection } = require(path.join(ROOTP, 'src/openrouter-client'));
  const ping = await testConnection(cfgSettings, { transport: async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'جاهز', text: 'اختبار اتصال ناجح — بدون أي بيانات عملاء.', review_checklist: ['التحقق من المفتاح والموديل المجاني'] }) }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0 } })) }) });
  assert.strictEqual(ping.ok, true, 'connection test must pass on a valid config');
  assert.ok(ping.model, 'connection test must report the model');
  const bad = await testConnection(cfgSettings, { transport: async () => ({ status: 401, raw: Buffer.from('nope') }) });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error_code, 'provider_auth_failed');

  console.log('UNIT-AI-OK');
})().catch(e => { console.error('UNIT-ERR', e && e.code, e && e.message); process.exit(1); });
`;
  const unitScriptPath = path.join(tmpDir, 'unit-ai.js');
  fs.writeFileSync(unitScriptPath, unitScript);
  const unitRun = spawnSync(process.execPath, [unitScriptPath], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(unitRun.status, 0, (unitRun.stderr || '') + ' | stdout: ' + (unitRun.stdout || ''));
  assert.ok(unitRun.stdout.includes('UNIT-AI-OK'));

  /* ---------------- 3. Client contract checks (direct) ---------------- */
  const { createConfig, buildBody, ProviderError, createLiveTransport, generateMarketingDraft } = require(path.join(ROOT, 'src/openrouter-client.js'));
  // content_draft keys exactly [channel, product_id]
  const b1 = buildBody('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'openrouter/free');
  assert.ok(b1.messages[0].content.includes('مصطنعة'), 'synthetic prompt must be used without product facts');
  // campaign_brief keys exactly [channel, daily_budget_egp, product_id]
  const b2 = buildBody('campaign_brief', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram', daily_budget_egp: 100 }, 'openrouter/free');
  assert.ok(JSON.stringify(b2.messages[1].content).includes('daily_budget_egp'));
  // real-catalogue PUBLIC facts allowed via explicit engine-verified object; prompt switches to catalogue wording
  const b3 = buildBody('content_draft', { product_id: 'DR-04', channel: 'instagram' }, 'openrouter/free', { id: 'DR-04', name: 'فستان كروازيه', note: 'كريب' });
  assert.ok(b3.messages[0].content.includes('كتالوج MAVI'), 'real-product prompt must state public catalogue fields only');
  // customer data still rejected
  assert.throws(() => buildBody('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram', customer_phone: '01012345678' }, 'openrouter/free'), err => err instanceof ProviderError);
  // invalid real facts (missing name) rejected
  assert.throws(() => buildBody('content_draft', { product_id: 'DR-04', channel: 'instagram' }, 'openrouter/free', { id: 'DR-04', name: '', note: '' }), err => err instanceof ProviderError);
  // paid model rejected
  assert.throws(() => buildBody('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'vendor/model'), err => err.code === 'only_free_model_ids_are_allowed');
  // live transport exists; generation without transport refuses (contract guard)
  assert.strictEqual(typeof createLiveTransport, 'function');
  const cfg = createConfig({ MAVI_OPENROUTER_ENABLED: '1', OPENROUTER_API_KEY: 'valid-mock-key-1234567890' });
  cfg.validate();
  await assert.rejects(() => generateMarketingDraft(cfg, { kind: 'content_draft', payload: { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' } }), err => err.code === 'live_network_transport_disabled_in_phase1');

  console.log('office-ai-provider.test.js PASSED');
});
