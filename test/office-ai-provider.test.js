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

  // K. testConnection: real-shaped check with a mock transport (lenient probe:
  //    auth + a live answer is enough — messy prose must NOT fail the check)
  const { testConnection, listFreeModels, resolveModel, createConfig, buildBody } = require(path.join(ROOTP, 'src/openrouter-client'));
  const PREFERRED_MODEL = 'deepseek/deepseek-chat-v3.1:free';
  const ping = await testConnection(cfgSettings, { transport: async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: 'أهلاً! هذا رد حرة بدون JSON' }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0 } })) }) });
  assert.strictEqual(ping.ok, true, 'a chatty non-JSON reply must still count as a working connection');
  assert.ok(ping.model, 'connection test must report the model');
  const bad = await testConnection(cfgSettings, { transport: async () => ({ status: 401, raw: Buffer.from('nope') }) });
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.error_code, 'provider_auth_failed');

  // L. Tolerant draft extraction: fenced / prose-wrapped JSON still completes
  process.env.MAVI_OFFICE_AI_NO_MODEL_DISCOVERY = '1';
  const fence = String.fromCharCode(96).repeat(3);
  const messyDraft = fence + 'json\\n{"title": "مسودة برسالة محيطة", "text": "نص المسودة.", "review_checklist": ["فحص"]}\\n' + fence + '\\nشكرًا!';
  const jMessy = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'ai-messy-1', owner);
  const stepMessy = await engine.runOnce({ provider: 'openrouter', jobId: jMessy.id, transport: async (body, secret) => {
    assert.strictEqual(body.model, 'openrouter/free', 'with discovery disabled the sentinel must pass through unchanged');
    return { status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: messyDraft }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0 } })) };
  }});
  assert.strictEqual(stepMessy.status, 'review', 'prose/fence-wrapped JSON drafts must be extracted and accepted');

  // M. Auto sentinel resolves to a real free model via the public models list
  delete process.env.MAVI_OFFICE_AI_NO_MODEL_DISCOVERY;
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (!String(url).includes('/api/v1/models')) throw new Error('unexpected fetch ' + url);
    return { ok: true, json: async () => ({ data: [
      { id: 'paid/vendor-pro', pricing: { prompt: '0.001', completion: '0.002' } },
      { id: PREFERRED_MODEL, pricing: { prompt: '0', completion: '0' } },
      { id: 'a/other:free', pricing: { prompt: '0', completion: '0' } },
    ] }) };
  };
  try {
    const models = await listFreeModels({ force: true });
    assert.deepStrictEqual(models.sort(), [PREFERRED_MODEL, 'a/other:free'].sort(), 'only true 0-cost :free ids may be listed');
    const autoCfg = createConfig({ MAVI_OPENROUTER_ENABLED: '1', OPENROUTER_API_KEY: 'valid-mock-key-1234567890' });
    const resolved = await resolveModel(autoCfg);
    assert.strictEqual(resolved, PREFERRED_MODEL, 'the auto sentinel must resolve to the preferred available free model');
    const jAuto = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'facebook' }, 'ai-auto-1', owner);
    const stepAuto = await engine.runOnce({ provider: 'openrouter', jobId: jAuto.id, transport: async (body) => {
      assert.strictEqual(body.model, PREFERRED_MODEL, 'generation must POST the resolved concrete free model');
      const draft = JSON.stringify({ title: 'مسودة تلقائية', text: 'نص.', review_checklist: ['x'] });
      return { status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: draft }, finish_reason: 'stop' }], model: PREFERRED_MODEL, usage: { cost: 0 } })) };
    }});
    assert.strictEqual(stepAuto.status, 'review');
  } finally {
    global.fetch = realFetch;
  }

  // N. Agent skill prompts: every supported kind carries professional skills,
  //    the shared quality contract, and the honesty/no-fabrication rules
  for (const kind of ['content_draft', 'campaign_brief', 'community_followup_draft', 'visual_reel_brief', 'seo_readiness_check', 'landing_page_check']) {
    const bb = buildBody(kind, kind === 'campaign_brief'
      ? { product_id: 'DEMO-PUBLIC-01', channel: 'instagram', daily_budget_egp: 20 }
      : kind === 'content_draft' || kind === 'community_followup_draft'
        ? { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }
        : { product_id: 'DEMO-PUBLIC-01' }, 'openrouter/free', null);
    const sys = bb.messages[0].content;
    assert.ok(sys.includes('قواعد الجودة الإلزامية'), kind + ': shared quality contract required');
    assert.ok(sys.includes('لا تخترع سعرًا'), kind + ': honesty rule required');
    assert.ok(sys.includes('الإذن المطلوب من المالكة'), kind + ': owner-permission line required');
    assert.ok(sys.length > 250, kind + ': role brief must carry real professional skills');
  }

  // N2. AUTO mode (the owner's gen_mode choice): AI-first with honest local fallback
  // settings-based config from section J is still active (office_ai_* settings)
  const okDraft = JSON.stringify({ title: 'مسودة تلقائية AI', text: 'نص.', review_checklist: ['x'] });
  const jA = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'auto-1', owner);
  const autoOk = await engine.runOnce({ provider: 'auto', jobId: jA.id, transport: async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: okDraft }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0 } })) }) });
  assert.strictEqual(autoOk.mode, 'ai_first');
  assert.strictEqual(autoOk.ai_attempted, 1);
  assert.strictEqual(autoOk.ai_succeeded, 1);
  assert.strictEqual(autoOk.ai_fallback, 0);
  const doneA = engine.get(jA.id, owner);
  assert.strictEqual(doneA.status, 'review');
  assert.strictEqual(doneA.result.provenance.source, 'openrouter_ai_draft', 'auto mode must produce an AI draft when the provider works');

  // provider failure -> honest local fallback (NOT failed, NOT fake AI)
  const jB = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'auto-2', owner);
  let fbCalls = 0;
  const autoFb = await engine.runOnce({ provider: 'auto', jobId: jB.id, transport: async () => { fbCalls++; return { status: 500, raw: Buffer.from('boom') }; } });
  assert.strictEqual(autoFb.ai_succeeded, 0);
  assert.strictEqual(autoFb.ai_fallback, 1, 'auto mode must fall back to the local template on provider failure');
  assert.strictEqual(fbCalls, 1, 'single AI pass — no automatic retries');
  const doneB = engine.get(jB.id, owner);
  assert.strictEqual(doneB.status, 'review');
  assert.strictEqual(doneB.result.provenance.mode, 'fixture', 'fallback draft must be honestly marked local');
  assert.strictEqual(doneB.result.provenance.ai_generated, false, 'fallback must never fake AI provenance');

  // non-marketing queued job + AI enabled: auto skips it (stays for local path)
  const jC = engine.enqueue('daily_ops_triage', {}, 'auto-3', owner);
  const autoSkip = await engine.runOnce({ provider: 'auto', jobId: jC.id, transport: notCalled });
  assert.strictEqual(autoSkip.ai_attempted, 0, 'customer-data kinds must never be sent to the provider');
  assert.strictEqual(autoSkip.ai_fallback, 0);
  assert.strictEqual(engine.get(jC.id, owner).status, 'queued', 'non-AI kinds stay queued for the local auto-prepare');

  // regenerateWithAi: fixture draft -> AI (success replaces the local draft honestly)
  const jD = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'regen-1', owner);
  engine.runOnce({ provider: 'fixture', jobId: jD.id });
  const localDone = engine.get(jD.id, owner);
  assert.strictEqual(localDone.status, 'review');
  assert.strictEqual(localDone.result.provenance.mode, 'fixture');
  const regen1 = await engine.regenerateWithAi(jD.id, owner, async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: okDraft }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0 } })) }) );
  assert.strictEqual(regen1.mode, 'ai');
  const regenDone = engine.get(jD.id, owner);
  assert.strictEqual(regenDone.status, 'review');
  assert.strictEqual(regenDone.result.provenance.source, 'openrouter_ai_draft', 'regeneration must replace the local draft with an AI one');

  // regenerateWithAi: provider down -> the local draft comes back (nothing lost)
  const jE = engine.enqueue('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'regen-2', owner);
  engine.runOnce({ provider: 'fixture', jobId: jE.id });
  const regen2 = await engine.regenerateWithAi(jE.id, owner, async () => ({ status: 500, raw: Buffer.from('boom') }));
  assert.strictEqual(regen2.mode, 'fixture_fallback');
  const backLocal = engine.get(jE.id, owner);
  assert.strictEqual(backLocal.status, 'review', 'a failed AI regen must restore a local draft, not leave the job failed');
  assert.strictEqual(backLocal.result.provenance.mode, 'fixture');

  // N3. Honest visibility: fallback reason persisted on the draft + activity stats
  const provB = JSON.parse(JSON.stringify(engine.get(jB.id, owner).result.provenance));
  assert.ok(provB.ai_fallback_error, 'fallback draft must carry the AI failure reason on itself');
  assert.ok(provB.ai_fallback_error.startsWith('provider'), 'fallback reason must be a provider code: ' + provB.ai_fallback_error);
  assert.strictEqual(provB.ai_fallback_error, 'provider_request_failed_no_automatic_retry');
  const stats = engine.aiActivityStats(owner);
  assert.ok(stats.last_24h.ai_ok >= 1, 'activity stats must count real AI drafts');
  assert.ok(stats.last_24h.fallback >= 1, 'activity stats must count fallbacks');
  assert.ok(stats.recent.some((r) => r.mode === 'fixture_fallback' && r.ai_error), 'activity must list the fallback with its reason');
  const statsStaff = makeActor('user:99', 'staff');
  assert.throws(() => engine.aiActivityStats(statsStaff), err => err.code === 'caller_not_permitted', 'staff must never read AI activity');

  // auto summary recorded on the engine for the dashboard strip
  // the most recent auto call may be a skip (non-marketing) — the summary must still exist honestly
  assert.ok(engine.lastAutoPrepare && typeof engine.lastAutoPrepare.ai_attempted === 'number' && engine.lastAutoPrepare.at, 'lastAutoPrepare summary recorded');
  assert.strictEqual(engine.lastAutoPrepare.ai_attempted, 0, 'a skip run reports zero attempts honestly');

  // N4. One-click demo draft: owner-only, REAL catalogue product (never DEMO*), honest modes
  const { run: unitRunSql } = require(path.join(ROOTP, 'src/db'));
  unitRunSql("INSERT OR IGNORE INTO styles(id,name,type,price,lead_days,active) VALUES('DEMO-XYZ','عنصر اختبار مرفوض للتجربة','made',100,7,1)");
  unitRunSql("INSERT OR IGNORE INTO styles(id,name,type,price,lead_days,active) VALUES('DRESS1','فستان سواريه','made',900,7,1)");
  const staffDemo = makeActor('user:77', 'staff');
  await assert.rejects(() => engine.runAiDemoDraft(staffDemo, { transport: notCalled }), err => err.code === 'caller_not_permitted', 'staff can never run the demo draft');
  process.env.MAVI_STAGING_MODE = '1';
  await assert.rejects(() => engine.runAiDemoDraft(owner, { transport: notCalled }), err => err.code === 'openrouter_disabled_in_staging', 'demo refuses before any claim when the provider is not ready');
  delete process.env.MAVI_STAGING_MODE;
  const demoOk = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: okDraft }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0 } })) }) });
  assert.strictEqual(demoOk.mode, 'ai', 'a working provider must make the demo draft with AI');
  assert.strictEqual(demoOk.product_id, 'DRESS1', 'demo must pick a REAL catalogue style, never DEMO*');
  assert.strictEqual(demoOk.status, 'review');
  assert.strictEqual(demoOk.model, 'test/vendor:free');
  const demoFail = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 500, raw: Buffer.from('boom') }) });
  assert.strictEqual(demoFail.mode, 'fixture_fallback', 'a failing provider must fall back honestly');
  assert.strictEqual(demoFail.product_id, 'DRESS1');
  assert.ok(demoFail.ai_error && String(demoFail.ai_error).indexOf('provider') === 0, 'fallback must carry the provider code: ' + demoFail.ai_error);
  assert.notStrictEqual(demoFail.job_id, demoOk.job_id, 'each demo click creates its own draft');
  const demoStats = engine.aiActivityStats(owner);
  assert.ok(demoStats.recent.some(function (r) { return r.mode === 'ai' && r.job_id === demoOk.job_id; }), 'demo success must appear in the activity feed');

  // N6. Repro-derived honesty locks:
  //  (a) model replies missing review_checklist -> ACCEPTED as AI (checklist never fabricated;
  //      engine prepends its own mandatory human-review items)
  const noChecks = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'مسودة بدون تشيك ليست', text: 'نص الموديل.' }) }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0 } })) }) });
  assert.strictEqual(noChecks.mode, 'ai', 'a missing checklist must not kill a usable draft');
  const noChecksRow = engine.get(noChecks.job_id, owner);
  assert.strictEqual(noChecksRow.result.provenance.source, 'openrouter_ai_draft');
  assert.ok(noChecksRow.result.review_checklist[0].includes('مراجعة بشرية إلزامية'), 'engine checklist must still wrap the AI draft');
  //  (b) extra keys in the model reply -> ignored, draft accepted
  const extraKeys = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'مسودة بمفاتيح زيادة', text: 'نص.', review_checklist: ['فحص'], notes: 'زيادة من الموديل' }) }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0 } })) }) });
  assert.strictEqual(extraKeys.mode, 'ai', 'extra reply keys must be ignored, not fatal');
  //  (c) zero-cost safety stop: stays FAILED and LOUD — no local fallback, exact code surfaced
  const costStop = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 't', text: 'x', review_checklist: ['c'] }) }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0.01 } })) }) });
  assert.strictEqual(costStop.mode, 'failed');
  assert.strictEqual(costStop.ai_error, 'unexpected_reported_cost_stop_and_check_dashboard', 'the safety-stop code must reach the owner verbatim');
  assert.strictEqual(engine.get(costStop.job_id, owner).status, 'failed', 'cost stop must never auto-fallback');
  //  (d) empty provider body (invalid_provider_response — no 'provider' prefix): honest LOCAL fallback now, not a dead-end
  const emptyBody = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 200, raw: Buffer.from('') }) });
  assert.strictEqual(emptyBody.mode, 'fixture_fallback', 'non-provider-prefixed codes must fall back locally instead of dead-ending');
  assert.strictEqual(emptyBody.ai_error, 'invalid_provider_response');
  assert.strictEqual(engine.get(emptyBody.job_id, owner).status, 'review', 'the fallback draft must be reviewable');
  const emptyProv = engine.get(emptyBody.job_id, owner).result.provenance;
  assert.strictEqual(emptyProv.ai_fallback_error, 'invalid_provider_response', 'the exact reason must be annotated on the draft itself');

  // N7. Truncation & shape tolerance (live-production codes):
  //  (a) the generation request must reserve enough room for Arabic JSON drafts
  const bbFloor = buildBody('content_draft', { product_id: 'DEMO-PUBLIC-01', channel: 'instagram' }, 'openrouter/free', null);
  assert.ok(bbFloor.max_tokens >= 1200, 'draft requests must allow enough completion tokens for Arabic JSON: ' + bbFloor.max_tokens);
  //  (b) finish_reason 'length' with a COMPLETE draft right at the cut -> accepted as AI
  const cutComplete = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'مسودة عند الحد', text: 'نص كامل.', review_checklist: ['فحص'] }) }, finish_reason: 'length' }], model: 'test/vendor:free', usage: { cost: 0 } })) }) });
  assert.strictEqual(cutComplete.mode, 'ai', "a complete draft at the token cut must not be rejected for finish_reason 'length'");
  //  (c) finish_reason 'length' with NO usable JSON -> honest fallback carrying 'provider_reply_truncated'
  const cutBroken = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: 'نص عربي اتنصّف بدون JSON كامل' }, finish_reason: 'length' }], model: 'test/vendor:free', usage: { cost: 0 } })) }) });
  assert.strictEqual(cutBroken.mode, 'fixture_fallback');
  assert.strictEqual(cutBroken.ai_error, 'provider_reply_truncated', 'truncated replies must say WHY, not a generic code');
  assert.strictEqual(engine.get(cutBroken.job_id, owner).status, 'review', 'truncated AI attempt must still leave a reviewable local draft');
  //  (d) omitted doc.model -> falls back to the requested model, draft still accepted
  const noModelField = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'مسودة بدون موديل', text: 'نص.', review_checklist: [] }) }, finish_reason: 'stop' }], usage: { cost: 0 } })) }) });
  assert.strictEqual(noModelField.mode, 'ai', 'a missing doc.model must not reject a usable draft');
  assert.ok(typeof noModelField.model === 'string' && noModelField.model.length > 0, 'model falls back to the id actually requested in the POST body');
  //  (e) finish_reason omitted by the proxy -> still parsed normally
  const noFinish = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: 'مسودة بدون سبب الإنهاء', text: 'نص.', review_checklist: [] }) } }], model: 'test/vendor:free', usage: { cost: 0 } })) }) });
  assert.strictEqual(noFinish.mode, 'ai', 'proxies that omit finish_reason must not break usable drafts');
  //  (f) prose-only reply (no JSON at all) -> honest local fallback with the clear code
  const prose = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: 'أهلاً! المسودة جاهزة لكن مش هكتب JSON خالص' }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0 } })) }) });
  assert.strictEqual(prose.mode, 'fixture_fallback');
  assert.strictEqual(prose.ai_error, 'invalid_or_incomplete_draft_response');

  // N8. Smart live-model ranking + the failed model is never anonymous:
  //  (a) resolveModel prefers capability tiers over alphabetical order
  const realFetchN8 = global.fetch;
  global.fetch = async (url) => {
    if (!String(url).includes('/api/v1/models')) throw new Error('unexpected fetch ' + url);
    return { ok: true, json: async () => ({ data: [
      { id: 'baidu/cobuddy:free', pricing: { prompt: '0', completion: '0' } },
      { id: 'z-ai/glm-4.7:free', pricing: { prompt: '0', completion: '0' } },
      { id: 'aardvark/tiny-weak:free', pricing: { prompt: '0', completion: '0' } },
    ] }) };
  };
  try {
    const rankedCfg = createConfig({ MAVI_OPENROUTER_ENABLED: '1', OPENROUTER_API_KEY: 'valid-mock-key-1234567890' });
    await listFreeModels({ force: true }); // bust the 1h model cache before ranking
    const ranked = await resolveModel(rankedCfg);
    assert.strictEqual(ranked, 'z-ai/glm-4.7:free', 'tier ranking must beat alphabetical-first weak models');
  } finally {
    global.fetch = realFetchN8;
  }
  //  (b) the demo result names the model the attempt actually used when it fails
  process.env.MAVI_OFFICE_AI_NO_MODEL_DISCOVERY = '1';
  const namedFail = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 200, raw: Buffer.from(JSON.stringify({ choices: [{ message: { content: 'رد بدون JSON نهائيًا' }, finish_reason: 'stop' }], model: 'test/vendor:free', usage: { cost: 0 } })) }) });
  assert.strictEqual(namedFail.mode, 'fixture_fallback');
  assert.strictEqual(namedFail.ai_error, 'invalid_or_incomplete_draft_response');
  // the RESOLVED concrete model that was truly POSTed must surface (the cache
  // from (a) holds the tier-ranked id — that is exactly what got attempted)
  assert.strictEqual(namedFail.model_attempted, 'z-ai/glm-4.7:free', 'the attempted model id must surface with the failure');
  process.env.MAVI_OFFICE_AI_NO_MODEL_DISCOVERY = '0';

  // N9. Capacity cooldown: a 429 on one free model makes the NEXT click pick a different one
  const { setModelCooldown: setCool, isModelOnCooldown: isCool, clearModelCooldowns: clearCool } = require(path.join(ROOTP, 'src/openrouter-client'));
  clearCool();
  const cfgN9 = createConfig({ MAVI_OPENROUTER_ENABLED: '1', OPENROUTER_API_KEY: 'valid-mock-key-1234567890' });
  const before429 = await resolveModel(cfgN9); // cache still holds N8's live list
  const hit429 = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 429, raw: Buffer.from('busy') }) });
  assert.strictEqual(hit429.mode, 'fixture_fallback');
  assert.strictEqual(hit429.ai_error, 'provider_rate_limited_no_automatic_retry');
  assert.ok(isCool(before429), 'the 429-hit model must enter cooldown: ' + before429);
  const after429 = await resolveModel(cfgN9);
  assert.notStrictEqual(after429, before429, 'the next resolution must skip the cooling model');
  assert.strictEqual(after429, 'aardvark/tiny-weak:free', 'cooldown filter falls through tiers to the remaining pool');
  setCool('aardvark/tiny-weak:free');
  const third = await resolveModel(cfgN9);
  assert.notStrictEqual(third, 'aardvark/tiny-weak:free', 'manual cooldown entries are honoured too');
  clearCool(); // keep later sections unaffected

  // N10. The provider's OWN reason is surfaced verbatim; an account-wide daily
  // cap gets its own identity (rotation can never fix an account-wide limit).
  clearCool();
  const dailyBody = JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: free-model-cap-per-day', metadata: { reason: 'free-model-cap-per-day' } } });
  const daily = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 429, raw: Buffer.from(dailyBody) }) });
  assert.strictEqual(daily.mode, 'fixture_fallback');
  assert.strictEqual(daily.ai_error, 'provider_free_daily_cap', 'an account-wide daily cap must be named as such, not a generic busy code: ' + daily.ai_error);
  assert.strictEqual(daily.provider_says, 'free-model-cap-per-day', 'the provider reason must reach the owner verbatim');
  const minuteBody = JSON.stringify({ error: { code: 429, message: 'Rate limit exceeded: req-per-min', metadata: { reason: 'req-per-min' } } });
  const minute = await engine.runAiDemoDraft(owner, { transport: async () => ({ status: 429, raw: Buffer.from(minuteBody) }) });
  assert.strictEqual(minute.ai_error, 'provider_rate_limited_no_automatic_retry', 'minute limits stay generic rate-limit codes');
  assert.strictEqual(minute.provider_says, 'req-per-min');
  const stats10 = engine.aiActivityStats(owner);
  const fallbackEntry10 = stats10.recent.find(function (r) { return r.mode === 'fixture_fallback' && r.provider_says; });
  assert.ok(fallbackEntry10, 'the activity feed must show the verbatim provider reason');

  // N5. aiFirstPrepare reports WHY it skipped when the provider is not ready
  process.env.MAVI_STAGING_MODE = '1';
  const skipSummary = await engine.aiFirstPrepare({ max: 1, transport: notCalled });
  delete process.env.MAVI_STAGING_MODE;
  assert.strictEqual(skipSummary.ai_attempted, 0);
  assert.strictEqual(skipSummary.ai_skipped_reason, 'openrouter_disabled_in_staging', 'skip reason must be honest and visible to the dashboard');

  // staff can never regenerate
  const staff = makeActor('user:2', 'staff');
  await assert.rejects(() => engine.regenerateWithAi(jE.id, staff, notCalled), err => err.code === 'caller_not_permitted');

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
