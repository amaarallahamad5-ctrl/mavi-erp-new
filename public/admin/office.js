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
      mode: '', // 'order' | 'style' | 'custom'
      ref: '',
      title: '',
      phone: '',
      cases: [],
      jobs: [],
      allowedKinds: [],
    };
  }

  const OFFICE_STATE = {
    tab: 'summary', // 'summary' | 'drafts' | 'team'
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

  const JOB_KIND_LABELS = {
    order_followup_draft: 'مسودة متابعة طلب عميلة',
    workshop_followup_draft: 'كشف متابعة ورشة وتنفيذ',
    quality_delivery_checklist: 'قائمة فحص الجودة قبل التسليم',
    customer_reply_draft: 'مسودة رد استفسار عميلة محكومة',
    deposit_followup_draft: 'مسودة متابعة عربون ومستحقات (للمالكة)',
    custom_design_followup_draft: 'مسودة مراجعة وتسعير تصميم خاص (للمالكة)',
    content_draft: 'مسودة محتوى منتج (قالب اختبار)',
    visual_reel_brief: 'موجز تصوير ريل وعرض مرئي',
    landing_page_check: 'فحص صفحة وصول الموديل ومسار الموبايل',
    community_followup_draft: 'مسودة تحويل استفسار وموافقة متابعة',
    seo_readiness_check: 'فحص جاهزية الظهور وصفحة الموديل',
    campaign_brief: 'موجز حملة تخطيطي (للمالكة)',
    paid_ad_setup_draft: 'مسودة إعداد حملة إعلانية محكومة لمصر (للمالكة)',
    daily_ops_triage: 'قائمة أولويات التشغيل اليومية',
    executive_weekly_plan: 'خطة أولويات الأسبوع المشتركة (للمالكة)',
    security_privacy_audit: 'فحص الخصوصية والصلاحيات والامتثال (للمالكة)',
    erp_data_health_report: 'تقرير سلامة بيانات الطلبات والربط (للمالكة)',
    funnel_attribution_report: 'تقرير قمع التحويل وفجوات القياس (للمالكة)',
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
            <h3 id="of-compose-title" style="font-size:15px;color:#172b4b;margin:0">تحضير مسودة جديدة في الطابور</h3>
            <p style="font-size:12px;color:#637386;margin-top:3px">إضافة المسودة تحفظها في الطابور فقط ولا تستدعي ذكاءً اصطناعيًا ولا ترسل شيئًا للعميلة.</p>
          </div>
          <span class="of-pill test">قوالب مسودات محلية — بدون إرسال آلي</span>
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

  function renderJobCard(j, opts) {
    const cardOpts = opts && typeof opts === 'object' ? opts : {};
    const st = JOB_STATUS_LABELS[j.status] || { label: j.status, cls: 'test' };
    const role = OFFICE_STATE.roles.find(r => r.id === j.employee_id);
    const roleLabel = role ? `${role.name} (${role.role})` : j.employee_id;
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

    return `
      <article class="of-job-card" data-job-id="${esc(j.id)}" data-job-status="${esc(j.status)}">
        <div class="of-job-top">
          <div style="display:flex;gap:7px;align-items:center;flex-wrap:wrap">
            <span class="of-pill ${st.cls}">${esc(st.label)}</span>
            <strong style="font-size:14.5px;color:#172b4b">${esc((res && res.title) || JOB_KIND_LABELS[j.kind] || j.kind)}</strong>
            ${isTestTemplate ? `<span class="of-pill test">قالب اختبار محلي — بدون AI</span>` : ''}
          </div>
          <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
            <span class="of-pill">النسخة #${Number(j.revision)} · مدخلات #${Number(j.input_revision)}</span>
            ${j.result_hash ? `<span class="of-pill" title="بصمة المسودة الكاملة: ${esc(j.result_hash)}">بصمة النص: <span class="mono">${esc(j.result_hash.slice(0, 12))}…</span></span>` : ''}
          </div>
        </div>

        <div class="of-meta-row">
          <span>قالب المسؤولية: <b>${esc(roleLabel)}</b></span>
          <span>المرجع: <b class="mono">${esc(displaySubjectRef)}</b></span>
          ${j.reviewed_by ? `<span>راجعتها: <b>${esc(j.reviewed_by)}</b></span>` : ''}
        </div>

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
            <div style="font-size:12px;font-weight:700;color:#41566e;margin-bottom:5px">نص المسودة المعروض للمراجعة:</div>
            <div class="of-draft-box">${esc(res.text)}</div>
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
            المسودة محفوظة في الطابور ولم تُولَّد بعد (العامل الخلفي متوقف افتراضيًا).
            ${isOwner() ? 'يمكنكِ توليد قالب اختبار محلي بالزر أعلاه لمعاينة النص والحقائق قبل القرار.' : 'توليد المسودات واعتمادها متاح للمالكة فقط.'}
          </div>
        `}

        ${isOwner() && j.status === 'review' ? `
          <div class="of-notice-only">اعتماد مسودة فقط — بدون إرسال أو صرف</div>
          <div class="of-actions">
            <button type="button" class="btn primary" data-approve-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeDecideJob(this.dataset.approveJob, 'approve')">
              ${inflight ? 'جاري تسجيل القرار...' : '✓ اعتماد المسودة (بدون إرسال أو صرف)'}
            </button>
            <button type="button" class="btn danger" data-reject-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeDecideJob(this.dataset.rejectJob, 'reject')">
              ✕ رفض المسودة
            </button>
            <button type="button" class="btn ghost sm" data-recheck-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeRecheckJob(this.dataset.recheckJob)">
              فحص البصمة الآن
            </button>
            ${orderCode ? `<button type="button" class="btn sm" data-open-order-code="${esc(orderCode)}" onclick="officeOpenOrderFromJob(this.dataset.openOrderCode)">فتح الطلب ›</button>` : ''}
            ${customId ? `<button type="button" class="btn sm" data-open-custom-id="${customId}" onclick="officeOpenSubject('custom_request', Number(this.dataset.openCustomId), 'CUSTOM-' + this.dataset.openCustomId)">فتح التصميم الخاص ›</button>` : ''}
          </div>
        ` : `
          <div class="of-actions">
            ${j.status === 'approved' && res && res.text ? `<button type="button" class="btn sm" data-copy-job="${esc(j.id)}" onclick="officeCopyApprovedText(this.dataset.copyJob)">نسخ النص المعتمد للاستخدام اليدوي</button>` : ''}
            ${waHref ? `<a class="btn wa sm" target="_blank" rel="noopener noreferrer" data-wa-approved-job="${esc(j.id)}" href="${esc(waHref)}">📲 فتح واتساب العميلة بالنص المعتمد (يدويًا)</a>` : ''}
            ${orderCode ? `<button type="button" class="btn sm" data-open-order-code="${esc(orderCode)}" onclick="officeOpenOrderFromJob(this.dataset.openOrderCode)">فتح الطلب ›</button>` : ''}
            ${customId ? `<button type="button" class="btn sm" data-open-custom-id="${customId}" onclick="officeOpenSubject('custom_request', Number(this.dataset.openCustomId), 'CUSTOM-' + this.dataset.openCustomId)">فتح التصميم الخاص ›</button>` : ''}
            ${!isOwner() && j.status === 'review' ? `<span class="of-pill warn">بانتظار مراجعة واعتماد المالكة</span>` : ''}
          </div>
        `}
      </article>
    `;
  }

  function renderDraftsTab() {
    const queuedCount = OFFICE_STATE.jobs.filter(j => j.status === 'queued').length;
    const reviewCnt = OFFICE_STATE.jobs.filter(j => j.status === 'review').length;
    const approvedCnt = OFFICE_STATE.jobs.filter(j => j.status === 'approved').length;
    const otherCnt = OFFICE_STATE.jobs.filter(j => !['queued', 'review', 'approved'].includes(j.status)).length;
    const sf = OFFICE_STATE.jobStatusFilter || 'all';
    const filteredJobs = sf === 'all'
      ? OFFICE_STATE.jobs
      : sf === 'other'
        ? OFFICE_STATE.jobs.filter(j => !['queued', 'review', 'approved'].includes(j.status))
        : OFFICE_STATE.jobs.filter(j => j.status === sf);
    const stepping = OFFICE_INFLIGHT.has('worker_step');
    const st = OFFICE_STATE.statusInfo;

    return `
      <section aria-labelledby="of-drafts-title" class="of-wrap">
        <div class="of-banner">
          <div>
            <strong>اعتماد مسودة فقط — بدون إرسال أو صرف</strong>
            <div>كل مخرجات هذا القسم مسودات نصية للمراجعة البشرية داخل اللوحة فقط؛ لا يوجد إرسال تلقائي للعميلات، ولا ربط إعلاني، ولا خصم أو تسجيل دفعات مالية.</div>
          </div>
          <div class="of-banner-badges">
            <span class="of-pill">العامل الخلفي: متوقف افتراضيًا</span>
            <span class="of-pill">ذكاء اصطناعي حي: غير متصل (0 طلبات شبكة)</span>
            ${isOwner() && st && st.openrouter ? `<span class="of-pill test">حالة المزوّد: ${esc(st.openrouter.status)}</span>` : ''}
          </div>
        </div>

        ${isOwner() ? `
          <div class="of-sec-head">
            <div>
              <h2 id="of-drafts-title">موافقات المسودات وطابور المراجعة (${OFFICE_STATE.jobs.length})</h2>
              <p>راجعي النص والنسخة والحقائق المستخدمة قبل القرار. إذا تغيّرت بيانات الطلب بعد تحضير المسودة سيرفض السيرفر الاعتماد القديم (409) لتحديثها أولًا.</p>
            </div>
            <div class="of-toolbar">
              <button type="button" class="btn sm" id="of-fixture-step-btn" ${(stepping || queuedCount === 0) ? 'disabled' : ''} ${stepping ? 'aria-busy="true"' : ''} onclick="officeRunFixtureStep()">
                ${stepping ? 'جاري تحضير قالب الاختبار...' : `تحضير مسودة من قالب اختبار محلي (${queuedCount} في الطابور)`}
              </button>
              ${queuedCount > 1 ? `
                <button type="button" class="btn primary sm" id="of-fixture-drain-btn" ${stepping ? 'disabled aria-busy="true"' : ''} onclick="officeRunFixtureDrain()">
                  ${stepping ? 'جاري التحضير...' : `⚡ تحضير كل الطابور للمراجعة (${queuedCount})`}
                </button>
              ` : ''}
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

        ${renderComposePanel()}

        ${OFFICE_STATE.jobs.length ? `
          <div class="filters" role="group" aria-label="تصفية المسودات حسب الحالة">
            <button type="button" class="chip ${sf === 'all' ? 'on' : ''}" aria-pressed="${sf === 'all'}" onclick="officeSetJobStatusFilter('all')">الكل (${OFFICE_STATE.jobs.length})</button>
            <button type="button" class="chip ${sf === 'review' ? 'on' : ''}" aria-pressed="${sf === 'review'}" onclick="officeSetJobStatusFilter('review')">بانتظار المراجعة (${reviewCnt})</button>
            <button type="button" class="chip ${sf === 'approved' ? 'on' : ''}" aria-pressed="${sf === 'approved'}" onclick="officeSetJobStatusFilter('approved')">معتمدة (${approvedCnt})</button>
            <button type="button" class="chip ${sf === 'queued' ? 'on' : ''}" aria-pressed="${sf === 'queued'}" onclick="officeSetJobStatusFilter('queued')">في الطابور (${queuedCount})</button>
            ${otherCnt > 0 ? `<button type="button" class="chip ${sf === 'other' ? 'on' : ''}" aria-pressed="${sf === 'other'}" onclick="officeSetJobStatusFilter('other')">مرفوضة / أخرى (${otherCnt})</button>` : ''}
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
        <div class="of-banner">
          <div>
            <strong>قوالب تنظيم المسؤوليات (١٧ دورًا) — بدون موظفين آليين في الخلفية</strong>
            <div>${esc(OFFICE_STATE.teamNote || 'الأدوار الـ١٧ هي قوالب لتوزيع المسؤوليات ومتابعة الحالات داخل MAVI وليست حسابات دخول مستقلة، ولا يوجد ذكاء اصطناعي شغال في الخلفية.')}</div>
          </div>
          <div class="of-banner-badges">
            <span class="of-pill">١٧ قالب مسؤولية</span>
            <span class="of-pill test">لا يوجد تنفيذ آلي خلفي</span>
          </div>
        </div>

        <div class="of-sec-head">
          <div>
            <h2 id="of-team-title">بطاقات مسؤوليات الفريق (${visibleRoles.length} / ${OFFICE_STATE.roles.length})</h2>
            <p>كل بطاقة مرتبطة بالحالات الحقيقية المفتوحة الآن وبقوالب المسودات المتاحة فعليًا لصلاحيتك.</p>
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
                <div class="of-role-gate"><b>ضابط المراجعة البشرية:</b> ${esc(r.limits)}</div>
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
    } else if (OFFICE_STATE.tab === 'drafts') {
      bodyHtml = renderDraftsTab();
    } else if (OFFICE_STATE.tab === 'team') {
      bodyHtml = renderTeamTab();
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
            <button type="button" class="btn ghost sm" id="of-audit-log-btn" onclick="officeShowAuditLog()">
              سجل القرارات والمراجعات
            </button>
          </div>
        ` : ''}
      </div>

      <div class="of-tabs" role="tablist" aria-label="أقسام المكتب والمتابعة" onkeydown="officeTabsKeydown(event)">
        <button type="button" role="tab" id="of-tab-summary" class="of-tab" aria-selected="${OFFICE_STATE.tab === 'summary'}" tabindex="${OFFICE_STATE.tab === 'summary' ? '0' : '-1'}" onclick="officeSwitchTab('summary')">
          <span>ملخص يومك</span>
          <span class="of-tab-cnt">${OFFICE_STATE.cases.length}</span>
        </button>
        <button type="button" role="tab" id="of-tab-drafts" class="of-tab" aria-selected="${OFFICE_STATE.tab === 'drafts'}" tabindex="${OFFICE_STATE.tab === 'drafts' ? '0' : '-1'}" onclick="officeSwitchTab('drafts')">
          <span>${isOwner() ? 'موافقات المسودات' : 'مسودات المتابعة'}</span>
          <span class="of-tab-cnt">${reviewCount}</span>
        </button>
        <button type="button" role="tab" id="of-tab-team" class="of-tab" aria-selected="${OFFICE_STATE.tab === 'team'}" tabindex="${OFFICE_STATE.tab === 'team' ? '0' : '-1'}" onclick="officeSwitchTab('team')">
          <span>الفريق (١٧ قالب مسؤولية)</span>
          <span class="of-tab-cnt">${OFFICE_STATE.roles.length || 17}</span>
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
    const order = ['summary', 'drafts', 'team'];
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
          toast('تم تحضير مسودة اختبار محلية للمراجعة البشرية');
        }
      }
    } catch (err) {
      if (err && (err.status === 401 || err.staleSession)) { authEnded = true; return; }
      if (isCurrentSession(gen, uid)) toast(err.message || 'تعذر تحضير قالب الاختبار');
    } finally {
      OFFICE_INFLIGHT.delete('worker_step');
      if (!authEnded) {
        await rerenderAfterLockRelease(gen, uid, hasFresh);
      }
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
    try {
      await officeApi('/jobs/' + encodeURIComponent(jobId) + '/review', {
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
        toast(decision === 'approve'
          ? 'تم اعتماد المسودة كمسودة محفوظة فقط — بدون إرسال أو صرف'
          : 'تم رفض المسودة');
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
        title: '🎬 موجز تصوير ريل وعرض مرئي — مايا',
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
    if (ctx.mode === 'style') {
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

        ${ctx.mode === 'custom' ? renderErpCasesCompact(ctx.cases) : ''}

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

  async function refreshActiveContextModal(gen, uid) {
    const ctx = OFFICE_STATE.ctx;
    if (!ctx || !ctx.mode || !ctx.ref) return;
    if (ctx.mode === 'style') {
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
    }
    const modal = document.getElementById('modal');
    if (modal && document.getElementById('of-ctx-modal-root')) {
      modal.classList.add('of-wide');
      modal.innerHTML = renderContextModalInner();
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
})();
