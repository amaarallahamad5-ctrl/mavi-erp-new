'use strict';
/* Disabled-by-default OpenRouter connector contract (ported from Accounting's
   automation/openrouter.py).
   - Zero live HTTP endpoints are wired to this module in Phase 1.
   - Disabled in staging (`MAVI_STAGING_MODE=1`) and whenever `MAVI_OPENROUTER_ENABLED !== '1'`.
   - Free model IDs ONLY (`openrouter/free` or `vendor/model:free`); zero paid fallbacks.
   - Synthetic / public-catalogue marketing drafts only — customer data, receipts,
     phones, measurements, and costs are strictly rejected at the boundary.
   - Tested exclusively with offline mock transports; no live network call is made. */
/* NOTE: this module must NOT statically require('./office-engine') — the engine
   statically imports AI_SUPPORTED_KINDS from here, and PolicyError is extended
   at class-definition time. Lazy requires keep the cycle impossible. */
const { isStagingMode, recordOutboundTelemetry } = require('./staging-guard');
const { setting, run } = require('./db');

// Standalone provider error (same shape as the engine's PolicyError: code + HTTP status).
class ProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProviderError';
    this.code = code;
    this.status = 400;
  }
}
const engineRefs = () => require('./office-engine'); // lazy: engine fully loads first

const HOST = 'openrouter.ai';
const PATH = '/api/v1/chat/completions';
const MAX_BYTES = 65536;

function createConfig(env = process.env) {
  const staging = env.MAVI_STAGING_MODE === '1' || isStagingMode();
  // Key/model/enabled can come from the hosting environment (highest priority)
  // or from the owner-only office AI settings stored in the ERP database, so
  // the owner can activate the free provider without touching hosting config.
  const settingsKey = String(setting('office_ai_api_key') || '');
  const settingsModel = String(setting('office_ai_model') || '').trim();
  const settingsEnabled = setting('office_ai_enabled') === '1';
  const rawKey = typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY
    ? env.OPENROUTER_API_KEY
    : settingsKey;
  const source = typeof env.OPENROUTER_API_KEY === 'string' && env.OPENROUTER_API_KEY
    ? 'env'
    : (settingsKey ? 'settings' : 'none');
  const enabled = !staging && (env.MAVI_OPENROUTER_ENABLED === '1' || (settingsEnabled && !!rawKey));
  const model = typeof env.OPENROUTER_MODEL === 'string' && env.OPENROUTER_MODEL.trim()
    ? env.OPENROUTER_MODEL.trim()
    : (settingsModel || 'openrouter/free');
  let lastTest = null;
  try { lastTest = JSON.parse(setting('office_ai_last_test') || 'null'); } catch { lastTest = null; }

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
    let status = 'ready';
    try { validate(); } catch (err) { status = err.code || 'openrouter_disabled'; }
    return {
      status,
      enabled,
      source,
      key_present: rawKey.length > 0,
      key_tail: rawKey ? rawKey.slice(-4) : '',
      model,
      free_models_only: true,
      automatic_retry: false,
      queue_connected: false,
      production_connected: false,
      network_calls: 0,
      last_test: lastTest && typeof lastTest === 'object' ? lastTest : null,
      supported_kinds: AI_SUPPORTED_KINDS.slice(),
    };
  }

  function getModel() { return model; }
  function useKey(fn) { return fn(rawKey); }

  // Freeze without exposing rawKey as an enumerable or inspectable property
  return Object.freeze({ validate, summary, getModel, useKey });
}

/* Marketing kinds the free provider may draft. Every one of them is bound to a
   PUBLIC catalogue product only — customer data, receipts, phones, measurements
   and costs are strictly rejected at this boundary. Operational order/workshop/
   deposit drafts deliberately stay on the local fact-based builder so customer
   data never leaves the ERP. */
const AI_SUPPORTED_KINDS = Object.freeze([
  'content_draft',
  'campaign_brief',
  'community_followup_draft',
  'visual_reel_brief',
  'seo_readiness_check',
  'landing_page_check',
  'style_page_copy_draft',
]);

function validateMarketingInput(kind, payload, opts = {}) {
  if (!AI_SUPPORTED_KINDS.includes(kind)) {
    throw new ProviderError('only_marketing_drafts_supported');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new ProviderError('only_allowlisted_demo_fields_are_supported');
  }
  // Strict per-kind allowlists mirroring the engine's validateJobPayload contracts:
  //   content_draft            -> [channel, product_id]
  //   campaign_brief           -> [channel, daily_budget_egp, product_id]
  //   community_followup_draft -> [channel, product_id]
  //   visual_reel_brief        -> [product_id]
  //   seo_readiness_check      -> [product_id]
  //   landing_page_check       -> [product_id]
  const expectedKeys = kind === 'campaign_brief'
    ? ['channel', 'daily_budget_egp', 'product_id']
    : kind === 'style_page_copy_draft'
      ? ['style_id']
      : kind === 'visual_reel_brief' || kind === 'seo_readiness_check' || kind === 'landing_page_check'
        ? ['product_id']
        : ['channel', 'product_id'];
  const keys = Object.keys(payload).sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new ProviderError('only_allowlisted_demo_fields_are_supported');
  }
  if (kind === 'style_page_copy_draft') {
    if (typeof payload.style_id !== 'string') throw new ProviderError('invalid_style_id');
  } else if (typeof payload.product_id !== 'string') {
    throw new ProviderError('only_synthetic_catalogue_is_supported');
  }
  const needsChannel = expectedKeys.includes('channel');
  if (needsChannel && !['facebook', 'instagram'].includes(payload.channel)) {
    throw new ProviderError('unsupported_channel');
  }
  if (kind === 'style_page_copy_draft' && !/^[A-Z0-9_-]{1,30}$/.test(payload.style_id)) {
    throw new ProviderError('invalid_style_id');
  }
  if (kind === 'campaign_brief' && (!Number.isInteger(payload.daily_budget_egp) || payload.daily_budget_egp < 1 || payload.daily_budget_egp > 100)) {
    throw new ProviderError('demo_daily_budget_must_be_integer_1_to_100');
  }
  const clean = kind === 'style_page_copy_draft' ? { style_id: payload.style_id } : { product_id: payload.product_id };
  if (kind === 'content_draft' || kind === 'campaign_brief' || kind === 'community_followup_draft') clean.channel = payload.channel;
  if (kind === 'campaign_brief') clean.daily_budget_egp = payload.daily_budget_egp;
  if (opts && opts.productFacts) {
    // Explicit, engine-verified PUBLIC catalogue facts (id/name/note only — never price, cost, or customer data).
    const pf = opts.productFacts;
    const expectedId = kind === 'style_page_copy_draft' ? payload.style_id : payload.product_id;
    if (
      !pf || typeof pf !== 'object' ||
      pf.id !== expectedId ||
      typeof pf.name !== 'string' || !pf.name.trim() || pf.name.length > 200 ||
      typeof pf.note !== 'string' || pf.note.length > 500
    ) {
      throw new ProviderError('only_allowlisted_demo_fields_are_supported');
    }
    // Optional PUBLIC catalogue facets for page-copy drafts (never price/cost).
    for (const key of ['fabrics', 'colours']) {
      if (pf[key] !== undefined) {
        if (!Array.isArray(pf[key]) || pf[key].length > 30 || pf[key].some((x) => typeof x !== 'string' || !x.trim() || x.length > 80)) {
          throw new ProviderError('only_allowlisted_demo_fields_are_supported');
        }
      }
    }
    return clean;
  }
  if (kind === 'style_page_copy_draft') {
    return clean; // real public style facts were validated above
  }
  const { SYNTHETIC_CATALOGUE } = engineRefs();
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
  const { SYNTHETIC_CATALOGUE } = engineRefs();
  const realProduct = !!productFacts;
  const product = realProduct
    ? {
        id: productFacts.id,
        name: productFacts.name,
        description: String(productFacts.note || ''),
        ...(Array.isArray(productFacts.fabrics) && productFacts.fabrics.length ? { fabrics: productFacts.fabrics } : {}),
        ...(Array.isArray(productFacts.colours) && productFacts.colours.length ? { colours: productFacts.colours } : {}),
      }
    : SYNTHETIC_CATALOGUE[clean.product_id];
  const roleBrief = {
    content_draft: 'أنت ليلى، كاتبة محتوى محترفة في براند MAVI لتفصيل الفساتين على المقاس (خبرة في كتابة سوشيال ميديا: hooks قوية في أول سطر، عرض فائدة واضحة، لغة بسيطة أنيقة، ودعوة تفاعل قصيرة)، وبتكتب مسودة بوست حقيقية تنتظر مراجعة المالكة',
    campaign_brief: 'أنت كريم، مدير تسويق ونمو محترف في براند MAVI (خبرة في تحديد الجمهور المستهدف، زاوية الرسالة، توزيع السقف التخطيطي بين المراحل، ومؤشرات قياس KPI واضحة — تخطيط فقط بدون أي صرف أو إطلاق)، وبتكتب موجز حملة تنتظر مراجعة المالكة',
    community_followup_draft: 'أنت بسمة، مسؤولة خدمة عملاء محترفة في براند MAVI (خبرة في ردود متعاطفة وواضحة، إجابة على سؤال العميلة مباشرة، وخطوة تالية بسيطة بدون ضغط)، وبتكتب ردًّا جاهزًا لعميلة مهتمة بالموديل تنتظر مراجعة المالكة',
    visual_reel_brief: 'أنت مايا، مصممة محتوى مرئي محترفة في براند MAVI (خبرة في بنية الريل: خطاف أول ٣ ثواني، مشاهد مرتبة بمدد واضحة، إبراز تفاصيل الخامة والقص، وخاتمة بعلامة البراند ودعوة للطلب)، وبتكتب خطة تصوير ريل للموديل تنتظر مراجعة المالكة',
    seo_readiness_check: 'أنت نادين، متخصصة تحسين ظهور محترفة في براند MAVI (خبرة في فحص الكلمات المفتاحية، العنوان والوصف التعريفي، نص بديل للصور alt، سرعة الصفحة، والروابط الداخلية)، وبتكتب مسودة فحص جاهزية صفحة الموديل قبل الترويج',
    landing_page_check: 'أنت كريم، مدير تسويق ونمو محترف في براند MAVI (خبرة في تحسين صفحات الهبوط: وضوح العرض، إشارات الثقة، ترتيب الأقسام، وضوح زر الإجراء)، وبتكتب مسودة تحسينات مقترحة على صفحة الموديل تنتظر موافقة المالكة',
    style_page_copy_draft: 'أنت ليلى، كاتبة محتوى محترفة في براند MAVI (خبرة في أوصاف صفحات المنتجات: وصف جذاب مختصر يبرز الخامة والتفصيل على المقاس بدون مبالغة)، وبتكتب وصف صفحة الموديل الذي سينشر فعلًا بعد موافقة المالكة',
  }[kind] || 'أنت عضو فريق MAVI لتفصيل الفساتين، وبتكتب مسودة تسويق تنتظر مراجعة المالكة';
  const productBoundary = realProduct
    ? 'البيانات التالية معلومات عامة من كتالوج MAVI (اسم ووصف عام فقط — بدون أي أسعار أو تكاليف أو بيانات عميلات)'
    : 'البيانات التالية مصطنعة وليست عرض بيع حقيقي';
  const decisionLine = {
    content_draft: '🎯 قراري كمدير المحتوى',
    campaign_brief: '🎯 قراري كمدير التسويق',
    community_followup_draft: '🎯 قراري كمدير المجتمع',
    visual_reel_brief: '🎯 قراري كمصممة المحتوى المرئي',
    seo_readiness_check: '🎯 قراري كمدير التسويق',
    landing_page_check: '🎯 قراري كمدير التسويق',
  }[kind] || '🎯 قراري المهني';
  const isStyleCopy = kind === 'style_page_copy_draft';
  const systemPrompt = `${roleBrief}. ${productBoundary}. قواعد الجودة الإلزامية: كل معلومة مبنية فقط على بيانات الموديل المعطاة — ممنوع اختراع أي تفصيلة غير موجودة فيها؛ أسلوب عربي واضح بسيط ومهني بدون مبالغة؛ خطوات عملية قابلة للتنفيذ فورًا؛ نظّم النص بعناوين ونقاط قصيرة. أعد JSON فقط بمفاتيح title وtext وreview_checklist (قائمة نصوص). ${isStyleCopy ? `في حالتك هذه (وصف صفحة الموديل): text هو الوصف نفسه الذي سينشر على الصفحة — عربي فصيح مبسط من ١٢٠ إلى ٤٥٠ حرف فقط، يذكر الخامة والألوان والتفصيل على المقاس، بدون أسعار وبدون وعود بمواعيد أو خصومات وبدون أي بيانات عملاء — هذا النص سينشر حرفيًا وسيصبح الوصف التعريفي للصفحة في محركات البحث (SEO)، ثم سطر يبدأ بـ «${decisionLine}:» فيه تبرير مختصر مبني على البيانات المعطاة فقط، ثم سطر يبدأ بـ «🙋 الإذن المطلوب من المالكة:» يوضح أن الاعتماد سينشر الوصف على صفحة الموديل مباشرة.` : `في text ابدأ بمحتوى المسودة الجاهزة للمراجعة (سطور قصيرة مناسبة للقناة، بدون أسعار)،`} ثم سطر يبدأ بـ «${decisionLine}:» فيه تبرير مختصر مبني على البيانات المعطاة فقط، ثم سطر يبدأ بـ «🙋 الإذن المطلوب من المالكة:» يوضح أن التنفيذ أو النشر يتم يدويًا بعد اعتمادها ولا يوجد إرسال تلقائي. لا تخترع سعرًا أو توافرًا أو موعد تسليم أو تقييمات، ولا تدعو لتنفيذ أي إجراء أو إرسال، ولا تطلب أدوات أو روابط أو بيانات عميلات.`;
  return {
    model,
    messages: [
      {
        role: 'system',
        content: systemPrompt,
      },
      {
        role: 'user',
        content: engineRefs().canonical({
          kind,
          synthetic_product: {
            id: product.id,
            name: product.name,
            description: product.description ?? '',
            ...(product.fabrics ? { fabrics: product.fabrics } : {}),
            ...(product.colours ? { colours: product.colours } : {}),
          },
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
      require_parameters: false,
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

  /* Small free models often wrap JSON in prose or code fences even when
     response_format is requested — extract the outermost JSON object first. */
  function extractJsonObject(text) {
    const s = String(text || '').replace(/```(?:json)?/gi, '');
    const start = s.indexOf('{');
    if (start === -1) return null;
    const end = s.lastIndexOf('}');
    if (end <= start) return null;
    return s.slice(start, end + 1);
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
    try {
      draft = JSON.parse(msg.content);
    } catch (_) {
      const extracted = extractJsonObject(msg.content);
      if (!extracted) throw new Error('bad_draft');
      draft = JSON.parse(extracted);
    }
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
  if (secret && engineRefs().canonical(out).includes(secret)) {
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
  // `openrouter/free` is the "auto" sentinel: resolve it to an actually
  // available :free model so generation never posts an imaginary model id.
  let model = config.getModel();
  try { model = await resolveModel(config); } catch { model = config.getModel(); }
  const body = buildBody(options.kind, options.payload, model, options.productFacts || null);
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

/* Real, minimal connectivity check the owner can run from the office UI.
   Uses the same gated transport + 0-cost provider block; a tiny one-shot
   prompt — never a customer payload. Records outbound telemetry honestly. */
/* Real free-model discovery + auto resolution for the `openrouter/free`
   sentinel. The owner can keep the sentinel ("auto") and the server picks an
   actually-available :free model at request time; the models list is public
   (no key), cached in-memory for an hour, and disabled in staging. */
const MODELS_PATH = '/api/v1/models';
const MODEL_LIST_TTL_MS = 60 * 60 * 1000;
const MODEL_CACHE = { at: 0, ids: [] };
const PREFERRED_FREE_MODELS = [
  'deepseek/deepseek-chat-v3.1:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'google/gemini-2.0-flash-exp:free',
  'qwen/qwen3-235b-a22b:free',
  'mistralai/mistral-small-3.2-24b-instruct:free',
];

async function listFreeModels(opts = {}) {
  const discoveryDisabled = process.env.MAVI_OFFICE_AI_NO_MODEL_DISCOVERY === '1';
  if (!opts.force && Date.now() - MODEL_CACHE.at < MODEL_LIST_TTL_MS) return MODEL_CACHE.ids.slice();
  if (isStagingMode() || discoveryDisabled) {
    MODEL_CACHE.at = Date.now();
    MODEL_CACHE.ids = [];
    return [];
  }
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 8000) : null;
  try {
    const res = await fetch(`https://${HOST}${MODELS_PATH}`, {
      headers: { Accept: 'application/json' },
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) throw new Error('models_http_' + res.status);
    const doc = await res.json();
    const ids = (Array.isArray(doc && doc.data) ? doc.data : [])
      .filter((m) => m && typeof m.id === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}\/[a-z0-9][a-z0-9._-]{0,119}:free$/.test(m.id)
        && m.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0)
      .map((m) => m.id)
      .sort();
    MODEL_CACHE.at = Date.now();
    MODEL_CACHE.ids = ids;
    return ids.slice();
  } catch {
    MODEL_CACHE.at = Date.now();
    MODEL_CACHE.ids = [];
    return [];
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveModel(config) {
  const current = config.getModel();
  if (current !== 'openrouter/free') return current;
  const ids = MODEL_CACHE.at && Date.now() - MODEL_CACHE.at < MODEL_LIST_TTL_MS
    ? MODEL_CACHE.ids
    : await listFreeModels();
  for (const pref of PREFERRED_FREE_MODELS) {
    if (ids.includes(pref)) return pref;
  }
  return ids[0] || current; // unresolvable -> sentinel passes through and fails honestly (404)
}

/* Lenient live-check parser: the probe only verifies auth + that the model
   answers with SOMETHING — small free models may ignore response_format, and
   that must not fail an otherwise perfectly working connection. */
function parseProbeResponse(status, rawBuffer, secret) {
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
  let doc;
  try { doc = JSON.parse(buf.toString('utf8')); } catch { throw new ProviderError('invalid_provider_response'); }
  const choice = doc && Array.isArray(doc.choices) && doc.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new ProviderError('invalid_or_incomplete_draft_response');
  }
  const model = typeof doc.model === 'string' && /^[A-Za-z0-9/._:-]{1,200}$/.test(doc.model) ? doc.model : null;
  const usage = doc.usage || {};
  if (Object.prototype.hasOwnProperty.call(usage, 'cost')) {
    if (typeof usage.cost !== 'number' || !Number.isFinite(usage.cost) || usage.cost !== 0) {
      throw new ProviderError('unexpected_reported_cost_stop_and_check_dashboard');
    }
  }
  return { model_reported: model };
}

async function testConnection(config, options = {}) {
  const started = Date.now();
  let status = 'ok';
  let error_code = null;
  let model_reported = null;
  let network_calls = 0;
  try {
    config.validate();
  } catch (err) {
    return { ok: false, error_code: err.code || 'openrouter_disabled', latency_ms: 0, model: config.getModel() };
  }
  const transport = typeof options.transport === 'function'
    ? options.transport
    : createLiveTransport({ timeoutMs: 20000 });
  // Resolve the auto sentinel to a concrete, actually-available free model so
  // the test measures the REAL configuration the owner will use.
  let usedModel = config.getModel();
  try { usedModel = await resolveModel(config); } catch { usedModel = config.getModel(); }
  const body = {
    model: usedModel,
    messages: [{ role: 'user', content: 'أعد هذا الـ JSON فقط بدون أي كلام إضافي: {"title":"جاهز","text":"اختبار اتصال","review_checklist":["تم"]}' }],
    stream: false,
    max_tokens: 120,
    temperature: 0,
    response_format: { type: 'json_object' },
    provider: {
      allow_fallbacks: false,
      require_parameters: false,
      data_collection: 'deny',
      max_price: { prompt: 0, completion: 0 },
    },
  };
  try {
    const parsed = await config.useKey(async (secret) => {
      const { status: httpStatus, raw } = await transport(body, secret, { host: HOST, path: PATH });
      network_calls = 1;
      return parseProbeResponse(httpStatus, raw, secret);
    });
    model_reported = parsed && parsed.model_reported ? parsed.model_reported : usedModel;
  } catch (err) {
    status = 'failed';
    error_code = err instanceof ProviderError ? err.code : 'provider_connection_failed_no_automatic_retry';
  }
  if (typeof options.transport !== 'function') recordOutboundTelemetry('openrouter_ai', network_calls ? 'network_attempt' : 'blocked_staging');
  const result = { ok: status === 'ok', error_code, model: model_reported || usedModel, latency_ms: Date.now() - started };
  try {
    run("INSERT INTO settings(key,value) VALUES('office_ai_last_test',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify({ ...result, at: new Date().toISOString() }));
  } catch { /* settings persistence is best-effort */ }
  return result;
}

module.exports = {
  HOST,
  PATH,
  MODELS_PATH,
  MAX_BYTES,
  ProviderError,
  AI_SUPPORTED_KINDS,
  createConfig,
  buildBody,
  parseResponse,
  parseProbeResponse,
  listFreeModels,
  resolveModel,
  generateSyntheticTest,
  createLiveTransport,
  generateMarketingDraft,
  testConnection,
};
