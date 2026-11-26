'use strict';
/* Alibaba Cloud Model Studio (DashScope international, OpenAI-compatible mode)
   as a SECOND office AI provider behind OpenRouter.

   Contract (same honesty rules as the OpenRouter client):
   - Owner-only settings keys (office_ds_*): the key never leaves the server.
   - validate() throws BEFORE any network call when disabled/staging/bad key/model.
   - Explicit Qwen model ids only (the free trial is PER MODEL) — no sentinel.
   - Local token guard: a settings counter (office_ds_tokens_used) increments by
     the reported usage and hard-stops BEFORE the request when the configured
     cap (default 900k, under the ~1M/model trial) is reached — the owner can
     never drift into the paid tier by accident, and with no card on file there
     is nothing to bill anyway: the provider just stops.
   - Prompt content is the same public-catalogue-only builder as OpenRouter
     (buildBody) with the OpenRouter-only routing block omitted.
*/
const { get: dbGet, run: dbRun, setting } = require('./db');
const isStagingMode = () => process.env.MAVI_STAGING_MODE === '1' || (typeof process.env.MAVI_STAGING === 'string' && process.env.MAVI_STAGING === '1');

const HOST_INTL = 'dashscope-intl.aliyuncs.com';
const HOST_CN = 'dashscope.aliyuncs.com';
const PATH = '/compatible-mode/v1/chat/completions';

// ONE shared error class with the OpenRouter client — the engine's catch
// blocks check `err instanceof ProviderError` to preserve honest codes.
const { ProviderError } = require('./openrouter-client');

const MODEL_RE = /^qwen[a-z0-9._-]{0,40}$/;
const KEY_RE = /^sk-[A-Za-z0-9_.-]{8,200}$/; // 2026 sk-ws- keys contain DOTS; the live test is the judge, not a format guess

function createConfig(env = process.env) {
  const staging = env.MAVI_STAGING_MODE === '1' || isStagingMode();
  const settingsKey = String(setting('office_ds_api_key') || '');
  const settingsModel = String(setting('office_ds_model') || '').trim();
  const settingsEnabled = setting('office_ds_enabled') === '1';
  const region = String(setting('office_ds_region') || 'intl') === 'cn' ? 'cn' : 'intl';
  // The CSV export hands a WORKSPACE-SPECIFIC endpoint (ws-*.maas.aliyuncs.com).
  // When present it wins; otherwise the legacy regional hosts remain the default.
  let host = region === 'cn' ? HOST_CN : HOST_INTL;
  let path = PATH;
  const apiBaseRaw = String(setting('office_ds_api_base') || '').trim();
  if (apiBaseRaw) {
    try {
      const u = new URL(apiBaseRaw);
      if (u.host.endsWith('.aliyuncs.com') || u.host.endsWith('.qwencloudapi.com')) {
        host = u.host;
        path = u.pathname.replace(/\/+$/, '') + '/chat/completions';
      }
    } catch (_) { /* legacy hosts stay */ }
  }
  const model = settingsModel || 'qwen-plus';
  const tokenCap = Number(setting('office_ds_token_cap')) || 900000;

  let lastTest = null;
  try { lastTest = JSON.parse(setting('office_ds_last_test') || 'null'); } catch { lastTest = null; }

  function tokensUsed() {
    const n = Number(setting('office_ds_tokens_used')) || 0;
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  }

  function validate() {
    if (staging) throw new ProviderError('openrouter_disabled_in_staging');
    if (!settingsEnabled) throw new ProviderError('openrouter_disabled');
    if (!KEY_RE.test(settingsKey)) throw new ProviderError('missing_or_invalid_server_key');
    if (!MODEL_RE.test(model)) throw new ProviderError('only_qwen_model_ids_are_allowed');
  }

  function summary() {
    let status = 'ready';
    try { validate(); } catch (err) { status = err.code || 'openrouter_disabled'; }
    const used = tokensUsed();
    return {
      status,
      enabled: settingsEnabled && !staging,
      source: settingsKey ? 'settings' : 'none',
      region,
      key_present: settingsKey.length > 0,
      key_tail: settingsKey ? settingsKey.slice(-4) : '',
      key_length: settingsKey.length,
      api_host: host,
      model,
      tokens_used: used,
      token_cap: tokenCap,
      tokens_remaining: Math.max(tokenCap - used, 0),
      last_test: lastTest && typeof lastTest === 'object' ? lastTest : null,
    };
  }

  function getModel() { return model; }
  function useKey(fn) { return fn(settingsKey); }

  return Object.freeze({ validate, summary, getModel, useKey, host, path, region, providerName: 'alibaba', omitProviderRouting: true });
}

function recordTokensUsed(totalTokens) {
  const n = Number.isInteger(totalTokens) && totalTokens >= 0 && totalTokens <= 100000000 ? totalTokens : 0;
  if (!n) return;
  try {
    dbRun("INSERT INTO settings(key,value) VALUES('office_ds_tokens_used',?) ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT)",
      String(n), String(n));
  } catch { /* counter is best-effort; the pre-request guard still applies */ }
}

function guardBeforeRequest() {
  const cfg = createConfig();
  if (cfg.summary().tokens_remaining <= 0) {
    throw new ProviderError('alibaba_quota_guard_reached');
  }
}

/* Live connection probe on the configured endpoint (owner-pressed): the same
   lenient contract as the OpenRouter probe — auth + any answer is enough. */
async function testConnection(config, options = {}) {
  const started = Date.now();
  try {
    config.validate();
  } catch (err) {
    return { ok: false, error_code: err.code || 'openrouter_disabled', latency_ms: 0, model: config.getModel() };
  }
  const transport = typeof options.transport === 'function'
    ? options.transport
    : require('./openrouter-client').createLiveTransport({ timeoutMs: 20000 });
  const body = {
    model: config.getModel(),
    messages: [{ role: 'user', content: 'أعد هذا الـ JSON فقط بدون أي كلام إضافي: {"title":"جاهز","text":"اختبار اتصال","review_checklist":["تم"]}' }],
    stream: false,
    max_tokens: 120,
    temperature: 0,
    response_format: { type: 'json_object' },
  };
  try {
    const result = await config.useKey(async (secret) => {
      const { status, raw } = await transport(body, secret, { host: config.host, path: config.path });
      if (status === 401 || status === 403) throw new ProviderError('provider_auth_failed');
      if (status !== 200) throw new ProviderError('provider_request_failed_no_automatic_retry');
      return true;
    });
    void result;
  } catch (err) {
    return {
      ok: false,
      error_code: err instanceof ProviderError ? err.code : 'provider_connection_failed_no_automatic_retry',
      latency_ms: Date.now() - started,
      model: config.getModel(),
    };
  }
  const out = { ok: true, error_code: null, model: config.getModel(), latency_ms: Date.now() - started };
  try {
    dbRun("INSERT INTO settings(key,value) VALUES('office_ds_last_test',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      JSON.stringify({ ...out, at: new Date().toISOString() }));
  } catch { /* persistence is best-effort */ }
  return out;
}

module.exports = {
  HOST_INTL,
  HOST_CN,
  PATH,
  ProviderError,
  MODEL_RE,
  createConfig,
  recordTokensUsed,
  guardBeforeRequest,
  testConnection,
  HOST_INTL,
  HOST_CN,
  PATH,
  ProviderError,
  MODEL_RE,
  createConfig,
  recordTokensUsed,
  guardBeforeRequest,
};
