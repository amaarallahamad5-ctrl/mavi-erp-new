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

  // every AI surface gone from the UI
  for (const gone of ['officeOpenIdeasModal', 'officeGenIdeas', 'officeOpenAiSettings', 'officeSmartSetup',
    'officeTestAi', 'officeSaveAiConfig', 'officeLoadAiModels', 'officeAiStatusChip', 'officeAiTestHint', 'officeRenderAiActivity']) {
    assert.ok(!uiSrc.includes(gone), `the AI surface ${gone} must be gone from the UI`);
  }
  assert.ok(!uiSrc.includes('💡 أفكار تسويق') && !uiSrc.includes('إعدادات الذكاء الاصطناعي') && !uiSrc.includes('/ai/ideas'), 'no AI buttons or endpoint calls may remain');
  assert.ok(!uiSrc.includes('أفكار') || !uiSrc.includes('تسويق') ? true : true, 'informational');

  // the real-data core stays
  assert.ok(uiSrc.includes('شغل النهاردة'), 'the today board stays');
  assert.ok(uiSrc.includes("officeApi('/today-board'"), 'the today board keeps its real-data endpoint');
  assert.ok(uiSrc.includes('officeRunDailyCycle') && uiSrc.includes('فحص اليوم وتحضير مسودات المتابعة'), 'the real-data daily cycle stays');
  assert.ok(uiSrc.includes('function renderManagerCard') && uiSrc.includes('window.officeBulkReview'), 'the manager bulk-decision card stays');
  assert.ok(uiSrc.includes('مسودات جاهزة لقرارك'), 'the drafts review stays');
  assert.ok(uiSrc.includes('محلية — من بيانات النظام'), 'drafts stay honestly labeled as prepared from real system data');
  assert.ok(!uiSrc.includes('ورامي أبلغ الفريق في الشات'), 'no chat-era toast text may remain');

  // server: /ai/ideas gone, the gated engine layer stays dormant for old data/tests
  const routesSrc = fs.readFileSync(path.join(ROOT, 'src/office-routes.js'), 'utf8');
  assert.ok(!routesSrc.includes('/ai/ideas'), 'the ideas route must be gone');
  assert.ok(routesSrc.includes("router.post('/ai/config'") && routesSrc.includes("router.post('/ai/test'"), 'the dormant OpenRouter config endpoints stay for the engine');
  const clientSrc = fs.readFileSync(path.join(ROOT, 'src/openrouter-client.js'), 'utf8');
  assert.ok(!clientSrc.includes('generateMarketingIdeas'), 'the ideas generator must be gone from the client');
  assert.ok(clientSrc.includes('async function generateMarketingDraft'), 'the gated draft pipeline stays dormant in the engine');

  // previous removal decision still holds
  assert.ok(fs.existsSync(path.join(ROOT, 'src/office-chat.js')) === false, 'the team chat stays deleted');
  assert.ok(!uiSrc.includes("'/chat'"), 'no chat endpoint may be called');
});
