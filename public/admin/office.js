/* MAVI Admin Office UI — «ملخص يومك», Owner Draft Approvals, and 17 Responsibility Templates.
   All RBAC, financial isolation, and stale-facts checks remain enforced on the server. */
(function () {
  'use strict';

  function defaultComposeState() {
    return {
      kind: 'order_followup_draft',
      order_code: '',
      request_id: '',
      focus: 'schedule',
      product_id: 'DEMO-PUBLIC-01',
      channel: 'instagram',
      daily_budget_egp: '100',
      holiday_budget_egp: '100',
      error: '',
    };
  }

  function defaultContextState() {
    return {
      mode: '', // 'order' | 'order_modal' | 'style' | 'custom' | 'ops' | 'desk'
      ref: '',
      title: '',
      phone: '',
      cases: [],
      jobs: [],
      allowedKinds: [],
      roleObj: null,
      targets: { orders: [], styles: [], custom_requests: [] },
      deskKind: '',
      deskOrderCode: '',
      deskFocus: 'schedule',
      deskStyleId: '',
      deskCustomId: '',
      deskChannel: 'instagram',
    };
  }

  const OFFICE_STATE = {
    tab: 'summary', // 'summary' | 'drafts' | 'team' | 'chat'
    chat: { loaded: false, messages: [], pending: 0 },
    roleFilter: '',
    deptFilter: 'all',
    jobStatusFilter: 'all',
    loading: false,
    error: '',
    loadedOnce: false,
    freshData: false,
    cases: [],
    jobs: [],
    roles: [],
    allowedKinds: [],
    teamNote: '',
    statusInfo: null,
    staleAlerts: {}, // jobId -> { code, message }
    editingJobId: '',
    editingText: '',
    compose: defaultComposeState(),
    ctx: defaultContextState(),
  };

  function findJobAny(jobId) {
    return OFFICE_STATE.jobs.find(j => j.id === jobId)
      || (OFFICE_STATE.ctx && Array.isArray(OFFICE_STATE.ctx.jobs) ? OFFICE_STATE.ctx.jobs.find(j => j.id === jobId) : null)
      || null;
  }

  const OFFICE_INFLIGHT = new Set();
  let OFFICE_SESSION_GEN = 0;

  function currentUserId() {
    return typeof USER !== 'undefined' && USER ? USER.id : null;
  }

  function isCurrentSession(gen, uid) {
    return gen === OFFICE_SESSION_GEN && currentUserId() !== null && currentUserId() === uid;
  }

  function resetOfficeState() {
    OFFICE_SESSION_GEN += 1;
    OFFICE_INFLIGHT.clear();
    OFFICE_STATE.tab = 'summary';
    OFFICE_STATE.roleFilter = '';
    OFFICE_STATE.deptFilter = 'all';
    OFFICE_STATE.jobStatusFilter = 'all';
    OFFICE_STATE.loading = false;
    OFFICE_STATE.error = '';
    OFFICE_STATE.loadedOnce = false;
    OFFICE_STATE.freshData = false;
    OFFICE_STATE.cases = [];
    OFFICE_STATE.jobs = [];
    OFFICE_STATE.roles = [];
    OFFICE_STATE.allowedKinds = [];
    OFFICE_STATE.teamNote = '';
    OFFICE_STATE.statusInfo = null;
    OFFICE_STATE.staleAlerts = {};
    OFFICE_STATE.editingJobId = '';
    OFFICE_STATE.editingText = '';
    OFFICE_STATE.compose = defaultComposeState();
    OFFICE_STATE.ctx = defaultContextState();
  }
  window.maviResetOfficeState = resetOfficeState;

  function esc(x) {
    return typeof safeCustom === 'function'
      ? safeCustom(x)
      : String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function handleSessionExpired() {
    resetOfficeState();
    try {
      const modal = document.getElementById('modal');
      if (modal) modal.classList.remove('of-wide');
      const ovl = document.getElementById('ovl');
      if (ovl) ovl.classList.remove('on');
    } catch (_) {}
    if (typeof logoutLocal === 'function') logoutLocal();
    if (typeof loginScreen === 'function') loginScreen();
    const errEl = document.getElementById('lerr');
    if (errEl) {
      errEl.textContent = 'انتهت الجلسة — سجّلي الدخول مرة أخرى للمتابعة.';
    }
  }
  window.maviHandleAdminSessionExpired = handleSessionExpired;

  async function officeApi(subPath, opts = {}, callerGen = OFFICE_SESSION_GEN, callerUid = currentUserId()) {
    const headers = { 'Content-Type': 'application/json' };
    if (typeof TOKEN !== 'undefined' && TOKEN) {
      headers.Authorization = 'Bearer ' + TOKEN;
      headers['X-Mavi-Token'] = TOKEN;
    }
    const res = await fetch('/api/admin/office' + subPath, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}

    if (!isCurrentSession(callerGen, callerUid)) {
      const staleErr = new Error('stale_session');
      staleErr.staleSession = true;
      throw staleErr;
    }

    if (res.status === 401) {
      handleSessionExpired();
      const authErr = new Error('session_expired');
      authErr.status = 401;
      throw authErr;
    }
    if (!res.ok) {
      const err = new Error((data && data.message) || 'تعذر تنفيذ العملية؛ حاولي مرة أخرى');
      err.status = res.status;
      err.code = data && data.error ? data.error : 'office_error';
      err.data = data;
      throw err;
    }
    return data;
  }

  function makeIdempotencyKey(prefix) {
    const rand = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    return `${prefix}-${rand}`;
  }

  const JOB_STATUS_LABELS = {
    queued: { label: 'في الطابور (لم تُولَّد بعد)', cls: 'test' },
    running: { label: 'قيد التحضير المحلي', cls: 'warn' },
    review: { label: 'بانتظار مراجعة المالكة', cls: 'warn' },
    approved: { label: 'مسودة معتمدة (محفوظة فقط)', cls: 'ok' },
    rejected: { label: 'مسودة مرفوضة', cls: 'urgent' },
    failed: { label: 'توقفت بعد حد المحاولات', cls: 'urgent' },
  };

  /* بطاقة الطلب الموحدة: تشتغل مع المسودات الجديدة والقديمة.
     تفكك النص لأجزاء (التفاصيل / القرار المهني / الإذن المطلوب)
     ولو المسودة قديمة بدون علامات، بتبني قرار واضح حسب النوع. */
  const KIND_OWNER_AR = {
    order_followup_draft: ['نور', 'منسقة الطلبات والمقاسات'],
    workshop_followup_draft: ['هنا', 'منسقة الورش والإنتاج'],
    quality_delivery_checklist: ['دينا', 'مسؤولة الجودة والتسليم'],
    customer_reply_draft: ['بسمة', 'مسؤولة خدمة العميلات'],
    deposit_followup_draft: ['عمر', 'المحاسب'],
    custom_design_followup_draft: ['نور', 'منسقة الطلبات والمقاسات'],
    style_page_copy_draft: ['ليلى', 'كاتبة المحتوى'],
    collection_copy_draft: ['ليلى', 'كاتبة المحتوى'],
    delivery_promise_draft: ['نور', 'منسقة الطلبات والمقاسات'],
    content_draft: ['ليلى', 'كاتبة المحتوى'],
    visual_reel_brief: ['مايا', 'مصممة المحتوى المرئي'],
    landing_page_check: ['كريم', 'مدير التسويق والنمو'],
    community_followup_draft: ['بسمة', 'مسؤولة خدمة العميلات'],
    seo_readiness_check: ['نادين', 'مسؤولة تحسين الظهور'],
    campaign_brief: ['كريم', 'مدير التسويق والنمو'],
    paid_ad_setup_draft: ['زياد', 'مسؤول الإعلانات المدفوعة'],
    daily_ops_triage: ['سلمى', 'مديرة التشغيل'],
    executive_weekly_plan: ['رامي', 'المدير العام'],
    security_privacy_audit: ['طارق', 'مسؤول الأمان والجودة'],
    erp_data_health_report: ['يوسف', 'مسؤول بيانات وربط ERP'],
    funnel_report: ['كريم', 'مدير التسويق والنمو'],
  };
  const KIND_DECISION_AR = {
    order_followup_draft: 'أوافقي على إرسال هذه المتابعة للعميلة يدويًا (واتساب/اتصال منك أنتِ).',
    workshop_followup_draft: 'أوافقي على استخدام هذا الكشف في متابعة الورش اليوم.',
    quality_delivery_checklist: 'أوافقي على اعتماد هذه القائمة لفحص القطع قبل التسليم.',
    customer_reply_draft: 'أوافقي على إرسال هذا الرد للعميلة يدويًا بعد تأكيد بياناتها.',
    deposit_followup_draft: 'أوافقي على متابعة العميلة بخصوص العربون المطلوب.',
    custom_design_followup_draft: 'أوافقي على مراجعة وتسعير طلب التصميم بالشروط المقترحة.',
    style_page_copy_draft: 'أوافقي على كتابة هذا الوصف على صفحة الموديل فورًا — التنفيذ حقيقي ويحدّث النص الظاهر والوصف التعريفي لمحركات البحث (SEO)، والاسترجاع متاح بعدها.',
    collection_copy_draft: 'أوافقي على كتابة هذا الوصف تحت المجموعة في المتجر فورًا (تنفيذ حقيقي — والاسترجاع متاح بعدها).',
    delivery_promise_draft: 'أوافقي على تسجيل موعد التسليم المقترح على الطلب فورًا (تنفيذ حقيقي — لا يمس السعر أو المقاسات).',
    content_draft: 'أوافقي على نشر هذا البوست على الحساب الرسمي (يدويًا منك).',
    visual_reel_brief: 'أوافقي على بدء تصوير الريل حسب هذه الخطة.',
    landing_page_check: 'أوافقي على تنفيذ التحسينات المقترحة على صفحة الموديل.',
    community_followup_draft: 'أوافقي على إرسال هذا الرد للعميلة المهتمة.',
    seo_readiness_check: 'أوافقي على استكمال النواقص قبل الترويج.',
    campaign_brief: 'أوافقي على خطة الحملة بهذا السقف (الإطلاق الفعلي يدوي منك).',
    paid_ad_setup_draft: 'أوافقي على إعداد الحملة بهذه المواصفات (التفعيل يدوي منك).',
    daily_ops_triage: 'أوافقي على هذه الأولويات وتوجيه فريق التشغيل بها.',
    executive_weekly_plan: 'أوافقي على خطة الأسبوع والأولويات المقترحة.',
    security_privacy_audit: 'اطلعتِ على التقرير — أي إجراء أمان يبقى بقرارك.',
    erp_data_health_report: 'اطلعتِ على التقرير — أي تنظيف بيانات يبقى بقرارك.',
    funnel_report: 'اطلعتِ على التحليل — أي خطوة تسويقية تالية بقرارك.',
  };
  function officeRequestParts(j, res) {
    const kindLabel = JOB_KIND_LABELS[j.kind] || j.kind;
    const owner = KIND_OWNER_AR[j.kind] || ['فريق MAVI', 'الشركة الافتراضية'];
    const text = res && typeof res.text === 'string' ? res.text : '';
    const PERMISSION_MARK = '🙋 الإذن المطلوب منك';
    const DECISION_MARK = '🎯 قراري';
    let details = text;
    let rationale = '';
    let decision = '';
    if (text.includes(PERMISSION_MARK)) {
      const pIdx = text.indexOf(PERMISSION_MARK);
      decision = text.slice(pIdx + PERMISSION_MARK.length).replace(/^[:：\s]+/, '').split('\n')[0].trim();
      details = text.slice(0, pIdx).trim();
      if (details.includes(DECISION_MARK)) {
        const dIdx = details.indexOf(DECISION_MARK);
        rationale = details.slice(dIdx + DECISION_MARK.length).replace(/^[:：\s]+/, '').trim();
        details = details.slice(0, dIdx).trim();
      }
    }
    if (!decision) decision = KIND_DECISION_AR[j.kind] || 'المطلوب قرارك: الموافقة ليتحول هذا العمل لخطوة تنفيذ — أو الرفض لإعادة الصياغة.';
    const asksFirst = (details.split('\n').map(s => s.trim()).find(s => s.length > 15) || details.slice(0, 140) || kindLabel).replace(/[«»]/g, '').slice(0, 160);
    return { ownerName: owner[0], ownerRole: owner[1], kindLabel, details, rationale, decision, asksFirst };
  }
  function officeRequestCard(j, res, inflight) {
    const p = officeRequestParts(j, res);
    return `
      <div class="of-request-card" data-request-card="${esc(j.id)}" style="border:1px solid #bfdfc2;border-inline-start:4px solid #1a7f37;border-radius:12px;padding:12px 14px;margin-bottom:12px;background:#f7fbf7">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;align-items:center">
          <strong style="color:#14532d;font-size:14px">⬅ القرار المطلوب منك:</strong>
          <span class="of-pill test">${esc(p.kindLabel)}</span>
        </div>
        ${p.decision ? `<div style="margin-top:6px">${esc(p.decision)}</div>` : ''}
        <div class="of-actions" style="margin-top:10px">
          <button type="button" class="btn primary" data-approve-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeDecideJob(this.dataset.approveJob, 'approve')">
            ${inflight ? 'جاري تسجيل القرار...' : (ACTION_KINDS.has(j.kind) ? '✅ اعتماد — يتنفذ على الموقع فورًا ويتحقق تلقائيًا' : '✅ اعتماد — المسودة تبقى جاهزة للاستخدام')}
          </button>
          <button type="button" class="btn danger" data-reject-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeDecideJob(this.dataset.rejectJob, 'reject')">
            ✗ مرفوض — تتحضر من جديد بصياغة تانية
          </button>
        </div>
        ${ACTION_KINDS.has(j.kind)
          ? `<small style="color:#8a5a00;display:block;margin-top:6px">الاعتماد هنا تنفيذ حقيقي على الموقع مع تحقق تلقائي — القيمة السابقة محفوظة وتقدري ترجعيها بضغطة.</small>`
          : `<small style="color:var(--muted);display:block;margin-top:6px">الاعتماد بيخلي النص جاهز للنسخ — النشر أو الإرسال للعميلات دايمًا منكِ يدويًا.</small>`}
      </div>`;
  }

  const JOB_KIND_LABELS = {
    order_followup_draft: 'مسودة متابعة طلب عميلة',
    workshop_followup_draft: 'كشف متابعة ورشة وتنفيذ',
    quality_delivery_checklist: 'قائمة فحص الجودة قبل التسليم',
    care_campaign_draft: 'حملة عناية للعميلات (أسبوعية)',
    customer_reply_draft: 'مسودة رد للعميلة',
    deposit_followup_draft: 'متابعة عربون ومستحقات',
    custom_design_followup_draft: 'مراجعة وتسعير تصميم خاص',
    style_page_copy_draft: 'وصف صفحة الموديل',
    collection_copy_draft: 'وصف مجموعة المتجر',
    delivery_promise_draft: 'موعد تسليم مقترح',
    content_draft: '🤖 مسودة بوست تسويقي (تتولد بالـ AI)',
    visual_reel_brief: 'خطة ريل للموديل',
    landing_page_check: 'فحص صفحة الموبايل قبل الترويج',
    community_followup_draft: 'رد جاهز على استفسار',
    seo_readiness_check: 'فحص جاهزية صفحة الموديل',
    campaign_brief: '🤖 موجز حملة (تتولد بالـ AI)',
    paid_ad_setup_draft: 'إعداد حملة إعلانية (تخطيط مالي)',
    daily_ops_triage: 'قائمة أولويات التشغيل اليومية',
    executive_weekly_plan: 'خطة أولويات الأسبوع',
    security_privacy_audit: 'فحص الخصوصية والصلاحيات',
    erp_data_health_report: 'تقرير سلامة البيانات',
    funnel_attribution_report: 'تقرير قمع التحويل',
  };

  async function fetchOfficeBundle({ sync = true, expectedGen = OFFICE_SESSION_GEN, expectedUid = currentUserId() } = {}) {
    if (!isCurrentSession(expectedGen, expectedUid)) return false;
    OFFICE_STATE.loading = true;
    OFFICE_STATE.error = '';
    try {
      const [casesRes, jobsRes, teamRes, statusRes] = await Promise.all([
        officeApi('/cases' + (sync ? '?sync=1' : ''), {}, expectedGen, expectedUid),
        officeApi('/jobs', {}, expectedGen, expectedUid),
        officeApi('/team', {}, expectedGen, expectedUid),
        officeApi('/status', {}, expectedGen, expectedUid),
      ]);
      if (!isCurrentSession(expectedGen, expectedUid)) return false;

      OFFICE_STATE.cases = Array.isArray(casesRes.cases) ? casesRes.cases : [];
      OFFICE_STATE.jobs = Array.isArray(jobsRes.jobs) ? jobsRes.jobs : [];
      OFFICE_STATE.roles = Array.isArray(teamRes.roles) ? teamRes.roles : [];
      OFFICE_STATE.allowedKinds = Array.isArray(teamRes.allowed_job_kinds) ? teamRes.allowed_job_kinds : [];
      OFFICE_STATE.teamNote = teamRes.note || '';
      OFFICE_STATE.statusInfo = statusRes || null;
      OFFICE_STATE.lastAutoPrepare = jobsRes.auto_prepare || null;
      OFFICE_STATE.loadedOnce = true;

      if (OFFICE_STATE.allowedKinds.length && !OFFICE_STATE.allowedKinds.some(k => k.kind === OFFICE_STATE.compose.kind)) {
        OFFICE_STATE.compose.kind = OFFICE_STATE.allowedKinds[0].kind;
      }
      if (!OFFICE_STATE.compose.order_code) {
        const firstOrderCase = OFFICE_STATE.cases.find(c => c.subject_type === 'order' && c.subject_code);
        if (firstOrderCase) {
          OFFICE_STATE.compose.order_code = firstOrderCase.subject_code;
        } else if (typeof CACHE !== 'undefined' && Array.isArray(CACHE.orders) && CACHE.orders[0]) {
          OFFICE_STATE.compose.order_code = CACHE.orders[0].code;
        }
      }
      if (!OFFICE_STATE.compose.request_id) {
        const firstCustomCase = OFFICE_STATE.cases.find(c => c.subject_type === 'custom_request' && c.subject_id);
        if (firstCustomCase) {
          OFFICE_STATE.compose.request_id = String(firstCustomCase.subject_id);
        }
      }
      return true;
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) throw err;
      if (isCurrentSession(expectedGen, expectedUid)) {
        OFFICE_STATE.error = err.message || 'تعذر تحميل بيانات الملخص والمسودات.';
      }
      return false;
    } finally {
      if (expectedGen === OFFICE_SESSION_GEN) {
        OFFICE_STATE.loading = false;
      }
    }
  }

  async function rerenderAfterLockRelease(gen, uid, hasFreshBundle) {
    if (!isCurrentSession(gen, uid)) return;
    if (hasFreshBundle) {
      OFFICE_STATE.freshData = true;
    } else {
      OFFICE_STATE.freshData = false;
    }
    const ovl = document.getElementById('ovl');
    const ctxModalRoot = document.getElementById('of-ctx-modal-root');
    if (ovl && ovl.classList.contains('on') && ctxModalRoot && typeof refreshActiveContextModal === 'function') {
      await refreshActiveContextModal(gen, uid);
      return;
    }
    if (typeof render === 'function') {
      await render();
    }
  }

  function casePriorityClass(rank) {
    if (rank <= 1) return 'urgent';
    if (rank <= 4) return 'warn';
    return 'test';
  }

  function renderOwnerCaseFinance(c) {
    if (!isOwner() || !c || !c.summary) return '';
    const parts = [];
    if (typeof c.summary.expected_deposit_egp === 'number') {
      parts.push(`العربون المطلوب: <b>${EGP(c.summary.expected_deposit_egp)} ج.م</b>`);
    }
    if (typeof c.summary.total_egp === 'number') {
      parts.push(`الإجمالي: <b>${EGP(c.summary.total_egp)} ج.م</b>`);
    }
    if (typeof c.summary.paid_egp === 'number') {
      parts.push(`المدفوع: <b>${EGP(c.summary.paid_egp)} ج.م</b>`);
    }
    if (!parts.length) return '';
    return `<div class="of-meta-row" data-owner-finance="1">${parts.join(' · ')}</div>`;
  }

  function renderCaseCard(c, compact = false) {
    const pCls = casePriorityClass(c.priority_rank);
    const isOrder = c.subject_type === 'order';
    const openLabel = isOrder ? 'فتح الطلب' : 'فتح التصميم الخاص';
    const episodeBadge = c.episode > 1
      ? `<span class="of-pill warn">أُعيد فتحها · الحلقة ${Number(c.episode)}</span>`
      : '';
    const promiseInfo = c.summary && c.summary.promise_date
      ? `<span>الموعد المسجل: <b class="mono">${esc(c.summary.promise_date)}</b></span>`
      : '';
    const stageInfo = c.summary && c.summary.order_status
      ? `<span>مرحلة الطلب: <b>${esc(typeof adminStatusLabel === 'function' ? adminStatusLabel(c.summary.order_status) : c.summary.order_status)}</b></span>`
      : '';

    const canDraftOrder = isOrder && OFFICE_STATE.allowedKinds.some(k => k.subject_type === 'order');
    const canDraftCustom = !isOrder && c.subject_type === 'custom_request' && OFFICE_STATE.allowedKinds.some(k => k.subject_type === 'custom_request');
    const canDraftSubject = canDraftOrder || canDraftCustom;

    return `
      <article class="of-case-card prio-${Number(c.priority_rank || 9)}" data-case-id="${Number(c.id)}" data-case-kind="${esc(c.case_kind)}">
        <div class="of-case-top">
          <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">
            <span class="of-pill ${pCls}">${esc(c.priority_label_ar || 'متابعة')}</span>
            <span class="of-code">${esc(c.subject_code)}</span>
            ${episodeBadge}
          </div>
          <span class="of-pill" title="قالب مسؤولية لتنظيم العمل البشري وليس موظفًا آليًا">
            المسؤول: ${esc(c.assignee_name_ar)}${c.assignee_title_ar ? ' · ' + esc(c.assignee_title_ar) : ''}
          </span>
        </div>
        <div>
          <div class="of-case-reason">${esc(c.reason_ar)}</div>
          ${c.next_step_ar ? `<div class="of-case-next">الخطوة التالية: ${esc(c.next_step_ar)}</div>` : ''}
        </div>
        ${(promiseInfo || stageInfo) ? `<div class="of-meta-row">${stageInfo}${promiseInfo}</div>` : ''}
        ${renderOwnerCaseFinance(c)}
        <div class="of-actions">
          <button type="button" class="btn primary sm" data-open-subject-type="${esc(c.subject_type)}" data-open-subject-id="${Number(c.subject_id)}" data-open-subject-code="${esc(c.subject_code)}" onclick="officeOpenSubject(this.dataset.openSubjectType, Number(this.dataset.openSubjectId), this.dataset.openSubjectCode)">
            ${openLabel} ›
          </button>
          ${!compact && canDraftSubject ? `<button type="button" class="btn sm" data-prefill-type="${esc(c.subject_type)}" data-prefill-id="${Number(c.subject_id)}" data-prefill-code="${esc(c.subject_code)}" data-prefill-kind="${esc(c.case_kind)}" onclick="officePrefillDraftFromCase(this.dataset.prefillCode, this.dataset.prefillKind, this.dataset.prefillType, Number(this.dataset.prefillId))">تحضير مسودة متابعة</button>` : ''}
          ${!compact ? `<button type="button" class="btn ghost sm" data-hist-type="${esc(c.subject_type)}" data-hist-id="${Number(c.subject_id)}" data-hist-code="${esc(c.subject_code)}" onclick="officeShowCaseHistory(this.dataset.histType, Number(this.dataset.histId), this.dataset.histCode)">سجل الحلقات</button>` : ''}
        </div>
      </article>
    `;
  }

  /* Compact «ملخص يومك» band embedded directly inside the main dashboard (`dashView`) */
  async function officeDashWidgetHtml() {
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    try {
      await fetchOfficeBundle({ sync: true, expectedGen: gen, expectedUid: uid });
    } catch (err) {
      if (err && err.staleSession) return '';
      throw err;
    }
    if (!isCurrentSession(gen, uid)) return '';
    if (OFFICE_STATE.error) {
      return `
        <section class="of-dash-band" aria-labelledby="of-dash-heading">
          <div class="of-sec-head">
            <div><h2 id="of-dash-heading">ملخص يومك</h2></div>
          </div>
          <div class="of-error-box" role="alert">
            <strong>تعذر تحميل ملخص يومك</strong>
            ${esc(OFFICE_STATE.error)}
            <div style="margin-top:8px"><button type="button" class="btn sm" onclick="render()">إعادة المحاولة</button></div>
          </div>
        </section>
      `;
    }

    const topCases = OFFICE_STATE.cases.slice(0, 5);
    const reviewCount = isOwner() ? OFFICE_STATE.jobs.filter(j => j.status === 'review').length : 0;

    return `
      <section class="of-dash-band" aria-labelledby="of-dash-heading">
        <div class="of-sec-head">
          <div>
            <h2 id="of-dash-heading">ملخص يومك <span class="cnt" style="font-size:12px;color:var(--muted);font-weight:600">(${OFFICE_STATE.cases.length} حالة مفتوحة مرتبة بالأولوية)</span></h2>
            <p>${isOwner()
              ? 'أهم الحالات المفتوحة اليوم حسب الأولوية التشغيلية والمالية، مع المسؤول وفتح الطلب مباشرة.'
              : 'الحالات التشغيلية المفتوحة اليوم مرتبة بالأولوية مع المسؤول وفتح الطلب مباشرة.'}</p>
          </div>
          <div class="of-toolbar">
            ${isOwner() && reviewCount > 0 ? `<button type="button" class="btn sm" onclick="officeGoTab('drafts')">مسودات تنتظر قرارك (${reviewCount})</button>` : ''}
            <button type="button" class="btn sm" onclick="officeGoTab('summary')">عرض كل الحالات والفريق ›</button>
          </div>
        </div>
        ${topCases.length
          ? `<div class="of-cases-grid">${topCases.map(c => renderCaseCard(c, true)).join('')}</div>`
          : `<div class="of-empty">لا توجد حالات متابعة مفتوحة حاليًا — جميع الطلبات النشطة مستوفاة.</div>`}
      </section>
    `;
  }

  function renderSummaryTab() {
    const filtered = OFFICE_STATE.roleFilter
      ? OFFICE_STATE.cases.filter(c => c.assignee_role_id === OFFICE_STATE.roleFilter)
      : OFFICE_STATE.cases;
    const activeRole = OFFICE_STATE.roleFilter
      ? OFFICE_STATE.roles.find(r => r.id === OFFICE_STATE.roleFilter)
      : null;
    const syncing = OFFICE_INFLIGHT.has('sync');

    return `
      <section aria-labelledby="of-summary-title" class="of-wrap">
        <div class="of-sec-head">
          <div>
            <h2 id="of-summary-title">ملخص يومك — حالات المتابعة النشطة (${filtered.length})</h2>
            <p>مرتبة تلقائيًا بالأولوية (المتأخر ثم الإيصالات والمقاسات الناقصة ثم التسعير ومواعيد التسليم القريبة).</p>
          </div>
          <div class="of-toolbar">
            ${activeRole ? `<button type="button" class="btn sm" onclick="officeClearRoleFilter()">إلغاء تصفية الدور: ${esc(activeRole.name)} ✕</button>` : ''}
            <button type="button" class="btn sm" id="of-sync-btn" ${syncing ? 'disabled aria-busy="true"' : ''} onclick="officeRunSync()">
              ${syncing ? 'جاري تحديث الحالات...' : '↻ تحديث الحالات الآن'}
            </button>
          </div>
        </div>
        ${filtered.length
          ? `<div class="of-cases-grid">${filtered.map(c => renderCaseCard(c, false)).join('')}</div>`
          : `<div class="of-empty">${activeRole
              ? `لا توجد حالات مفتوحة حاليًا ضمن قالب مسؤولية «${esc(activeRole.name)}».`
              : 'لا توجد حالات متابعة مفتوحة حاليًا — كل الطلبات النشطة مستوفاة.'}</div>`}
        <div style="margin-top:14px;padding-top:10px;border-top:1px dashed #e5e5ea;font-size:12px;color:#8a93a3;display:flex;gap:14px;flex-wrap:wrap">
          <span>مكتب التشغيل:</span>
          <button type="button" class="of-quiet-link" onclick="officeSwitchTab('hq')">صالة المكتب الحي ›</button>
          <button type="button" class="of-quiet-link" onclick="officeSwitchTab('team')">أدوار الفريق ›</button>
        </div>
      </section>
    `;
  }

  function renderComposePanel() {
    const kinds = OFFICE_STATE.allowedKinds;
    if (!kinds.length) return '';
    const selected = kinds.find(k => k.kind === OFFICE_STATE.compose.kind) || kinds[0];
    const isOrderKind = selected.subject_type === 'order';
    const isCustomKind = selected.subject_type === 'custom_request';
    const isOpsSummaryKind = selected.subject_type === 'ops_summary';
    const isBrief = selected.kind === 'campaign_brief' || selected.kind === 'paid_ad_setup_draft';
    const isProductOnly = ['seo_readiness_check', 'visual_reel_brief', 'landing_page_check'].includes(selected.kind);
    const creating = OFFICE_INFLIGHT.has('create_job');

    const catalogueStyles = (typeof CACHE !== 'undefined' && Array.isArray(CACHE.styles)) ? CACHE.styles : [];
    const customCases = OFFICE_STATE.cases.filter(c => c.subject_type === 'custom_request');

    return `
      <section class="of-compose" aria-labelledby="of-compose-title">
        <div class="of-sec-head">
          <div>
            <h3 id="of-compose-title" style="font-size:15px;color:#172b4b;margin:0">مسودة جديدة</h3>
            <p style="font-size:12px;color:#637386;margin-top:3px">اختاري النوع والمنتج — المسودة تتحفظ عندك وتتحضر للمراجعة. مفيش أي إرسال تلقائي.</p>
          </div>
          <span class="of-pill test">بدون إرسال تلقائي</span>
        </div>
        <div class="of-form-grid">
          <label class="of-field" for="of-kind-select">نوع المسودة
            <select id="of-kind-select" onchange="officeUpdateComposeKind(this.value)">
              ${kinds.map(k => `<option value="${esc(k.kind)}" ${k.kind === selected.kind ? 'selected' : ''}>${esc(k.label || JOB_KIND_LABELS[k.kind] || k.kind)}</option>`).join('')}
            </select>
          </label>
          ${isOrderKind ? `
            <label class="of-field" for="of-order-code">رقم الطلب (الأوردر)
              <input id="of-order-code" type="text" dir="ltr" placeholder="مثال: MV-..." value="${esc(OFFICE_STATE.compose.order_code)}" oninput="officeSetComposeField('order_code', this.value)">
            </label>
            ${selected.kind === 'order_followup_draft' ? `
              <label class="of-field" for="of-order-focus">محور المتابعة
                <select id="of-order-focus" onchange="officeSetComposeField('focus', this.value)">
                  <option value="schedule" ${OFFICE_STATE.compose.focus === 'schedule' ? 'selected' : ''}>موعد التسليم</option>
                  <option value="measurements" ${OFFICE_STATE.compose.focus === 'measurements' ? 'selected' : ''}>استكمال المقاسات</option>
                  <option value="status_update" ${OFFICE_STATE.compose.focus === 'status_update' ? 'selected' : ''}>تحديث مرحلة التنفيذ</option>
                </select>
              </label>
            ` : ''}
          ` : isCustomKind ? `
            <label class="of-field" for="of-custom-req-id">رقم طلب التصميم الخاص
              <input id="of-custom-req-id" type="number" min="1" step="1" dir="ltr" placeholder="مثال: 1" value="${esc(OFFICE_STATE.compose.request_id)}" oninput="officeSetComposeField('request_id', this.value)">
            </label>
            ${customCases.length ? `
              <label class="of-field" for="of-custom-case-pick">اختيار سريع من التصاميم المفتوحة
                <select id="of-custom-case-pick" onchange="officeSetComposeField('request_id', this.value); const inp=document.getElementById('of-custom-req-id'); if(inp) inp.value=this.value;">
                  ${customCases.map(c => `<option value="${Number(c.subject_id)}" ${String(OFFICE_STATE.compose.request_id) === String(c.subject_id) ? 'selected' : ''}>${esc(c.subject_code)} — ${esc(c.reason_ar)}</option>`).join('')}
                </select>
              </label>
            ` : ''}
          ` : isOpsSummaryKind ? (
            selected.kind === 'executive_weekly_plan' ? `
              <label class="of-field" for="of-holiday-budget">سقف تخطيطي ليوم الإجازة الأسبوعية (ج.م — حد ١٠٠ بدون صرف فعلي)
                <input id="of-holiday-budget" type="number" min="1" max="100" step="1" value="${esc(OFFICE_STATE.compose.holiday_budget_egp)}" oninput="officeSetComposeField('holiday_budget_egp', this.value)">
              </label>
            ` : `
              <div class="of-field" style="justify-content:flex-end">
                <span style="font-size:12px;color:#516479">تقرأ هذه المهمة مؤشرات النظام الحية تلقائيًا عند التحضير دون الحاجة لإدخال كود يدوي.</span>
              </div>
            `
          ) : `
            <label class="of-field" for="of-product-id">الموديل / عنصر الاختبار
              <select id="of-product-id" onchange="officeSetComposeField('product_id', this.value)">
                <option value="DEMO-PUBLIC-01" ${OFFICE_STATE.compose.product_id === 'DEMO-PUBLIC-01' ? 'selected' : ''}>DEMO-PUBLIC-01 (عنصر اختبار تجريبي)</option>
                ${catalogueStyles.map(s => `<option value="${esc(s.id)}" ${OFFICE_STATE.compose.product_id === s.id ? 'selected' : ''}>${esc(s.id)} — ${esc(s.name)}</option>`).join('')}
              </select>
            </label>
            ${!isProductOnly ? `
              <label class="of-field" for="of-channel">القناة
                <select id="of-channel" onchange="officeSetComposeField('channel', this.value)">
                  <option value="instagram" ${OFFICE_STATE.compose.channel === 'instagram' ? 'selected' : ''}>Instagram</option>
                  <option value="facebook" ${OFFICE_STATE.compose.channel === 'facebook' ? 'selected' : ''}>Facebook</option>
                </select>
              </label>
            ` : ''}
            ${isOwner() && isBrief ? `
              <label class="of-field" for="of-budget">سقف تخطيطي ليوم واحد (ج.م — حد ١٠٠ بدون صرف فعلي)
                <input id="of-budget" type="number" min="1" max="100" step="1" value="${esc(OFFICE_STATE.compose.daily_budget_egp)}" oninput="officeSetComposeField('daily_budget_egp', this.value)">
              </label>
            ` : ''}
          `}
        </div>
        ${OFFICE_STATE.compose.error ? `<div class="of-error-box" role="alert">${esc(OFFICE_STATE.compose.error)}</div>` : ''}
        <div class="of-actions">
          <button type="button" class="btn primary" id="of-create-job-btn" ${creating ? 'disabled aria-busy="true"' : ''} onclick="officeSubmitCompose()">
            ${creating ? 'جاري حفظ الطلب في الطابور...' : '＋ إضافة المسودة للطابور'}
          </button>
        </div>
      </section>
    `;
  }

  function resolveJobOrderCode(j) {
    if (!j || j.subject_type !== 'order') return '';
    return String(j.subject_code || (j.payload && j.payload.order_code) || '').trim();
  }

  function resolveJobCustomId(j) {
    if (!j || j.subject_type !== 'custom_request') return 0;
    const raw = Number((j.payload && j.payload.request_id) || j.subject_ref || 0);
    return Number.isInteger(raw) && raw > 0 ? raw : 0;
  }

  const CUSTOMER_FACING_KINDS = new Set([
    'order_followup_draft',
    'customer_reply_draft',
    'deposit_followup_draft',
    'custom_design_followup_draft',
  ]);

  function approvedWhatsappHref(j, phoneRaw) {
    if (!j || j.status !== 'approved' || !j.result || !j.result.text) return '';
    if (!CUSTOMER_FACING_KINDS.has(j.kind)) return '';
    const digits = String(phoneRaw || '').replace(/[^0-9]/g, '');
    if (!/^01[0-9]{9}$/.test(digits)) return '';
    return 'https://wa.me/2' + digits + '?text=' + encodeURIComponent(String(j.result.text));
  }

  const EXEC_CHANNEL_LABELS = {
    whatsapp: 'واتساب يدوي',
    instagram: 'إنستجرام يدوي',
    facebook: 'فيسبوك يدوي',
    phone: 'اتصال هاتفي',
    internal: 'استخدام داخلي بالـ ERP',
  };

  function defaultExecChannelForKind(kind) {
    if (CUSTOMER_FACING_KINDS.has(kind)) return 'whatsapp';
    if (['content_draft', 'visual_reel_brief', 'community_followup_draft', 'campaign_brief', 'paid_ad_setup_draft'].includes(kind)) return 'instagram';
    return 'internal';
  }

  /* حالات المسودات التنفيذية (شغل حقيقي على مافي): التمييز الإلزامي بين
     «معتمدة محفوظة فقط» و«تم التنفيذ والتحقق» و«فشل — يحتاج تدخل». */
  const EXEC_STATE_AR = {
    verified: { label: 'تم التنفيذ والتحقق ✓ — النتيجة على الصفحة/السجل', cls: 'ok' },
    failed: { label: 'فشل التنفيذ — يحتاج تدخل', cls: 'urgent' },
    restored: { label: 'تم الاسترجاع للقيمة السابقة', cls: 'warn' },
  };
  const ACTION_KINDS = new Set(['style_page_copy_draft', 'delivery_promise_draft', 'collection_copy_draft']);
  const EXEC_TOOL_AR = { style_note_update: 'كتابة وصف الموديل على الصفحة', promise_date_update: 'تسجيل موعد التسليم على الطلب', collection_note_update: 'كتابة وصف المجموعة على المتجر' };

  function officeExecutionBanner(j) {
    const er = j.execution_result || {};
    const tool = EXEC_TOOL_AR[er.tool] || 'تنفيذ على مافي';
    const val = (a, b) => `<div style="margin-top:6px"><b>قبل:</b> ${esc(String(a ?? '—').slice(0, 220))}<br><b>بعد:</b> ${esc(String(b ?? '—').slice(0, 220))}</div>`;
    if (j.execution === 'verified') {
      return `<div class="of-erp-ok" data-exec-banner="${esc(j.id)}" role="status">
          <strong>✓ ${esc(tool)} — تم التنفيذ والتحقق</strong>
          ${val(er.old_note ?? er.old_date, er.new_note ?? er.new_date)}
          ${er.link ? `<div style="margin-top:7px"><a class="btn sm" href="${esc(er.link)}" target="_blank" rel="noopener noreferrer">افتح الصفحة المنشورة وشوف النتيجة ›</a></div>` : ''}
          <small style="color:var(--muted);display:block;margin-top:6px">تمت إعادة قراءة السجل نفسه بعد الكتابة للتأكد — وده سجل التحقق المحفوظ على المسودة.</small>
        </div>`;
    }
    if (j.execution === 'failed') {
      return `<div class="of-stale-alert" data-exec-banner="${esc(j.id)}" role="alert">
          <strong>✗ فشل التنفيذ — محتاج تدخلك (${esc(String(er.error_code || ''))})</strong>
          ${esc(String(er.message || ''))}
          <div style="margin-top:7px">جرّبي «إعادة محاولة التنفيذ» — لو فضل فاشل، السبب مكتوب هنا بصدق ومفيش أي ادعاء إن حاجة اتنفّذت.</div>
        </div>`;
    }
    return `<div class="of-erp-ok" data-exec-banner="${esc(j.id)}" role="status">
        <strong>↩ ${esc(tool)} — تم الاسترجاع للقيمة السابقة</strong>
        ${val(er.old_note ?? er.old_date, er.new_note ?? er.new_date)}
        ${er.link ? `<div style="margin-top:7px"><a class="btn sm" href="${esc(er.link)}" target="_blank" rel="noopener noreferrer">افتح الصفحة للتأكد ›</a></div>` : ''}
      </div>`;
  }

  function renderJobCard(j, opts) {
    const cardOpts = opts && typeof opts === 'object' ? opts : {};
    const st = (j.execution && EXEC_STATE_AR[j.execution]) || JOB_STATUS_LABELS[j.status] || { label: j.status, cls: 'test' };
    const staleAlert = OFFICE_STATE.staleAlerts[j.id];
    const inflight = OFFICE_INFLIGHT.has(`job:${j.id}`);
    const res = j.result || null;
    const facts = res && Array.isArray(res.facts_used) ? res.facts_used : [];
    const checklist = res && Array.isArray(res.review_checklist) ? res.review_checklist : [];
    const isTestTemplate = !res || (res.provenance && res.provenance.mode === 'fixture') || j.subject_ref === 'DEMO-PUBLIC-01';
    const orderCode = cardOpts.hideOpenSubject ? '' : resolveJobOrderCode(j);
    const customId = cardOpts.hideOpenSubject ? 0 : resolveJobCustomId(j);
    const displaySubjectRef = resolveJobOrderCode(j) || (resolveJobCustomId(j) ? `CUSTOM-${resolveJobCustomId(j)}` : j.subject_ref);
    const waHref = approvedWhatsappHref(j, cardOpts.customerPhone || (OFFICE_STATE.ctx && OFFICE_STATE.ctx.phone) || '');
    const isEditing = isOwner() && OFFICE_STATE.editingJobId === j.id && res && ['review', 'approved'].includes(j.status);
    const defChannel = defaultExecChannelForKind(j.kind);

    return `
      <article class="of-job-card" data-job-id="${esc(j.id)}" data-job-status="${esc(j.status)}">
        <div class="of-job-top">
          <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">
            <span class="of-pill ${st.cls}">${esc(st.label)}</span>
            <strong style="font-size:14.5px;color:#172b4b">${esc((res && res.title) || JOB_KIND_LABELS[j.kind] || j.kind)}</strong>
            ${res && res.human_edited ? `<span class="of-pill ok">✎ معدّلة يدويًا</span>` : ''}
            ${(() => {
              if (!isTestTemplate) return '';
              const prov = res && res.provenance;
              const aiCapable = ['content_draft', 'campaign_brief', 'community_followup_draft', 'visual_reel_brief', 'seo_readiness_check', 'landing_page_check', 'style_page_copy_draft', 'collection_copy_draft'].includes(j.kind);
              if (prov && prov.ai_fallback_error) {
                return `<span class="of-pill warn" title="الذكاء الاصطناعي فشل على المسودة دي — السبب: ${esc(String(prov.ai_fallback_error))} — فاتحضرت محليًا من بيانات النظام بدل ما تضيع">محلية — الـ AI فشل (${esc(String(prov.ai_fallback_error))})</span>`;
              }
              if (!aiCapable) {
                return `<span class="of-pill test" title="النوع ده تخطيطي/مالي بالتصميم — بيتحضر محليًا من بيانات النظام ومش بيبعت أي بيانات خارجية">تخطيط/مالي — محلي بالتصميم</span>`;
              }
              return `<span class="of-pill test" title="اتحضرت محليًا من بيانات النظام — زر «🤖 أعد التوليد بالذكاء الاصطناعي» موجود تحت لو حابة نسخة AI">محلية — قابلة لإعادة التوليد بالـ AI</span>`;
            })()}
          </div>
        </div>

        <div class="of-meta-row" style="font-size:11px;color:var(--muted)">
          <span>النسخة #${Number(j.revision)}</span>
          ${j.result_hash ? `<span title="بصمة المسودة الكاملة: ${esc(j.result_hash)}">بصمة النص: <span class="mono">${esc(j.result_hash.slice(0, 12))}…</span></span>` : ''}
          <span>المرجع: <b class="mono">${esc(displaySubjectRef)}</b></span>
          ${cardOpts.showDate ? `<span>آخر تحديث: <b>${esc(officeArDate(j.updated_at))}</b></span>` : ''}
          ${j.reviewed_by ? `<span>راجعتها: <b>${esc(j.reviewed_by)}</b></span>` : ''}
        </div>

        ${isOwner() && j.status === 'review' && res ? officeRequestCard(j, res, inflight) : ''}

        ${j.manual_execution ? `
          <div class="of-erp-ok" data-manual-exec="${esc(j.id)}">
            ✓ تم تسجيل الاستخدام اليدوي (${esc(EXEC_CHANNEL_LABELS[j.manual_execution.channel] || j.manual_execution.channel)}) بواسطة <span class="mono">${esc(j.manual_execution.used_by || '')}</span> — لعدم تكرار الإرسال
          </div>
        ` : ''}

        ${j.execution && j.execution_result ? officeExecutionBanner(j) : ''}

        ${staleAlert ? `
          <div class="of-stale-alert" role="alert" data-stale-error="${esc(staleAlert.code)}">
            <strong>تعذر اعتماد المسودة لأن البيانات تغيّرت (${esc(staleAlert.code)})</strong>
            ${esc(staleAlert.message)}
            <br>لم يتم إعادة الاعتماد تلقائيًا. اضغطي «تحديث المسودة للمراجعة من جديد» لإعادة تحضيرها على البيانات الحالية ثم راجعيها قبل القرار.
            <div class="of-actions" style="margin-top:9px">
              <button type="button" class="btn sm primary" data-refresh-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeRefreshStaleJob(this.dataset.refreshJob)">
                ${inflight ? 'جاري تحديث المسودة...' : '↻ تحديث المسودة للمراجعة من جديد'}
              </button>
              ${orderCode ? `<button type="button" class="btn sm" data-open-order-code="${esc(orderCode)}" onclick="officeOpenOrderFromJob(this.dataset.openOrderCode)">فتح الطلب لمراجعة التعديلات ›</button>` : ''}
              ${customId ? `<button type="button" class="btn sm" data-open-custom-id="${customId}" onclick="officeOpenSubject('custom_request', Number(this.dataset.openCustomId), 'CUSTOM-' + this.dataset.openCustomId)">فتح التصميم الخاص ›</button>` : ''}
            </div>
          </div>
        ` : (j.subject_stale && j.status === 'review' ? `
          <div class="of-stale-alert" role="status">
            <strong>تنبيه: بيانات الطلب أو الموديل تغيّرت بعد تحضير هذه المسودة</strong>
            الحقائق أدناه قد لا تطابق آخر تعديل محفوظ على السيرفر. حدّثي المسودة وراجعيها قبل الاعتماد.
            <div class="of-actions" style="margin-top:9px">
              <button type="button" class="btn sm primary" data-refresh-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeRefreshStaleJob(this.dataset.refreshJob)">
                ${inflight ? 'جاري تحديث المسودة...' : '↻ تحديث المسودة للمراجعة من جديد'}
              </button>
              ${orderCode ? `<button type="button" class="btn sm" data-open-order-code="${esc(orderCode)}" onclick="officeOpenOrderFromJob(this.dataset.openOrderCode)">فتح الطلب لمراجعة التعديلات ›</button>` : ''}
              ${customId ? `<button type="button" class="btn sm" data-open-custom-id="${customId}" onclick="officeOpenSubject('custom_request', Number(this.dataset.openCustomId), 'CUSTOM-' + this.dataset.openCustomId)">فتح التصميم الخاص ›</button>` : ''}
            </div>
          </div>
        ` : '')}

        ${res ? `
          <div>
            <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px">
              <div style="font-size:12px;font-weight:700;color:#41566e">النص الجاهز — انسخيه أو عدّليه قبل القرار:</div>
              ${!isEditing ? `<button type="button" class="btn primary sm" data-copy-draft-job="${esc(j.id)}" onclick="officeCopyDraftText(this.dataset.copyDraftJob)" title="نسخ النص للحافظة — الاستخدام يفضل يدوي منك دايمًا">📋 نسخ النص</button>` : ''}
            </div>
            ${isEditing ? `
              <textarea id="of-edit-ta-${esc(j.id)}" class="of-edit-ta" dir="rtl" oninput="officeUpdateEditDraftText(this.value)">${esc(OFFICE_STATE.editingText)}</textarea>
              <div class="of-actions" style="margin-top:8px">
                <button type="button" class="btn primary sm" data-save-edit-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeSaveEditJob(this.dataset.saveEditJob)">
                  ${inflight ? 'جاري الحفظ...' : '💾 حفظ النص المعدّل للمراجعة'}
                </button>
                <button type="button" class="btn sm" onclick="officeCancelEditJob()">إلغاء التعديل</button>
              </div>
            ` : `
              <div class="of-draft-box">${esc(res.text)}</div>
            `}
          </div>

          ${facts.length ? `
            <div>
              <div style="font-size:12px;font-weight:700;color:#41566e;margin-bottom:6px">الحقائق المستخدمة وقت توليد المسودة:</div>
              <div class="of-facts-grid">
                ${facts.map(f => `<div class="of-fact-item"><span>${esc(f.label)}</span><strong>${esc(f.value)}</strong></div>`).join('')}
              </div>
            </div>
          ` : ''}

          ${checklist.length ? `
            <div>
              <div style="font-size:12px;font-weight:700;color:#41566e;margin-bottom:4px">ضوابط المراجعة قبل الاستخدام اليدوي:</div>
              <ul class="of-checklist">${checklist.map(item => `<li>${esc(item)}</li>`).join('')}</ul>
            </div>
          ` : ''}
        ` : `
          <div class="of-empty" style="padding:14px">
            المسودة محفوظة ولم تُحضَّر بعد — افتحي المكتب وبتتحضر لوحدها، أو دوسي «تحضير المسودات المعلّقة» من الأدوات المتقدمة فوق.
          </div>
        `}

        ${isOwner() && j.status === 'review' ? `
          <div class="of-actions" style="margin-top:4px">
            ${res && !isEditing ? `<button type="button" class="btn sm" data-edit-job="${esc(j.id)}" ${inflight ? 'disabled' : ''} onclick="officeStartEditJob(this.dataset.editJob)">✎ تعديل</button>` : ''}
            ${(() => {
              const aiKindsUi = ['content_draft', 'campaign_brief', 'community_followup_draft', 'visual_reel_brief', 'seo_readiness_check', 'landing_page_check', 'style_page_copy_draft', 'collection_copy_draft'];
              const orSt = OFFICE_STATE.statusInfo && OFFICE_STATE.statusInfo.openrouter;
              const aiReadyUi = !!(orSt && ['ready', 'configured_not_tested'].includes(orSt.status));
              return (isOwner() && aiReadyUi && aiKindsUi.includes(j.kind) && res && res.provenance && res.provenance.mode === 'fixture')
                ? `<button type="button" class="btn sm" data-regen-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeRegenerateAi(this.dataset.regenJob)" title="اسحبي النص المحلي وولّديه من جديد بالذكاء الاصطناعي — لو فشل يرجع المحلي تلقائيًا">🤖 أعد التوليد بالذكاء الاصطناعي</button>`
                : '';
            })()}
            <button type="button" class="btn ghost sm" data-recheck-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeRecheckJob(this.dataset.recheckJob)" title="فحص أن بيانات الطلب ما تغيرتش بعد التحضير">
              فحص تحديث البيانات
            </button>
            ${orderCode ? `<button type="button" class="btn sm" data-open-order-code="${esc(orderCode)}" onclick="officeOpenOrderFromJob(this.dataset.openOrderCode)">فتح الطلب ›</button>` : ''}
            ${customId ? `<button type="button" class="btn sm" data-open-custom-id="${esc(customId)}" onclick="officeOpenSubject('custom_request', Number(this.dataset.openCustomId), 'CUSTOM-' + this.dataset.openCustomId)">فتح التصميم الخاص ›</button>` : ''}
          </div>
        ` : `
          <div class="of-actions">
            ${j.status === 'approved' && res && res.text && !ACTION_KINDS.has(j.kind) ? `<button type="button" class="btn sm" data-copy-job="${esc(j.id)}" onclick="officeCopyApprovedText(this.dataset.copyJob)">نسخ النص المعتمد للاستخدام اليدوي</button>` : ''}
            ${waHref && !ACTION_KINDS.has(j.kind) ? `<a class="btn wa sm" target="_blank" rel="noopener noreferrer" data-wa-approved-job="${esc(j.id)}" href="${esc(waHref)}">📲 فتح واتساب العميلة بالنص المعتمد (يدويًا)</a>` : ''}
            ${j.status === 'approved' && !j.manual_execution && !ACTION_KINDS.has(j.kind) ? `<button type="button" class="btn sm primary" data-mark-used-job="${esc(j.id)}" data-mark-used-ch="${esc(defChannel)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeMarkJobUsed(this.dataset.markUsedJob, this.dataset.markUsedCh)">✓ تسجيل أنه تم الإرسال / الاستخدام يدويًا</button>` : ''}
            ${isOwner() && ACTION_KINDS.has(j.kind) && j.execution === 'failed' ? `<button type="button" class="btn sm primary" data-exec-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeExecuteJob(this.dataset.execJob)">↻ إعادة محاولة التنفيذ الآن</button>` : ''}
            ${isOwner() && j.kind === 'style_page_copy_draft' && j.execution === 'verified' ? `<button type="button" class="btn sm" data-restore-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeRestoreExecution(this.dataset.restoreJob)">↩ استرجاع الوصف السابق</button>` : ''}
            ${isOwner() && j.status === 'approved' && res && !isEditing ? `<button type="button" class="btn ghost sm" data-edit-job="${esc(j.id)}" onclick="officeStartEditJob(this.dataset.editJob)">✎ تعديل النص</button>` : ''}
            ${orderCode ? `<button type="button" class="btn sm" data-open-order-code="${esc(orderCode)}" onclick="officeOpenOrderFromJob(this.dataset.openOrderCode)">فتح الطلب ›</button>` : ''}
            ${customId ? `<button type="button" class="btn sm" data-open-custom-id="${customId}" onclick="officeOpenSubject('custom_request', Number(this.dataset.openCustomId), 'CUSTOM-' + this.dataset.openCustomId)">فتح التصميم الخاص ›</button>` : ''}
            ${!isOwner() && j.status === 'review' ? `<span class="of-pill warn">بانتظار مراجعة واعتماد المالكة</span>` : ''}
            ${isOwner() && ['approved', 'rejected', 'failed'].includes(j.status) ? `<button type="button" class="btn ghost sm" data-delete-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeDeleteDecidedJob(this.dataset.deleteJob)" title="حذف هذه المسودة نهائيًا — سجل القرار بيفضل محفوظ في سجل التدقيق">🗑 حذف</button>` : ''}
          </div>
        `}
      </article>
    `;
  }

  /* The owner's RESULTS view: every approved draft lands here with its final
     text ready to copy — she can come back any time and see what she produced.
     Executable kinds show their verified on-site result banner on the card. */
  function officeArDate(epochSec) {
    try {
      return new Date(Number(epochSec) * 1000).toLocaleDateString('ar-EG', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch (_) { return ''; }
  }

  function renderApprovedTab() {
    const approved = OFFICE_STATE.jobs
      .filter(j => j.status === 'approved')
      .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0));
    const executed = approved.filter(j => j.execution === 'verified');
    const execFailed = approved.filter(j => j.execution === 'failed');
    const readyToSend = approved.filter(j => !j.manual_execution && ['customer_reply_draft', 'order_followup_draft'].includes(j.kind));
    const followRows = executed.map(j => {
      const er = j.execution_result || {};
      const val = String(er.new_note ?? er.new_date ?? '').slice(0, 90);
      const when = officeArDate(Number(j.updated_at || 0));
      return `<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:center;padding:8px 0;border-bottom:1px dashed var(--line)">
        <div style="font-size:12.5px"><strong>${esc(JOB_KIND_LABELS[j.kind] || j.kind)}</strong>${val ? ` — «${esc(val)}${val.length >= 90 ? '…' : ''}»` : ''} <span style="color:var(--muted)">(${esc(when)})</span></div>
        <div style="display:flex;gap:8px;align-items:center">
          ${er.link ? `<a class="btn sm" href="${esc(er.link)}" target="_blank" rel="noopener noreferrer">افتح الصفحة المعدلة ›</a>` : ''}
          ${j.kind === 'delivery_promise_draft' ? `<button type="button" class="btn sm" onclick="officeOpenOrderFromJob('${esc(j.subject_ref)}')">فتح الطلب ›</button>` : ''}
        </div>
      </div>`;
    }).join('');
    return `
      <div class="of-sec-head">
        <div>
          <h2 id="of-approved-title">النتائج المعتمدة (${approved.length})</h2>
          <p>كل مسودة اعتمدتيها محفوظة هنا بنصها النهائي — انسخيها أو استخدميها وقت ما تحبي، ومفيش حاجة بتضيع.</p>
        </div>
      </div>
      ${executed.length || readyToSend.length || execFailed.length ? `
      <div class="of-manager-card" style="margin-bottom:14px">
        <div>
          <strong>المتابعة الفعلية — ما تم على أرض الواقع</strong>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">${executed.length} تعديل اتنفذ على الموقع واتحقق · ${readyToSend.length} رسالة معتمدة مستنية إرسالك من صفحة العملاء${execFailed.length ? ` · ${execFailed.length} فشل تنفيذ محتاج تدخلك` : ''}</div>
        </div>
        <div class="of-banner-badges">
          ${readyToSend.length ? `<button type="button" class="btn primary sm" onclick="go('customers')">📨 رسايل جاهزة للإرسال (${readyToSend.length})</button>` : ''}
        </div>
      </div>
      ${executed.length ? `<div style="background:#fff;border:1px solid #e7e6ec;border-radius:14px;padding:6px 16px 8px;margin-bottom:14px">${followRows}</div>` : ''}
      ` : ''}
      ${approved.length
        ? `<div class="of-jobs-grid">${approved.map(j => renderJobCard(j, { showDate: true })).join('')}</div>`
        : `<div class="of-empty">لسه مفيش نتائج معتمدة. اعتمدي أي مسودة من تاب «المسودات» وهتلاقيها هنا دايمًا بنصها النهائي الجاهز للنسخ.</div>`}
    `;
  }

  function renderDraftsTab() {
    const queuedCount = OFFICE_STATE.jobs.filter(j => j.status === 'queued').length;
    const reviewCnt = OFFICE_STATE.jobs.filter(j => j.status === 'review').length;
    const activeCnt = OFFICE_STATE.jobs.filter(j => ['queued', 'review'].includes(j.status)).length;
    const archiveCnt = OFFICE_STATE.jobs.filter(j => ['approved', 'rejected', 'failed'].includes(j.status)).length;
    const sf = OFFICE_STATE.jobStatusFilter || 'all';
    const statusRank = { review: 0, queued: 1 };
    const filteredJobs = (sf === 'all'
      ? OFFICE_STATE.jobs.filter(j => ['queued', 'review'].includes(j.status))
      : sf === 'archive'
        ? OFFICE_STATE.jobs.filter(j => ['approved', 'rejected', 'failed'].includes(j.status))
        : OFFICE_STATE.jobs.filter(j => j.status === sf)
    ).slice().sort((a, b) =>
      ((statusRank[a.status] ?? 2) - (statusRank[b.status] ?? 2))
      || (Number(b.updated_at || 0) - Number(a.updated_at || 0))
    );
    const stepping = OFFICE_INFLIGHT.has('worker_step');
    const st = OFFICE_STATE.statusInfo;

    return `
      <section aria-labelledby="of-drafts-title" class="of-wrap">
        ${isOwner() ? `
          <div class="of-sec-head">
            <div>
              <h2 id="of-drafts-title">مسودات جاهزة لقرارك (${OFFICE_STATE.jobs.length})</h2>
              <p>انسخي النص أو عدّليه أو اعتمديه — ولا حاجة بتتبعت لأي حد لوحدها. لو تغيّرت بيانات الطلب السيرفر يوقف الاعتماد القديم (409) وتحدّثيها أولًا.</p>
            </div>
            <div class="of-toolbar">
              ${st && st.openrouter ? officeAiStatusChip(st.openrouter) : ''}
              ${(() => {
                const orCfg = st && st.openrouter ? st.openrouter : null;
                const aiConfigured = !!(orCfg && ['ready', 'configured_not_tested'].includes(orCfg.status));
                const aiKinds = aiConfigured && Array.isArray(orCfg.supported_kinds) && orCfg.supported_kinds.length
                  ? orCfg.supported_kinds
                  : (aiConfigured ? ['content_draft', 'campaign_brief'] : []);
                const aiQueued = aiConfigured
                  ? OFFICE_STATE.jobs
                      .filter(j => j.status === 'queued' && aiKinds.includes(j.kind))
                      .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0))[0] || null
                  : null;
                const aiQueuedCount = aiConfigured
                  ? OFFICE_STATE.jobs.filter(j => j.status === 'queued' && aiKinds.includes(j.kind)).length
                  : 0;
                return `${aiQueued ? `
                <button type="button" class="btn primary sm" id="of-ai-step-btn" ${stepping ? 'disabled aria-busy="true"' : ''} onclick="officeRunAiStep()" data-ai-step-job="${esc(aiQueued.id)}" title="توليد مسودة تسويقية بالذكاء الاصطناعي (نموذج مجاني) — تظهر للمراجعة البشرية فقط">
                  🤖 توليد بالذكاء الاصطناعي (${esc(aiQueued.id.slice(0, 8))}…)
                </button>
                ` : ''}
                ${aiQueuedCount > 1 ? `
                <button type="button" class="btn primary sm" id="of-ai-batch-btn" ${stepping ? 'disabled aria-busy="true"' : ''} onclick="officeRunAiBatch()" title="توليد كل المسودات التسويقية في الطابور بالذكاء الاصطناعي خطوة بخطوة — واللي يفشل يتحضر محليًا بدلها">
                  ⚡ ولّد الطابور بالذكاء الاصطناعي (${aiQueuedCount})
                </button>
                ` : ''}
                <button type="button" class="btn primary sm" id="of-ai-demo-btn" ${stepping || OFFICE_INFLIGHT.has('ai_demo') ? 'disabled aria-busy="true"' : ''} onclick="officeRunAiDemo()" title="تجربة فعلية بدقيقة واحدة: بيعمل مسودة حقيقية لموديل من الكتالوج ويحاول توليدها بالذكاء الاصطناعي فورًا — النتيجة بالصدق: نجحت (الموديل كذا) أو فشلت (الكود كذا)">
                  🧪 جرّبي الـ AI الآن بمسودة حقيقية
                </button>
                <button type="button" class="btn ghost sm" id="of-ai-settings-btn" onclick="officeOpenAiSettings()">⚙ إعدادات الذكاء الاصطناعي</button>
              ${(() => {
                const ap = OFFICE_STATE.lastAutoPrepare;
                if (!ap) return '';
                if (!ap.ai_attempted && ap.ai_skipped_reason) return '<div style="width:100%;font-size:11.5px;color:var(--muted);margin-top:4px">الـ AI ما اتجربش آخر مرة — السبب: ' + esc(String(ap.ai_skipped_reason)) + ' — استخدمي «🧪 جرّبي الـ AI الآن» لتجربة فعلية</div>';
                if (!ap.ai_attempted) return '<div style="width:100%;font-size:11.5px;color:var(--muted);margin-top:4px">آخر تحضير تلقائي: مفيش مسودات تسويقية في الطابور للـ AI — استخدمي «🧪 جرّبي الـ AI الآن» لتجربة فعلية</div>';
                const errCodes = ap.steps.filter(x => x.ai_error).map(x => x.ai_error).join('، ');
                return '<div style="width:100%;font-size:11.5px;color:var(--muted);margin-top:4px">آخر تحضير تلقائي: ' + ap.ai_succeeded + ' بالذكاء الاصطناعي · ' + ap.ai_fallback + ' محلي كبديل' + (errCodes ? ' (سبب المحلي: ' + esc(errCodes) + ')' : '') + '</div>';
              })()}`;
              })()}
              <details style="width:100%;margin-top:2px">
                <summary style="cursor:pointer;font-size:12px;color:var(--muted);user-select:none">أدوات متقدمة (${queuedCount} في الطابور · ${archiveCnt} في الأرشيف)</summary>
                <div class="of-actions" style="margin-top:8px">
                  <button type="button" class="btn sm" id="of-fixture-step-btn" ${(stepping || queuedCount === 0) ? 'disabled' : ''} ${stepping ? 'aria-busy="true"' : ''} onclick="officeRunFixtureStep()">
                    ${stepping ? 'جاري تحضير المسودة...' : `تحضير المسودات المعلّقة (${queuedCount})`}
                  </button>
                  ${queuedCount > 1 ? `
                    <button type="button" class="btn sm" id="of-fixture-drain-btn" ${stepping ? 'disabled aria-busy="true"' : ''} onclick="officeRunFixtureDrain()">
                      ${stepping ? 'جاري التحضير...' : `⚡ تحضير كل الطابور للمراجعة (${queuedCount})`}
                    </button>
                  ` : ''}
                  <button type="button" class="btn ghost sm" id="of-legacy-refresh-btn" ${OFFICE_INFLIGHT.has('legacy_refresh') ? 'disabled aria-busy="true"' : ''} onclick="officeRefreshLegacyJobs()" title="إعادة تحضير المسودات القديمة بالنظام الجديد من غير تغيير قراراتها">
                    ↻ إعادة صياغة المسودات القديمة
                  </button>
                  ${archiveCnt > 0 ? `
                  <button type="button" class="btn ghost sm" id="of-purge-decided-btn" ${OFFICE_INFLIGHT.has('purge_decided') ? 'disabled aria-busy="true"' : ''} onclick="officePurgeDecidedJobs()" title="حذف المسودات المحسومة من القايمة — سجل القرارات والتدقيق بيفضل محفوظ">
                    🗑 تفريغ الأرشيف (${archiveCnt})
                  </button>
                  ` : ''}
                </div>
              </details>
            </div>
          </div>
        ` : `
          <div class="of-sec-head">
            <div>
              <h2 id="of-drafts-title">مسودات المتابعة والتشغيل (${OFFICE_STATE.jobs.length})</h2>
              <p>يمكنكِ تحضير ومتابعة المسودات التشغيلية المسموحة فقط؛ الاعتماد النهائي والمسودات المالية خاصان بالمالكة.</p>
            </div>
          </div>
        `}

        <details class="of-compose-wrap">
          <summary>＋ تحضير مسودة جديدة</summary>
          ${renderComposePanel()}
        </details>

        ${isOwner() ? renderManagerCard() : ''}

        ${OFFICE_STATE.jobs.length ? `
          <div class="filters" role="group" aria-label="تصفية المسودات حسب الحالة">
            <button type="button" class="chip ${sf === 'all' ? 'on' : ''}" aria-pressed="${sf === 'all'}" onclick="officeSetJobStatusFilter('all')">النشطة (${activeCnt})</button>
            <button type="button" class="chip ${sf === 'review' ? 'on' : ''}" aria-pressed="${sf === 'review'}" onclick="officeSetJobStatusFilter('review')">بانتظار المراجعة (${reviewCnt})</button>
            <button type="button" class="chip ${sf === 'queued' ? 'on' : ''}" aria-pressed="${sf === 'queued'}" onclick="officeSetJobStatusFilter('queued')">في الطابور (${queuedCount})</button>
            <button type="button" class="chip ${sf === 'archive' ? 'on' : ''}" aria-pressed="${sf === 'archive'}" onclick="officeSetJobStatusFilter('archive')" title="المسودات اللي اتخذ القرار فيها — بتتنضف تلقائيًا بعد ٧ أيام ويمكن تفريغها فورًا">الأرشيف — محسومة (${archiveCnt})</button>
          </div>
        ` : ''}

        ${filteredJobs.length
          ? `<div class="of-jobs-grid">${filteredJobs.map(renderJobCard).join('')}</div>`
          : `<div class="of-empty">${OFFICE_STATE.jobs.length ? 'لا توجد مسودات مطابقة لتصفية الحالة المختارة.' : 'لا توجد مسودات مسجلة بعد. يمكنكِ إضافة مسودة جديدة في الطابور من النموذج أعلاه.'}</div>`}
      </section>
    `;
  }

  function renderTeamTab() {
    const depts = ['all'];
    for (const r of OFFICE_STATE.roles) {
      if (r.department && !depts.includes(r.department)) depts.push(r.department);
    }
    const visibleRoles = OFFICE_STATE.deptFilter === 'all'
      ? OFFICE_STATE.roles
      : OFFICE_STATE.roles.filter(r => r.department === OFFICE_STATE.deptFilter);

    const openCountByRole = new Map();
    for (const c of OFFICE_STATE.cases) {
      openCountByRole.set(c.assignee_role_id, (openCountByRole.get(c.assignee_role_id) || 0) + 1);
    }
    const allowedMap = new Map(OFFICE_STATE.allowedKinds.map(k => [k.kind, k]));

    return `
      <section aria-labelledby="of-team-title" class="of-wrap">
        <div class="of-sec-head">
          <div>
            <h2 id="of-team-title">أدوار الفريق (${visibleRoles.length})</h2>
            <p>${esc(OFFICE_STATE.teamNote || 'أدوار لتوزيع المسؤوليات ومتابعة الحالات — ليست حسابات دخول مستقلة.')} <span style="color:#1b7a37;font-weight:600">بدون موظفين آليين في الخلفية.</span></p>
          </div>
        </div>

        <div class="filters" role="group" aria-label="تصفية المسؤوليات حسب القسم">
          ${depts.map(d => `
            <button type="button" class="chip ${OFFICE_STATE.deptFilter === d ? 'on' : ''}" aria-pressed="${OFFICE_STATE.deptFilter === d}" data-dept-filter="${esc(d)}" onclick="officeSetDeptFilter(this.dataset.deptFilter)">
              ${d === 'all' ? 'كل الأقسام' : esc(d)}
            </button>
          `).join('')}
        </div>

        <div class="of-team-grid">
          ${visibleRoles.map(r => {
            const openCnt = openCountByRole.get(r.id) || 0;
            const roleAllowedKinds = (r.job_kinds || []).filter(k => allowedMap.has(k));
            return `
              <article class="of-role-card" data-role-id="${esc(r.id)}">
                <div class="of-role-top">
                  <div>
                    <div class="of-role-name">${esc(r.name)}</div>
                    <div class="of-role-title">${esc(r.role)} · ${esc(r.department)}</div>
                  </div>
                  <span class="of-pill">قالب مسؤولية</span>
                </div>
                <div class="of-role-desc">${esc(r.description)}</div>
                <div class="of-role-gate"><b>حدود الدور:</b> ${esc(r.limits)}</div>
                <div class="of-meta-row">
                  <span>الحالات المفتوحة الآن: <b>${openCnt}</b></span>
                  ${roleAllowedKinds.length
                    ? `<span class="of-pill test">قالب اختبار متاح: ${roleAllowedKinds.map(k => esc(JOB_KIND_LABELS[k] || k)).join(' ، ')}</span>`
                    : `<span>نوع المتابعة: <b>إدارة بشرية مباشرة من شاشات النظام</b></span>`}
                </div>
                <div class="of-actions">
                  ${openCnt > 0 ? `
                    <button type="button" class="btn primary sm" data-filter-role="${esc(r.id)}" onclick="officeFilterCasesByRole(this.dataset.filterRole)">
                      عرض الحالات المفتوحة (${openCnt}) ›
                    </button>
                  ` : ''}
                  ${roleAllowedKinds.length ? `
                    <button type="button" class="btn sm" data-role-draft-kind="${esc(roleAllowedKinds[0])}" onclick="officeStartRoleDraft(this.dataset.roleDraftKind)">
                      تحضير قالب مسودة اختبار
                    </button>
                  ` : ''}
                </div>
              </article>
            `;
          }).join('')}
        </div>
      </section>
    `;
  }

  function timeAgoAr(ts) {
    const n = Number(ts);
    if (!Number.isFinite(n) || n <= 0) return '';
    const diffSec = Math.max(0, Math.floor(Date.now() / 1000 - n));
    if (diffSec < 60) return 'الآن';
    if (diffSec < 3600) return `منذ ${Math.floor(diffSec / 60)} دقيقة`;
    if (diffSec < 86400) return `منذ ${Math.floor(diffSec / 3600)} ساعة`;
    return `منذ ${Math.floor(diffSec / 86400)} يوم`;
  }

  /* Live company pulse: RBAC-safe activity items built from the jobs the current actor is allowed to see.
     Staff never receive financial job rows from the engine, so their ticker is financially clean by construction. */
  function buildHqTicker() {
    const rolesById = new Map(OFFICE_STATE.roles.map(r => [r.id, r]));
    const recent = OFFICE_STATE.jobs
      .slice()
      .sort((a, b) => Number(b.updated_at || 0) - Number(a.updated_at || 0))
      .slice(0, 10);
    const items = [];
    for (const j of recent) {
      const who = (rolesById.get(j.employee_id) || {}).name || j.employee_id;
      const jTitle = (j.result && j.result.title) || JOB_KIND_LABELS[j.kind] || j.kind;
      const when = timeAgoAr(j.updated_at);
      let eventText = '';
      if (j.status === 'review') {
        eventText = `${who} حضّرت مسودة «${jTitle}» — ${isOwner() ? 'بانتظار اعتمادك' : 'بانتظار المالكة'}`;
      } else if (j.status === 'queued') {
        eventText = `${who} أضافت مسودة «${jTitle}» إلى الطابور`;
      } else if (j.status === 'approved') {
        eventText = `المالكة اعتمدت مسودة «${jTitle}» — محفوظة بدون إرسال`;
      } else if (j.status === 'used_manually') {
        const ch = (j.manual_execution && j.manual_execution.channel) || 'manual';
        eventText = `تم تسجيل إرسال يدوي لمسودة «${jTitle}» عبر ${ch === 'whatsapp' ? 'واتساب' : (ch === 'copy' ? 'النسخ' : 'القناة المسجلة')}`;
      } else if (j.status === 'rejected') {
        eventText = `المالكة أرجعت مسودة «${jTitle}» للتعديل`;
      } else {
        continue;
      }
      items.push({ text: `${eventText}${when ? ` · ${when}` : ''}`, status: j.status });
    }
    return items;
  }

  function renderHqTab() {
    const rolesById = new Map(OFFICE_STATE.roles.map(r => [r.id, r]));
    const openCasesByRole = new Map();
    const latestCaseByRole = new Map();
    for (const c of OFFICE_STATE.cases) {
      openCasesByRole.set(c.assignee_role_id, (openCasesByRole.get(c.assignee_role_id) || 0) + 1);
      if (!latestCaseByRole.has(c.assignee_role_id)) latestCaseByRole.set(c.assignee_role_id, c);
    }

    const reviewByRole = new Map();
    const approvedByRole = new Map();
    const latestJobByRole = new Map();
    for (const j of OFFICE_STATE.jobs) {
      if (j.status === 'review') reviewByRole.set(j.employee_id, (reviewByRole.get(j.employee_id) || 0) + 1);
      if (j.status === 'approved') approvedByRole.set(j.employee_id, (approvedByRole.get(j.employee_id) || 0) + 1);
      if (!latestJobByRole.has(j.employee_id)) latestJobByRole.set(j.employee_id, j);
    }

    const totalReview = OFFICE_STATE.jobs.filter(j => j.status === 'review').length;
    const totalApproved = OFFICE_STATE.jobs.filter(j => j.status === 'approved').length;

    const wings = [
      {
        dept: 'الإدارة العليا',
        title: '🏛️ جناح القيادة والحوكمة',
        sub: 'تنسيق أولويات الأسبوع وفحص الخصوصية والصلاحيات قبل أي قرار',
      },
      {
        dept: 'التشغيل',
        title: '⚙️ صالة التشغيل والأتيليه وخدمة العميلات',
        sub: 'متابعة الطلبات والمقاسات والورش وفحص الجودة وسلامة بيانات الـ ERP',
      },
      {
        dept: 'التسويق',
        title: '📣 استوديو التسويق والمحتوى والنمو',
        sub: 'المحتوى العضوي والريلز وفحص صفحات الموديلات والظهور والتحويل',
      },
    ];

    return `
      <section aria-labelledby="of-hq-title" class="of-wrap">
        <div class="of-hq-hero">
          <div>
            <h2 id="of-hq-title">مكتب التشغيل — صالة المكتب الحي</h2>
            <p>${isOwner()
              ? 'اضغطي على أي دور لفتح صفحته وتحضير مسودة فورية — المراجعة والاعتماد عندك دايمًا.'
              : 'اضغطي على أي دور تشغيلي لمتابعة الحالات المسندة وطلب مسودة لمراجعة المالكة.'}</p>
          </div>
          <div class="of-hq-kpis">
            <div class="of-hq-kpi"><strong>${OFFICE_STATE.roles.length || 17}</strong><span>دور</span></div>
            <div class="of-hq-kpi"><strong>${OFFICE_STATE.cases.length}</strong><span>حالة متابعة نشطة</span></div>
            <div class="of-hq-kpi"><strong>${totalReview}</strong><span>${isOwner() ? 'بانتظار اعتمادك' : 'بانتظار المالكة'}</span></div>
            <div class="of-hq-kpi"><strong>${totalApproved}</strong><span>مسودة معتمدة</span></div>
          </div>
        </div>

        ${(() => {
          const tickerItems = buildHqTicker();
          const chips = tickerItems.length
            ? tickerItems.map(t => `<span class="of-ticker-item st-${esc(t.status)}">${esc(t.text)}</span>`).join('')
            : '<span class="of-ticker-item">المكتب جاهز — لا نشاط مسجل بعد، ابدئي بتكليف أي مكتب من الأجنحة أدناه</span>';
          return `
            <div class="of-ticker" data-of-ticker="1" aria-label="نبض المكتب الحي — آخر نشاط الشركة">
              <span class="of-ticker-label">📡 نبض المكتب الحي</span>
              <div class="of-ticker-track">${chips}</div>
            </div>
          `;
        })()}

        ${wings.map(w => {
          const wingRoles = OFFICE_STATE.roles.filter(r => r.department === w.dept);
          if (!wingRoles.length) return '';
          return `
            <div class="of-wing" data-wing-dept="${esc(w.dept)}">
              <div class="of-wing-head">
                <div>
                  <h3>${esc(w.title)} (${wingRoles.length})</h3>
                  <small>${esc(w.sub)}</small>
                </div>
                <span class="of-pill">مراجعة بشرية كاملة · 0 إرسال تلقائي</span>
              </div>
              <div class="of-desks-grid">
                ${wingRoles.map(r => {
                  const revCnt = reviewByRole.get(r.id) || 0;
                  const openCnt = openCasesByRole.get(r.id) || 0;
                  const appCnt = approvedByRole.get(r.id) || 0;
                  const lastJob = latestJobByRole.get(r.id);
                  const lastCase = latestCaseByRole.get(r.id);
                  const mgr = r.manager_id ? rolesById.get(r.manager_id) : null;
                  const mgrLabel = mgr ? mgr.name : 'المالكة مباشرة';

                  let statusBadge = `<span class="of-pill"><span class="of-live-dot" style="background:#7a8aa0;box-shadow:0 0 0 3px rgba(122,138,160,0.18)"></span>جاهز للتكليف</span>`;
                  if (revCnt > 0) {
                    statusBadge = `<span class="of-pill warn"><span class="of-live-dot"></span>${isOwner() ? `بانتظار اعتمادك (${revCnt})` : `بانتظار المالكة (${revCnt})`}</span>`;
                  } else if (openCnt > 0) {
                    statusBadge = `<span class="of-pill info"><span class="of-live-dot" style="background:#2f6fae;box-shadow:0 0 0 3px rgba(47,111,174,0.18)"></span>حالات نشطة (${openCnt})</span>`;
                  } else if (appCnt > 0) {
                    statusBadge = `<span class="of-pill ok"><span class="of-live-dot" style="background:#2e8b57;box-shadow:0 0 0 3px rgba(46,139,87,0.18)"></span>معتمد (${appCnt})</span>`;
                  }

                  let bubbleText = r.deliverable;
                  if (lastJob) {
                    const jTitle = (lastJob.result && lastJob.result.title) || JOB_KIND_LABELS[lastJob.kind] || lastJob.kind;
                    bubbleText = `آخر مسودة: ${jTitle}`;
                  } else if (lastCase) {
                    bubbleText = `متابعة نشطة (${lastCase.subject_code}): ${lastCase.reason_ar}`;
                  }

                  return `
                    <button type="button" class="of-desk-card ${revCnt > 0 && isOwner() ? 'has-review' : ''}" data-desk-id="${esc(r.id)}" onclick="officeOpenRoleDesk(this.dataset.deskId)">
                      <div class="of-desk-top">
                        <span class="of-desk-avatar" style="background:${esc(r.color || '#53796b')}">${esc(r.initial || r.name.slice(0, 1))}</span>
                        <div class="of-desk-who">
                          <strong>${esc(r.name)}</strong>
                          <span>${esc(r.role)} · التنسيق مع: ${esc(mgrLabel)}</span>
                        </div>
                      </div>
                      <div class="of-desk-bubble">${esc(bubbleText)}</div>
                      <div class="of-desk-foot">
                        ${statusBadge}
                        <span style="font-size:12px;font-weight:700;color:#274b7a">فتح المكتب ›</span>
                      </div>
                    </button>
                  `;
                }).join('')}
              </div>
            </div>
          `;
        }).join('')}
      </section>
    `;
  }

  async function officeView() {
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    if (OFFICE_STATE.freshData) {
      OFFICE_STATE.freshData = false;
    } else {
      try {
        await fetchOfficeBundle({ sync: !OFFICE_STATE.loadedOnce, expectedGen: gen, expectedUid: uid });
      } catch (err) {
        if (err && err.staleSession) return '';
        throw err;
      }
    }
    if (!isCurrentSession(gen, uid)) return '';

    const reviewCount = isOwner() ? OFFICE_STATE.jobs.filter(j => j.status === 'review').length : OFFICE_STATE.jobs.length;

    let bodyHtml = '';
    if (OFFICE_STATE.loading && !OFFICE_STATE.loadedOnce) {
      bodyHtml = `<div class="of-loading" role="status">جاري تحميل ملخص يومك والمسودات...</div>`;
    } else if (OFFICE_STATE.error) {
      bodyHtml = `
        <div class="of-error-box" role="alert">
          <strong>تعذر تحميل البيانات</strong>
          ${esc(OFFICE_STATE.error)}
          <div style="margin-top:10px">
            <button type="button" class="btn sm primary" onclick="officeRetryLoad()">إعادة المحاولة</button>
          </div>
        </div>
      `;
    } else if (OFFICE_STATE.tab === 'hq') {
      bodyHtml = renderHqTab();
    } else if (OFFICE_STATE.tab === 'drafts') {
      bodyHtml = renderDraftsTab();
    } else if (OFFICE_STATE.tab === 'approved') {
      bodyHtml = renderApprovedTab();
    } else if (OFFICE_STATE.tab === 'team') {
      bodyHtml = renderTeamTab();
    } else if (OFFICE_STATE.tab === 'chat') {
      bodyHtml = renderChatTab();
    } else {
      bodyHtml = renderSummaryTab();
    }

    const cycling = OFFICE_INFLIGHT.has('daily_cycle');
    return `
      <div class="topbar" style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        <div>
          <h1>${isOwner() ? 'ملخص يومك والموافقات والفريق' : 'ملخص يومك والمتابعة التشغيلية'}</h1>
          <div class="sub">${isOwner()
            ? 'متابعة الحالات الحقيقية بالأولوية، ومراجعة المسودات قبل الاعتماد، وقوالب مسؤوليات الفريق الـ١٧.'
            : 'متابعة الحالات التشغيلية اليومية ومسودات التنفيذ المسموحة بدون أي بيانات مالية.'}</div>
        </div>
        ${isOwner() ? `
          <div class="of-toolbar">
            <button type="button" class="btn primary sm" id="of-daily-cycle-btn" ${cycling ? 'disabled aria-busy="true"' : ''} onclick="officeRunDailyCycle()">
              ${cycling ? 'جاري تشغيل دورة اليوم...' : '⚡ فحص اليوم وتحضير مسودات المتابعة'}
            </button>
            <details class="of-owner-tools">
              <summary>أدوات المالكة</summary>
              <div class="of-actions" style="margin-top:8px">
                <button type="button" class="btn sm" id="of-readiness-btn" onclick="officeShowReadinessModal()">
                  🚀 جاهزية التشغيل الفعلي
                </button>
                <button type="button" class="btn ghost sm" id="of-audit-log-btn" onclick="officeShowAuditLog()">
                  سجل القرارات والمراجعات
                </button>
              </div>
            </details>
          </div>
        ` : ''}
      </div>

      <div class="of-tabs" role="tablist" aria-label="أقسام المكتب والمتابعة" onkeydown="officeTabsKeydown(event)">
        <button type="button" role="tab" id="of-tab-summary" class="of-tab" aria-selected="${OFFICE_STATE.tab === 'summary'}" tabindex="${OFFICE_STATE.tab === 'summary' ? '0' : '-1'}" onclick="officeSwitchTab('summary')">
          <span>اليوم</span>
          <span class="of-tab-cnt">${OFFICE_STATE.cases.length}</span>
        </button>
        <span class="of-tabs-divider" aria-hidden="true"></span>
        <button type="button" role="tab" id="of-tab-hq" class="of-tab of-tab-sec" aria-selected="${OFFICE_STATE.tab === 'hq'}" tabindex="${OFFICE_STATE.tab === 'hq' ? '0' : '-1'}" onclick="officeSwitchTab('hq')">
          <span>مكتب التشغيل</span>
        </button>
        <button type="button" role="tab" id="of-tab-drafts" class="of-tab" aria-selected="${OFFICE_STATE.tab === 'drafts'}" tabindex="${OFFICE_STATE.tab === 'drafts' ? '0' : '-1'}" onclick="officeSwitchTab('drafts')">
          <span>${isOwner() ? 'المسودات' : 'مسودات المتابعة'}</span>
          <span class="of-tab-cnt">${reviewCount}</span>
        </button>
        <button type="button" role="tab" id="of-tab-approved" class="of-tab" aria-selected="${OFFICE_STATE.tab === 'approved'}" tabindex="${OFFICE_STATE.tab === 'approved' ? '0' : '-1'}" onclick="officeSwitchTab('approved')">
          <span>النتائج المعتمدة</span>
          <span class="of-tab-cnt">${OFFICE_STATE.jobs.filter(j => j.status === 'approved').length || ''}</span>
        </button>
        <button type="button" role="tab" id="of-tab-team" class="of-tab of-tab-sec" aria-selected="${OFFICE_STATE.tab === 'team'}" tabindex="${OFFICE_STATE.tab === 'team' ? '0' : '-1'}" onclick="officeSwitchTab('team')">
          <span>الأدوار</span>
        </button>
        <button type="button" role="tab" id="of-tab-chat" class="of-tab" aria-selected="${OFFICE_STATE.tab === 'chat'}" tabindex="${OFFICE_STATE.tab === 'chat' ? '0' : '-1'}" onclick="officeSwitchTab('chat')">
          <span>💬 شات الفريق</span>
          <span class="of-tab-cnt">${OFFICE_STATE.chat.pending || ''}</span>
        </button>
      </div>

      <div id="of-tabpanel" role="tabpanel" aria-labelledby="of-tab-${esc(OFFICE_STATE.tab)}" style="margin-top:14px">
        ${bodyHtml}
      </div>
    `;
  }

  /* ---------- Interactive handlers ---------- */
  window.officeView = officeView;
  window.officeDashWidgetHtml = officeDashWidgetHtml;
  window.officeOpenCaseCount = () => OFFICE_STATE.cases.length;

  window.officeGoTab = function (tab) {
    OFFICE_STATE.tab = tab || 'summary';
    if (typeof VIEW !== 'undefined') VIEW = 'office';
    if (typeof render === 'function') return render();
  };

  window.officeSwitchTab = function (tab) {
    OFFICE_STATE.tab = tab;
    if (typeof render === 'function') return render();
  };

  window.officeTabsKeydown = function (event) {
    const order = ['summary', 'hq', 'drafts', 'team', 'chat'];
    const idx = order.indexOf(OFFICE_STATE.tab);
    if (idx === -1) return;
    const rtl = document.documentElement.dir !== 'ltr';
    let nextIdx = -1;
    if (event.key === 'ArrowLeft') nextIdx = rtl ? (idx + 1) % order.length : (idx - 1 + order.length) % order.length;
    else if (event.key === 'ArrowRight') nextIdx = rtl ? (idx - 1 + order.length) % order.length : (idx + 1) % order.length;
    else if (event.key === 'Home') nextIdx = 0;
    else if (event.key === 'End') nextIdx = order.length - 1;
    if (nextIdx !== -1) {
      event.preventDefault();
      OFFICE_STATE.tab = order[nextIdx];
      if (typeof render === 'function') {
        Promise.resolve(render()).then(() => {
          const btn = document.getElementById('of-tab-' + OFFICE_STATE.tab);
          if (btn) btn.focus();
        });
      }
    }
  };

  window.officeRetryLoad = function () {
    OFFICE_STATE.loadedOnce = false;
    OFFICE_STATE.freshData = false;
    if (typeof render === 'function') return render();
  };

  window.officeOpenSubject = function (subjectType, subjectId, subjectCode) {
    if (subjectType === 'order' && subjectCode) {
      if (typeof openOrder === 'function') openOrder(String(subjectCode));
      return;
    }
    if (subjectType === 'custom_request' && isOwner() && typeof window.maviOpenCustomAdmin === 'function') {
      window.maviOpenCustomAdmin(Number(subjectId));
    }
  };

  window.officeOpenOrderFromJob = function (orderCode) {
    if (orderCode && typeof openOrder === 'function') {
      openOrder(String(orderCode));
    }
  };

  window.officeFilterCasesByRole = function (roleId) {
    OFFICE_STATE.roleFilter = roleId;
    OFFICE_STATE.tab = 'summary';
    OFFICE_STATE.freshData = OFFICE_STATE.loadedOnce;
    if (typeof render === 'function') return render();
  };

  window.officeClearRoleFilter = function () {
    OFFICE_STATE.roleFilter = '';
    OFFICE_STATE.freshData = OFFICE_STATE.loadedOnce;
    if (typeof render === 'function') return render();
  };

  window.officeSetDeptFilter = function (dept) {
    OFFICE_STATE.deptFilter = dept || 'all';
    OFFICE_STATE.freshData = OFFICE_STATE.loadedOnce;
    if (typeof render === 'function') return render();
  };

  window.officePrefillDraftFromCase = function (subjectCode, caseKind, subjectType, subjectId) {
    OFFICE_STATE.compose.error = '';
    if (subjectType === 'custom_request' && isOwner() && OFFICE_STATE.allowedKinds.some(k => k.kind === 'custom_design_followup_draft')) {
      OFFICE_STATE.compose.kind = 'custom_design_followup_draft';
      OFFICE_STATE.compose.request_id = String(subjectId || '');
    } else {
      OFFICE_STATE.compose.order_code = subjectCode;
      if (caseKind === 'workshop_unassigned' && OFFICE_STATE.allowedKinds.some(k => k.kind === 'workshop_followup_draft')) {
        OFFICE_STATE.compose.kind = 'workshop_followup_draft';
      } else if (['needs_quote', 'receipt_pending_review', 'deposit_unpaid'].includes(caseKind) && isOwner() && OFFICE_STATE.allowedKinds.some(k => k.kind === 'deposit_followup_draft')) {
        OFFICE_STATE.compose.kind = 'deposit_followup_draft';
      } else {
        OFFICE_STATE.compose.kind = 'order_followup_draft';
        OFFICE_STATE.compose.focus = caseKind === 'missing_measurements' ? 'measurements' : 'schedule';
      }
    }
    OFFICE_STATE.tab = 'drafts';
    OFFICE_STATE.freshData = OFFICE_STATE.loadedOnce;
    if (typeof render === 'function') return render();
  };

  window.officeStartRoleDraft = function (kind) {
    if (OFFICE_STATE.allowedKinds.some(k => k.kind === kind)) {
      OFFICE_STATE.compose.kind = kind;
      OFFICE_STATE.compose.error = '';
    }
    OFFICE_STATE.tab = 'drafts';
    OFFICE_STATE.freshData = OFFICE_STATE.loadedOnce;
    if (typeof render === 'function') return render();
  };

  window.officeUpdateComposeKind = function (kind) {
    OFFICE_STATE.compose.kind = kind;
    OFFICE_STATE.compose.error = '';
    OFFICE_STATE.freshData = OFFICE_STATE.loadedOnce;
    if (typeof render === 'function') return render();
  };

  window.officeSetComposeField = function (field, value) {
    OFFICE_STATE.compose[field] = value;
  };

  window.officeRunSync = async function () {
    if (OFFICE_INFLIGHT.has('sync')) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add('sync');
    const btn = document.getElementById('of-sync-btn');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    let hasFresh = false;
    let authEnded = false;
    try {
      await officeApi('/cases/sync', { method: 'POST', body: {} }, gen, uid);
      hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      if (isCurrentSession(gen, uid)) {
        toast('تم تحديث حالات المتابعة');
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تحديث الحالات');
    } finally {
      OFFICE_INFLIGHT.delete('sync');
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
    }
  };

  window.officeSubmitCompose = async function () {
    if (OFFICE_INFLIGHT.has('create_job')) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add('create_job');
    OFFICE_STATE.compose.error = '';
    const btn = document.getElementById('of-create-job-btn');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    let hasFresh = false;
    let authEnded = false;
    try {
      const kind = OFFICE_STATE.compose.kind;
      let payload;
      if (kind === 'order_followup_draft') {
        payload = {
          order_code: String(OFFICE_STATE.compose.order_code || '').trim().toUpperCase(),
          focus: OFFICE_STATE.compose.focus || 'schedule',
        };
      } else if (
        kind === 'workshop_followup_draft' ||
        kind === 'deposit_followup_draft' ||
        kind === 'quality_delivery_checklist' ||
        kind === 'customer_reply_draft'
      ) {
        payload = {
          order_code: String(OFFICE_STATE.compose.order_code || '').trim().toUpperCase(),
        };
      } else if (kind === 'custom_design_followup_draft') {
        payload = {
          request_id: Number(OFFICE_STATE.compose.request_id || 0),
        };
      } else if (kind === 'executive_weekly_plan') {
        payload = {
          holiday_budget_egp: Number(OFFICE_STATE.compose.holiday_budget_egp || 100),
        };
      } else if (
        kind === 'daily_ops_triage' ||
        kind === 'security_privacy_audit' ||
        kind === 'erp_data_health_report' ||
        kind === 'funnel_attribution_report'
      ) {
        payload = {};
      } else if (
        kind === 'seo_readiness_check' ||
        kind === 'visual_reel_brief' ||
        kind === 'landing_page_check'
      ) {
        payload = {
          product_id: String(OFFICE_STATE.compose.product_id || 'DEMO-PUBLIC-01').trim(),
        };
      } else if (kind === 'campaign_brief' || kind === 'paid_ad_setup_draft') {
        payload = {
          product_id: String(OFFICE_STATE.compose.product_id || 'DEMO-PUBLIC-01').trim(),
          channel: OFFICE_STATE.compose.channel || 'instagram',
          daily_budget_egp: Number(OFFICE_STATE.compose.daily_budget_egp || 100),
        };
      } else {
        payload = {
          product_id: String(OFFICE_STATE.compose.product_id || 'DEMO-PUBLIC-01').trim(),
          channel: OFFICE_STATE.compose.channel || 'instagram',
        };
      }
      await officeApi('/jobs', {
        method: 'POST',
        body: {
          kind,
          payload,
          idempotency_key: makeIdempotencyKey('ui-job'),
        },
      }, gen, uid);
      hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      if (isCurrentSession(gen, uid)) {
        toast('تمت إضافة المسودة في الطابور بدون إرسال');
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) {
        OFFICE_STATE.compose.error = err.message || 'راجعي بيانات المسودة وحاولي مرة أخرى';
      }
    } finally {
      OFFICE_INFLIGHT.delete('create_job');
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
    }
  };

  /* ---------- شات الفريق (رسائل + طلبات موافقة/رفض) ---------- */
  const CHAT_KIND_AR = {
    content_draft: 'مسودة محتوى',
    community_followup_draft: 'متابعة مجتمع',
    visual_reel_brief: 'بريف ريلز',
    seo_readiness_check: 'فحص SEO',
    landing_page_check: 'فحص صفحة الهبوط',
    style_page_copy_draft: 'وصف صفحة موديل (تنفيذ حقيقي)',
    collection_copy_draft: 'وصف مجموعة (تنفيذ حقيقي)',
    delivery_promise_draft: 'موعد تسليم (تنفيذ حقيقي)',
  };
  const CHAT_STATUS_AR = { pending: 'بانتظار قرارك', approved: 'تمت الموافقة ✓', rejected: 'مرفوض ✗' };

  function renderChatTab() {
    const c = OFFICE_STATE.chat;
    if (!c.loaded) {
      window.officeLoadChat();
      return `<div class="of-loading" role="status">جاري تحميل شات الفريق...</div>`;
    }
    const rows = c.messages.map((m) => {
      const isOwnerMsg = m.sender_role === 'owner';
      const reqBadge = m.request_kind
        ? `<span class="of-pill test">طلب: ${esc(CHAT_KIND_AR[m.request_kind] || m.request_kind)} · ${CHAT_STATUS_AR[m.request_status] || ''}</span>`
        : '';
      const decided = m.request_kind && m.request_status !== 'pending'
        ? `<small style="color:var(--muted)">${CHAT_STATUS_AR[m.request_status] || ''}${m.job_id ? ' · ' + esc(String(m.job_id).slice(0, 8)) + '…' : ''}${m.decision_note ? ' — ' + esc(m.decision_note) : ''}</small>`
        : '';
      const decide = isOwner() && m.request_kind && m.request_status === 'pending'
        ? `<div style="margin-top:8px;padding:10px 12px;border:1px solid #bfdfc2;border-inline-start:4px solid #1a7f37;border-radius:12px;background:#f7fbf7">
             <strong style="color:#14532d;font-size:13px;display:block;margin-bottom:8px">⬅ القرار المطلوب منك:</strong>
             <div style="display:flex;gap:8px;flex-wrap:wrap">
               <button type="button" class="btn primary sm" onclick="officeChatDecide(${Number(m.id)}, 'approve')">✅ اعتماد — المسودة تتحضر للمراجعة</button>
               <button type="button" class="btn danger sm" onclick="officeChatDecide(${Number(m.id)}, 'reject')">✗ مرفوض</button>
             </div>
           </div>`
        : '';
      return `<div class="of-chat-msg ${isOwnerMsg ? 'of-chat-owner' : ''}">
        <small style="color:var(--muted)"><strong>${esc(m.sender_name)}</strong> · ${esc(String(m.created_at || '').slice(0, 16))}</small>
        <p style="margin:6px 0 4px">${esc(m.body)}</p>
        ${reqBadge}${decided}${decide}
      </div>`;
    }).join('') || `<p style="font-size:12px;color:var(--muted)">لسه مفيش رسائل — ابدأ المحادثة 👋</p>`;

    const requestComposer = isOwner() ? '' : `
          <div class="fld">
            <label>نوع الطلب (اختياري — بيوصلك قرار المالكة هنا)</label>
            <select id="of-chat-kind" onchange="officeChatKindChanged()">
              <option value="">رسالة عادية بدون طلب</option>
              <option value="content_draft">🤖 مسودة بوست (تتولد بالـ AI)</option>
              <option value="community_followup_draft">🤖 متابعة مجتمع (تتولد بالـ AI)</option>
              <option value="visual_reel_brief">🤖 بريف ريلز (تتولد بالـ AI)</option>
              <option value="seo_readiness_check">🤖 فحص SEO (تتولد بالـ AI)</option>
              <option value="landing_page_check">🤖 فحص صفحة الهبوط (تتولد بالـ AI)</option>
              <option value="style_page_copy_draft">🤖 وصف صفحة موديل — تنفيذ حقيقي بعد موافقتها</option>
              <option value="collection_copy_draft">🤖 وصف مجموعة المتجر — تنفيذ حقيقي بعد موافقتها</option>
              <option value="delivery_promise_draft">📅 موعد تسليم طلب — تنفيذ حقيقي بعد موافقتها (محلي)</option>
            </select>
            <div id="of-chat-req-fields"></div>
          </div>`;

    return `
      <div class="of-sec-head">
        <h2>شات الفريق</h2>
        <p class="of-muted">رسائل وطلبات بينك وبين الفريق — التنسيق فقط، بدون أرقام مالية أو بيانات حساسة.</p>
      </div>
      <div class="of-chat-list">${rows}</div>
      <div style="margin-top:12px;border-top:1px solid var(--line);padding-top:12px">
        ${requestComposer}
        <div class="fld">
          <label>رسالتك</label>
          <textarea id="of-chat-body" maxlength="1000" rows="2" placeholder="اكتبي رسالتك هنا..."></textarea>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
          <button type="button" class="btn primary sm" onclick="officeChatSend()">إرسال</button>
          <button type="button" class="btn sm" onclick="officeLoadChat()">🔄 تحديث</button>
        </div>
      </div>`;
  }

  window.officeLoadChat = async function () {
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    try {
      const res = await officeApi('/chat', {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      OFFICE_STATE.chat = {
        loaded: true,
        messages: Array.isArray(res.messages) ? res.messages : [],
        pending: Number(res.pending_count) || 0,
      };
      if (typeof render === 'function') render();
    } catch (err) {
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تحميل الشات');
    }
  };

  window.officeChatKindChanged = function () {
    const holder = document.getElementById('of-chat-req-fields');
    if (!holder) return;
    const kindSel = document.getElementById('of-chat-kind');
    const kind = kindSel ? kindSel.value : '';
    if (!kind) { holder.innerHTML = ''; return; }
    const needChannel = kind === 'content_draft' || kind === 'community_followup_draft';
    const isPromise = kind === 'delivery_promise_draft';
    const isCollection = kind === 'collection_copy_draft';
    const idLabel = isPromise ? 'رقم الطلب (الكود)' : (isCollection ? '' : 'معرّف الموديل');
    const idPlaceholder = isPromise ? 'مثال: MAVI-1024' : 'مثال: DR-04';
    const collectionField = isCollection ? `
      <label style="font-size:12px;margin-top:6px">المجموعة</label>
      <select id="of-chat-section" style="width:100%;max-width:220px">
        <option value="all">الكل — المجموعة الكاملة</option>
        <option value="summer">الصيفي</option>
        <option value="winter">الشتوي</option>
        <option value="trend">المجموعة المميزة</option>
        <option value="offers">العروض</option>
      </select>` : '';
    holder.innerHTML = collectionField + (isCollection ? '' : `
      <label style="font-size:12px;margin-top:6px">${idLabel}</label>
      <input id="of-chat-product" maxlength="40" placeholder="${idPlaceholder}" style="width:100%;max-width:220px">
      ${needChannel ? `<label style="font-size:12px;margin-top:6px">القناة</label>
      <select id="of-chat-channel" style="width:100%;max-width:220px">
        <option value="instagram">إنستجرام</option>
        <option value="facebook">فيسبوك</option>
      </select>` : ''}
    `);
  };

  window.officeChatSend = async function () {
    if (OFFICE_INFLIGHT.has('chat_send')) return;
    const bodyEl = document.getElementById('of-chat-body');
    const text = bodyEl ? String(bodyEl.value || '') : '';
    if (!text.trim()) { toast('اكتبي رسالة الأول'); return; }
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add('chat_send');
    let authEnded = false;
    try {
      const kindSel = document.getElementById('of-chat-kind');
      const kind = kindSel && kindSel.value ? kindSel.value : '';
      const payload = { body: text, request_kind: kind, request_payload: '' };
      if (kind) {
        const pidEl = document.getElementById('of-chat-product');
        const chEl = document.getElementById('of-chat-channel');
        const pid = pidEl ? pidEl.value.trim().toUpperCase() : '';
        if (kind === 'collection_copy_draft') {
          const sel = document.getElementById('of-chat-section');
          payload.request_payload = { section: sel && sel.value ? sel.value : 'all' };
        } else if (kind === 'style_page_copy_draft') {
          payload.request_payload = { style_id: pid };
        } else if (kind === 'delivery_promise_draft') {
          payload.request_payload = { order_code: pid };
        } else {
          payload.request_payload = ['content_draft', 'community_followup_draft'].includes(kind)
            ? { product_id: pid, channel: chEl ? chEl.value : 'instagram' }
            : { product_id: pid };
        }
      }
      await officeApi('/chat', { method: 'POST', body: payload }, gen, uid);
      if (isCurrentSession(gen, uid)) {
        if (bodyEl) bodyEl.value = '';
        toast(kind ? 'اتبعت الطلب — بانتظار قرار المالكة ✅' : 'اتبعتت رسالتك ✅');
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر الإرسال');
    } finally {
      OFFICE_INFLIGHT.delete('chat_send');
      if (!authEnded) {
        const hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid }).then(() => true).catch(() => false);
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
    }
  };

  window.officeChatDecide = async function (id, decision) {
    if (!isOwner() || OFFICE_INFLIGHT.has('chat_decide')) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add('chat_decide');
    let hasFresh = false;
    let authEnded = false;
    try {
      await officeApi(`/chat/requests/${id}/decision`, {
        method: 'POST',
        body: { decision, note: '' },
      }, gen, uid);
      hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      if (isCurrentSession(gen, uid)) {
        toast(decision === 'approve' ? 'تمت الموافقة — المهمة اتبعتت للطابور ✅' : 'تم رفض الطلب');
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تنفيذ القرار');
    } finally {
      OFFICE_INFLIGHT.delete('chat_decide');
      if (!authEnded) await rerenderAfterLockRelease(gen, uid, hasFresh);
    }
  };

  const AI_PROVIDER_ERROR_AR = {
    openrouter_disabled: 'ربط الذكاء الاصطناعي غير مفعّل على السيرفر',
    openrouter_disabled_in_staging: 'وضع التدريج يمنع أي اتصال خارجي',
    missing_or_invalid_server_key: 'مفتاح OpenRouter غير مضاف أو غير صالح في إعدادات السيرفر',
    only_free_model_ids_are_allowed: 'الموديل المختار ليس مجانيًا — مسموح النماذج المجانية فقط',
    provider_auth_failed: 'مفتاح OpenRouter مرفوض — راجعي المفتاح في إعدادات السيرفر',
    provider_credit_or_quota_required: 'الموديل المطلوب غير مجاني — لازم موديل ينتهي بـ :free',
    provider_access_denied: 'المزود رفض الوصول لهذا الموديل',
    free_model_unavailable: 'الموديل المجاني غير متاح حاليًا — اختاري موديل :free آخر',
    provider_rate_limited_no_automatic_retry: 'زحمة مؤقتة على الموديل المجاني ده — الدفعة الجاية هتختار موديل مختلف تلقائيًا؛ جربي بعد ٥–١٠ دقايق أو ثبّتي موديل من القايمة',
    provider_free_daily_cap: 'الحد اليومي للنماذج المجانية خلص على حسابك كلو في OpenRouter (مش موديل معين!) — بينعده تلقائي بعد منتصف الليل بتوقيت UTC (٢–٣ صباحًا بتوقيتنا). كل ضغطة تجربة بتخصم من نفس الرصيد اليومي',
    provider_connection_failed_no_automatic_retry: 'تعذر الاتصال بـ OpenRouter — بدون إعادة محاولة تلقائية',
    unexpected_reported_cost_stop_and_check_dashboard: 'تحذير: ظهرت تكلفة غير صفرية! راجعي لوحة OpenRouter فورًا',
    ai_provider_kind_not_supported: 'هذا النوع لا يدعم التوليد بالذكاء الاصطناعي — مسودة AI للتسويق فقط',
    product_not_found: 'الموديل غير موجود في الكتالوج',
    invalid_or_incomplete_draft_response: 'الموديل رجّع رد مش قابل للتحليل — جربي مرة تانية، ولو تكرر ثبّتي موديل أقوى من ⚙ الإعدادات بدل التلقائي',
    provider_reply_truncated: 'الرد اتنصّف من الموديل (حد التوكنات) — جربي مرة تانية، ولو تكررت اختاري موديل مجاني أخف',
    invalid_provider_response: 'رد غير صالح من المزود — حاولي مرة أخرى لاحقًا',
    provider_response_redacted: 'تم حجب رد المزود لأمان المفاتيح — حاولي مرة أخرى',
    subject_not_active: 'تغيّرت بيانات الموديل أثناء التوليد — حدّثي المسودة وجرّبي من جديد',
  };

  window.officeRunAiStep = async function () {
    if (!isOwner() || OFFICE_INFLIGHT.has('worker_step')) return;
    const btn = document.getElementById('of-ai-step-btn');
    const jobId = btn ? btn.getAttribute('data-ai-step-job') : '';
    if (!jobId) { toast('لا توجد مسودة تسويقية في الطابور للتوليد بالذكاء الاصطناعي'); return; }
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add('worker_step');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    const stepBtn = document.getElementById('of-fixture-step-btn');
    if (stepBtn) { stepBtn.disabled = true; }
    let hasFresh = false;
    let authEnded = false;
    try {
      const res = await officeApi('/worker/step', {
        method: 'POST',
        body: { provider: 'openrouter', job_id: jobId },
      }, gen, uid);
      hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      if (isCurrentSession(gen, uid)) {
        const s = res && res.step;
        if (s && s.status === 'review') {
          toast(`تم توليد المسودة بالذكاء الاصطناعي (${s.model_reported || 'نموذج مجاني'}) — بانتظار مراجعتك واعتمادك`);
        } else if (s && s.status === 'idle') {
          toast('المسودة لم تكن في الطابور — حدّثي الصفحة');
        } else {
          const code = s && s.error_code;
          toast('فشل التوليد: ' + (AI_PROVIDER_ERROR_AR[code] || code || 'خطأ غير معروف'));
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر التوليد بالذكاء الاصطناعي');
    } finally {
      OFFICE_INFLIGHT.delete('worker_step');
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
    }
  };

  window.officeRunAiBatch = async function () {
    if (!isOwner() || OFFICE_INFLIGHT.has('worker_step')) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add('worker_step');
    const btn = document.getElementById('of-ai-batch-btn');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    const stepBtn = document.getElementById('of-fixture-step-btn');
    if (stepBtn) { stepBtn.disabled = true; }
    let hasFresh = false;
    let authEnded = false;
    try {
      const res = await officeApi('/worker/ai-batch', { method: 'POST', body: { max_steps: 10 } }, gen, uid);
      hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      if (isCurrentSession(gen, uid)) {
        const sum = res && res.summary;
        if (!sum || (!sum.ai_succeeded && !sum.ai_fallback)) {
          toast('مفيش مسودات تسويقية في الطابور للتوليد بالذكاء الاصطناعي');
        } else if (sum.ai_fallback) {
          toast('اتولد ' + sum.ai_succeeded + ' بالذكاء الاصطناعي و ' + sum.ai_fallback + ' اتحضرت محليًا كبديل صادق (الـ AI فشل عليها) — الكل بانتظار مراجعتك');
        } else {
          toast('تم توليد ' + sum.ai_succeeded + ' مسودة بالذكاء الاصطناعي — كلها بانتظار مراجعتك');
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر التوليد بالذكاء الاصطناعي');
    } finally {
      OFFICE_INFLIGHT.delete('worker_step');
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
    }
  };

  window.officeRegenerateAi = async function (jobId) {
    if (!isOwner() || OFFICE_INFLIGHT.has('worker_step')) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add('worker_step');
    document.querySelectorAll('[data-regen-job="' + jobId + '"]').forEach(b => { b.disabled = true; b.setAttribute('aria-busy', 'true'); });
    let hasFresh = false;
    let authEnded = false;
    try {
      const res = await officeApi('/jobs/' + encodeURIComponent(jobId) + '/regenerate-ai', { method: 'POST', body: {} }, gen, uid);
      hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      if (isCurrentSession(gen, uid)) {
        const r = res && res.step;
        if (r && r.mode === 'ai') {
          toast('تم إعادة التوليد بالذكاء الاصطناعي (' + (r.model_reported || 'نموذج مجاني') + ') — بانتظار مراجعتك');
        } else if (r && r.mode === 'fixture_fallback') {
          const code = r && r.error_code;
          toast('الذكاء الاصطناعي فشل (' + (AI_PROVIDER_ERROR_AR[code] || code || 'خطأ') + ') — رجّعنا المسودة المحلية بدل ما تضيع');
        } else {
          const code = r && r.error_code;
          toast('فشل التوليد: ' + (AI_PROVIDER_ERROR_AR[code] || code || 'خطأ غير معروف'));
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر إعادة التوليد');
    } finally {
      OFFICE_INFLIGHT.delete('worker_step');
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
    }
  };

  /* One-click output: copy the current draft text (review or approved) — the
     actual deliverable the owner wants. Copying is local-only, never a send. */
  window.officeCopyDraftText = async function (jobId) {
    const j = OFFICE_STATE.jobs.find((x) => x.id === jobId);
    const text = j && j.result && j.result.text;
    if (!text) { toast('مفيش نص محفوظ للمسودة دي'); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast('📋 النص اتنسخ — جاهز تلصقيه في إنستجرام أو فيسبوك أو أي مكان');
    } catch (_) {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        toast('📋 النص اتنسخ — جاهز تلصقيه في إنستجرام أو فيسبوك');
      } catch (_e) {
        toast('انسخي النص يدويًا من الكارت — التحديد التلقائي مش متاح في المتصفح ده');
      }
    }
  };

  window.officeRunAiDemo = async function () {
    if (!isOwner() || OFFICE_INFLIGHT.has('ai_demo')) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add('ai_demo');
    const btn = $('of-ai-demo-btn');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    let hasFresh = false;
    let authEnded = false;
    try {
      const res = await officeApi('/ai/demo-draft', { method: 'POST', body: {} }, gen, uid);
      hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      if (isCurrentSession(gen, uid)) {
        const r = res && res.result;
        if (r && r.mode === 'ai') {
          toast('✅ نجح التوليد بالذكاء الاصطناعي فعلًا — الموديل ' + (r.model || 'المجاني المختار') + ' — مسودة ' + (r.product_id || '') + ' في «بانتظار المراجعة»');
        } else if (r && r.mode === 'fixture_fallback') {
          const tried = r.model_attempted ? ' على الموديل [' + r.model_attempted + ']' : '';
          const says = r.provider_says ? ' — المزوّد بيقول حرفيًا: «' + r.provider_says + '»' : '';
          toast('🟡 الـ AI فشل' + tried + ' — ' + (AI_PROVIDER_ERROR_AR[r.ai_error] || r.ai_error || 'خطأ') + says + ' — المسودة اتحضرت محليًا كبديل');
        } else {
          const tried = r && r.model_attempted ? ' على الموديل [' + r.model_attempted + ']' : '';
          const says2 = r && r.provider_says ? ' — المزوّد بيقول حرفيًا: «' + r.provider_says + '»' : '';
          toast('❌ التجربة ما كملتش' + tried + ': ' + (AI_PROVIDER_ERROR_AR[r && r.ai_error] || (r && r.ai_error) || 'خطأ غير معروف') + says2);
        }
        if (window.officeRenderAiActivity) officeRenderAiActivity();
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast('مسودة التجربة: ' + (err.message || 'تعذر التنفيذ'));
    } finally {
      OFFICE_INFLIGHT.delete('ai_demo');
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      } else if (btn) {
        btn.disabled = false; btn.removeAttribute('aria-busy');
      }
    }
  };

  window.officeRunFixtureStep = async function () {
    if (!isOwner() || OFFICE_INFLIGHT.has('worker_step')) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add('worker_step');
    const btn = document.getElementById('of-fixture-step-btn');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    let hasFresh = false;
    let authEnded = false;
    try {
      const res = await officeApi('/worker/step', {
        method: 'POST',
        body: { provider: 'fixture' },
      }, gen, uid);
      hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      if (isCurrentSession(gen, uid)) {
        if (res.step && res.step.status === 'idle') {
          toast('لا توجد مسودات في الطابور حاليًا');
        } else {
          toast('تم تحضير المسودة — بانتظار مراجعة واعتماد المالكة');
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تحضير المسودة');
    } finally {
      OFFICE_INFLIGHT.delete('worker_step');
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
    }
  };

  window.officeRefreshLegacyJobs = async function () {
    if (!isOwner() || OFFICE_INFLIGHT.has('legacy_refresh')) return;    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add('legacy_refresh');
    const btn = document.getElementById('of-legacy-refresh-btn');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    let authEnded = false;
    try {
      const res = await officeApi('/jobs/refresh-legacy', { method: 'POST', body: {} }, gen, uid);
      const n = Number(res && res.refreshed) || 0;
      if (isCurrentSession(gen, uid)) {
        toast(n > 0 ? `تمت إعادة صياغة ${n} مسودة قديمة بالنظام الجديد — القرارات لم تتغير` : 'كل المسودات محدثة بالنظام الجديد بالفعل ✅');
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر إعادة صياغة المسودات القديمة');
    } finally {
      OFFICE_INFLIGHT.delete('legacy_refresh');
      if (!authEnded) await rerenderAfterLockRelease(gen, uid, false);
    }
  };

  /* ---------- Office AI (OpenRouter free provider) — owner settings ---------- */
  function officeAiStatusChip(orCfg) {
    const s = orCfg.status || 'none';
    const test = orCfg.last_test;
    const testNote = test && test.ok
      ? ` · اختبار الاتصال: ناجح (${esc(String(test.model || ''))})`
      : (test && !test.ok ? ' · آخر اختبار: فشل' : '');
    if (s === 'ready') {
      return `<span class="of-pill ok" title="المزوّد المجاني مفعّل ويولّد المسودات التسويقية عند الضغط على زر الذكاء الاصطناعي">✨ الذكاء الاصطناعي: مفعّل (${esc(String(orCfg.model || 'openrouter/free'))})${testNote}</span>`
        + `<button type="button" class="btn ghost sm" style="padding:2px 8px" onclick="officeOpenAiSettings()">⚙</button>`;
    }
    if (s === 'configured_not_tested' || s === 'missing_or_invalid_server_key') {
      return `<span class="of-pill test" title="المفتاح محفوظ لكن الاتصال لم يُختبر بعد">✨ الذكاء الاصطناعي: محفوظ — اختبري الاتصال${testNote}</span>`
        + `<button type="button" class="btn ghost sm" style="padding:2px 8px" onclick="officeOpenAiSettings()">⚙</button>`;
    }
    return `<span class="of-pill test" title="المسودات التسويقية تُحضَّر محليًا. فعّلي المزوّد المجاني من إعدادات الذكاء الاصطناعي">✨ الذكاء الاصطناعي: غير مفعّل</span>`
      + `<button type="button" class="btn ghost sm" style="padding:2px 8px" onclick="officeOpenAiSettings()">⚙</button>`;
  }

  /* The general manager's report card: one place that shows everything the
     agents prepared and turns the owner's single decision into action for the
     whole team (bulk approve/reject; per-card decisions stay available). */
  function renderManagerCard() {
    const reviewJobs = OFFICE_STATE.jobs.filter(j => j.status === 'review' && j.result_hash);
    const queuedJobs = OFFICE_STATE.jobs.filter(j => j.status === 'queued');
    const archiveJobs = OFFICE_STATE.jobs.filter(j => ['approved', 'rejected', 'failed'].includes(j.status));
    const byKind = {};
    for (const j of reviewJobs) byKind[j.kind] = (byKind[j.kind] || 0) + 1;
    const breakdown = Object.entries(byKind).map(([k, n]) => `${JOB_KIND_LABELS[k] || k} (${n})`).join(' · ');
    const inflight = OFFICE_INFLIGHT.has('bulk_review');
    return `
      <div class="of-manager-card" aria-labelledby="of-manager-title">
        <div>
          <strong id="of-manager-title">مسودات جاهزة لقرارك (${reviewJobs.length})</strong>
          ${reviewJobs.length ? `<div style="margin-top:2px;color:#8a93a3;font-size:12px">بانتظار قرارك: ${esc(breakdown)}</div>` : ''}
          ${(queuedJobs.length || archiveJobs.length) ? `<div style="margin-top:2px;color:var(--muted);font-size:12px">في الطابور: ${queuedJobs.length} · بالنتائج المعتمدة: ${archiveJobs.length}</div>` : ''}
        </div>
        <div class="of-banner-badges">
          ${reviewJobs.length ? `
          <button type="button" class="btn primary sm" id="of-bulk-approve-btn" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeBulkReview('approve')" title="اعتماد كل المسودات الجاهزة (${reviewJobs.length}) — كلها بتتنقل ل«النتائج المعتمدة»">
            ✅ اعتماد الكل (${reviewJobs.length})
          </button>
          <button type="button" class="btn danger sm" id="of-bulk-reject-btn" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeBulkReview('reject')" title="رفض كل المسودات الجاهزة (${reviewJobs.length}) — تتحضر من جديد بصياغة تانية">
            ✗ رفض الكل (${reviewJobs.length})
          </button>` : '<span class="of-pill ok">مفيش مسودات مستنية قرار ✅</span>'}
        </div>
      </div>`;
  }

  window.officeBulkReview = async function (decision) {
    if (!isOwner() || OFFICE_INFLIGHT.has('bulk_review')) return;
    const targets = OFFICE_STATE.jobs
      .filter(j => j.status === 'review' && j.result_hash)
      .map(j => ({ id: j.id, expected_revision: j.revision, expected_result_hash: j.result_hash }));
    if (!targets.length) { toast('مفيش مسودات بانتظار القرار'); return; }
    if (!window.confirm(decision === 'approve'
      ? `هتعتمدي ${targets.length} مسودة مرة واحدة؟ كل معتمدة هتنقل شغلها لفريقها والخطوات التالية هتتحضر فورًا للمراجعة.`
      : `هترفضي ${targets.length} مسودة مرة واحدة؟ هترجع لموظفيها لإعادة الصياغة.`)) return;
    const gen = OFFICE_SESSION_GEN, uid = currentUserId();
    OFFICE_INFLIGHT.add('bulk_review');
    document.querySelectorAll('#of-bulk-approve-btn, #of-bulk-reject-btn').forEach(b => {
      b.disabled = true; b.setAttribute('aria-busy', 'true');
    });
    try {
      const res = await officeApi('/jobs/bulk-review', { method: 'POST', body: { decision, targets } }, gen, uid);
      if (isCurrentSession(gen, uid)) {
        const failedNote = res.failed ? ` (${res.failed} محتاجة تحديث بيانات — شوف التنبيه في كروتها)` : '';
        toast(decision === 'approve'
          ? `المدير نفّذ قرارك ✅ — اعتماد ${res.approved} مسودة${failedNote}. الخطوات التالية في الطابور ورامي أبلغ الفريق في الشات`
          : `المدير نفّذ قرارك — رفض ${res.rejected} مسودة${failedNote} ورجعت لموظفيها`);
        if (typeof VIEW !== 'undefined' && (VIEW === 'office' || VIEW === 'dash')) {
          const hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
          await rerenderAfterLockRelease(gen, uid, hasFresh);
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) return;
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تنفيذ القرار الجماعي');
    } finally {
      OFFICE_INFLIGHT.delete('bulk_review');
      document.querySelectorAll('#of-bulk-approve-btn, #of-bulk-reject-btn').forEach(b => {
        b.disabled = false; b.removeAttribute('aria-busy');
      });
    }
  };

  window.officeOpenAiSettings = function () {
    if (!isOwner()) return;
    const st = OFFICE_STATE.statusInfo || {};
    const cfg = st.openrouter || {};
    const test = cfg.last_test;
    const content = `
      <div class="inv-form-note">المزوّد مجاني بالكامل (نماذج :free فقط) ويُستخدم لمسودات التسويق المرتبطة بالموديلات العامة من الكتالوج — مسودات الطلبات والورش والعربون تبقى محلية من بيانات النظام لأنها بيانات عميلات ولا تُرسل لأي جهة خارجية. كل مسودة AI تظهر لكِ للمراجعة قبل أي استخدام.</div>
      <label class="inv-field">مفتاح OpenRouter (يُحفظ في قاعدة البيانات ولا يظهر كاملًا بعد الحفظ)
        <input id="of-ai-key" type="password" dir="ltr" maxlength="256" placeholder="${cfg.key_present ? '••••' + esc(String(cfg.key_tail || '')) + ' (اتركيه فارغًا للإبقاء)' : 'sk-or-v1-...'}">
      </label>
      <label class="inv-field">الموديل المجاني — «openrouter/free» معناها تلقائي: السيرفر يختار موديل مجاني متاح فعلًا
        <input id="of-ai-model" type="text" dir="ltr" maxlength="120" list="of-ai-model-list" value="${esc(String(cfg.model || 'openrouter/free'))}">
        <datalist id="of-ai-model-list"></datalist>
        <small id="of-ai-models-note" style="color:var(--muted)">جاري تحميل قايمة الموديلات المجانية المتاحة...</small>
      </label>
      <label class="inv-field" style="display:flex;gap:8px;align-items:center"><input id="of-ai-enabled" type="checkbox" ${cfg.enabled ? 'checked' : ''}> تفعيل توليد المسودات التسويقية بالذكاء الاصطناعي</label>
      <div class="inv-form-note" id="of-ai-test-result">${test ? (test.ok ? 'آخر اختبار: ✅ ناجح — الموديل ' + esc(String(test.model || '')) + ' (' + Number(test.latency_ms || 0) + 'ms)' : 'آخر اختبار: ❌ فشل — ' + esc(officeAiTestHint(test.error_code))) : (cfg.status === 'ready' ? 'المفتاح محفوظ ومفعّل — لم يُختبر الاتصال الحي بعد.' : 'غير مفعّل حاليًا.')}</div>
      ${(() => {
        const ali = st.alibaba || {};
        const aliTest = ali.last_test;
        return `<div style="border-top:1px dashed var(--line);margin-top:14px;padding-top:12px">
          <b style="font-size:12.5px">طبقة احتياط: Alibaba Cloud — موديلات Qwen (تجربة مجانية محدودة)</b>
          <div class="inv-form-note">كوتة مجانية مؤقتة لكل موديل (تقريبًا مليون توكن / ٩٠ يوم). بدون فيزا على الحساب مفيش أي فاتورة ممكنة — الكوتة تخلص والخدمة بتوقف لوحدها. عدّاد محلي بيقفل قبل النهاية. النظام بيستخدمها بس لو OpenRouter مش جاهز.</div>
          <div class="inv-form-note">⚠️ في الكونسول المفتاح بيتعرض مخفي بنقط — لازم تكشفيه (أيقونة العين) أو تنسخيه بزرار النسخ جنب السطر، عشان اللي يوصل هنا هو المفتاح الحقيقي مش النقط. بيبدأ بـ sk- وطوله عشرات الحروف.</div>
          <div class="inv-form-note" style="color:#b45309">💡 أسهل طريقة مضمونة: في صفحة API-KEY نزّلي **الشيت (Export/تنزيل CSV)** — افتحيه وانسخي محتواه كله والصقيه في الخانة دي: النظام يسحب المفتاح **والنطاق الخاص بحسابك** لوحده. (أو: Create API Key وانسخي من نافذة الإنشاء — بيظهر كامل مرة واحدة بس.) ملاحظة: مفتاح ٢٠٢٦ فيه نقاط جواه — ده طبيعي.</div>
          <label class="inv-field">مفتاح DashScope (من حساب Alibaba Cloud — يُحفظ هنا ولا يظهر كاملًا)
            <input id="of-ai2-key" type="password" dir="ltr" maxlength="4000" oninput="ofAi2PasteCheck()" placeholder="${ali.key_present ? '••••' + esc(String(ali.key_tail || '')) + ' (اتركيه فارغًا للإبقاء)' : 'sk-...'}">
          </label>
          <label class="inv-field">موديل Qwen (الكوتة لكل موديل منفصل — مثال: qwen-plus أو qwen3-235b-a22b أو qwen4-max — اختاري من القايمة أو اكتبي)
            <input id="of-ai2-model" type="text" dir="ltr" maxlength="60" list="of-ai2-model-list" value="${esc(String(ali.model || 'qwen-plus'))}">
            <datalist id="of-ai2-model-list"><option value="qwen4-max"></option><option value="qwen-plus"></option><option value="qwen3-235b-a22b"></option><option value="qwen-flash"></option></datalist>
          </label>
          <div class="inv-form-note" id="of-ai2-paste-state"></div>
          <label class="inv-field">🎬 الأسهل: اختاري ملف الشيت من الجهاز مباشرة — من غير نسخ ولا لصق
            <input type="file" accept=".csv,text/csv,text/plain" onchange="ofAi2SheetFile(this)">
          </label>
          <label class="inv-field">منطقة الحساب — لو «اختبار Alibaba» طلع «المفتاح اترفض» بدّلي المنطقة دي واحفظي (مفاتيح كل منطقة مختلفة عن التانية)
            <select id="of-ai2-region" style="width:100%">
              <option value="intl" ${ali.region !== 'cn' ? 'selected' : ''}>سنغافورة / العالمي (dashscope-intl) — الافتراضي للحسابات المسجلة عالميًا</option>
              <option value="cn" ${ali.region === 'cn' ? 'selected' : ''}>الصين — بكين (dashscope.aliyuncs.com)</option>
            </select>
          </label>
          <label class="inv-field" style="display:flex;gap:8px;align-items:center"><input id="of-ai2-enabled" type="checkbox" ${ali.enabled ? 'checked' : ''}> تفعيل طبقة Alibaba كاحتياط عند تعذر OpenRouter</label>
          <div class="inv-form-note" id="of-ai2-test-result">${aliTest ? (aliTest.ok ? 'آخر اختبار: ✅ ناجح — ' + esc(String(aliTest.model || '')) + ' (' + Number(aliTest.latency_ms || 0) + 'ms)' : 'آخر اختبار: ❌ ' + esc(officeAiTestHint(aliTest.error_code, 'alibaba'))) : (ali.key_present ? 'المفتاح محفوظ — لم يُختبر بعد.' : 'مفيش مفتاح محفوظ — الصقي المفتاح اللي بيبدأ بـ sk- واضغطي «حفظ وتفعيل» الأول، وبعدين اختبري الاتصال.')} ${Number.isFinite(ali.tokens_remaining) ? '· المتبقي في الحارس: ' + Number(ali.tokens_remaining).toLocaleString('en') + ' توكن' : ''}</div>
        </div>`;
      })()}`;
    showInventoryModal('إعدادات الذكاء الاصطناعي (المالكة)', 'مفتاح OpenRouter من حسابك المجاني — الاستخدام للنماذج المجانية فقط بدون أي صرف.', content + '<div id="of-ai-activity"></div>',
      `<button class="btn sm" id="of-ai-test-btn" onclick="officeTestAi()">🔌 اختبر OpenRouter</button>
       <button class="btn sm" id="of-ai2-test-btn" onclick="officeTestAi2()">🔌 اختبر Alibaba</button>
       <button class="btn primary" id="of-ai-save-btn" onclick="officeSaveAiConfig()">💾 حفظ وتفعيل</button>`);
    officeLoadAiModels();
    officeRenderAiActivity();
  };

  /* Real provider activity (persisted on the drafts — no memory-only claims):
     what actually succeeded, what fell back locally and WHY. */
  window.officeRenderAiActivity = async function () {
    const holder = document.getElementById('of-ai-activity');
    if (!holder) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    try {
      const r = await officeApi('/ai/config', {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      if (r && r.alibaba && OFFICE_STATE.statusInfo) OFFICE_STATE.statusInfo.alibaba = r.alibaba;
      const act = r && r.activity;
      if (!act) { holder.innerHTML = ''; return; }
      const cfgS = (r && r.openrouter) || {};
      const ready = cfgS.status === 'ready';
      const zero = !act.last_24h.ai_ok && !act.last_24h.fallback && !act.last_24h.failed && !(act.recent || []).length;
      const rows = (act.recent || []).map((a) => {
        const mode = a.mode === 'ai' ? '✅ بالذكاء الاصطناعي' + (a.model ? ' — ' + esc(String(a.model)) : '') : a.mode === 'fixture_fallback' ? '🟡 محلي كبديل — الـ AI فشل' : '❌ فشل نهائي';
        const kindAr = JOB_KIND_LABELS[a.kind] || a.kind;
        const detail = (a.ai_error ? ' — ' + esc(String(a.ai_error)) : '')
          + (a.model_attempted ? ' [' + esc(String(a.model_attempted)) + ']' : '')
          + (a.provider_says ? ' («' + esc(String(a.provider_says)) + '»)' : '');
        return '<div style="display:flex;justify-content:space-between;gap:8px;padding:5px 0;border-bottom:1px dashed var(--line)"><span>' + esc(kindAr) + '</span><span>' + mode + detail + '</span></div>';
      }).join('');
      holder.innerHTML = '<div style="margin-top:12px;border-top:1px solid var(--line);padding-top:10px"><b style="font-size:12px">نشاط المولّد الفعلي (آخر ٢٤ ساعة):</b>'
        + '<div style="font-size:12px;margin-top:4px">' + (ready
          ? '<span style="color:#1a7f37">✅ المولّد جاهز فعلًا</span>' + (cfgS.model ? ' — الموديل: <bdi dir="ltr">' + esc(String(cfgS.model)) + '</bdi>' : '') + (cfgS.last_test && cfgS.last_test.ok ? ' · آخر اختبار اتصال: ناجح (' + Number(cfgS.last_test.latency_ms || 0) + 'ms)' : '')
          : '⚠️ المولّد مش جاهز — ' + esc(officeAiTestHint(cfgS.status))) + '</div>'
        + '<div style="font-size:12px;color:var(--muted);margin-top:4px">' + act.last_24h.ai_ok + ' نجح بالذكاء الاصطناعي · ' + act.last_24h.fallback + ' اتحضر محليًا كبديل · ' + act.last_24h.failed + ' فشل نهائي</div>'
        + (zero ? '<div style="font-size:12px;color:var(--muted);margin-top:6px">الصفر ده صادق: لسه مفيش أي محاولة توليد فعلية. أنواع التخطيط المالي (زي إعداد الحملة الإعلانية) محلية بالتصميم ومش بتتفتح للـ AI أصلًا. للتجربة الفعلية دلوقتي: دوسي «🧪 جرّبي الـ AI الآن بمسودة حقيقية» من شريط أدوات المكتب — هتعمل مسودة لموديل حقيقي من المتجر، تحاول توليدها فورًا، وتقول لكِ بالصدق: نجحت بالموديل كذا، أو فشلت بالكود كذا.</div>' : '')
        + (rows || '<div style="color:var(--muted);font-size:12px;margin-top:6px">لسه مفيش محاولات مولّد مسجلة.</div>')
        + '</div>';
    } catch (err) {
      if (isCurrentSession(gen, uid)) holder.innerHTML = '<div style="color:var(--muted);font-size:12px;margin-top:8px">تعذر تحميل نشاط المولّد — ' + esc(String(err.message || '')) + '</div>';
    }
  };

  function officeAiTestHint(code, provider) {
    const hints = {
      provider_auth_failed: 'المفتاح غير مقبول من OpenRouter — راجعي المفتاح من حسابك وإنسخيه من جديد',
      provider_credit_or_quota_required: 'OpenRouter رفض لأن الحساب بلا رصيد/سقف — الشغل هنا مجاني فقط، اختاري موديل :free',
      free_model_unavailable: 'الموديل المختار مش متاح دلوقتي — الدفعة الجاية هتختار بديل تلقائيًا؛ أو اختاري موديل من القايمة بنفسك',
      provider_rate_limited_no_automatic_retry: 'زحمة مؤقتة على الموديل المجاني — جربي بعد ٥–١٠ دقايق أو اختاري موديل تاني من القايمة',
      provider_free_daily_cap: 'الحد اليومي للنماذج المجانية خلص على حسابك كلو — بينعده تلقائي بعد منتصف الليل UTC (٢–٣ صباحًا بتوقيتنا)',
      provider_access_denied: 'OpenRouter رفض الوصول — راجعي إعدادات حسابك (privacy/limits)',
      invalid_or_incomplete_draft_response: 'الموديل رجّع رد مش قابل للتحليل — جربي تاني، ولو تكرر ثبّتي موديل أقوى من القايمة بدل التلقائي',
      provider_reply_truncated: 'الرد اتنصّف من الموديل (حد التوكنات) — جربي مرة تانية أو موديل أخف',
      openrouter_disabled: 'التفعيل مقفول — فعّلي «توليد المسودات» واحفظي الأول',
      missing_or_invalid_server_key: 'مفيش مفتاح محفوظ أو المفتاح بشكل غلط — الصقي المفتاح كامل',
      only_free_model_ids_are_allowed: 'الموديلات المدفوعة غير مسموحة — النماذج المجانية (:free) فقط',
    };
    const aliHints = {
      provider_auth_failed: 'جرّبنا كل النطاقات الرسمية تلقائيًا (الإقليمي بدون معرف مساحة + مساحتك + Token Plan + القديم) والكل رفض بنفس المفتاح. حسب دليل QwenCloud الرسمي ده معناه واحد من اتنين: (1) المفتاح معمول في منطقة مختلفة عن نطاق الاختبار — اتأكدي إن المنطقة سنغافورة ap-southeast-1 في الكونسول، أو (2) المفتاح من خطة Token Plan وبيتدق على نطاق الدفع حسب الاستخدام (أو العكس) — استخدمي مفتاح من نفس الخطة اللي بتختاريها، أو اعملي مفتاح جديد من نفس مساحة الخدمة المختارة',
      missing_or_invalid_server_key: 'مفيش مفتاح Alibaba محفوظ — الصقي المفتاح اللي بيبدأ بـ sk- واضغطي «حفظ وتفعيل» الأول، وبعدين اختبري الاتصال',
      only_qwen_model_ids_are_allowed: 'مسموح بموديلات Qwen فقط (مثلًا qwen-plus) — اكتبي اسم الموديل من جديد',
      alibaba_quota_guard_reached: 'حارس الكوتة المحلي قفل — العدّاد وصل للسقف قبل ما الكوتة تخلص؛ النظام رجّع OpenRouter تلقائيًا',
      provider_request_failed_no_automatic_retry: 'المفتاح اتقبل بس الطلب فشل على السيرفر — جربي زر الاختبار تاني بعد دقيقة، ولو تكرر قوليلي «الاختبار فشل» واسم الموديل',
      openrouter_disabled: 'طبقة Alibaba مقفولة من الخانة — نزّلي تحت آخر المودال وعلّمي على «تفعيل طبقة Alibaba كاحتياط عند تعذر OpenRouter» ثم اضغطي «حفظ وتفعيل» (المفتاح والنطاق محفوظين بالفعل ومش محتاجين إعادة اختيار ملف)',
    };
    const map = provider === 'alibaba' ? aliHints : hints;
    const generic = provider === 'alibaba'
      ? 'جربي مرة تانية — لو فضلت المشكلة اتأكدي إن المفتاح sk-... منسوخ كامل من غير مسافات أو نقاط، وإن المنطقة (سنغافورة/العالمي) مطابقة لحسابك'
      : 'جربي مرة تانية، ولو فضلت المشكلة جربي موديل مجاني تاني من القايمة';
    return `${code || 'تعذر الاتصال'} — ${map[code] || generic}`;
  }

  /* Live paste verdict BEFORE saving: the console shows keys masked/truncated
     after creation, so copies often carry no full key at all. The field itself
     now tells the owner instantly whether the paste contains a usable key. */
  window.ofAi2PasteCheck = function () {
    const fld = $('of-ai2-key');
    const st = $('of-ai2-paste-state');
    if (!fld || !st) return;
    const raw = String(fld.value || '');
    if (!raw) { st.textContent = ''; return; }
    if (/openAiCompatible[\t,]|apiHost[\t,]|workspaceId[\t,]|apiKey[\t,]|compatible-mode\/v1/.test(raw)) {
      // EOL-agnostic: the console CSV may use \r\n, \n or bare \r separators.
      // Single-line exports join pairs with commas — capture ONLY key chars
      // (A-Z a-z 0-9 _ . -) so the match stops at the next pair's comma.
      const km = raw.match(/apiKey[\t,]\s*(sk-[A-Za-z0-9_.-]{8,200})/);
      const t = km ? km[1].replace(/\.+$/, '') : '';
      const hasWs = /workspaceId[\t,]\s*ws-[A-Za-z0-9]+/.test(raw);
      const hasUrl = /https:\/\/[a-z0-9.-]+\.(aliyuncs|qwencloudapi)\.com\/[a-z0-9./_-]*compatible-mode\/v1/.test(raw);
      if (t) {
        st.textContent = '✅ الشيت اتلصق صح — المفتاح (طوله ' + t.length + ' حرف)' + (/aliyuncs\.com/.test(raw) || /qwencloudapi\.com/.test(raw) || hasWs ? ' والنطاق هيتظبط تلقائيًا' : '') + '. اضغطي «حفظ وتفعيل»';
        st.style.color = 'var(--ok, #1a7f37)';
      } else if (hasUrl) {
        st.textContent = '✅ رابط النطاق اتلصق صح — اضغطي «حفظ وتفعيل» والمفتاح المحفوظ هيفضل زي ما هو';
        st.style.color = 'var(--ok, #1a7f37)';
      } else {
        st.textContent = 'الشيت من غير سطر apiKey ولا رابط نطاق — انسخي رابط «OpenAI Compatible» بزرار النسخ من صفحة API-KEY أو نزّلي الشيت';
        st.style.color = '#b45309';
      }
      return;
    }
    const tokens = raw.match(/sk-[A-Za-z0-9_.-]{8,200}/g);
    if (tokens) {
      const best = tokens.slice().sort((a, b) => b.length - a.length)[0].replace(/\.+$/, '');
      if (/sk-ws-/.test(best) && !raw.includes('aliyuncs.com')) {
        st.textContent = '⚠️ المفتاح سليم (طوله ' + best.length + ' حرف) بس ناقصه سطر النطاق — مفتاح sk-ws- بيشتغل بس مع نطاق حسابك من الشيت. افتحي ملف الشيت وانسخيه كله (Ctrl+A) والصقيه هنا';
        st.style.color = '#b45309';
        return;
      }
      st.textContent = '✅ اتلصق مفتاح سليم (طوله ' + best.length + ' حرف بعد sk-) — جاهز: اضغطي «حفظ وتفعيل»';
      st.style.color = 'var(--ok, #1a7f37)';
    } else {
      st.textContent = '⚠️ اللي اتلصق (' + raw.length + ' حرف) مفيهوش مفتاح كامل — أسهل طريقة: نزّلي الشيت (Export CSV) من صفحة API-KEY والصقيه هنا كامل، أو اعملي مفتاح جديد (Create API Key) وانقليه من نافذة الإنشاء فورًا';
      st.style.color = '#b45309';
    }
  };

  /* Three-state auth verdict from the SAVED facts (length + endpoint):
     truncated copy / workspace key on the generic host / a key Alibaba itself
     refuses. No more guessing between them. */
  function aliAuthVerdict(res) {
    const len = Number(res && res.key_length || 0);
    const host = String(res && res.api_host || '');
    if (len < 30) return 'النسخة المحفوظة مقصوصة (' + len + ' حرف) — نزّلي الشيت (Export CSV) من صفحة API-KEY والصقيه كامل في الخانة ثم اضغطي «حفظ وتفعيل»';
    if (host && !host.includes('maas.aliyuncs.com')) return 'المفتاح محفوظ كامل (' + len + ' حرف) بس النطاق العام — مفتاحك نوع sk-ws- مربوط بنطاق حسابك: الصقي الشيت كامل (فيه سطر openAiCompatible) واحفظي';
    return 'المفتاح (' + len + ' حرف) والنطاق مظبوطين وAlibaba برضه رفضه — اتأكدي إن المفتاح ظاهر ومفعّل في صفحة API-KEY، ولو أول مرة فعّلي خدمة Model Studio من الكونسول، أو اعملي مفتاح جديد';
  }
  /* Zero-copy path: pick the console's CSV file and the field fills itself.
     No clipboard, no partial selection, no Excel tab/cometer surprises. */
  window.ofAi2SheetFile = function (inp) {
    const f = inp && inp.files && inp.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const fld = $('of-ai2-key');
      const incoming = String(rd.result || '').replace(/^\uFEFF/, ''); // strip BOM
      if (fld) {
        const cur = String(fld.value || '');
        // Choosing a SECOND sheet APPENDS: the keys-list sheet carries the
        // openAiCompatible endpoint, the create-dialog sheet the fresh key.
        fld.value = cur && /apiKey/.test(cur) && /apiKey/.test(incoming)
          ? cur.replace(/\s*$/, '') + '\n' + incoming
          : incoming;
      }
      if (window.ofAi2PasteCheck) ofAi2PasteCheck();
      toast('الشيت اتقرى من الملف — اضغطي «حفظ وتفعيل»');
    };
    rd.readAsText(f, 'utf-8');
  };

  window.officeTestAi2 = async function () {
    const btn = $('of-ai2-test-btn');
    const out = $('of-ai2-test-result');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    const gen = OFFICE_SESSION_GEN, uid = currentUserId();
    try {
      const res = await officeApi('/ai/alibaba/test', { method: 'POST', body: {} }, gen, uid);
      const meta = ' — الطول المحفوظ: ' + Number(res.key_length || 0) + ' حرف' + (res.api_host ? ' · النطاق: ' + res.api_host : '') + (res.host_healed === true ? ' · ✨ النطاق اتصلّح تلقائيًا واتحفظ' : '');
      if (out) out.textContent = res.ok
        ? `اختبار Alibaba: ✅ ناجح — الموديل ${res.model || ''} (${Number(res.latency_ms || 0)}ms)` + meta
        : `اختبار Alibaba: ❌ ` + (res.error_code === 'provider_auth_failed' ? aliAuthVerdict(res) : officeAiTestHint(res.error_code, 'alibaba')) + meta;
    } catch (err) {
      if (out) out.textContent = 'اختبار Alibaba: ❌ ' + (err.message || 'تعذر الاتصال');
    } finally {
      if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
    }
  };

  window.officeLoadAiModels = async function () {
    const list = document.getElementById('of-ai-model-list');
    const note = document.getElementById('of-ai-models-note');
    if (!list) return;
    const gen = OFFICE_SESSION_GEN, uid = currentUserId();
    try {
      const res = await officeApi('/ai/models', { method: 'GET' }, gen, uid);
      const models = Array.isArray(res && res.models) ? res.models : [];
      if (!isCurrentSession(gen, uid)) return;
      list.innerHTML = models.map(m => `<option value="${esc(m)}"></option>`).join('');
      if (note) note.textContent = models.length
        ? `متاح دلوقتي ${models.length} موديل مجاني — اختاري من القايمة تحت خانة الموديل أو سيبيه openrouter/free للتلقائي`
        : 'معرفتش تجيب قايمة الموديلات دلوقتي — اكتبي الموديل يدوي (مثلًا meta-llama/llama-3.3-70b-instruct:free) أو استخدمي التلقائي openrouter/free';
    } catch (_) { /* models list is best-effort */ }
  };

  window.officeSaveAiConfig = async function () {
    const btn = $('of-ai-save-btn');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    const gen = OFFICE_SESSION_GEN, uid = currentUserId();
    try {
      // Paste artifacts (quotes/wrapping/invisible chars) are cleaned before send —
      // a real provider key never contains any of them, so this is always safe.
      const cleanKey = (v) => String(v || '')
        .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
        .replace(/["'«»„‟“”‘’]/g, '')
        .replace(/\s+/g, '');
      const body = {
        model: ($('of-ai-model') || {}).value || 'openrouter/free',
        enabled: !!($('of-ai-enabled') || {}).checked,
      };
      const orKey = cleanKey(($('of-ai-key') || {}).value);
      if (orKey) body.api_key = orKey; // the field promises "leave empty to keep" — so an empty field must never wipe the saved key
      const key2raw = String(($('of-ai2-key') || {}).value || '')
        .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
        .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660));
      if (key2raw && /[•*·●○◦]/.test(key2raw)) {
        toast('اللي منسوخ فيه نقط إخفاء (•) — ده النص المخفي المعروض مش المفتاح. نزّلي الشيت (Export CSV) من صفحة API-KEY والصقيه هنا كامل');
        if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
        return;
      }
      // Two honest inputs: the console's CSV export (key + workspace endpoint,
      // parsed server-side) or a bare sk- token. 2026 keys contain DOTS
      // (sk-ws-H.x.y...) — no client-side format verdicts beyond that.
      // NOTE: no client-side endpoint guard here — the SERVER knows whether a
      // workspace endpoint is already saved and is the single gatekeeper; the
      // create-dialog sheet legitimately carries no endpoint lines.
      const isCsv2 = /openAiCompatible[\t,]|apiHost[\t,]|workspaceId[\t,]|^apiKey[\t,]|https:\/\/[a-z0-9.-]+\.(aliyuncs|qwencloudapi)\.com/m.test(key2raw);
      let key2 = '';
      if (isCsv2) {
        key2 = key2raw; // the whole sheet goes to the server: key + endpoint
        const km2 = key2raw.match(/apiKey[\t,]\s*(sk-[A-Za-z0-9_.-]{8,200})/);
        if (km2) { const fld2 = $('of-ai2-key'); if (fld2) fld2.value = km2[1].replace(/\.+$/, ''); }
      } else {
        const pickLongest2 = (arr) => arr.slice().sort((a, b) => b.length - a.length)[0];
        const tokens2 = key2raw.match(/sk-[A-Za-z0-9_.-]{8,200}/g);
        const glued2 = tokens2 ? null : key2raw.replace(/\s+/g, '').match(/sk-[A-Za-z0-9_.-]{8,200}/g);
        if (!tokens2 && !glued2 && /compatible-mode\/v1/.test(key2raw)) {
          key2 = key2raw; // endpoint-only paste: server updates the base and KEEPS the saved key
        } else {
          key2 = tokens2 ? pickLongest2(tokens2).replace(/\.+$/, '') : (glued2 ? pickLongest2(glued2).replace(/\.+$/, '') : key2raw.replace(/\s+/g, ''));
          if (key2) { const fld2 = $('of-ai2-key'); if (fld2) fld2.value = key2; }
        }
        const isUrlOnly = /^https:\/\/[a-z0-9.-]+\.(aliyuncs|qwencloudapi)\.com\//.test(key2) && /compatible-mode\/v1/.test(key2);
        if (key2 && !isUrlOnly && !key2.startsWith('sk-')) {
          toast('النص اللي اتلصق (' + key2.length + ' حرف) مفيهوش مفتاح بيبدأ بـ sk- — أسهل طريقة: انسخي رابط «OpenAI Compatible» بزرار النسخ من صفحة API-KEY والصقيه هنا، أو نزّلي الشيت');
          if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
          return;
        }
      }
      const res = await officeApi('/ai/config', { method: 'POST', body }, gen, uid);
      let alibabaSummary = null;
      const model2 = ($('of-ai2-model') || {}).value;
      const enabled2 = !!($('of-ai2-enabled') || {}).checked;
      const region2 = (($('of-ai2-region') || {}).value || 'intl');
      {
        const body2 = { model: model2 || 'qwen-plus', enabled: enabled2, region: region2 };
        if (key2) body2.api_key = key2; // sheet text (server parses) or the bare token; empty field keeps the saved key
        const res2 = await officeApi('/ai/alibaba/config', { method: 'POST', body: body2 }, gen, uid);
        alibabaSummary = res2 && res2.alibaba;
      }
      OFFICE_STATE.statusInfo = Object.assign({}, OFFICE_STATE.statusInfo, { openrouter: res.openrouter, ...(alibabaSummary ? { alibaba: alibabaSummary } : {}) });
      try { await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid }); } catch (_) { /* background refresh is best-effort */ }
      const savedLen = alibabaSummary && alibabaSummary.key_present ? String(alibabaSummary.key_tail || '').length >= 0 : null;
      const tailTxt = alibabaSummary && alibabaSummary.key_present ? ' — المفتاح المحفوظ للـ Alibaba طوله ' + (Number(alibabaSummary.key_length) || '?') + ' حرف وبيبدأ بـ sk-' : '';
      toast('اتحفظ ✅' + tailTxt + ' — بختبر الاتصال لوحدي، النتيجة تظهر فوق في كل قسم');
      void savedLen;
      try { await officeTestAi(); } catch (_) { /* the result line shows the failure */ }
      try { await officeTestAi2(); } catch (_) { /* the result line shows the failure */ }
      if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
    } catch (err) {
      toast(err.message || 'تعذر حفظ الإعدادات');
      if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
    }
  };

  window.officeTestAi = async function () {
    const btn = $('of-ai-test-btn');
    const out = $('of-ai-test-result');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    const gen = OFFICE_SESSION_GEN, uid = currentUserId();
    try {
      const res = await officeApi('/ai/test', { method: 'POST', body: {} }, gen, uid);
      const says = res && res.provider_says ? ' — المزوّد بيقول حرفيًا: «' + res.provider_says + '»' : '';
      if (out) out.textContent = res.ok
        ? `الاختبار الحي: ✅ الاتصال ناجح — الموديل ${res.model || ''} (${Number(res.latency_ms || 0)}ms). الذكاء الاصطناعي شغّال فعلًا.`
        : `الاختبار الحي: ❌ ${officeAiTestHint(res.error_code)}${says}`;
      if (isCurrentSession(gen, uid)) await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
    } catch (err) {
      if (out) out.textContent = 'الاختبار الحي: ❌ ' + (err.message || 'تعذر الاتصال');
    } finally {
      if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
    }
  };

  window.officeDeleteDecidedJob = async function (jobId) {
    if (!isOwner() || !jobId) return;
    if (!window.confirm('تحذفي هذه المسودة المحسومة نهائيًا؟ القرار نفسه بيفضل مسجّل في سجل التدقيق.')) return;
    const lockKey = `job:${jobId}`;
    if (OFFICE_INFLIGHT.has(lockKey)) return;
    const gen = OFFICE_SESSION_GEN, uid = currentUserId();
    OFFICE_INFLIGHT.add(lockKey);
    document.querySelectorAll(`[data-delete-job="${jobId}"]`).forEach(b => {
      b.disabled = true; b.setAttribute('aria-busy', 'true');
    });
    try {
      await officeApi('/jobs/' + encodeURIComponent(jobId), { method: 'DELETE' }, gen, uid);
      if (isCurrentSession(gen, uid)) {
        toast('اتحذفت المسودة ✅ — سجل القرار محفوظ في التدقيق');
        if (typeof VIEW !== 'undefined' && (VIEW === 'office' || VIEW === 'dash')) {
          await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
          await rerenderAfterLockRelease(gen, uid, true);
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) return;
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر الحذف');
    } finally {
      OFFICE_INFLIGHT.delete(lockKey);
    }
  };

  window.officePurgeDecidedJobs = async function () {
    if (!isOwner() || OFFICE_INFLIGHT.has('purge_decided')) return;
    if (!window.confirm('هتحذفي كل المسودات اللي اتخذ القرار فيها (المعتمدة والمرفوضة)؟ سجل القرارات بيفضل محفوظ في سجل التدقيق، والمسودات النشطة مش هتتأثر.')) return;
    const gen = OFFICE_SESSION_GEN, uid = currentUserId();
    OFFICE_INFLIGHT.add('purge_decided');
    const btn = document.getElementById('of-purge-decided-btn');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    try {
      const res = await officeApi('/jobs/purge-decided', { method: 'POST', body: {} }, gen, uid);
      if (isCurrentSession(gen, uid)) {
        toast(`اتفرّغ الأرشيف ✅ — اتحذفت ${Number((res && res.purged) || 0)} مسودة محسومة`);
        if (typeof VIEW !== 'undefined' && (VIEW === 'office' || VIEW === 'dash')) {
          await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
          await rerenderAfterLockRelease(gen, uid, true);
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) return;
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تفريغ الأرشيف');
    } finally {
      OFFICE_INFLIGHT.delete('purge_decided');
      if (btn) { btn.disabled = false; btn.removeAttribute('aria-busy'); }
    }
  };

  window.officeRunFixtureDrain = async function () {
    if (!isOwner() || OFFICE_INFLIGHT.has('worker_step')) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add('worker_step');
    ['of-fixture-step-btn', 'of-fixture-drain-btn'].forEach(id => {
      const b = document.getElementById(id);
      if (b) { b.disabled = true; b.setAttribute('aria-busy', 'true'); }
    });
    let hasFresh = false;
    let authEnded = false;
    try {
      const res = await officeApi('/worker/drain', {
        method: 'POST',
        body: { provider: 'fixture', max_steps: 20 },
      }, gen, uid);
      hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      if (isCurrentSession(gen, uid)) {
        const n = Number(res && res.drain && res.drain.processed_count) || 0;
        if (n === 0) {
          toast('لا توجد مسودات في الطابور حاليًا');
        } else {
          toast(`تم تحضير ${n} مسودة للمراجعة البشرية — بدون اعتماد أو إرسال تلقائي`);
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تحضير الطابور');
    } finally {
      OFFICE_INFLIGHT.delete('worker_step');
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
    }
  };

  window.officeCopyApprovedText = async function (jobId) {
    const job = findJobAny(jobId);
    if (!job || job.status !== 'approved' || !job.result || !job.result.text) return;
    const txt = String(job.result.text);
    try {
      if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(txt);
      }
      toast('تم نسخ النص المعتمد للاستخدام اليدوي — لم يُرسل أي شيء تلقائيًا');
    } catch (_) {
      toast('تعذر النسخ التلقائي للحافظة؛ يمكنكِ تحديد النص ونسخه يدويًا');
    }
  };

  /* Owner review decision — strictly locked against double-clicks and NEVER auto-retries on 409! */
  window.officeDecideJob = async function (jobId, decision) {
    if (!isOwner()) return;
    const lockKey = `job:${jobId}`;
    if (OFFICE_INFLIGHT.has(lockKey)) return;

    const job = findJobAny(jobId);
    if (!job || job.status !== 'review' || !job.result_hash) return;

    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add(lockKey);
    document.querySelectorAll(`[data-approve-job="${jobId}"], [data-reject-job="${jobId}"]`).forEach(b => {
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
    });

    let hasFresh = false;
    let authEnded = false;
    let lastDecideRes = null;
    try {
      lastDecideRes = await officeApi('/jobs/' + encodeURIComponent(jobId) + '/review', {
        method: 'POST',
        body: {
          expected_revision: job.revision,
          expected_result_hash: job.result_hash,
          decision,
        },
      }, gen, uid);
      delete OFFICE_STATE.staleAlerts[jobId];
      if (typeof VIEW !== 'undefined' && (VIEW === 'office' || VIEW === 'dash')) {
        hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      }
      if (isCurrentSession(gen, uid)) {
        const handoff = decision === 'approve' ? (lastDecideRes && lastDecideRes.handoff) : null;
        const exec = decision === 'approve' ? (lastDecideRes && lastDecideRes.execution) : null;
        if (decision === 'approve' && exec) {
          toast(exec.ok
            ? 'تم الاعتماد والتنفيذ والتحقق ✓ — النتيجة اتكتبت فعلًا على مافي واتسجلت على المسودة، وبرضه تقدري تسترجعي القيمة السابقة'
            : `تم الاعتماد لكن فشل التنفيذ (${exec.message || exec.error_code || 'سبب غير معروف'}) — الكارت بيظهر حالة الفشل وزر إعادة المحاولة، ومفيش أي ادعاء إن حاجة اتنفّذت`);
        } else {
          toast(decision === 'approve'
            ? (handoff && handoff.next_prepared > 0
              ? `تم الاعتماد ✅ — اتحضّرت ${handoff.next_prepared} مسودة للخطوة الجاية وبانتظار مراجعتك، والمسؤولة أعلنت الاستلام في الشات. المسودة المعتمدة في الأرشيف`
              : 'تم الاعتماد ✅ — القرار مسجّل والمسودة بقت في تاب «النتائج المعتمدة»، ولو رسالة لعميلة هتظهر في صفحة العملاء للإرسال اليدوي')
            : 'تم الرفض — الطلب رجع للموظف لإعادة الصياغة');
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (!isCurrentSession(gen, uid)) return;
      if (err && err.status === 409) {
        // NEVER auto-reapprove! Surface explicit stale notice and require manual refresh + human re-review.
        OFFICE_STATE.staleAlerts[jobId] = {
          code: err.code || 'stale_conflict',
          message: err.message || 'تغيّرت بيانات الطلب أو نسخة المسودة بعد فتحها؛ حدّثي المسودة وراجعيها من جديد قبل اتخاذ القرار.',
        };
      } else {
        toast(err.message || 'تعذر حفظ القرار');
      }
    } finally {
      OFFICE_INFLIGHT.delete(lockKey);
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
    }
  };

  /* Manual execution / restore for ACTION drafts — honest buttons wired to the
     real tools; toasts state exactly what happened (or failed). */
  window.officeExecuteJob = async function (jobId) {
    if (!isOwner()) return;
    const lockKey = `job:${jobId}`;
    if (OFFICE_INFLIGHT.has(lockKey)) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add(lockKey);
    document.querySelectorAll(`[data-exec-job="${jobId}"]`).forEach(b => { b.disabled = true; b.setAttribute('aria-busy', 'true'); });
    let hasFresh = false;
    let authEnded = false;
    try {
      const r = await officeApi('/jobs/' + encodeURIComponent(jobId) + '/execute', { method: 'POST', body: {} }, gen, uid);
      if (typeof VIEW !== 'undefined' && (VIEW === 'office' || VIEW === 'dash')) {
        hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      }
      if (isCurrentSession(gen, uid)) {
        const er = r && r.job && r.job.execution_result;
        toast(r && r.job && r.job.execution === 'verified'
          ? 'تم التنفيذ والتحقق ✓ — النتيجة مسجّلة على المسودة وصفحة الموديل/الطلب محدّثة'
          : `فشل التنفيذ (${(er && er.message) || 'سبب غير معروف'}) — مفيش أي تغيير اتكتب، والسبب ظاهر على الكارت بصدق`);
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تنفيذ المسودة');
    } finally {
      OFFICE_INFLIGHT.delete(lockKey);
      if (!authEnded) await rerenderAfterLockRelease(gen, uid, hasFresh);
    }
  };

  window.officeRestoreExecution = async function (jobId) {
    if (!isOwner()) return;
    const lockKey = `job:${jobId}`;
    if (OFFICE_INFLIGHT.has(lockKey)) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add(lockKey);
    document.querySelectorAll(`[data-restore-job="${jobId}"]`).forEach(b => { b.disabled = true; b.setAttribute('aria-busy', 'true'); });
    let hasFresh = false;
    let authEnded = false;
    try {
      const r = await officeApi('/jobs/' + encodeURIComponent(jobId) + '/restore', { method: 'POST', body: {} }, gen, uid);
      if (typeof VIEW !== 'undefined' && (VIEW === 'office' || VIEW === 'dash')) {
        hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      }
      if (isCurrentSession(gen, uid)) {
        toast('تم الاسترجاع ✓ — الوصف السابق رجع للصفحة واتأكد من الحفظ');
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر الاسترجاع');
    } finally {
      OFFICE_INFLIGHT.delete(lockKey);
      if (!authEnded) await rerenderAfterLockRelease(gen, uid, hasFresh);
    }
  };

  /* Explicit manual refresh when a draft's underlying order/product changed — targets exact `jobId` & NEVER auto-approves */
  window.officeRefreshStaleJob = async function (jobId) {
    const lockKey = `job:${jobId}`;
    if (OFFICE_INFLIGHT.has(lockKey)) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add(lockKey);
    document.querySelectorAll(`[data-refresh-job="${jobId}"], [data-approve-job="${jobId}"], [data-reject-job="${jobId}"]`).forEach(b => {
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
    });

    let hasFresh = false;
    let authEnded = false;
    try {
      const latestRes = await officeApi('/jobs/' + encodeURIComponent(jobId), {}, gen, uid);
      const latest = latestRes.job;
      await officeApi('/jobs/' + encodeURIComponent(jobId), {
        method: 'PATCH',
        body: {
          payload: latest.payload,
          expected_revision: latest.revision,
        },
      }, gen, uid);

      let stepRes = null;
      if (isOwner()) {
        stepRes = await officeApi('/worker/step', {
          method: 'POST',
          body: { provider: 'fixture', job_id: jobId },
        }, gen, uid);
      }

      if (typeof VIEW !== 'undefined' && (VIEW === 'office' || VIEW === 'dash')) {
        hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      }
      const afterJobRes = !hasFresh ? await officeApi('/jobs/' + encodeURIComponent(jobId), {}, gen, uid) : null;
      if (isCurrentSession(gen, uid)) {
        delete OFFICE_STATE.staleAlerts[jobId];
        const updatedJob = (afterJobRes && afterJobRes.job) || findJobAny(jobId);
        const preparedExactJob = updatedJob
          && updatedJob.status === 'review'
          && (!stepRes || !stepRes.step || stepRes.step.job_id === jobId);
        if (preparedExactJob) {
          toast('تم تحديث المسودة على البيانات الحالية — راجعي النص والحقائق الجديدة قبل اتخاذ القرار');
        } else if (updatedJob && updatedJob.status === 'queued') {
          toast('أُعيدت المسودة إلى الطابور على البيانات الحالية وبانتظار التحضير والمراجعة البشرية');
        } else {
          toast('تعذر إتمام تحضير المسودة المحدثة — راجعي حالتها في الطابور');
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تحديث المسودة');
    } finally {
      OFFICE_INFLIGHT.delete(lockKey);
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
    }
  };

  window.officeRecheckJob = async function (jobId) {
    if (!isOwner()) return;
    const lockKey = `job:${jobId}`;
    if (OFFICE_INFLIGHT.has(lockKey)) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add(lockKey);
    document.querySelectorAll(`[data-recheck-job="${jobId}"], [data-approve-job="${jobId}"], [data-reject-job="${jobId}"]`).forEach(b => {
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
    });

    let hasFresh = false;
    let authEnded = false;
    try {
      const res = await officeApi('/jobs/' + encodeURIComponent(jobId) + '/recheck', {
        method: 'POST',
        body: {},
      }, gen, uid);
      const idx = OFFICE_STATE.jobs.findIndex(j => j.id === jobId);
      if (idx >= 0 && res && res.job) {
        OFFICE_STATE.jobs[idx] = res.job;
        hasFresh = true;
      }
      const cIdx = OFFICE_STATE.ctx && Array.isArray(OFFICE_STATE.ctx.jobs)
        ? OFFICE_STATE.ctx.jobs.findIndex(j => j.id === jobId)
        : -1;
      if (cIdx >= 0 && res && res.job) {
        OFFICE_STATE.ctx.jobs[cIdx] = res.job;
      }
      if (isCurrentSession(gen, uid)) {
        if (res && res.subject_stale) {
          OFFICE_STATE.staleAlerts[jobId] = {
            code: 'stale_subject_facts',
            message: 'كشف الفحص الكامل للبصمة (شامل الصور والإيصالات) عن تعديل بعد تحضير المسودة — حدّثي المسودة وراجعيها قبل الاعتماد.',
          };
          toast('تغيّرت البيانات أو المرفقات — يلزم تحديث المسودة قبل الاعتماد');
        } else {
          delete OFFICE_STATE.staleAlerts[jobId];
          toast('البصمة الكاملة مطابقة لآخر بيانات ومرفقات محفوظة');
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر فحص البصمة');
    } finally {
      OFFICE_INFLIGHT.delete(lockKey);
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
    }
  };

  window.officeShowCaseHistory = async function (subjectType, subjectId, subjectCode) {
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    try {
      const h = await officeApi(`/cases/${encodeURIComponent(subjectType)}/${Number(subjectId)}/history`, {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      const episodes = Array.isArray(h.episodes) ? h.episodes : [];
      const modal = document.getElementById('modal');
      const ovl = document.getElementById('ovl');
      if (!modal || !ovl) return;
      modal.innerHTML = `
        <div class="inv-modal-head">
          <div>
            <h3>سجل حلقات المتابعة — <span class="mono">${esc(subjectCode)}</span></h3>
            <p>يعرض جميع الحلقات المفتوحة والمغلقة وإعادة الفتح لهذا الطلب دون حذف التاريخ السابق.</p>
          </div>
          <button type="button" class="inv-close" aria-label="إغلاق" onclick="closeModal()">×</button>
        </div>
        ${episodes.length ? `
          <ul class="of-history-list">
            ${episodes.map(ep => `
              <li>
                <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
                  <strong>${esc(ep.reason_ar)} (الحلقة #${Number(ep.episode)})</strong>
                  <span class="of-pill ${ep.state === 'open' ? 'warn' : 'ok'}">${ep.state === 'open' ? 'مفتوحة' : 'مغلقة'}</span>
                </div>
                <div style="color:#5c6f84;margin-top:4px">
                  فُتحت: <span class="mono">${esc(ep.opened_at)}</span>
                  ${ep.resolved_at ? ` · أُغلقت: <span class="mono">${esc(ep.resolved_at)}</span> (${esc(ep.resolution_reason || '')})` : ''}
                </div>
              </li>
            `).join('')}
          </ul>
        ` : `<div class="of-empty" style="margin-top:12px">لا يوجد سجل حلقات محفوظ لهذا الطلب بعد.</div>`}
        <div class="row"><button type="button" class="btn" onclick="closeModal()">إغلاق</button></div>
      `;
      ovl.classList.add('on');
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) return;
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر عرض السجل');
    }
  };

  window.officeSetJobStatusFilter = function (filterKey) {
    OFFICE_STATE.jobStatusFilter = filterKey || 'all';
    OFFICE_STATE.freshData = OFFICE_STATE.loadedOnce;
    if (typeof render === 'function') return render();
  };

  window.officeRunDailyCycle = async function () {
    if (!isOwner() || OFFICE_INFLIGHT.has('daily_cycle')) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add('daily_cycle');
    const btn = document.getElementById('of-daily-cycle-btn');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    let hasFresh = false;
    let authEnded = false;
    try {
      const res = await officeApi('/cycle/run', {
        method: 'POST',
        body: { provider: 'fixture', holiday_budget_egp: 100 },
      }, gen, uid);
      OFFICE_STATE.tab = 'drafts';
      OFFICE_STATE.jobStatusFilter = 'review';
      hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      if (isCurrentSession(gen, uid)) {
        const c = (res && res.cycle) || {};
        const prep = Number(c.prepared_count || 0);
        const enq = Number(c.enqueued_count || 0);
        if (enq === 0 && prep === 0) {
          toast('جميع تقارير اليوم ومسودات الحالات المفتوحة جاهزة بالفعل للمراجعة');
        } else {
          toast(`تم تجهيز ${prep || enq} مسودة وتقرير للمراجعة البشرية — بدون اعتماد أو إرسال تلقائي`);
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تشغيل دورة اليوم');
    } finally {
      OFFICE_INFLIGHT.delete('daily_cycle');
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
    }
  };

  const AUDIT_EVENT_LABELS = {
    queued: 'إضافة المسودة في الطابور',
    claimed: 'بدء التحضير المحلي',
    fixture_ready_for_review: 'جاهزة لمراجعة المالكة (قالب محلي)',
    draft_approved_no_execution: 'اعتماد المسودة من المالكة (بدون إرسال أو صرف)',
    draft_rejected_no_execution: 'رفض المسودة من المالكة',
    owner_edited_draft_text: 'تعديل نص المسودة يدويًا من المالكة',
    manual_execution_logged: 'تسجيل الاستخدام / الإرسال اليدوي بعد الاعتماد',
    revised_prior_output_and_approval_invalidated: 'تحديث بيانات المسودة وإلغاء النسخة السابقة',
    recheck_detected_stale_subject: 'رصد تغيّر في البيانات/المرفقات عند فحص البصمة',
    recheck_verified_fresh: 'فحص البصمة الكاملة: مطابقة للبيانات الحالية',
    expired_queued: 'إعادة جدولة بعد انتهاء مهلة التحضير',
    expired_failed: 'توقف بعد تجاوز حد المحاولات',
    failed: 'توقف التحضير',
  };

  window.officeShowAuditLog = async function () {
    if (!isOwner()) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    try {
      const res = await officeApi('/audit?limit=50', {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      const events = Array.isArray(res.events) ? res.events : [];
      const modal = document.getElementById('modal');
      const ovl = document.getElementById('ovl');
      if (!modal || !ovl) return;
      modal.innerHTML = `
        <div class="inv-modal-head">
          <div>
            <h3>سجل القرارات والمراجعات — المكتب الموحد</h3>
            <p>سجل تدقيقي غير قابل للتعديل لكل إضافة وتحضير ومراجعة واعتماد داخل الشركة الافتراضية.</p>
          </div>
          <button type="button" class="inv-close" aria-label="إغلاق" onclick="closeModal()">×</button>
        </div>
        ${events.length ? `
          <ul class="of-history-list">
            ${events.map(ev => {
              const dt = ev.created_at ? new Date(Number(ev.created_at) * 1000).toISOString().replace('T', ' ').slice(0, 19) + 'Z' : '';
              const pillCls = ev.event === 'draft_approved_no_execution'
                ? 'ok'
                : (ev.event === 'draft_rejected_no_execution' || ev.event === 'recheck_detected_stale_subject')
                  ? 'urgent'
                  : 'test';
              return `
                <li>
                  <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap">
                    <strong>${esc(AUDIT_EVENT_LABELS[ev.event] || ev.event)} · ${esc(ev.kind_label_ar || ev.kind)}</strong>
                    <span class="of-pill ${pillCls}">${esc(ev.subject_ref || '')}</span>
                  </div>
                  <div style="color:#5c6f84;margin-top:4px;font-size:12px">
                    المسؤول: <b>${esc(ev.assignee_name_ar || 'النظام')}</b> · المنفّذ: <span class="mono">${esc(ev.actor_id)}</span> · التوقيت: <span class="mono">${esc(dt)}</span>
                    ${ev.result_hash ? ` · البصمة: <span class="mono">${esc(String(ev.result_hash).slice(0, 12))}</span>` : ''}
                  </div>
                </li>
              `;
            }).join('')}
          </ul>
        ` : `<div class="of-empty" style="margin-top:12px">لا توجد أحداث مسجلة بعد.</div>`}
        <div class="row"><button type="button" class="btn" onclick="closeModal()">إغلاق</button></div>
      `;
      ovl.classList.add('on');
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) return;
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تحميل سجل المراجعات');
    }
  };

  /* ---------- Contextual In-ERP Virtual Company Integration (Order / Style / Custom Request) ---------- */
  function buildQuickBtnHtml(btnSpec, busy) {
    const encoded = encodeURIComponent(JSON.stringify(btnSpec.payload));
    return `
      <button type="button" class="of-quick-btn"
        data-quick-kind="${esc(btnSpec.kind)}"
        data-quick-payload="${esc(encoded)}"
        ${busy ? 'disabled aria-busy="true"' : ''}
        onclick="officeQuickDraft(this.dataset.quickKind, this.dataset.quickPayload)">
        <strong>${esc(btnSpec.title)}</strong>
        <small>${esc(btnSpec.subtitle)}</small>
      </button>
    `;
  }

  function orderQuickSpecs(orderCode, allowedKinds) {
    const allowed = new Set((allowedKinds || []).map(k => k.kind));
    const specs = [
      {
        kind: 'order_followup_draft',
        payload: { order_code: orderCode, focus: 'schedule' },
        title: '💬 متابعة موعد وجدول التسليم — نور',
        subtitle: 'رسالة عميلة منظمة بموعد التسليم وحالة التشغيل الحالية',
      },
      {
        kind: 'order_followup_draft',
        payload: { order_code: orderCode, focus: 'measurements' },
        title: '📏 استكمال المقاسات الناقصة — نور',
        subtitle: 'تذكير لطيف للعميلة بالمقاسات المطلوبة لبدء القص',
      },
      {
        kind: 'customer_reply_draft',
        payload: { order_code: orderCode },
        title: '🙋‍♀️ رد استفسار عميلة محكوم — بسمة',
        subtitle: 'رد رسمي بالحقائق الفعلية للطلب بدون وعود غير موثقة',
      },
      {
        kind: 'workshop_followup_draft',
        payload: { order_code: orderCode },
        title: '🪡 متابعة الورشة والتشغيل — هنا',
        subtitle: 'مذكرة متابعة للورشة والقطع والخامات المسجلة على الطلب',
      },
      {
        kind: 'quality_delivery_checklist',
        payload: { order_code: orderCode },
        title: '✅ قائمة فحص الجودة قبل التسليم — دينا',
        subtitle: 'مراجعة التشطيب والمقاسات والتغليف قبل خروج الأوردر',
      },
      {
        kind: 'deposit_followup_draft',
        payload: { order_code: orderCode },
        title: '💰 متابعة العربون والتحصيل — عمر',
        subtitle: 'مسودة مالية للمالكة فقط بالمطلوب والمدفوع وحالة الإيصال',
      },
    ];
    return specs.filter(s => allowed.size === 0 ? (s.kind !== 'deposit_followup_draft' || isOwner()) : allowed.has(s.kind));
  }

  function styleQuickSpecs(styleId, allowedKinds) {
    const allowed = new Set((allowedKinds || []).map(k => k.kind));
    const specs = [
      {
        kind: 'content_draft',
        payload: { product_id: styleId, channel: 'instagram' },
        title: '✍️ كابشن إنستجرام للموديل — ليلى',
        subtitle: 'وصف جذاب بالألوان والخامات الفعلية بدون مبالغة',
      },
      {
        kind: 'visual_reel_brief',
        payload: { product_id: styleId },
        title: '🎬 خطة ريل للموديل — مايا',
        subtitle: 'لقطات مقترحة لحركة القماش وتفاصيل الفينيش والتفصيل',
      },
      {
        kind: 'seo_readiness_check',
        payload: { product_id: styleId },
        title: '🔍 فحص جاهزية SEO والظهور — نادين',
        subtitle: 'مراجعة العنوان والوصف والصور لصفحة الموديل على المتجر',
      },
      {
        kind: 'landing_page_check',
        payload: { product_id: styleId },
        title: '📱 فحص صفحة الوصول ومسار الموبايل — آدم',
        subtitle: 'مراجعة وضوح المقاسات وخطوات الطلب من الموبايل',
      },
      {
        kind: 'community_followup_draft',
        payload: { product_id: styleId, channel: 'instagram' },
        title: '🤝 تحويل استفسار السوشيال لطلب — جنى',
        subtitle: 'رد محكوم لتحويل تعليقات ورسائل الموديل إلى طلب فعلي',
      },
      {
        kind: 'campaign_brief',
        payload: { product_id: styleId, channel: 'instagram', daily_budget_egp: 100 },
        title: '📊 موجز حملة تخطيطي (سقف ١٠٠ ج) — كريم',
        subtitle: 'للمالكة فقط — خطة ترويج بدون ربط بحسابات إعلانية',
      },
      {
        kind: 'paid_ad_setup_draft',
        payload: { product_id: styleId, channel: 'instagram', daily_budget_egp: 100 },
        title: '📣 مسودة إعداد إعلان ممول لمصر — زياد',
        subtitle: 'للمالكة فقط — مسودة استهداف وميزانية للمراجعة اليدوية',
      },
    ];
    const ownerOnly = new Set(['campaign_brief', 'paid_ad_setup_draft']);
    return specs.filter(s => allowed.size === 0 ? (!ownerOnly.has(s.kind) || isOwner()) : allowed.has(s.kind));
  }

  function renderErpCasesCompact(cases) {
    if (!Array.isArray(cases) || !cases.length) {
      return `<div class="of-erp-ok">✓ لا توجد حالات تأخير أو نواقص مفتوحة على هذا العنصر حاليًا</div>`;
    }
    return `
      <div class="of-erp-cases">
        ${cases.map(c => `
          <div class="of-erp-case-row" data-erp-case-kind="${esc(c.case_kind)}">
            <div>
              <strong>⚠️ ${esc(c.reason_ar)}</strong>
              <span style="margin-inline-start:8px;color:#7a5a1e">المسؤول: <b>${esc(c.assignee_name_ar || c.assignee_role_id)}</b></span>
            </div>
            <span class="of-pill ${casePriorityClass(c.priority_rank)}">${esc(c.priority_label_ar || 'متابعة')}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  window.officeFetchOrderPanelHtml = async function (order) {
    if (!order || !order.code) return '';
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    const orderCode = String(order.code).trim().toUpperCase();
    const customerPhone = (order.customer && order.customer.phone) ? String(order.customer.phone) : '';
    const busy = OFFICE_INFLIGHT.has('quick_draft');
    try {
      const data = await officeApi('/context/order/' + encodeURIComponent(orderCode), {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return '';
      OFFICE_STATE.ctx = {
        mode: 'order',
        ref: orderCode,
        title: orderCode,
        phone: customerPhone,
        cases: Array.isArray(data.cases) ? data.cases : [],
        jobs: Array.isArray(data.jobs) ? data.jobs : [],
        allowedKinds: Array.isArray(data.allowed_kinds) ? data.allowed_kinds : [],
      };
      const quickBtns = orderQuickSpecs(orderCode, OFFICE_STATE.ctx.allowedKinds)
        .map(spec => buildQuickBtnHtml(spec, busy))
        .join('');
      const jobsHtml = OFFICE_STATE.ctx.jobs.length
        ? `<div class="of-jobs-grid">${OFFICE_STATE.ctx.jobs.map(j => renderJobCard(j, { hideOpenSubject: true, customerPhone })).join('')}</div>`
        : `<div class="of-empty" style="padding:16px">لا توجد مسودات محفوظة لهذا الطلب بعد — اضغطي أحد أزرار الفريق أعلاه لتحضير مسودة فورية مبنية على بيانات الطلب الحقيقية.</div>`;

      return `
        <section id="of-order-ctx-section" class="of-erp-panel" aria-label="فريق المتابعة والمسودات للطلب">
          <div class="of-erp-head">
            <div>
              <h2>✨ فريق المتابعة والمسودات لهذا الطلب (<span class="mono">${esc(orderCode)}</span>)</h2>
              <p>${isOwner()
                ? 'حضّري مسودة فورية من بيانات الطلب الفعلية، وراجعي البصمة واعتمديها هنا مباشرة — بدون إرسال تلقائي للعميلة.'
                : 'اطلبي مسودة متابعة تشغيلية لهذا الطلب بدون بيانات مالية؛ الاعتماد النهائي خاص بالمالكة.'}</p>
            </div>
            <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">
              <span class="of-pill">اعتماد بشري فقط · 0 إرسال تلقائي</span>
              <button type="button" class="btn ghost sm" onclick="officeGoTab('drafts')">فتح طابور المكتب الموحد ›</button>
            </div>
          </div>

          ${renderErpCasesCompact(OFFICE_STATE.ctx.cases)}

          <div>
            <div style="font-size:12.5px;font-weight:800;color:#223856;margin-bottom:7px">
              ${isOwner() ? 'تحضير مسودة فورية للمراجعة بضغطة واحدة:' : 'إضافة مسودة تشغيلية في طابور مراجعة المالكة:'}
            </div>
            <div class="of-quick-grid">${quickBtns}</div>
          </div>

          <div>
            <div style="font-size:12.5px;font-weight:800;color:#223856;margin-bottom:7px">
              مسودات هذا الطلب (${OFFICE_STATE.ctx.jobs.length}):
            </div>
            ${jobsHtml}
          </div>
        </section>
      `;
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) return '';
      return `
        <section id="of-order-ctx-section" class="of-erp-panel">
          <div class="of-error-box">
            <strong>تعذر تحميل مسودات الفريق لهذا الطلب</strong>
            ${esc((err && err.message) || 'حدث خطأ غير متوقع أثناء قراءة مسودات الطلب.')}
          </div>
        </section>
      `;
    }
  };

  function renderContextModalInner() {
    const ctx = OFFICE_STATE.ctx || defaultContextState();
    const busy = OFFICE_INFLIGHT.has('quick_draft');
    let quickSpecs = [];
    let heading = '';
    let sub = '';
    if (ctx.mode === 'order_modal') {
      heading = `✨ مسودات المتابعة السريعة للطلب — ${ctx.ref}`;
      sub = isOwner()
        ? 'تحضير ومراجعة واعتماد مسودات الطلب مباشرة بدون مغادرة جدول الطلبات.'
        : 'طلب مسودة تشغيلية لهذا الأوردر — الاعتماد النهائي للمالكة.';
      quickSpecs = orderQuickSpecs(ctx.ref, ctx.allowedKinds);
    } else if (ctx.mode === 'style') {
      heading = `✨ فريق المحتوى والتسويق والـ SEO — ${ctx.title || ctx.ref} (${ctx.ref})`;
      sub = isOwner()
        ? 'توليد ومراجعة مسودات الكابشن والريل وفحص SEO والحملات التخطيطية مباشرة من بيانات الموديل المسجلة.'
        : 'توليد مسودات المحتوى والـ SEO وفحص الصفحة للموديل — الاعتماد النهائي والمسودات الإعلانية للمالكة فقط.';
      quickSpecs = styleQuickSpecs(ctx.ref, ctx.allowedKinds);
    } else if (ctx.mode === 'custom') {
      heading = `✨ مسودة مراجعة وتسعير التصميم الخاص #${ctx.ref}`;
      sub = 'تحضير ومراجعة مسودة عمر لطلب التصميم الخاص مع فحص البصمة قبل الاعتماد اليدوي.';
      quickSpecs = [
        {
          kind: 'custom_design_followup_draft',
          payload: { request_id: Number(ctx.ref) },
          title: '💰 تحضير مسودة مراجعة وتسعير العميلة — عمر',
          subtitle: 'تلخيص الخامة والمقاسات والسعر والعربون المسجلين في الطلب',
        },
      ];
    } else if (ctx.mode === 'ops') {
      if (ctx.ref === 'board') {
        heading = '✨ أولويات التشغيل والورش اليومية — سلمى';
        sub = isOwner()
          ? 'فرز الطلبات المتأخرة ومراحل القص والخياطة والجاهز للتسليم مباشرة من لوحة التشغيل.'
          : 'تجهيز قائمة أولويات الورش والتشغيل اليومية لمراجعة المالكة — بدون أي بيانات مالية.';
        quickSpecs = [
          {
            kind: 'daily_ops_triage',
            payload: {},
            title: '📋 تحضير قائمة أولويات التشغيل اليومية — سلمى',
            subtitle: 'تجميع المتأخرات وتوزيع مراحل الورشة حسب المواعيد الفعلية',
          },
        ];
      } else if (ctx.ref === 'finance') {
        heading = '✨ خطة الأسبوع وتقارير التحويل — رامي وفرح';
        sub = 'للمالكة فقط — تقارير الأولويات الأسبوعية وقمع التحويل وفجوات القياس من بيانات الـ ERP.';
        quickSpecs = [
          {
            kind: 'executive_weekly_plan',
            payload: { holiday_budget_egp: 100 },
            title: '🧭 خطة أولويات الأسبوع المشتركة — رامي',
            subtitle: 'ملخص تنفيذي للأرباح والتحصيل وأولويات الأسبوع (سقف تخطيطي ١٠٠ ج)',
          },
          {
            kind: 'funnel_attribution_report',
            payload: {},
            title: '📈 تقرير قمع التحويل وفجوات القياس — فرح',
            subtitle: 'تحليل القنوات المسجلة للطلبات وتحويل الاستفسارات إلى طلبات مؤكدة',
          },
        ];
      } else if (ctx.ref === 'system') {
        heading = '✨ فحص سلامة بيانات الـ ERP والخصوصية — يوسف وطارق';
        sub = 'للمالكة فقط — مراجعة اتساق سجلات الطلبات والمدفوعات وفحص الصلاحيات والنسخ الاحتياطي.';
        quickSpecs = [
          {
            kind: 'erp_data_health_report',
            payload: {},
            title: '🗄️ تقرير سلامة بيانات الطلبات والربط — يوسف',
            subtitle: 'رصد النواقص التشغيلية والطلبات بدون مواعيد أو مقاسات أو تسعير',
          },
          {
            kind: 'security_privacy_audit',
            payload: {},
            title: '🛡️ فحص الخصوصية والصلاحيات والامتثال — طارق',
            subtitle: 'التحقق من عزل صلاحيات الموظفين وحماية الإيصالات والنسخ الاحتياطي',
          },
        ];
      }
    }

    const jobsHtml = ctx.jobs.length
      ? `<div class="of-jobs-grid">${ctx.jobs.map(j => renderJobCard(j, { hideOpenSubject: true, customerPhone: ctx.phone })).join('')}</div>`
      : `<div class="of-empty" style="padding:16px">لا توجد مسودات محفوظة لهذا العنصر بعد — اضغطي أحد الأزرار أعلاه لتحضير أول مسودة.</div>`;

    return `
      <div id="of-ctx-modal-root" class="of-wrap">
        <div class="inv-modal-head">
          <div>
            <h3>${esc(heading)}</h3>
            <p>${esc(sub)}</p>
          </div>
          <button type="button" class="inv-close" aria-label="إغلاق" onclick="closeModal()">×</button>
        </div>

        ${(ctx.mode === 'custom' || ctx.mode === 'order_modal') ? renderErpCasesCompact(ctx.cases) : ''}

        <div>
          <div style="font-size:12.5px;font-weight:800;color:#223856;margin-bottom:7px">
            ${isOwner() ? 'تحضير مسودة فورية للمراجعة:' : 'إضافة مسودة لطابور مراجعة المالكة:'}
          </div>
          <div class="of-quick-grid">${quickSpecs.map(s => buildQuickBtnHtml(s, busy)).join('')}</div>
        </div>

        <div>
          <div style="font-size:12.5px;font-weight:800;color:#223856;margin-bottom:7px">
            المسودات المحفوظة (${ctx.jobs.length}):
          </div>
          ${jobsHtml}
        </div>

        <div class="row"><button type="button" class="btn" onclick="closeModal()">إغلاق</button></div>
      </div>
    `;
  }

  const DESK_CHANNEL_KINDS = new Set(['content_draft', 'community_followup_draft', 'campaign_brief', 'paid_ad_setup_draft']);
  const DESK_BUDGET_KINDS = new Set(['campaign_brief', 'paid_ad_setup_draft', 'executive_weekly_plan']);

  function deskSelectedKind() {
    const ctx = OFFICE_STATE.ctx;
    if (!ctx || ctx.mode !== 'desk') return null;
    const kinds = Array.isArray(ctx.allowedKinds) ? ctx.allowedKinds : [];
    return kinds.find(x => x.kind === ctx.deskKind) || kinds[0] || null;
  }

  function deskChannelField() {
    const ctx = OFFICE_STATE.ctx;
    return `
            <label class="of-field" for="of-desk-channel">قناة العرض اليدوي اللاحقة
              <select id="of-desk-channel" onchange="officeSetDeskField('deskChannel', this.value)">
                <option value="instagram" ${ctx.deskChannel === 'instagram' ? 'selected' : ''}>انستجرام</option>
                <option value="facebook" ${ctx.deskChannel === 'facebook' ? 'selected' : ''}>فيسبوك</option>
              </select>
            </label>`;
  }

  function deskBudgetField() {
    const ctx = OFFICE_STATE.ctx;
    const val = Number.isInteger(Number(ctx.deskBudget)) && Number(ctx.deskBudget) >= 1 && Number(ctx.deskBudget) <= 100
      ? Number(ctx.deskBudget)
      : 100;
    return `
            <label class="of-field" for="of-desk-budget">السقف التخطيطي اليومي (رقم من ١ إلى ١٠٠ — تخطيطي فقط بلا أي إنفاق)
              <input id="of-desk-budget" type="number" min="1" max="100" step="1" dir="ltr" value="${val}" oninput="officeSetDeskField('deskBudget', this.value)">
            </label>`;
  }

  function renderDeskFormFields() {
    const ctx = OFFICE_STATE.ctx;
    const k = deskSelectedKind();
    if (!k) return '<p style="font-size:12.5px;color:#5b6e84;margin:0">لا توجد قوالب مسودات متاحة لهذا المكتب ضمن صلاحياتك.</p>';
    const t = ctx.targets || { orders: [], styles: [], custom_requests: [] };
    if (k.subject_type === 'order') {
      const opts = (t.orders || []).map(o => `<option value="${esc(o.code)}" ${ctx.deskOrderCode === o.code ? 'selected' : ''}>${esc(o.code)} — ${esc(o.customer_name || 'عميلة')} (${esc(o.status || '')})</option>`).join('');
      const focusSel = k.kind === 'order_followup_draft' ? `
            <label class="of-field" for="of-desk-focus">محور المتابعة
              <select id="of-desk-focus" onchange="officeSetDeskField('deskFocus', this.value)">
                <option value="schedule" ${ctx.deskFocus === 'schedule' ? 'selected' : ''}>موعد التسليم</option>
                <option value="measurements" ${ctx.deskFocus === 'measurements' ? 'selected' : ''}>استكمال المقاسات</option>
                <option value="status_update" ${ctx.deskFocus === 'status_update' ? 'selected' : ''}>تحديث مرحلة التنفيذ</option>
              </select>
            </label>` : '';
      return `
            <label class="of-field" for="of-desk-order">اختيار الطلب من بيانات الـ ERP الحية
              <select id="of-desk-order" onchange="officeSetDeskField('deskOrderCode', this.value)">
                <option value="">— اختاري الطلب —</option>
                ${opts}
              </select>
            </label>
            ${focusSel}
          `;
    }
    if (k.subject_type === 'catalogue') {
      const opts = (t.styles || []).map(s => `<option value="${esc(s.id)}" ${ctx.deskStyleId === s.id ? 'selected' : ''}>${esc(s.id)} — ${esc(s.name)}</option>`).join('');
      return `
            <label class="of-field" for="of-desk-style">اختيار الموديل من الكتالوج
              <select id="of-desk-style" onchange="officeSetDeskField('deskStyleId', this.value)">
                <option value="">— اختاري الموديل —</option>
                ${opts}
              </select>
            </label>
            ${DESK_CHANNEL_KINDS.has(k.kind) ? deskChannelField() : ''}
            ${DESK_BUDGET_KINDS.has(k.kind) ? deskBudgetField() : ''}
          `;
    }
    if (k.subject_type === 'custom_request') {
      const opts = (t.custom_requests || []).map(c => `<option value="${Number(c.id)}" ${String(ctx.deskCustomId) === String(c.id) ? 'selected' : ''}>تصميم خاص #${Number(c.id)} — ${esc(c.customer_name || '')} (${esc(c.status || '')})</option>`).join('');
      return `
            <label class="of-field" for="of-desk-custom">اختيار طلب التصميم الخاص
              <select id="of-desk-custom" onchange="officeSetDeskField('deskCustomId', this.value)">
                <option value="">— اختاري الطلب —</option>
                ${opts}
              </select>
            </label>
          `;
    }
    if (k.subject_type === 'ops_summary') {
      return `
            ${k.kind === 'executive_weekly_plan' ? deskBudgetField() : ''}
            <p style="font-size:12.5px;color:#5b6e84;margin:4px 0 0">تُحضَّر هذه المسودة مباشرة من ملخصات التشغيل الحية في الـ ERP — بدون اختيار عنصر.</p>
          `;
    }
    return '';
  }

  function renderDeskModalInner() {
    const ctx = OFFICE_STATE.ctx;
    const role = ctx.roleObj || {};
    const kinds = Array.isArray(ctx.allowedKinds) ? ctx.allowedKinds : [];
    const selKind = deskSelectedKind();
    const busy = OFFICE_INFLIGHT.has('quick_draft');
    const jobsHtml = ctx.jobs.length
      ? `<div class="of-jobs-grid">${ctx.jobs.map(j => renderJobCard(j, { hideOpenSubject: true, customerPhone: ctx.phone })).join('')}</div>`
      : `<div class="of-empty" style="padding:16px">لا توجد مسودات محفوظة لهذا المكتب بعد — حضّري أول مسودة من النموذج أعلاه.</div>`;

    const mgrNote = role.manager_id
      ? `التنسيق والتصعيد: ${(OFFICE_STATE.roles.find(r => r.id === role.manager_id) || {}).name || role.manager_id} — القرار النهائي للمالكة.`
      : 'يرفع التوصيات مباشرة للمالكة — القرار النهائي بشري دائمًا.';

    return `
      <div id="of-ctx-modal-root" class="of-wrap">
        <div class="inv-modal-head">
          <div>
            <h3>${esc(role.initial || '•')} غرفة عمل ${esc(role.name)} — ${esc(role.role)}</h3>
            <p>${esc(role.description || '')}</p>
          </div>
          <button type="button" class="inv-close" aria-label="إغلاق" onclick="closeModal()">×</button>
        </div>

        <div class="of-facts-grid" style="margin-top:10px">
          <div class="of-fact-item"><span>الجناح</span><strong>${esc(role.department || '')}</strong></div>
          <div class="of-fact-item"><span>المخرج الثابت</span><strong style="font-size:12px">${esc(role.deliverable || '')}</strong></div>
          <div class="of-fact-item"><span>مؤشر الأداء</span><strong style="font-size:12px">${esc(role.kpi || '')}</strong></div>
          <div class="of-fact-item"><span>حدود الدور</span><strong style="font-size:12px">${esc(role.limits || '')}</strong></div>
        </div>
        <p style="font-size:12.5px;color:#5b6e84;margin:10px 0 0">${esc(mgrNote)}</p>

        ${renderErpCasesCompact(ctx.cases)}

        ${!kinds.length ? `
        <div class="of-empty" style="margin-top:12px;padding:12px" data-desk-no-kinds="1">
          لا توجد قوالب مسودات متاحة لهذا المكتب ضمن صلاحياتك — هذا الدور تخطيطي/مالكي وتُدار مسوداته من المالكة مباشرة.
        </div>
        ` : `
        <div class="of-desk-assign-box" style="margin-top:12px">
          <div style="font-size:12.5px;font-weight:800;color:#223856">
            ${isOwner() ? 'تكليف فوري: تحضير مسودة من بيانات الـ ERP الحقيقية ومراجعتها واعتمادها هنا' : 'طلب مسودة تشغيلية لهذا المكتب — تُحفظ في طابور مراجعة المالكة بدون إرسال تلقائي'}
          </div>
          <label class="of-field" for="of-desk-kind">نوع المسودة
            <select id="of-desk-kind" onchange="officeSetDeskField('deskKind', this.value); rerenderDeskModal()">
              ${kinds.map(k => `<option value="${esc(k.kind)}" ${selKind && selKind.kind === k.kind ? 'selected' : ''}>${esc(k.label || JOB_KIND_LABELS[k.kind] || k.kind)}</option>`).join('')}
            </select>
          </label>
          ${renderDeskFormFields()}
          <div class="row" style="margin:0">
            <button type="button" class="btn primary" ${busy ? 'disabled aria-busy="true"' : ''} onclick="officeDeskQuickRun()">
              ${busy ? 'جاري التحضير...' : (isOwner() ? '⚡ تحضير المسودة للمراجعة الآن' : '➕ إضافة مسودة لطابور المالكة')}
            </button>
            <span class="of-pill test">اعتماد بشري فقط · 0 إرسال آلي · 0 إنفاق</span>
          </div>
        </div>
        `}

        <div style="margin-top:12px">
          <div style="font-size:12.5px;font-weight:800;color:#223856;margin-bottom:7px">
            مسودات ومخرجات ${esc(role.name)} (${ctx.jobs.length}):
          </div>
          ${jobsHtml}
        </div>

        <div class="row"><button type="button" class="btn" onclick="closeModal()">إغلاق</button></div>
      </div>
    `;
  }

  function rerenderDeskModal() {
    const modal = document.getElementById('modal');
    if (modal && document.getElementById('of-ctx-modal-root')) {
      modal.innerHTML = renderDeskModalInner();
    }
  }
  window.rerenderDeskModal = rerenderDeskModal;

  window.officeSetDeskField = function (field, value) {
    const ctx = OFFICE_STATE.ctx;
    if (!ctx || ctx.mode !== 'desk') return;
    ctx[field] = value;
  };

  window.officeOpenRoleDesk = async function (roleId) {
    const rid = String(roleId || '').trim().toLowerCase();
    if (!rid) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    try {
      const data = await officeApi('/context/desk/' + encodeURIComponent(rid), {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      OFFICE_STATE.ctx = {
        ...defaultContextState(),
        mode: 'desk',
        ref: rid,
        roleObj: data.role || {},
        cases: Array.isArray(data.cases) ? data.cases : [],
        jobs: Array.isArray(data.jobs) ? data.jobs : [],
        allowedKinds: Array.isArray(data.allowed_kinds) ? data.allowed_kinds : [],
        targets: data.targets || { orders: [], styles: [], custom_requests: [] },
        deskKind: (Array.isArray(data.allowed_kinds) && data.allowed_kinds.length) ? data.allowed_kinds[0].kind : '',
        deskOrderCode: (data.targets && data.targets.orders && data.targets.orders[0]) ? data.targets.orders[0].code : '',
        deskStyleId: (data.targets && data.targets.styles && data.targets.styles[0]) ? data.targets.styles[0].id : '',
        deskCustomId: (data.targets && data.targets.custom_requests && data.targets.custom_requests[0]) ? String(data.targets.custom_requests[0].id) : '',
        deskFocus: 'schedule',
        deskChannel: 'instagram',
        deskBudget: 100,
      };
      const modal = document.getElementById('modal');
      const ovl = document.getElementById('ovl');
      if (!modal || !ovl) return;
      modal.classList.add('of-wide');
      modal.innerHTML = renderDeskModalInner();
      ovl.classList.add('on');
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) return;
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر فتح غرفة العمل');
    }
  };

  window.officeDeskQuickRun = async function () {
    const ctx = OFFICE_STATE.ctx;
    if (!ctx || ctx.mode !== 'desk' || OFFICE_INFLIGHT.has('quick_draft')) return;
    const k = deskSelectedKind();
    if (!k) { toast('لا توجد قوالب مسودات متاحة لهذا المكتب'); return; }
    const payload = {};
    if (k.subject_type === 'order') {
      if (!ctx.deskOrderCode) { toast('اختاري الطلب من القائمة أولًا'); return; }
      payload.order_code = ctx.deskOrderCode;
      if (k.kind === 'order_followup_draft') payload.focus = ctx.deskFocus || 'schedule';
    } else if (k.subject_type === 'catalogue') {
      if (!ctx.deskStyleId) { toast('اختاري الموديل من الكتالوج أولًا'); return; }
      payload.product_id = ctx.deskStyleId;
      if (DESK_CHANNEL_KINDS.has(k.kind)) payload.channel = ctx.deskChannel || 'instagram';
      if (DESK_BUDGET_KINDS.has(k.kind)) {
        const b = Number(ctx.deskBudget);
        if (!Number.isInteger(b) || b < 1 || b > 100) { toast('السقف التخطيطي يجب أن يكون رقمًا من ١ إلى ١٠٠'); return; }
        payload.daily_budget_egp = b;
      }
    } else if (k.subject_type === 'custom_request') {
      if (!ctx.deskCustomId) { toast('اختاري طلب التصميم الخاص أولًا'); return; }
      payload.request_id = Number(ctx.deskCustomId);
    } else if (k.subject_type === 'ops_summary') {
      if (k.kind === 'executive_weekly_plan') {
        const b = Number(ctx.deskBudget);
        if (!Number.isInteger(b) || b < 1 || b > 100) { toast('السقف التخطيطي يجب أن يكون رقمًا من ١ إلى ١٠٠'); return; }
        payload.holiday_budget_egp = b;
      }
    }

    if (k.employee_id && k.employee_id !== ctx.ref) { toast('هذا القالب يخص مكتبًا آخر'); return; }
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add('quick_draft');
    rerenderDeskModal();
    let authEnded = false;
    try {
      const res = await officeApi('/quick-draft', {
        method: 'POST',
        body: {
          kind: k.kind,
          payload,
          idempotency_key: makeIdempotencyKey('desk'),
        },
      }, gen, uid);
      if (isCurrentSession(gen, uid)) {
        if (res && (res.prepared_for_review || (res.job && res.job.status === 'review'))) {
          toast('تم تحضير المسودة للمراجعة البشرية — راجعي الحقائق واعتمديها بدون إرسال تلقائي');
        } else {
          toast('تمت إضافة المسودة في طابور مراجعة المالكة — بدون إرسال تلقائي');
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تحضير المسودة');
    } finally {
      OFFICE_INFLIGHT.delete('quick_draft');
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, false);
      }
    }
  };

  async function refreshActiveContextModal(gen, uid) {
    const ctx = OFFICE_STATE.ctx;
    if (!ctx || !ctx.mode || !ctx.ref) return;
    if (ctx.mode === 'order_modal') {
      const data = await officeApi('/context/order/' + encodeURIComponent(ctx.ref), {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      OFFICE_STATE.ctx.cases = Array.isArray(data.cases) ? data.cases : [];
      OFFICE_STATE.ctx.jobs = Array.isArray(data.jobs) ? data.jobs : [];
      OFFICE_STATE.ctx.allowedKinds = Array.isArray(data.allowed_kinds) ? data.allowed_kinds : [];
    } else if (ctx.mode === 'style') {
      const data = await officeApi('/context/style/' + encodeURIComponent(ctx.ref), {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      OFFICE_STATE.ctx.jobs = Array.isArray(data.jobs) ? data.jobs : [];
      OFFICE_STATE.ctx.allowedKinds = Array.isArray(data.allowed_kinds) ? data.allowed_kinds : [];
    } else if (ctx.mode === 'custom') {
      const data = await officeApi('/context/custom/' + encodeURIComponent(ctx.ref), {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      OFFICE_STATE.ctx.cases = Array.isArray(data.cases) ? data.cases : [];
      OFFICE_STATE.ctx.jobs = Array.isArray(data.jobs) ? data.jobs : [];
      OFFICE_STATE.ctx.allowedKinds = Array.isArray(data.allowed_kinds) ? data.allowed_kinds : [];
    } else if (ctx.mode === 'ops') {
      const data = await officeApi('/context/ops/' + encodeURIComponent(ctx.ref), {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      OFFICE_STATE.ctx.jobs = Array.isArray(data.jobs) ? data.jobs : [];
      OFFICE_STATE.ctx.allowedKinds = Array.isArray(data.allowed_kinds) ? data.allowed_kinds : [];
    } else if (ctx.mode === 'desk') {
      const data = await officeApi('/context/desk/' + encodeURIComponent(ctx.ref), {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      OFFICE_STATE.ctx.roleObj = data.role || OFFICE_STATE.ctx.roleObj;
      OFFICE_STATE.ctx.cases = Array.isArray(data.cases) ? data.cases : [];
      OFFICE_STATE.ctx.jobs = Array.isArray(data.jobs) ? data.jobs : [];
      OFFICE_STATE.ctx.allowedKinds = Array.isArray(data.allowed_kinds) ? data.allowed_kinds : [];
      OFFICE_STATE.ctx.targets = data.targets || OFFICE_STATE.ctx.targets;
    }
    const modal = document.getElementById('modal');
    if (modal && document.getElementById('of-ctx-modal-root')) {
      modal.classList.add('of-wide');
      modal.innerHTML = ctx.mode === 'desk' ? renderDeskModalInner() : renderContextModalInner();
    }
  }

  window.officeOpenStyleAssistant = async function (styleId, styleName) {
    const sid = String(styleId || '').trim().toUpperCase();
    if (!sid) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    try {
      const data = await officeApi('/context/style/' + encodeURIComponent(sid), {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      OFFICE_STATE.ctx = {
        mode: 'style',
        ref: sid,
        title: String(styleName || data.style_name || sid),
        phone: '',
        cases: [],
        jobs: Array.isArray(data.jobs) ? data.jobs : [],
        allowedKinds: Array.isArray(data.allowed_kinds) ? data.allowed_kinds : [],
      };
      const modal = document.getElementById('modal');
      const ovl = document.getElementById('ovl');
      if (!modal || !ovl) return;
      modal.classList.add('of-wide');
      modal.innerHTML = renderContextModalInner();
      ovl.classList.add('on');
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) return;
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر فتح مساعد مسودات الموديل');
    }
  };

  window.officeOpenCustomAssistant = async function (requestId, customerPhone) {
    if (!isOwner()) return;
    const reqId = Number(requestId);
    if (!Number.isSafeInteger(reqId) || reqId < 1) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    try {
      const data = await officeApi('/context/custom/' + encodeURIComponent(String(reqId)), {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      OFFICE_STATE.ctx = {
        mode: 'custom',
        ref: String(reqId),
        title: `CUSTOM-${reqId}`,
        phone: String(customerPhone || ''),
        cases: Array.isArray(data.cases) ? data.cases : [],
        jobs: Array.isArray(data.jobs) ? data.jobs : [],
        allowedKinds: Array.isArray(data.allowed_kinds) ? data.allowed_kinds : [],
      };
      const modal = document.getElementById('modal');
      const ovl = document.getElementById('ovl');
      if (!modal || !ovl) return;
      modal.classList.add('of-wide');
      modal.innerHTML = renderContextModalInner();
      ovl.classList.add('on');
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) return;
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر فتح مسودات التصميم الخاص');
    }
  };

  window.officeOpenOpsAssistant = async function (scope) {
    const cleanScope = String(scope || '').trim();
    if (!['board', 'finance', 'system'].includes(cleanScope)) return;
    if (cleanScope !== 'board' && !isOwner()) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    try {
      const data = await officeApi('/context/ops/' + encodeURIComponent(cleanScope), {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      OFFICE_STATE.ctx = {
        mode: 'ops',
        ref: cleanScope,
        title: cleanScope,
        phone: '',
        cases: [],
        jobs: Array.isArray(data.jobs) ? data.jobs : [],
        allowedKinds: Array.isArray(data.allowed_kinds) ? data.allowed_kinds : [],
      };
      const modal = document.getElementById('modal');
      const ovl = document.getElementById('ovl');
      if (!modal || !ovl) return;
      modal.classList.add('of-wide');
      modal.innerHTML = renderContextModalInner();
      ovl.classList.add('on');
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) return;
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر فتح تقارير الفريق');
    }
  };

  window.officeQuickDraft = async function (kind, encodedPayload) {
    if (OFFICE_INFLIGHT.has('quick_draft')) return;
    let payload = null;
    try {
      payload = JSON.parse(decodeURIComponent(String(encodedPayload || '')));
    } catch (_) {
      toast('بيانات المسودة غير صالحة');
      return;
    }
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add('quick_draft');
    document.querySelectorAll('.of-quick-btn').forEach(b => {
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
    });

    let authEnded = false;
    try {
      const res = await officeApi('/quick-draft', {
        method: 'POST',
        body: {
          kind,
          payload,
          idempotency_key: makeIdempotencyKey('erp-quick'),
        },
      }, gen, uid);
      if (isCurrentSession(gen, uid)) {
        if (res && res.prepared_for_review) {
          toast('تم تحضير المسودة للمراجعة البشرية — راجعي الحقائق واعتمديها بدون إرسال تلقائي');
        } else {
          toast('تمت إضافة المسودة في طابور مراجعة المالكة — بدون إرسال تلقائي');
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تحضير المسودة');
    } finally {
      OFFICE_INFLIGHT.delete('quick_draft');
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, false);
      }
    }
  };

  window.officeOpenOrderAssistant = async function (orderCode, customerPhone) {
    const code = String(orderCode || '').trim().toUpperCase();
    if (!code) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    try {
      const data = await officeApi('/context/order/' + encodeURIComponent(code), {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      OFFICE_STATE.ctx = {
        mode: 'order_modal',
        ref: code,
        title: code,
        phone: String(customerPhone || ''),
        cases: Array.isArray(data.cases) ? data.cases : [],
        jobs: Array.isArray(data.jobs) ? data.jobs : [],
        allowedKinds: Array.isArray(data.allowed_kinds) ? data.allowed_kinds : [],
      };
      const modal = document.getElementById('modal');
      const ovl = document.getElementById('ovl');
      if (!modal || !ovl) return;
      modal.classList.add('of-wide');
      modal.innerHTML = renderContextModalInner();
      ovl.classList.add('on');
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) return;
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر فتح مسودات الطلب');
    }
  };

  window.officeStartEditJob = async function (jobId) {
    if (!isOwner()) return;
    const job = findJobAny(jobId);
    if (!job || !job.result) return;
    OFFICE_STATE.editingJobId = job.id;
    OFFICE_STATE.editingText = String(job.result.text || '');
    await rerenderAfterLockRelease(OFFICE_SESSION_GEN, currentUserId(), OFFICE_STATE.loadedOnce);
  };

  window.officeUpdateEditDraftText = function (val) {
    OFFICE_STATE.editingText = String(val ?? '');
  };

  window.officeCancelEditJob = async function () {
    OFFICE_STATE.editingJobId = '';
    OFFICE_STATE.editingText = '';
    await rerenderAfterLockRelease(OFFICE_SESSION_GEN, currentUserId(), OFFICE_STATE.loadedOnce);
  };

  window.officeSaveEditJob = async function (jobId) {
    if (!isOwner()) return;
    const lockKey = `job:${jobId}`;
    if (OFFICE_INFLIGHT.has(lockKey)) return;
    const job = findJobAny(jobId);
    if (!job || !job.result_hash) return;
    const ta = document.getElementById('of-edit-ta-' + jobId);
    const nextText = (ta && 'selectionStart' in ta) ? String(ta.value ?? '') : OFFICE_STATE.editingText;

    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add(lockKey);
    let hasFresh = false;
    let authEnded = false;
    try {
      await officeApi('/jobs/' + encodeURIComponent(jobId) + '/edit-text', {
        method: 'PATCH',
        body: {
          text: nextText,
          expected_revision: job.revision,
          expected_result_hash: job.result_hash,
        },
      }, gen, uid);
      OFFICE_STATE.editingJobId = '';
      OFFICE_STATE.editingText = '';
      delete OFFICE_STATE.staleAlerts[jobId];
      if (typeof VIEW !== 'undefined' && (VIEW === 'office' || VIEW === 'dash')) {
        hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      }
      if (isCurrentSession(gen, uid)) {
        toast('تم حفظ النص المعدّل وإعادة حساب البصمة — راجعيه واضغطي اعتماد للتثبيت');
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) {
        if (err && err.status === 409) {
          OFFICE_STATE.editingJobId = '';
          OFFICE_STATE.staleAlerts[jobId] = {
            code: err.code || 'stale_conflict',
            message: err.message || 'تغيّرت بيانات الطلب أو نسخة المسودة قبل الحفظ؛ حدّثي المسودة أولًا.',
          };
        } else {
          toast(err.message || 'تعذر حفظ تعديل النص');
        }
      }
    } finally {
      OFFICE_INFLIGHT.delete(lockKey);
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
    }
  };

  window.officeMarkJobUsed = async function (jobId, channel) {
    const lockKey = `job:${jobId}`;
    if (OFFICE_INFLIGHT.has(lockKey)) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    OFFICE_INFLIGHT.add(lockKey);
    let hasFresh = false;
    let authEnded = false;
    try {
      await officeApi('/jobs/' + encodeURIComponent(jobId) + '/mark-used', {
        method: 'POST',
        body: { channel: channel || 'internal' },
      }, gen, uid);
      if (typeof VIEW !== 'undefined' && (VIEW === 'office' || VIEW === 'dash')) {
        hasFresh = await fetchOfficeBundle({ sync: false, expectedGen: gen, expectedUid: uid });
      }
      if (isCurrentSession(gen, uid)) {
        toast('✓ تم تسجيل الاستخدام اليدوي للمسودة لمنع تكرار الإرسال');
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تسجيل الاستخدام اليدوي');
    } finally {
      OFFICE_INFLIGHT.delete(lockKey);
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
    }
  };

  window.officeShowReadinessModal = async function () {
    if (!isOwner()) return;
    const gen = OFFICE_SESSION_GEN;
    const uid = currentUserId();
    try {
      const r = await officeApi('/readiness', {}, gen, uid);
      if (!isCurrentSession(gen, uid)) return;
      const checks = Array.isArray(r.checks) ? r.checks : [];
      const q = r.queue_summary || {};
      const modal = document.getElementById('modal');
      const ovl = document.getElementById('ovl');
      if (!modal || !ovl) return;
      modal.classList.add('of-wide');
      modal.innerHTML = `
        <div class="inv-modal-head">
          <div>
            <h3>🚀 تقرير جاهزية التشغيل الفعلي — MAVI ERP + الشركة الافتراضية</h3>
            <p>فحص حي لقاعدة البيانات، ربط الـ١٧ دور بأقسام الـ ERP، عزل الصلاحيات، وضوابط ما قبل الرفع العام.</p>
          </div>
          <button type="button" class="inv-close" aria-label="إغلاق" onclick="closeModal()">×</button>
        </div>

        <div class="of-facts-grid" style="margin-top:10px">
          <div class="of-fact-item"><span>في الطابور</span><strong>${Number(q.queued || 0)}</strong></div>
          <div class="of-fact-item"><span>بانتظار مراجعة المالكة</span><strong>${Number(q.review || 0)}</strong></div>
          <div class="of-fact-item"><span>مسودات معتمدة</span><strong>${Number(q.approved || 0)}</strong></div>
          <div class="of-fact-item"><span>نُفِّذ بالأدوات وتحقق ✓</span><strong>${Number(q.executed_verified || 0)}</strong></div>
          <div class="of-fact-item"><span>فشل تنفيذ (بالسبب)</span><strong>${Number(q.executed_failed || 0)}</strong></div>
          <div class="of-fact-item"><span>مسجّل استخدام يدوي</span><strong>${Number(q.used_manually || 0)}</strong></div>
        </div>

        <div class="of-readiness-list">
          ${checks.map(c => `
            <div class="of-readiness-item" data-readiness-check="${esc(c.id)}">
              <div>
                <strong>${c.ok ? '✅' : (c.warn ? '⚠️' : '❌')} ${esc(c.label_ar)}</strong>
                <small>${esc(c.detail_ar)}</small>
              </div>
              <span class="of-pill ${c.ok ? 'ok' : (c.warn ? 'warn' : 'urgent')}">${c.ok ? 'جاهز' : (c.warn ? 'تنبيه قبل الرفع' : 'يلزم المراجعة')}</span>
            </div>
          `).join('')}
        </div>

        <div class="row" style="margin-top:14px">
          <button type="button" class="btn ghost sm" onclick="closeModal();go('system')">فتح النسخ والأمان ›</button>
          <button type="button" class="btn primary" onclick="closeModal()">تمت المراجعة</button>
        </div>
      `;
      ovl.classList.add('on');
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) return;
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر فحص جاهزية التشغيل');
    }
  };
})();
