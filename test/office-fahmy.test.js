'use strict';
/* فهمي بتاع التسويق — the daily marketing idea (owner decision 26.11):
   - one idea per Cairo day, idempotent (same idea on repeated calls)
   - built ONLY from real system data: real order codes, real customer names,
     real style names, real counts — never invented content
   - plain understandable Arabic body with facts + ordered steps
   - owner-only endpoints (staff gets 403)
   - reading the idea flips is_new (the bell dot clears) */
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

test('Fahmy daily idea: one per day, real data only, owner-only, read tracking', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/office-fahmy.js'), 'utf8');
  assert.ok(src.includes('CREATE TABLE IF NOT EXISTS fahmy_ideas'), 'the ideas table must exist');
  assert.ok(src.includes("require('./business-date')") && src.includes('cairoDate('), 'the day key must come from the Cairo business-date helper');
  assert.ok(src.includes('INSERT OR IGNORE'), 'generation must be idempotent per day');
  assert.ok(src.includes('buildIdeaForDay') && src.includes('collectBrief'), 'the real-data brief must drive the topic');
  // AI-first engine (owner decision 26.11): fahmy goes through the GATED provider
  // client only — never a raw key, never a hardcoded model, honest local fallback
  assert.ok(src.includes("require('./openrouter-client')"), 'the provider client must be the gated one');
  assert.ok(!/OPENROUTER_API_KEY\s*=|sk-[A-Za-z0-9]{10,}/.test(src), 'no hardcoded keys in fahmy');

  const routesSrc = fs.readFileSync(path.join(ROOT, 'src/office-routes.js'), 'utf8');
  assert.ok(routesSrc.includes("router.get('/fahmy/today', A.requireOwner"), 'the today endpoint must be owner-only');
  assert.ok(routesSrc.includes("router.post('/fahmy/read', A.requireOwner"), 'the read endpoint must be owner-only');

  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');
  assert.ok(uiSrc.includes('id="of-fahmy-btn"'), 'the notification button must render in the owner toolbar');
  assert.ok(uiSrc.includes('أفكار الأيام اللي فاتت'), 'previous ideas stay readable');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-fahmy-'));
  const dbPath = path.join(tmpDir, 'fahmy.db');
  const seeded = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
  });
  assert.strictEqual(seeded.status, 0, seeded.stderr);

  const PORT = 3092;
  const BASE = `http://127.0.0.1:${PORT}`;
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
    const api = (method, p, token) => fetch(`${BASE}/api/admin/office${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Mavi-Token': token } : {}) },
    });

    // staff never gets the marketing brain
    const staffRes = await api('GET', '/fahmy/today', staffT);
    assert.strictEqual(staffRes.status, 403, 'staff must never read فهمي ideas');
    const staffRead = await api('POST', '/fahmy/read', staffT);
    assert.strictEqual(staffRead.status, 403, 'staff must never mark ideas read');

    // first owner call creates today's idea
    const r1 = await api('GET', '/fahmy/today', ownerT);
    assert.strictEqual(r1.status, 200);
    const b1 = await r1.json();
    assert.strictEqual(b1.ok, true);
    const idea = b1.idea;
    assert.ok(idea && idea.id && idea.day, 'an idea with id+day must be returned');
    assert.ok(idea.title_ar && idea.title_ar.length > 10, 'the idea carries an Arabic title');
    assert.ok(idea.body_ar && idea.body_ar.length > 120, 'the idea carries FULL details, not a stub');
    assert.ok(Array.isArray(idea.facts) && idea.facts.length >= 1, 'real numbers are shown as facts');
    assert.ok(Array.isArray(idea.steps) && idea.steps.length >= 2, 'ordered steps are included');
    assert.strictEqual(b1.unread, 1, 'a fresh idea starts unread');
    assert.ok(previousShape(b1.previous), 'previous ideas list is returned');

    // idempotent: same idea on the second call of the same day
    const r2 = await api('GET', '/fahmy/today', ownerT);
    const b2 = await r2.json();
    assert.strictEqual(b2.idea.id, idea.id, 'the same day must return the same idea (no duplicates)');

    // idea content must reference real system data (seed has styles + orders)
    const allText = `${idea.title_ar} ${idea.body_ar} ${idea.facts.map(f => `${f.label} ${f.value}`).join(' ')}`;
    assert.ok(/[A-Z]{2}-\d{4}-\d{1,3}|MV-\d{6}-\d{1,3}|SK-|CR-\d/.test(allText) || /\d/.test(allText),
      'the idea must carry real codes or counts, got: ' + allText.slice(0, 200));
    assert.ok(!/(GPT|OpenRouter|API key|نموذج لغوي)/i.test(allText), 'no provider-speak in the idea');

    // mark read -> unread clears
    const rr = await api('POST', '/fahmy/read', ownerT);
    assert.strictEqual(rr.status, 200);
    const rb = await rr.json();
    assert.strictEqual(rb.ok, true);
    assert.strictEqual(rb.idea.is_new, false, 'reading flips is_new');
    const r3 = await api('GET', '/fahmy/today', ownerT);
    const b3 = await r3.json();
    assert.strictEqual(b3.unread, 0, 'the badge dot must clear after reading');
  } finally {
    child.kill('SIGKILL');
  }

  console.log('FAHMY-OK');
});

function previousShape(list) {
  return Array.isArray(list) && list.every(i => i && typeof i.title_ar === 'string');
}

/* AI-first engine (owner decision 26.11): Fahmy's PRIMARY engine is the AI
   provider doing research over the sanitized real-data brief; any failure
   falls back to the honest local idea; a local idea upgrades later the same
   day when the provider works; customer names never reach the transport. */
test('Fahmy AI-first: researched idea via provider, sanitized brief, honest local fallback + same-day upgrade', async () => {
  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');
  assert.ok(uiSrc.includes('بحث بالذكاء الاصطناعي'), 'the researched-idea provenance pill must exist in the modal');
  const clientSrc = fs.readFileSync(path.join(ROOT, 'src/openrouter-client.js'), 'utf8');
  assert.ok(clientSrc.includes('function generateFahmyIdea') && clientSrc.includes('buildFahmyBody'), 'the gated Fahmy engine must exist in the provider client');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mavi-fahmy-ai-'));
  const dbPath = path.join(tmpDir, 'fahmy-ai.db');
  const seeded = spawnSync(process.execPath, ['src/seed.js'], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, DB_PATH: dbPath, AUTO_SEED: '0' },
  });
  assert.strictEqual(seeded.status, 0, seeded.stderr);

  const script = `process.env.DB_PATH = ${JSON.stringify(dbPath)};
process.env.MAVI_OFFICE_AI_NO_MODEL_DISCOVERY = '1';
const assert = require('assert');
const { run, get } = require(${JSON.stringify(path.join(ROOT, 'src/db'))});
require(${JSON.stringify(path.join(ROOT, 'src/office-engine'))});
const F = require(${JSON.stringify(path.join(ROOT, 'src/office-fahmy'))});

// real data: a named customer with a 3-day-late order (proves sanitization)
run("INSERT OR IGNORE INTO customers(phone,name,area) VALUES('01099988877','سعاد عميلة','المهندسين')");
const cid = get("SELECT id FROM customers WHERE phone = ?", '01099988877').id;
run("INSERT INTO orders(code,customer_id,channel,status,promise_date,created_at,updated_at) VALUES('MV-2601-001'," + cid + ",'whatsapp','sewing','2026-01-01','2026-01-02','2026-01-02')");

// enable the gated provider through the owner settings (same path the office uses)
run("INSERT OR REPLACE INTO settings(key,value) VALUES('office_ai_enabled','1')");
run("INSERT OR REPLACE INTO settings(key,value) VALUES('office_ai_api_key','sktest1234567890abc')");
run("INSERT OR REPLACE INTO settings(key,value) VALUES('office_ai_model','openrouter/free')");

let lastBody = null;
let calls = 0;
let freeLastBody = null;
const goodStub = (body, secret, meta) => {
  calls += 1;
  lastBody = body;
  assert.ok(String(meta && meta.host).includes('openrouter'), 'the transport must be pointed at the configured provider host');
  const content = JSON.stringify({
    title: 'فكرة النهاردة بعد البحث: أقفل المتأخرات الأول',
    body: 'بعد بحث في أرقام النظام النهاردة لقيت إن أسرع مكسب هو إقفال المتأخرات. ' +
      'البيانات بتقول إن في طلبات موعدها عدّى ولسه في التشغيل، وكل يوم تأخير بيأثر على التقييم. ' +
      'الخطة: اتصلي بالترتيب على الطلبات المتأخرة، اتفقي على ميعاد جديد، وسجليه على الطلب. ' +
      'بعدها شوفلي الطلبات اللي ناقصها مقاسات عشان القص ميوقفش. ' +
      'ولو ضيق الوقت، ابدأي بالأقدم فحسب وكمل الباقي بكرة بنفس الطريقة بدون ما تحسبي أي حاجة في دماغك.',
    steps: ['اتصلي على أول طلب متأخر واتفقي على ميعاد جديد', 'سجلي الميعاد على الطلب', 'شوفي الطلبات الناقصة المقاسات وكلمي العميلات'],
  });
  return Promise.resolve({ status: 200, raw: Buffer.from(JSON.stringify({
    model: 'deepseek/deepseek-v3.2:free',
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 500, completion_tokens: 400, total_tokens: 900 },
  })) });
};
const garbageStub = () => Promise.resolve({ status: 200, raw: Buffer.from(JSON.stringify({
  model: 'deepseek/deepseek-v3.2:free',
  choices: [{ message: { content: 'أنا موديل ومش عارف أرد بصيغة JSON' }, finish_reason: 'stop' }],
})) });

(async () => {
  // 1) fresh day + broken provider reply -> honest LOCAL idea (nothing faked)
  const local = await F.ensureTodayIdea({ transport: garbageStub });
  assert.strictEqual(local.source, 'real-data', 'a broken provider reply must fall back to the honest local idea');
  assert.ok(local.title_ar && local.body_ar, 'the local fallback is complete');

  // 2) same day, provider now works -> the local idea UPGRADES to the researched one
  F._testResetAiThrottle();
  const ai = await F.ensureTodayIdea({ transport: goodStub });
  assert.strictEqual(ai.source, 'ai', 'the researched idea must replace the fallback the same day');
  assert.strictEqual(ai.is_new, true, 'the upgrade re-flags the notification as new');
  assert.ok(ai.ai_model.includes('deepseek'), 'the model attribution is stored');
  assert.ok(Array.isArray(ai.steps) && ai.steps.length === 3, 'ordered steps come from the research');
  assert.ok(Array.isArray(ai.facts) && ai.facts.length >= 1, 'real system numbers ride along as facts');
  assert.strictEqual(ai.body_ar.includes('سعاد'), false, 'the AI body must not carry customer names');
  assert.strictEqual(calls >= 1, true);
  const userPayload = JSON.stringify(lastBody.messages[1].content) + JSON.stringify(lastBody.messages[0].content);
  assert.strictEqual(userPayload.includes('MV-2601-001'), false, 'order codes NEVER leave the ERP to any provider');
  assert.strictEqual(userPayload.includes('سعاد'), false, 'customer names never leave the ERP');
  assert.strictEqual(userPayload.includes('01099988877'), false, 'phones never leave the ERP');
  assert.ok(lastBody.model === 'openrouter/free' || /:free$/.test(lastBody.model), 'free models only');

  // 3) free-agent chain: fresh day + gated provider garbage -> keyless free agent wins
  F._testResetAiThrottle();
  run("INSERT OR REPLACE INTO settings(key,value) VALUES('office_ai_enabled','0')");
  run("DELETE FROM fahmy_ideas");
  const freeStub = (body) => {
  freeLastBody = body;
    const content = JSON.stringify({
      title: 'فكرة الوكيل المجاني بعد البحث في الأرقام',
      body: 'عملت بحث شامل في أرقام النظام النهاردة ولقيت إن في فرصة كبيرة جدًا لتحسين المتأخرات والتسليمات الجاهزة عندنا في البراند بشكل واضح ومميز اليوم بكل تفاصيلها العملية والعملية جدًا للتنفيذ الفوري_without_any_delay.',
      steps: ['خطوة أولى واضحة', 'خطوة تانية عملية', 'خطوة تالتة سريعة'],
    });
    return Promise.resolve({ status: 200, raw: Buffer.from(JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
    })) });
  };
  const upgraded = await F.ensureTodayIdea({ transport: garbageStub, freeTransport: freeStub });
  assert.strictEqual(upgraded.source, 'ai', 'the keyless free agent must rescue the day when the gated provider fails');
  assert.strictEqual(upgraded.ai_model, 'pollinations:openai', 'the free agent is attributed honestly');
  assert.ok(upgraded.body_ar.length > 150, 'free-agent ideas carry full details');

  // 4) free-agent payload privacy: no codes either
  assert.strictEqual(JSON.stringify(freeLastBody).includes('MV-2601-001'), false, 'no order codes to the free agent');
  assert.strictEqual(JSON.stringify(freeLastBody).includes('سعاد'), false, 'no customer names to the free agent');

  // 5) source==='ai' -> no more provider calls today (steady state is instant)
  const again = await F.ensureTodayIdea({ transport: () => Promise.reject(new Error('must not be called')), freeTransport: () => Promise.reject(new Error('must not be called')) });
  assert.strictEqual(again.source, 'ai');

  console.log('FAHMY-AI-OK');
  process.exit(0);
})().catch((err) => { console.error(err && err.stack || err); process.exit(1); });
`;
  const scriptPath = path.join(tmpDir, 'ai.js');
  fs.writeFileSync(scriptPath, script);
  const out = spawnSync(process.execPath, [scriptPath], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(out.status, 0, out.stdout + '\n' + out.stderr);
  assert.ok(out.stdout.includes('FAHMY-AI-OK'), out.stdout);
});
