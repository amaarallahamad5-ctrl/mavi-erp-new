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
const { setting, run, run: dbRun } = require('./db');

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
  // Key/model/enabled can come from the owner-only office AI settings stored in
  // the ERP database (HIGHEST priority — an explicit owner action must always
  // beat a stale hosting env var, which once shadowed her fresh key and kept
  // the engine rejecting a dead credential), or fall back to the hosting
  // environment as a bootstrap default.
  const settingsKey = String(setting('office_ai_api_key') || '').trim();
  const settingsModel = String(setting('office_ai_model') || '').trim();
  const settingsEnabled = setting('office_ai_enabled') === '1';
  const envKey = typeof env.OPENROUTER_API_KEY === 'string' ? env.OPENROUTER_API_KEY.trim() : '';
  const rawKey = settingsKey || envKey;
  const source = settingsKey ? 'settings' : (envKey ? 'env' : 'none');
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
  'collection_copy_draft',
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
      : kind === 'collection_copy_draft'
        ? ['section']
        : kind === 'visual_reel_brief' || kind === 'seo_readiness_check' || kind === 'landing_page_check'
          ? ['product_id']
          : ['channel', 'product_id'];
  const keys = Object.keys(payload).sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw new ProviderError('only_allowlisted_demo_fields_are_supported');
  }
  if (kind === 'style_page_copy_draft') {
    if (typeof payload.style_id !== 'string') throw new ProviderError('invalid_style_id');
  } else if (kind === 'collection_copy_draft') {
    if (typeof payload.section !== 'string' || !/^(all|summer|winter|trend|offers)$/.test(payload.section)) {
      throw new ProviderError('invalid_section');
    }
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
  const clean = kind === 'style_page_copy_draft'
    ? { style_id: payload.style_id }
    : kind === 'collection_copy_draft'
      ? { section: payload.section }
      : { product_id: payload.product_id };
  if (kind === 'content_draft' || kind === 'campaign_brief' || kind === 'community_followup_draft') clean.channel = payload.channel;
  if (kind === 'campaign_brief') clean.daily_budget_egp = payload.daily_budget_egp;
  if (opts && opts.productFacts) {
    // Explicit, engine-verified PUBLIC catalogue facts (id/name/note only — never price, cost, or customer data).
    const pf = opts.productFacts;
    const expectedId = kind === 'style_page_copy_draft'
      ? payload.style_id
      : kind === 'collection_copy_draft'
        ? String(payload.section).toUpperCase()
        : payload.product_id;
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
  if (kind === 'style_page_copy_draft' || kind === 'collection_copy_draft') {
    return clean; // real public facts were validated above
  }
  const { SYNTHETIC_CATALOGUE } = engineRefs();
  if (!Object.prototype.hasOwnProperty.call(SYNTHETIC_CATALOGUE, payload.product_id)) {
    throw new ProviderError('only_synthetic_catalogue_is_supported');
  }
  return clean;
}

function buildBody(kind, payload, model, productFacts = null, opts = null) {
  // The :free-only ID contract is OpenRouter-specific; the Alibaba config
  // enforces its own qwen-family allowlist before any request is built.
  if (!(opts && opts.omitProviderRouting === true)) {
    if (
      model !== 'openrouter/free' &&
      !/^[a-z0-9][a-z0-9._-]{0,79}\/[a-z0-9][a-z0-9._-]{0,119}:free$/.test(String(model || ''))
    ) {
      throw new ProviderError('only_free_model_ids_are_allowed');
    }
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
    collection_copy_draft: 'أنت ليلى، كاتبة محتوى محترفة في براند MAVI (خبرة في أوصاف مجموعات المتجر: وصف مختصر يعرّف بالمجموعة ويبرز الخامات والتفصيل على المقاس بدون مبالغة)، وبتكتب وصف مجموعة المتجر الذي سينشر فعلًا بعد موافقة المالكة',
  }[kind] || 'أنت عضو فريق MAVI لتفصيل الفساتين، وبتكتب مسودة تسويق تنتظر مراجعة المالكة';
  const productBoundary = realProduct
    ? 'البيانات التالية معلومات عامة من كتالوج MAVI (اسم ووصف عام فقط — بدون أي أسعار أو تكاليف أو بيانات عميلات)'
    : 'البيانات التالية مصطنعة وليست عرض بيع حقيقي';
  const decisionLine = {
    content_draft: '🎯 قراري كمدير المحتوى',
    collection_copy_draft: '🎯 قراري كمدير المحتوى',
    campaign_brief: '🎯 قراري كمدير التسويق',
    community_followup_draft: '🎯 قراري كمدير المجتمع',
    visual_reel_brief: '🎯 قراري كمصممة المحتوى المرئي',
    seo_readiness_check: '🎯 قراري كمدير التسويق',
    landing_page_check: '🎯 قراري كمدير التسويق',
  }[kind] || '🎯 قراري المهني';
  const isStyleCopy = kind === 'style_page_copy_draft';
  const isCollectionCopy = kind === 'collection_copy_draft';
  const systemPrompt = `${roleBrief}. ${productBoundary}. قواعد الجودة الإلزامية: كل معلومة مبنية فقط على بيانات الموديل المعطاة — ممنوع اختراع أي تفصيلة غير موجودة فيها؛ أسلوب عربي واضح بسيط ومهني بدون مبالغة؛ خطوات عملية قابلة للتنفيذ فورًا؛ نظّم النص بعناوين ونقاط قصيرة. أعد JSON فقط بمفاتيح title وtext وreview_checklist (قائمة نصوص). ${isStyleCopy ? `في حالتك هذه (وصف صفحة الموديل): text هو الوصف نفسه الذي سينشر على الصفحة — عربي فصيح مبسط من ١٢٠ إلى ٤٥٠ حرف فقط، يذكر الخامة والألوان والتفصيل على المقاس، بدون أسعار وبدون وعود بمواعيد أو خصومات وبدون أي بيانات عملاء — هذا النص سينشر حرفيًا وسيصبح الوصف التعريفي للصفحة في محركات البحث (SEO)، ثم سطر يبدأ بـ «${decisionLine}:» فيه تبرير مختصر مبني على البيانات المعطاة فقط، ثم سطر يبدأ بـ «🙋 الإذن المطلوب من المالكة:» يوضح أن الاعتماد سينشر الوصف على صفحة الموديل مباشرة.` : isCollectionCopy ? `في حالتك هذه (وصف مجموعة المتجر): text هو الوصف نفسه الذي سيظهر تحت المجموعة على المتجر — عربي فصيح مبسط من ١٢٠ إلى ٤٥٠ حرف فقط، مبني على عدد الموديلات والخامات المعطاة فعلًا ولو قليلة قول ذلك بصدق، بدون أسعار وبدون وعود بمواعيد أو خصومات وبدون أي بيانات عملاء — هذا النص سينشر حرفيًا للزوار، ثم سطر يبدأ بـ «${decisionLine}:» فيه تبرير مختصر مبني على البيانات المعطاة فقط، ثم سطر يبدأ بـ «🙋 الإذن المطلوب من المالكة:» يوضح أن الاعتماد سينشر الوصف على المتجر مباشرة.` : `في text ابدأ بمحتوى المسودة الجاهزة للمراجعة (سطور قصيرة مناسبة للقناة، بدون أسعار)،`} ثم سطر يبدأ بـ «${decisionLine}:» فيه تبرير مختصر مبني على البيانات المعطاة فقط، ثم سطر يبدأ بـ «🙋 الإذن المطلوب من المالكة:» يوضح أن التنفيذ أو النشر يتم يدويًا بعد اعتمادها ولا يوجد إرسال تلقائي. لا تخترع سعرًا أو توافرًا أو موعد تسليم أو تقييمات، ولا تدعو لتنفيذ أي إجراء أو إرسال، ولا تطلب أدوات أو روابط أو بيانات عميلات.`;
  const body = {
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
    // Arabic is token-expensive: 400 truncated real drafts mid-JSON
    // (finish_reason 'length') and the strict parser then rejected them whole.
    // 1500 covers the largest allowed draft (2000-char text) with headroom —
    // still exactly $0 on :free models.
    max_tokens: 1500,
    temperature: 0.2,
    response_format: { type: 'json_object' },
  };
  // The routing/zero-cost block is OpenRouter-specific; strict OpenAI-compatible
  // endpoints (DashScope) may reject unknown params.
  if (!opts || opts.omitProviderRouting !== true) {
    body.provider = {
      allow_fallbacks: false,
      require_parameters: false,
      data_collection: 'deny',
      max_price: { prompt: 0, completion: 0 },
    };
  }
  return body;
}

function parseResponse(status, rawBuffer, secret, fallbackModel = null) {
  const errorMap = {
    401: 'provider_auth_failed',
    402: 'provider_credit_or_quota_required',
    403: 'provider_access_denied',
    404: 'free_model_unavailable',
    429: 'provider_rate_limited_no_automatic_retry',
  };
  if (status !== 200) {
    const says = providerSaysFromBody(rawBuffer);
    const code = (says && classifyRateReason(says)) || errorMap[status] || 'provider_request_failed_no_automatic_retry';
    const err = new ProviderError(code);
    if (says) err.provider_says = says;
    throw err;
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
    /* finish_reason: 'stop' is normal, 'length' means the reply hit the token
       ceiling (the draft may still be complete right at the cut), and several
       free-model proxies omit the field entirely. Only tool/function calls and
       content_filter are real rejections. If a 'length' reply cannot yield a
       usable draft we say WHY: provider_reply_truncated. */
    if (!msg || msg.tool_calls || msg.function_call || choice.finish_reason === 'content_filter') {
      throw new Error('bad_finish');
    }
    if (typeof msg.content !== 'string') throw new Error('bad_content');
    // Nemotron-style hybrid thinkers may wrap the answer in <think>...</think>
    // reasoning blocks — strip them so JSON extraction sees clean content.
    const bareContent = msg.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    const truncCode = choice.finish_reason === 'length' ? 'provider_reply_truncated' : 'invalid_or_incomplete_draft_response';
    try {
      draft = JSON.parse(bareContent);
    } catch (_) {
      const extracted = extractJsonObject(bareContent);
      if (!extracted) throw new ProviderError(truncCode);
      try {
        draft = JSON.parse(extracted);
      } catch (_) {
        throw new ProviderError(truncCode);
      }
    }
    if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new ProviderError(truncCode);
    /* Real free models often omit review_checklist or add extra keys — that must
       not kill the draft. Required: usable title + text. review_checklist is
       OPTIONAL: missing/invalid -> [] (never fabricated; the engine prepends its
       own two mandatory human-review items anyway). Extra keys are ignored —
       only these three fields are ever consumed. */
    if (typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 120) throw new Error('bad_title');
    if (typeof draft.text !== 'string' || !draft.text.trim() || draft.text.length > 2000) throw new Error('bad_text');
    if (
      draft.review_checklist !== undefined &&
      (!Array.isArray(draft.review_checklist) ||
        draft.review_checklist.length > 8 ||
        draft.review_checklist.some(x => typeof x !== 'string' || !x.trim() || x.length > 300))
    ) {
      throw new Error('bad_checks');
    }
    if (!Array.isArray(draft.review_checklist)) draft.review_checklist = [];
    draft.review_checklist = draft.review_checklist.filter(x => typeof x === 'string' && x.trim());
    model = (typeof doc.model === 'string' && /^[A-Za-z0-9/._:-]{1,200}$/.test(doc.model))
      ? doc.model
      : (fallbackModel || null);
    if (!model) throw new Error('bad_model');
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
      return parseResponse(status, raw, secret, config.getModel());
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
  return function liveTransport(body, secret, { host, path, port, scheme } = {}) {
    // scheme 'http' serves the owner's local Docker Model Runner on localhost;
    // every cloud provider keeps the default https.
    const mod = scheme === 'http' ? require('http') : https;
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body), 'utf8');
      const reqOpts = { host, path, method: 'POST', timeout: timeoutMs };
      if (port) reqOpts.port = port;
      const req = mod.request(
        reqOpts,
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
      // Optional per-provider-docs attribution headers (openrouter.ai/docs):
      // they only affect app ranking on their site, never the request itself.
      req.setHeader('X-OpenRouter-Title', 'MAVI ERP');
      if (process.env.PUBLIC_ORIGIN) req.setHeader('HTTP-Referer', String(process.env.PUBLIC_ORIGIN).slice(0, 200));
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
  const body = buildBody(options.kind, options.payload, model, options.productFacts || null, { omitProviderRouting: config.omitProviderRouting === true });
  let parsed;
  try {
    parsed = await config.useKey(async (secret) => {
      const { status, raw } = await options.transport(body, secret, { host: config.host || HOST, path: config.path || PATH, port: config.port, scheme: config.scheme });
      return parseResponse(status, raw, secret, model);
    });
  } catch (err) {
    // Honest transparency: the owner must see WHICH model failed, not just the code.
    if (err instanceof ProviderError) {
      try { err.model = model; } catch (_) { /* attribute is best-effort */ }
      if (model && (err.code === 'provider_rate_limited_no_automatic_retry' || err.code === 'free_model_unavailable')) {
        setModelCooldown(model); // the next click picks a different free model
      }
      throw err;
    }
    const wrapped = new ProviderError('provider_connection_failed_no_automatic_retry');
    wrapped.model = model;
    throw wrapped;
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

/* فهمي بتاع التسويق — the owner's ONE daily idea, researched by the AI provider
   over REAL system data. Owner decision (26.11): «المشغل الأساسي بتاع فهمي
   يكون الذكاء الاصطناعي ويطلع نتايج قوية بعد بحث».
   - input: the engine-built brief (aggregates, order/style codes, dates,
     stages) — NO customer names, NO phones, NO measurements, NO money
   - output: strict JSON { title, body, steps } in plain Arabic; every number
     must come from the provided data (the model is told, and the local layer
     validates shape/lengths); zero provider-speak reaches the owner
   - same contract as the marketing drafts: one-shot transport, no retries,
     free models only, human (the owner) decides everything. */
function buildFahmyBody(brief, model) {
  if (
    model !== 'openrouter/free' &&
    !/^[a-z0-9][a-z0-9._-]{0,79}\/[a-z0-9][a-z0-9._-]{0,119}:free$/.test(String(model || ''))
  ) {
    throw new ProviderError('only_free_model_ids_are_allowed');
  }
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) {
    throw new ProviderError('invalid_fahmy_brief');
  }
  const systemPrompt =
    'أنت فهمي، مسئول التسويق المحترف في براند MAVI لتفصيل الفساتين على المقاس، وبتجهز للمالكة فكرة واحدة كل يوم ' +
    'بعد بحث عميق في بيانات النظام المعطاة (أرقام حقيقية لحظة الفحص). ' +
    'قواعد إلزامية: استخدم فقط الأرقام والحقائق الموجودة في البيانات المعطاة — ممنوع تمامًا اختراع أي رقم أو حالة؛ ' +
    'ممنوع ذكر أي اسم عميلة أو رقم هاتف أو سعر أو تكلفة؛ ' +
    'عربي بسيط مفهوم بصوت فهمي مباشر للمالكة، بدون مصطلحات تقنية وبدون ذكر أي مزود خدمة أو ذكاء اصطناعي أو نماذج لغوية؛ ' +
    'الفكرة لازم تكون قوية وعملية: تشرح الموقف بالأرقام، توضّح ليه دي أولوية، وتدي خطة عمل واضحة قابلة للتنفيذ النهاردة؛ ' +
    'التفاصيل الكاملة مطلوبة — من ٧٠٠ إلى ١٦٠٠ حرف بسطور قصيرة منظمة؛ ' +
    'ممنوع أي إرسال تلقائي أو وعد بالتواصل مع العميلات نيابة عن المالكة — كل التنفيذ بيدها هي. ' +
    'أعد JSON فقط بمفاتيح: title (عنوان قوي محدد حتى ١٤٠ حرف)، body (التفاصيل الكاملة)، steps (مصفوفة من ٣ إلى ٦ خطوات عملية قصيرة).';
  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: engineRefs().canonical({
          task: 'fahmy_daily_idea',
          data: brief,
          note: 'كل الأرقام والكودات في data حقيقية من قاعدة بيانات النظام لحظة الفحص — البحث والإ تحليل مبني عليها فقط',
        }),
      },
    ],
    stream: false,
    max_tokens: 1500,
    temperature: 0.35,
    response_format: { type: 'json_object' },
    provider: {
      allow_fallbacks: false,
      require_parameters: false,
      data_collection: 'deny',
      max_price: { prompt: 0, completion: 0 },
    },
  };
  return body;
}

function parseFahmyResponse(status, rawBuffer, secret, fallbackModel) {
  const errorMap = {
    401: 'provider_auth_failed',
    402: 'provider_credit_or_quota_required',
    403: 'provider_access_denied',
    404: 'free_model_unavailable',
    429: 'provider_rate_limited_no_automatic_retry',
  };
  if (status !== 200) {
    const says = providerSaysFromBody(rawBuffer);
    const code = (says && classifyRateReason(says)) || errorMap[status] || 'provider_request_failed_no_automatic_retry';
    const err = new ProviderError(code);
    if (says) err.provider_says = says;
    throw err;
  }
  const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(String(rawBuffer || ''), 'utf8');
  if (buf.length === 0 || buf.length > MAX_BYTES) throw new ProviderError('invalid_provider_response');
  if (secret && buf.includes(Buffer.from(secret, 'utf8'))) throw new ProviderError('provider_response_redacted');
  let doc;
  try { doc = JSON.parse(buf.toString('utf8')); } catch { throw new ProviderError('invalid_provider_response'); }
  const choice = doc && Array.isArray(doc.choices) && doc.choices[0];
  const msg = choice && choice.message;
  if (!msg || msg.tool_calls || msg.function_call || choice.finish_reason === 'content_filter') {
    throw new ProviderError('invalid_or_incomplete_draft_response');
  }
  if (typeof msg.content !== 'string') throw new ProviderError('invalid_or_incomplete_draft_response');
  const bareContent = msg.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  function extractJsonObject(text) {
    const s0 = String(text || '').replace(/```(?:json)?/gi, '');
    const start = s0.indexOf('{');
    if (start === -1) return null;
    const end = s0.lastIndexOf('}');
    if (end <= start) return null;
    return s0.slice(start, end + 1);
  }
  let idea;
  try {
    idea = JSON.parse(bareContent);
  } catch (_) {
    const extracted = extractJsonObject(bareContent);
    if (!extracted) throw new ProviderError('invalid_or_incomplete_draft_response');
    try { idea = JSON.parse(extracted); } catch (_) { throw new ProviderError('invalid_or_incomplete_draft_response'); }
  }
  if (!idea || typeof idea !== 'object' || Array.isArray(idea)) throw new ProviderError('invalid_or_incomplete_draft_response');
  const title = typeof idea.title === 'string' ? idea.title.trim() : '';
  const bodyText = typeof idea.body === 'string' ? idea.body.trim() : '';
  if (title.length < 8 || title.length > 160) throw new ProviderError('invalid_or_incomplete_draft_response');
  if (bodyText.length < 150 || bodyText.length > 2200) throw new ProviderError('invalid_or_incomplete_draft_response');
  let steps = [];
  if (idea.steps !== undefined && idea.steps !== null) {
    if (!Array.isArray(idea.steps) || idea.steps.length > 8) throw new ProviderError('invalid_or_incomplete_draft_response');
    steps = idea.steps
      .filter(x => typeof x === 'string' && x.trim().length >= 3 && x.trim().length <= 220)
      .map(x => x.trim());
  }
  const model = (typeof doc.model === 'string' && /^[A-Za-z0-9/._:-]{1,200}$/.test(doc.model))
    ? doc.model
    : (fallbackModel || null);
  if (!model) throw new ProviderError('invalid_or_incomplete_draft_response');
  return { title, body: bodyText, steps, model_reported: model };
}

/* Gated Fahmy generation: explicit brief + transport, one call, no retries.
   The caller (office-fahmy) owns the honest local fallback. */
async function generateFahmyIdea(config, options = {}) {
  config.validate();
  if (typeof options.transport !== 'function') {
    throw new ProviderError('live_network_transport_disabled_in_phase1');
  }
  let model = config.getModel();
  try { model = await resolveModel(config); } catch { model = config.getModel(); }
  const body = buildFahmyBody(options.brief, model);
  let parsed;
  try {
    parsed = await config.useKey(async (secret) => {
      const { status, raw } = await options.transport(body, secret, { host: HOST, path: PATH });
      return parseFahmyResponse(status, raw, secret, model);
    });
  } catch (err) {
    if (err instanceof ProviderError) {
      try { err.model = model; } catch (_) { /* best-effort attribute */ }
      if (model && (err.code === 'provider_rate_limited_no_automatic_retry' || err.code === 'free_model_unavailable')) {
        setModelCooldown(model);
      }
      throw err;
    }
    const wrapped = new ProviderError('provider_connection_failed_no_automatic_retry');
    wrapped.model = model;
    throw wrapped;
  }
  return { ...parsed, mode: 'openrouter_fahmy', ai_generated: true };
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
/* Capacity cooldown: free models are frequently at capacity (429) or vanish
   from routing (404). The failing model gets a short in-memory cooldown so the
   NEXT owner click resolves to a DIFFERENT model instead of hammering the same
   congested one. Still exactly one attempt per click — no automatic retries. */
const MODEL_COOLDOWN_MS = 10 * 60 * 1000;
const MODEL_COOLDOWN = new Map();
function setModelCooldown(modelId, ms = MODEL_COOLDOWN_MS) {
  if (typeof modelId === 'string' && modelId) MODEL_COOLDOWN.set(modelId, Date.now() + ms);
}
function isModelOnCooldown(modelId) {
  const until = MODEL_COOLDOWN.get(modelId);
  if (!until) return false;
  if (Date.now() > until) { MODEL_COOLDOWN.delete(modelId); return false; }
  return true;
}
function clearModelCooldowns() { MODEL_COOLDOWN.clear(); }
/* Free-model IDs rotate on OpenRouter, so the auto sentinel ranks the LIVE
   list instead of trusting a static list: exact preferred ids first, then
   capability tiers by model family, then alphabetical as the last resort
   (the old ids[0] blindly picked weak alphabetical-first models like
   baidu/...-flash for real generation). Never paid models — callers filter
   to 0-cost :free ids only. */
const PREFERRED_FREE_MODELS = [
  'deepseek/deepseek-v3.2:free',
  'deepseek/deepseek-chat-v3.1:free',
  'deepseek/deepseek-chat-v3-0324:free',
  'meta-llama/llama-4-maverick:free',
  'meta-llama/llama-4-scout:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'z-ai/glm-4.7:free',
  'z-ai/glm-4.5-air:free',
  'qwen/qwen3-235b-a22b:free',
  'qwen/qwen-3-235b:free',
  'openai/gpt-oss-120b:free',
  'mistralai/mistral-small-3.2-24b-instruct:free',
  'minimax/minimax-m2.5:free',
];
const FAMILY_TIERS = [
  /deepseek-(v3|chat)/,
  /llama-4-(maverick|scout)/,
  /glm-4/,
  /qwen-?3?-(235b|coder)/,
  /gpt-oss/,
  /llama-3\.3/,
  /mistral-small/,
  /nemotron|minimax|gemma-[34]/,
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
  const allIds = MODEL_CACHE.at && Date.now() - MODEL_CACHE.at < MODEL_LIST_TTL_MS
    ? MODEL_CACHE.ids
    : await listFreeModels();
  // Models cooling down (recently 429/404) are skipped while ANY alternative exists.
  const ids = allIds.filter((id) => !isModelOnCooldown(id));
  const pool = ids.length ? ids : allIds;
  for (const pref of PREFERRED_FREE_MODELS) {
    if (pool.includes(pref)) return pref;
  }
  for (const tier of FAMILY_TIERS) {
    const match = pool.filter((id) => tier.test(id)).sort()[0];
    if (match) return match;
  }
  return pool[0] || current; // unresolvable -> sentinel passes through and fails honestly (404)
}

/* Lenient live-check parser: the probe only verifies auth + that the model
   answers with SOMETHING — small free models may ignore response_format, and
   that must not fail an otherwise perfectly working connection. */
/* OpenRouter includes its OWN reason in non-200 bodies, e.g.:
   {"error":{"code":429,"message":"Rate limit exceeded: free-model-cap-per-day",
    "metadata":{"reason":"free-model-cap-per-day"}}}. Surfacing it verbatim is
   the only way the owner can tell a congested MODEL apart from her ACCOUNT's
   free-tier daily cap. Sanitized to a short single line. */
function providerSaysFromBody(rawBuffer) {
  try {
    const doc = JSON.parse(Buffer.isBuffer(rawBuffer) ? rawBuffer.toString('utf8') : String(rawBuffer || ''));
    const err = doc && doc.error;
    if (!err) return null;
    const cand = String((err.metadata && err.metadata.reason) || err.message || '').trim();
    if (!cand) return null;
    const clean = cand.replace(/[<>\x00-\x1f\x7f`"'\\]/g, '').slice(0, 160).trim();
    return clean || null;
  } catch {
    return null;
  }
}

/* Account-wide free-tier limits produce the SAME code on every model — they
   deserve their own honest identity instead of a generic busy message. */
function classifyRateReason(reason) {
  const low = String(reason || '').toLowerCase();
  if (low.includes('free-model-cap') || low.includes('cap-per-day') || (low.includes('daily') && low.includes('free'))) {
    return 'provider_free_daily_cap';
  }
  return null;
}

function parseProbeResponse(status, rawBuffer, secret) {
  const errorMap = {
    401: 'provider_auth_failed',
    402: 'provider_credit_or_quota_required',
    403: 'provider_access_denied',
    404: 'free_model_unavailable',
    429: 'provider_rate_limited_no_automatic_retry',
  };
  if (status !== 200) {
    const says = providerSaysFromBody(rawBuffer);
    const code = (says && classifyRateReason(says)) || errorMap[status] || 'provider_request_failed_no_automatic_retry';
    const err = new ProviderError(code);
    if (says) err.provider_says = says;
    throw err;
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
  setModelCooldown,
  isModelOnCooldown,
  clearModelCooldowns,
  generateSyntheticTest,
  createLiveTransport,
  generateMarketingDraft,
  buildFahmyBody,
  generateFahmyIdea,
  testConnection,
};
