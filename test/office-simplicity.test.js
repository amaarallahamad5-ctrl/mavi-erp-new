'use strict';
/* THE SIMPLE SHAPE (owner decision): «خلي الموقع بسيط — مش محتاج موظفين كتير
   بس محتاج بيانات دقيقة وصح».
   Locked here:
   - the office has exactly TWO tabs (اليوم / المسودات) — the roles tab
     (أدوار الفريق) and the live-floor tab (صالة المكتب الحي) are GONE
   - every AI surface is GONE from the UI (ideas button/modal, AI settings,
     smart setup, connection test, model lister) and POST /ai/ideas is gone
   - what remains is the accurate-data core: the TODAY board (real orders,
     deposits, ready replies), the daily cycle button (real-data follow-up
     drafts), the drafts review screen with the manager bulk-decision card,
     and the honest local-prepared pill
   - the team chat removal (previous owner decision) stays locked */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test } = require('node:test');

const ROOT = path.join(__dirname, '..');

test('The simple shape: two office tabs, zero AI surfaces, the real-data core intact', () => {
  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/admin/office.js'), 'utf8');

  // two tabs only
  assert.ok(uiSrc.includes("const order = ['summary', 'drafts'];"), 'the tab order must be exactly اليوم -> المسودات');
  assert.ok(uiSrc.includes('id="of-tab-summary"') && uiSrc.includes('id="of-tab-drafts"'), 'both tabs must render buttons');
  assert.ok(!uiSrc.includes('of-tab-team') && !uiSrc.includes('of-tab-hq') && !uiSrc.includes('of-tab-chat'), 'no third tab may exist');

  // the roles tab and the live floor are gone
  assert.ok(!uiSrc.includes('renderTeamTab') && !uiSrc.includes('renderHqTab') && !uiSrc.includes('buildHqTicker'), 'the roles/live-floor renderers must be gone');
  assert.ok(!uiSrc.includes('أدوار الفريق') && !uiSrc.includes('صالة المكتب الحي'), 'no roles / live-floor texts may remain');

  // the retired AI surfaces stay gone (owner removed them, then re-commissioned
  // marketing intelligence as ONE named notification persona: فهمي بتاع التسويق)
  for (const gone of ['officeOpenIdeasModal', 'officeGenIdeas', 'officeOpenAiSettings', 'officeSmartSetup',
    'officeTestAi', 'officeSaveAiConfig', 'officeLoadAiModels', 'officeAiStatusChip', 'officeAiTestHint', 'officeRenderAiActivity']) {
    assert.ok(!uiSrc.includes(gone), `the AI surface ${gone} must be gone from the UI`);
  }
  assert.ok(!uiSrc.includes('💡 أفكار تسويق') && !uiSrc.includes('إعدادات الذكاء الاصطناعي') && !uiSrc.includes('/ai/ideas'), 'no AI buttons or endpoint calls may remain');

  // فهمي بتاع التسويق: one notification button, one idea per day, real data only
  assert.ok(uiSrc.includes('id="of-fahmy-btn"') && uiSrc.includes('فهمي — بتاع التسويق'), 'the فهمي notification button must exist');
  assert.ok(uiSrc.includes('officeOpenFahmyModal') && uiSrc.includes("officeApi('/fahmy/today'"), 'the فهمي modal must load the daily idea');
  assert.ok(uiSrc.includes("officeApi('/fahmy/read'"), 'reading the idea must be recorded');
  assert.ok(!uiSrc.includes('OpenRouter') && !uiSrc.includes('openrouter'), 'فهمي stays provider-free in the UI');

  // the real-data core stays
  assert.ok(uiSrc.includes('شغل النهاردة'), 'the today board stays');
  assert.ok(uiSrc.includes("officeApi('/today-board'"), 'the today board keeps its real-data endpoint');
  assert.ok(uiSrc.includes('officeRunDailyCycle') && uiSrc.includes('فحص اليوم وتحضير مسودات المتابعة'), 'the real-data daily cycle stays');
  assert.ok(uiSrc.includes('function renderManagerCard') && uiSrc.includes('window.officeBulkReview'), 'the manager bulk-decision card stays');
  assert.ok(uiSrc.includes('مسودات جاهزة لقرارك'), 'the drafts review stays');
  assert.ok(uiSrc.includes('محلية — من بيانات النظام'), 'drafts stay honestly labeled as prepared from real system data');
  assert.ok(!uiSrc.includes('ورامي أبلغ الفريق في الشات'), 'no chat-era toast text may remain');

  // owner decision 26.11: draft cards carry apply-able suggestions with a
  // dedicated apply button next to (not instead of) the approval button
  assert.ok(uiSrc.includes('officeApplySuggestion') && uiSrc.includes('apply-suggestion'), 'the apply path must exist in the UI');
  assert.ok(uiSrc.includes('اقتراحات جاهزة تتعمل من الكارت'), 'the suggestions block must render on the decision card');
  assert.ok(uiSrc.includes('officeRestoreSuggestion'), 'every value edit must be undoable from the card');

  // server: /ai/ideas gone, the gated engine layer stays dormant for old data/tests
  const routesSrc = fs.readFileSync(path.join(ROOT, 'src/office-routes.js'), 'utf8');
  assert.ok(!routesSrc.includes('/ai/ideas'), 'the ideas route must be gone');
  assert.ok(routesSrc.includes("router.get('/fahmy/today'") && routesSrc.includes("router.post('/fahmy/read'"), 'the فهمي endpoints must exist (owner-only)');
  assert.ok(routesSrc.includes("router.post('/jobs/:id/apply-suggestion'") && routesSrc.includes("router.post('/jobs/:id/restore-suggestion'"), 'the apply/restore endpoints must exist');
  assert.ok(routesSrc.includes("router.post('/ai/config'") && routesSrc.includes("router.post('/ai/test'"), 'the dormant OpenRouter config endpoints stay for the engine');
  const clientSrc = fs.readFileSync(path.join(ROOT, 'src/openrouter-client.js'), 'utf8');
  assert.ok(!clientSrc.includes('generateMarketingIdeas'), 'the ideas generator must be gone from the client');
  assert.ok(clientSrc.includes('async function generateMarketingDraft'), 'the gated draft pipeline stays dormant in the engine');

  // previous removal decision still holds
  assert.ok(fs.existsSync(path.join(ROOT, 'src/office-chat.js')) === false, 'the team chat stays deleted');
  assert.ok(!uiSrc.includes("'/chat'"), 'no chat endpoint may be called');
});
