'use strict';
/* وكيل مجاني (free agent) — keyless AI fallback for Fahmy's daily research.
   Owner request (26.11): «لو انت قدرت تجيب وكيل مجاني تبقي شاطر» — fahmy's
   AI-first chain is: (1) the gated OpenRouter config (env or owner-saved key),
   (2) THIS keyless free agent, (3) the honest local real-data builder.
   Hard guarantees (same posture as the rest of the office):
   - receives the ULTRA-sanitized brief only: counts, stages, dates, public
     style names — NO order codes, NO customer names, NO phones, NO
     measurements, NO money (the brief builder enforces this and tests lock it)
   - disabled in staging mode and by MAVI_FREE_AGENT_ENABLED=0
   - one-shot call, no retries; any failure -> the caller falls back honestly
   - response is strictly parsed/validated before it ever reaches the owner */

const { isStagingMode, recordOutboundTelemetry } = require('./staging-guard');

const FREE_AGENT_HOST = 'text.pollinations.ai';
const FREE_AGENT_PATH = '/openai';
const FREE_AGENT_MODEL = 'openai';
const MAX_BYTES = 65536;

function freeAgentEnabled() {
  if (isStagingMode()) return false;
  if (process.env.MAVI_FREE_AGENT_ENABLED === '0') return false;
  return true;
}

/* Minimal OpenAI-compatible POST transport (no auth header at all). */
function createFreeAgentTransport({ timeoutMs = 22000 } = {}) {
  return async function freeTransport(body) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const res = await fetch(`https://${FREE_AGENT_HOST}${FREE_AGENT_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        ...(controller ? { signal: controller.signal } : {}),
      });
      const text = await res.text();
      if (text.length > MAX_BYTES + 1) throw new Error('free_agent_response_too_large');
      return { status: res.status, raw: Buffer.from(text, 'utf8') };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

function extractJsonObject(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  const end = s.lastIndexOf('}');
  if (end <= start) return null;
  return s.slice(start, end + 1);
}

function buildFahmyFreeBody(brief) {
  if (!brief || typeof brief !== 'object' || Array.isArray(brief)) {
    throw new Error('invalid_fahmy_brief');
  }
  const systemPrompt =
    'أنت فهمي، مسئول التسويق المحترف في براند MAVI لتفصيل الفساتين على المقاس، وبتجهز للمالكة فكرة واحدة كل يوم ' +
    'بعد بحث عميق في بيانات النظام المعطاة (أرقام حقيقية لحظة الفحص). ' +
    'قواعد إلزامية: استخدم فقط الأرقام والحقائق الموجودة في البيانات المعطاة — ممنوع تمامًا اختراع أي رقم أو حالة؛ ' +
    'ممنوع ذكر أي اسم عميلة أو رقم هاتف أو سعر أو تكلفة؛ ' +
    'عربي بسيط مفهوم بصوت فهمي مباشر للمالكة، بدون مصطلحات تقنية وبدون ذكر أي مزود خدمة أو ذكاء اصطناعي؛ ' +
    'الفكرة لازم تكون قوية وعملية: تشرح الموقف بالأرقام، توضّح ليه دي أولوية، وتدي خطة عمل واضحة قابلة للتنفيذ النهاردة؛ ' +
    'التفاصيل الكاملة مطلوبة — من ٧٠٠ إلى ١٦٠٠ حرف بسطور قصيرة منظمة؛ ' +
    'ممنوع أي إرسال تلقائي أو وعد بالتواصل مع العميلات نيابة عن المالكة. ' +
    'أعد JSON فقط بمفاتيح: title (عنوان قوي محدد حتى ١٤٠ حرف)، body (التفاصيل الكاملة)، steps (مصفوفة من ٣ إلى ٦ خطوات عملية قصيرة).';
  return {
    model: FREE_AGENT_MODEL,
    referrer: 'mavi-erp',
    private: true,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'fahmy_daily_idea',
          data: brief,
          note: 'كل الأرقام في data حقيقية من قاعدة بيانات النظام لحظة الفحص — التحليل مبني عليها فقط',
        }),
      },
    ],
    stream: false,
    max_tokens: 1500,
    temperature: 0.35,
  };
}

function parseFahmyFreeResponse(status, rawBuffer) {
  if (status !== 200) throw new Error('free_agent_http_' + status);
  const buf = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(String(rawBuffer || ''), 'utf8');
  if (buf.length === 0 || buf.length > MAX_BYTES) throw new Error('invalid_free_agent_response');
  let doc;
  try { doc = JSON.parse(buf.toString('utf8')); } catch { throw new Error('invalid_free_agent_response'); }
  const choice = doc && Array.isArray(doc.choices) && doc.choices[0];
  const content = choice && choice.message && typeof choice.message.content === 'string'
    ? choice.message.content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
    : '';
  if (!content) throw new Error('invalid_free_agent_response');
  let idea;
  try {
    idea = JSON.parse(content);
  } catch (_) {
    const extracted = extractJsonObject(content);
    if (!extracted) throw new Error('invalid_free_agent_response');
    try { idea = JSON.parse(extracted); } catch (_) { throw new Error('invalid_free_agent_response'); }
  }
  if (!idea || typeof idea !== 'object' || Array.isArray(idea)) throw new Error('invalid_free_agent_response');
  const title = typeof idea.title === 'string' ? idea.title.trim() : '';
  const bodyText = typeof idea.body === 'string' ? idea.body.trim() : '';
  if (title.length < 8 || title.length > 160) throw new Error('invalid_free_agent_response');
  if (bodyText.length < 150 || bodyText.length > 2200) throw new Error('invalid_free_agent_response');
  let steps = [];
  if (idea.steps !== undefined && idea.steps !== null) {
    if (!Array.isArray(idea.steps) || idea.steps.length > 8) throw new Error('invalid_free_agent_response');
    steps = idea.steps
      .filter(x => typeof x === 'string' && x.trim().length >= 3 && x.trim().length <= 220)
      .map(x => x.trim());
  }
  return { title, body: bodyText, steps, model_reported: 'pollinations:openai' };
}

/* Gated keyless generation: explicit brief (+ injectable transport for tests).
   Throws on any failure — the caller owns the honest fallback chain. */
async function generateFahmyIdeaFree(brief, options = {}) {
  if (!freeAgentEnabled()) throw new Error('free_agent_disabled');
  const transport = typeof options.transport === 'function'
    ? options.transport
    : createFreeAgentTransport({ timeoutMs: options.timeoutMs || 22000 });
  const body = buildFahmyFreeBody(brief);
  let parsed;
  try {
    const { status, raw } = await transport(body);
    parsed = parseFahmyFreeResponse(status, raw);
  } finally {
    if (typeof options.transport !== 'function') {
      try { recordOutboundTelemetry('free_agent_fahmy', 'network_attempt'); } catch (_) { /* best-effort */ }
    }
  }
  return { ...parsed, mode: 'free_agent', ai_generated: true };
}

module.exports = {
  FREE_AGENT_HOST,
  FREE_AGENT_MODEL,
  freeAgentEnabled,
  createFreeAgentTransport,
  buildFahmyFreeBody,
  parseFahmyFreeResponse,
  generateFahmyIdeaFree,
};
