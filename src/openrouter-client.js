'use strict';
/* Disabled-by-default OpenRouter connector contract (ported from Accounting's
   automation/openrouter.py).
   - Zero live HTTP endpoints are wired to this module in Phase 1.
   - Disabled in staging (`MAVI_STAGING_MODE=1`) and whenever `MAVI_OPENROUTER_ENABLED !== '1'`.
   - Free model IDs ONLY (`openrouter/free` or `vendor/model:free`); zero paid fallbacks.
   - Synthetic / public-catalogue marketing drafts only — customer data, receipts,
     phones, measurements, and costs are strictly rejected at the boundary.
   - Tested exclusively with offline mock transports; no live network call is made. */
const { PolicyError, SYNTHETIC_CATALOGUE, canonical } = require('./office-engine');
const { isStagingMode } = require('./staging-guard');

const HOST = 'openrouter.ai';
const PATH = '/api/v1/chat/completions';
const MAX_BYTES = 65536;

class ProviderError extends PolicyError {
  constructor(code) {
    super(code, code);
    this.status = 400;
  }
}

function createConfig(env = process.env) {
  const staging = env.MAVI_STAGING_MODE === '1' || isStagingMode();
  const enabled = !staging && env.MAVI_OPENROUTER_ENABLED === '1';
  const rawKey = typeof env.OPENROUTER_API_KEY === 'string' ? env.OPENROUTER_API_KEY : '';
  const model = typeof env.OPENROUTER_MODEL === 'string' && env.OPENROUTER_MODEL.trim()
    ? env.OPENROUTER_MODEL.trim()
    : 'openrouter/free';

  function validate() {
    if (staging) throw new ProviderError('openrouter_disabled_in_staging');
    if (!enabled) throw new ProviderError('openrouter_disabled');
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(rawKey)) {
      throw new ProviderError('missing_or_invalid_server_key');
    }
    if (
      model !== 'openrouter/free' &&
      !/^[a-z0-9][a-z0-9._-]{0,79}\/[a-z0-9][a-z0-9._-]{0,119}:free$/.test(model)
    ) {
      throw new ProviderError('only_free_model_ids_are_allowed');
    }
  }

  function summary() {
    let status = 'configured_not_tested';
    try { validate(); } catch (err) { status = err.code || 'openrouter_disabled'; }
    return {
      status,
      enabled,
      key_present: rawKey.length > 0,
      free_models_only: true,
      automatic_retry: false,
      queue_connected: false,
      production_connected: false,
      network_calls: 0,
    };
  }

  function getModel() { return model; }
  function useKey(fn) { return fn(rawKey); }

  // Freeze without exposing rawKey as an enumerable or inspectable property
  return Object.freeze({ validate, summary, getModel, useKey });
}

function validateMarketingInput(kind, payload, opts = {}) {
  if (!['campaign_brief', 'content_draft'].includes(kind)) {
    throw new ProviderError('only_marketing_drafts_supported');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProviderError('only_allowlisted_demo_fields_are_supported');
  }
  // Strict per-kind allowlists mirroring the engine's validateJobPayload contracts:
  //   content_draft  -> [channel, product_id]
  //   campaign_brief -> [channel, daily_budget_egp, product_id]
  const expectedKeys = kind === 'campaign_brief'
    ? ['channel', 'daily_budget_egp', 'product_id']
    : ['channel', 'product_id'];
  const keys = Object.keys(payload).sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new ProviderError('only_allowlisted_demo_fields_are_supported');
  }
  if (typeof payload.product_id !== 'string') {
    throw new ProviderError('only_synthetic_catalogue_is_supported');
  }
  if (!['facebook', 'instagram'].includes(payload.channel)) {
    throw new ProviderError('unsupported_channel');
  }
  if (kind === 'campaign_brief' && (!Number.isInteger(payload.daily_budget_egp) || payload.daily_budget_egp < 1 || payload.daily_budget_egp > 100)) {
    throw new ProviderError('demo_daily_budget_must_be_integer_1_to_100');
  }
  const clean = {
    product_id: payload.product_id,
    channel: payload.channel,
  };
  if (kind === 'campaign_brief') clean.daily_budget_egp = payload.daily_budget_egp;
  if (opts && opts.productFacts) {
    // Explicit, engine-verified PUBLIC catalogue facts (id/name/note only — never price, cost, or customer data).
    const pf = opts.productFacts;
    if (
      !pf || typeof pf !== 'object' ||
      pf.id !== payload.product_id ||
      typeof pf.name !== 'string' || !pf.name.trim() || pf.name.length > 200 ||
      typeof pf.note !== 'string' || pf.note.length > 500
    ) {
      throw new ProviderError('only_allowlisted_demo_fields_are_supported');
    }
    return clean;
  }
  if (!Object.prototype.hasOwnProperty.call(SYNTHETIC_CATALOGUE, payload.product_id)) {
    throw new ProviderError('only_synthetic_catalogue_is_supported');
  }
  return clean;
}

function buildBody(kind, payload, model, productFacts = null) {
  if (
    model !== 'openrouter/free' &&
    !/^[a-z0-9][a-z0-9._-]{0,79}\/[a-z0-9][a-z0-9._-]{0,119}:free$/.test(String(model || ''))
  ) {
    throw new ProviderError('only_free_model_ids_are_allowed');
  }
  const clean = validateMarketingInput(kind, payload, { productFacts });
  const realProduct = !!productFacts;
  const product = realProduct
    ? { id: productFacts.id, name: productFacts.name, description: String(productFacts.note || '') }
    : SYNTHETIC_CATALOGUE[clean.product_id];
  const systemPrompt = realProduct
    ? 'أنت مدير المحتوى في براند MAVI لتفصيل الفساتين على المقاس، وبتكتب مسودة تسويق حقيقية تنتظر مراجعة المالكة. البيانات التالية معلومات عامة من كتالوج MAVI (اسم ووصف عام فقط — بدون أي أسعار أو تكاليف أو بيانات عميلات). أعد JSON فقط بمفاتيح title وtext وreview_checklist (قائمة نصوص). اكتب بالعربية بأسلوب مسوقة محترفة: في text ابدأ بنص البوست الجاهز للنشر (سطور قصيرة جاذبة تناسب إنستجرام أو فيسبوك، بدون أسعار)، ثم سطر يبدأ بـ «🎯 قراري كمدير المحتوى:» فيه تبرير تسويقي مختصر مبني على البيانات المعطاة فقط، ثم سطر يبدأ بـ «🙋 الإذن المطلوب من المالكة:» يوضح أن النشر يتم يدويًا بعد اعتمادها ولا يوجد نشر تلقائي. لا تخترع سعرًا أو توافرًا أو موعد تسليم أو تقييمات، ولا تدعو لتنفيذ أي إجراء أو إرسال، ولا تطلب أدوات أو روابط أو بيانات عميلات.'
    : 'أنت مساعد لصياغة مسودة تسويق اختبار فقط. البيانات التالية مصطنعة وليست عرض بيع. أعد JSON فقط بمفاتيح title وtext وreview_checklist (قائمة نصوص). اكتب بالعربية. لا تخترع سعر منتج أو توافرًا أو موعد تسليم أو تقييمات، ولا تدع تنفيذ أي إجراء. لا تطلب أدوات أو روابط أو بيانات عميلات. اجعل المسودة قصيرة وتحتاج مراجعة بشرية.';
  return {
    model,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: canonical({
          kind,
          synthetic_product: { id: product.id, name: product.name, description: product.note },
          request: clean,
          test_data_only: true,
        }),
      },
    ],
    stream: false,
    max_tokens: 400,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    provider: {
      allow_fallbacks: false,
      require_parameters: true,
      data_collection: 'deny',
      max_price: { prompt: 0, completion: 0 },
    },
  };
}

function parseResponse(status, rawBuffer, secret) {
  const errorMap = {
    401: 'provider_auth_failed',
    402: 'provider_credit_or_quota_required',
    403: 'provider_access_denied',
    404: 'free_model_unavailable',
    429: 'provider_rate_limited_no_automatic_retry',
  };
  if (status !== 200) {
    throw new ProviderError(errorMap[status] || 'provider_request_failed_no_automatic_retry');
  }
  const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(String(rawBuffer || ''), 'utf8');
  if (buf.length === 0 || buf.length > MAX_BYTES) {
    throw new ProviderError('invalid_provider_response');
  }
  if (secret && buf.includes(Buffer.from(secret, 'utf8'))) {
    throw new ProviderError('provider_response_redacted');
  }

  let doc, draft, model, tokens;
  try {
    doc = JSON.parse(buf.toString('utf8'));
    if (!doc || !Array.isArray(doc.choices) || doc.choices.length !== 1) throw new Error('bad_choices');
    const choice = doc.choices[0];
    const msg = choice && choice.message;
    if (!msg || choice.finish_reason !== 'stop' || msg.tool_calls || msg.function_call) {
      throw new Error('bad_finish');
    }
    if (typeof msg.content !== 'string') throw new Error('bad_content');
    draft = JSON.parse(msg.content);
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('bad_draft');
    if (JSON.stringify(Object.keys(draft).sort()) !== JSON.stringify(['review_checklist', 'text', 'title'])) {
      throw new Error('bad_draft_keys');
    }
    if (typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 120) throw new Error('bad_title');
    if (typeof draft.text !== 'string' || !draft.text.trim() || draft.text.length > 2000) throw new Error('bad_text');
    if (
      !Array.isArray(draft.review_checklist) ||
      draft.review_checklist.length < 1 ||
      draft.review_checklist.length > 8 ||
      draft.review_checklist.some(x => typeof x !== 'string' || !x.trim() || x.length > 300)
    ) {
      throw new Error('bad_checks');
    }
    model = doc.model;
    if (typeof model !== 'string' || !/^[A-Za-z0-9/._:-]{1,200}$/.test(model)) throw new Error('bad_model');
    const usage = doc.usage || {};
    if (Object.prototype.hasOwnProperty.call(usage, 'cost')) {
      if (typeof usage.cost !== 'number' || !Number.isFinite(usage.cost) || usage.cost !== 0) {
        throw new ProviderError('unexpected_reported_cost_stop_and_check_dashboard');
      }
    }
    tokens = {};
    for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
      if (Number.isInteger(usage[k]) && usage[k] >= 0 && usage[k] <= 100000000) {
        tokens[k] = usage[k];
      }
    }
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('invalid_or_incomplete_draft_response');
  }

  const out = { draft, model_reported: model, tokens };
  if (secret && canonical(out).includes(secret)) {
    throw new ProviderError('provider_response_redacted');
  }
  return out;
}

async function generateSyntheticTest(config, options = {}) {
  config.validate();
  if (typeof options.transport !== 'function') {
    // Phase 1 deliberately refuses live network calls; only explicit mock transports in tests run here.
    throw new ProviderError('live_network_transport_disabled_in_phase1');
  }
  // Canonical synthetic round-trip uses campaign_brief — the only kind whose payload contract
  // includes the planning budget (content_draft allows strictly product_id + channel).
  const payload = { product_id: 'DEMO-PUBLIC-01', channel: 'instagram', daily_budget_egp: 100 };
  const body = buildBody('campaign_brief', payload, config.getModel());
  let parsed;
  try {
    parsed = await config.useKey(async (secret) => {
      const { status, raw } = await options.transport(body, secret, { host: HOST, path: PATH });
      return parseResponse(status, raw, secret);
    });
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('provider_connection_failed_no_automatic_retry');
  }
  return {
    ...parsed,
    mode: 'openrouter_mock_test',
    ai_generated: true,
    requires_human_review: true,
    external_actions: [],
    request_attempts: 1,
    production_connected: false,
  };
}

/* Real HTTPS transport (used only when the engine's gated OpenRouter step runs):
   one-shot POST, hard 64 KiB response cap, strict timeout, NO automatic retries.
   Non-HTTP failures surface as provider_connection_failed_no_automatic_retry;
   HTTP error statuses are mapped by parseResponse's error table. */
function createLiveTransport({ timeoutMs = 20000 } = {}) {
  const https = require('https');
  return function liveTransport(body, secret, { host, path } = {}) {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const req = https.request(
        { host, path, method: 'POST', timeout: timeoutMs },
        (res) => {
          const chunks = [];
          let total = 0;
          let done = false;
          res.on('data', (c) => {
            if (done) return;
            total += c.length;
            if (total > MAX_BYTES + 1) {
              done = true;
              res.destroy();
              reject(new ProviderError('invalid_provider_response'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            if (done) return;
            done = true;
            resolve({ status: res.statusCode || 0, raw: Buffer.concat(chunks) });
          });
          res.on('error', () => {
            if (done) return;
            done = true;
            reject(new ProviderError('provider_connection_failed_no_automatic_retry'));
          });
        }
      );
      req.setHeader('Content-Type', 'application/json');
      req.setHeader('Authorization', 'Bearer ' + secret);
      req.setHeader('Content-Length', payload.length);
      req.on('timeout', () => {
        req.destroy(new ProviderError('provider_connection_failed_no_automatic_retry'));
      });
      req.on('error', (err) => {
        if (err instanceof ProviderError) reject(err);
        else reject(new ProviderError('provider_connection_failed_no_automatic_retry'));
      });
      req.end(payload);
    });
  };
}

/* Engine-facing gated draft generation: explicit kind + allowlisted payload +
   optional engine-verified PUBLIC product facts (real catalogue) + transport.
   Every returned draft requires human review; zero external actions. */
async function generateMarketingDraft(config, options = {}) {
  config.validate();
  if (typeof options.transport !== 'function') {
    throw new ProviderError('live_network_transport_disabled_in_phase1');
  }
  const body = buildBody(options.kind, options.payload, config.getModel(), options.productFacts || null);
  let parsed;
  try {
    parsed = await config.useKey(async (secret) => {
      const { status, raw } = await options.transport(body, secret, { host: HOST, path: PATH });
      return parseResponse(status, raw, secret);
    });
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError('provider_connection_failed_no_automatic_retry');
  }
  return {
    ...parsed,
    mode: 'openrouter',
    ai_generated: true,
    requires_human_review: true,
    external_actions: [],
    request_attempts: 1,
    production_connected: true,
  };
}

module.exports = {
  HOST,
  PATH,
  MAX_BYTES,
  ProviderError,
  createConfig,
  buildBody,
  parseResponse,
  generateSyntheticTest,
  createLiveTransport,
  generateMarketingDraft,
};
