/* MAVI Admin Office UI — «ملخص يومك», Owner Draft Approvals, and 17 Responsibility Templates.
   All RBAC, financial isolation, and stale-facts checks remain enforced on the server. */
(function () {
  'use strict';

  const OFFICE_STATE = {
    tab: 'summary', // 'summary' | 'drafts' | 'team'
    roleFilter: '',
    deptFilter: 'all',
    loading: false,
    error: '',
    loadedOnce: false,
    cases: [],
    jobs: [],
    roles: [],
    allowedKinds: [],
    teamNote: '',
    statusInfo: null,
    staleAlerts: {}, // jobId -> { code, message }
    compose: {
      kind: 'order_followup_draft',
      order_code: '',
      focus: 'schedule',
      product_id: 'DEMO-PUBLIC-01',
      channel: 'instagram',
      daily_budget_egp: '100',
      error: '',
    },
  };

  const OFFICE_INFLIGHT = new Set();

  function esc(x) {
    return typeof safeCustom === 'function'
      ? safeCustom(x)
      : String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function handleSessionExpired() {
    OFFICE_INFLIGHT.clear();
    try {
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

  async function officeApi(subPath, opts = {}) {
    const headers = { 'Content-Type': 'application/json' };
    if (typeof TOKEN !== 'undefined' && TOKEN) {
      headers.Authorization = 'Bearer ' + TOKEN;
    }
    const res = await fetch('/api/admin/office' + subPath, {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) {}
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
    deposit_followup_draft: 'مسودة متابعة عربون ومستحقات (للمالكة)',
    content_draft: 'مسودة محتوى منتج (قالب اختبار)',
    campaign_brief: 'موجز حملة تخطيطي (للمالكة)',
  };

  async function fetchOfficeBundle({ sync = true } = {}) {
    OFFICE_STATE.loading = true;
    OFFICE_STATE.error = '';
    try {
      const [casesRes, jobsRes, teamRes, statusRes] = await Promise.all([
        officeApi('/cases' + (sync ? '?sync=1' : '')),
        officeApi('/jobs'),
        officeApi('/team'),
        officeApi('/status'),
      ]);
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
    } catch (err) {
      if (err && err.status === 401) throw err;
      OFFICE_STATE.error = err.message || 'تعذر تحميل بيانات الملخص والمسودات.';
    } finally {
      OFFICE_STATE.loading = false;
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
          <button type="button" class="btn primary sm" data-open-subject-type="${esc(c.subject_type)}" data-open-subject-id="${Number(c.subject_id)}" data-open-subject-code="${esc(c.subject_code)}" onclick="officeOpenSubject('${esc(c.subject_type)}', ${Number(c.subject_id)}, '${esc(c.subject_code)}')">
            ${openLabel} ›
          </button>
          ${!compact && canDraftOrder ? `<button type="button" class="btn sm" onclick="officePrefillDraftFromCase('${esc(c.subject_code)}', '${esc(c.case_kind)}')">تحضير مسودة متابعة</button>` : ''}
          ${!compact ? `<button type="button" class="btn ghost sm" onclick="officeShowCaseHistory('${esc(c.subject_type)}', ${Number(c.subject_id)}, '${esc(c.subject_code)}')">سجل الحلقات</button>` : ''}
        </div>
      </article>
    `;
  }

  /* Compact «ملخص يومك» band embedded directly inside the main dashboard (`dashView`) */
  async function officeDashWidgetHtml() {
    await fetchOfficeBundle({ sync: true });
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
    const isBrief = selected.kind === 'campaign_brief';
    const creating = OFFICE_INFLIGHT.has('create_job');

    const catalogueStyles = (typeof CACHE !== 'undefined' && Array.isArray(CACHE.styles)) ? CACHE.styles : [];

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
          ` : `
            <label class="of-field" for="of-product-id">الموديل / عنصر الاختبار
              <select id="of-product-id" onchange="officeSetComposeField('product_id', this.value)">
                <option value="DEMO-PUBLIC-01" ${OFFICE_STATE.compose.product_id === 'DEMO-PUBLIC-01' ? 'selected' : ''}>DEMO-PUBLIC-01 (عنصر اختبار تجريبي)</option>
                ${catalogueStyles.map(s => `<option value="${esc(s.id)}" ${OFFICE_STATE.compose.product_id === s.id ? 'selected' : ''}>${esc(s.id)} — ${esc(s.name)}</option>`).join('')}
              </select>
            </label>
            <label class="of-field" for="of-channel">القناة
              <select id="of-channel" onchange="officeSetComposeField('channel', this.value)">
                <option value="instagram" ${OFFICE_STATE.compose.channel === 'instagram' ? 'selected' : ''}>Instagram</option>
                <option value="facebook" ${OFFICE_STATE.compose.channel === 'facebook' ? 'selected' : ''}>Facebook</option>
              </select>
            </label>
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

  function renderJobCard(j) {
    const st = JOB_STATUS_LABELS[j.status] || { label: j.status, cls: 'test' };
    const role = OFFICE_STATE.roles.find(r => r.id === j.employee_id);
    const roleLabel = role ? `${role.name} (${role.role})` : j.employee_id;
    const staleAlert = OFFICE_STATE.staleAlerts[j.id];
    const inflight = OFFICE_INFLIGHT.has(`job:${j.id}`);
    const res = j.result || null;
    const facts = res && Array.isArray(res.facts_used) ? res.facts_used : [];
    const checklist = res && Array.isArray(res.review_checklist) ? res.review_checklist : [];
    const isTestTemplate = !res || (res.provenance && res.provenance.mode === 'fixture') || j.subject_ref === 'DEMO-PUBLIC-01';

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
          <span>المرجع: <b class="mono">${esc(j.subject_ref)}</b></span>
          ${j.reviewed_by ? `<span>راجعتها: <b>${esc(j.reviewed_by)}</b></span>` : ''}
        </div>

        ${staleAlert ? `
          <div class="of-stale-alert" role="alert" data-stale-error="${esc(staleAlert.code)}">
            <strong>تعذر اعتماد المسودة لأن البيانات تغيّرت (${esc(staleAlert.code)})</strong>
            ${esc(staleAlert.message)}
            <br>لم يتم إعادة الاعتماد تلقائيًا. اضغطي «تحديث المسودة للمراجعة من جديد» لإعادة تحضيرها على البيانات الحالية ثم راجعيها قبل القرار.
            <div class="of-actions" style="margin-top:9px">
              <button type="button" class="btn sm primary" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeRefreshStaleJob('${esc(j.id)}')">
                ↻ تحديث المسودة للمراجعة من جديد
              </button>
              ${j.subject_type === 'order' ? `<button type="button" class="btn sm" onclick="openOrder('${esc(j.subject_ref)}')">فتح الطلب لمراجعة التعديلات ›</button>` : ''}
            </div>
          </div>
        ` : (j.subject_stale && j.status === 'review' ? `
          <div class="of-stale-alert" role="status">
            <strong>تنبيه: بيانات الطلب أو الموديل تغيّرت بعد تحضير هذه المسودة</strong>
            الحقائق أدناه قد لا تطابق آخر تعديل محفوظ على السيرفر. حدّثي المسودة وراجعيها قبل الاعتماد.
            <div class="of-actions" style="margin-top:9px">
              <button type="button" class="btn sm primary" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeRefreshStaleJob('${esc(j.id)}')">
                ↻ تحديث المسودة للمراجعة من جديد
              </button>
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
            <button type="button" class="btn primary" data-approve-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeDecideJob('${esc(j.id)}', 'approve')">
              ${inflight ? 'جاري تسجيل القرار...' : '✓ اعتماد المسودة (بدون إرسال أو صرف)'}
            </button>
            <button type="button" class="btn danger" data-reject-job="${esc(j.id)}" ${inflight ? 'disabled aria-busy="true"' : ''} onclick="officeDecideJob('${esc(j.id)}', 'reject')">
              ✕ رفض المسودة
            </button>
            ${j.subject_type === 'order' ? `<button type="button" class="btn sm" onclick="openOrder('${esc(j.subject_ref)}')">فتح الطلب ›</button>` : ''}
          </div>
        ` : `
          <div class="of-actions">
            ${j.subject_type === 'order' ? `<button type="button" class="btn sm" onclick="openOrder('${esc(j.subject_ref)}')">فتح الطلب ›</button>` : ''}
            ${!isOwner() && j.status === 'review' ? `<span class="of-pill warn">بانتظار مراجعة واعتماد المالكة</span>` : ''}
          </div>
        `}
      </article>
    `;
  }

  function renderDraftsTab() {
    const queuedCount = OFFICE_STATE.jobs.filter(j => j.status === 'queued').length;
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

        ${OFFICE_STATE.jobs.length
          ? `<div class="of-jobs-grid">${OFFICE_STATE.jobs.map(renderJobCard).join('')}</div>`
          : `<div class="of-empty">لا توجد مسودات مسجلة بعد. يمكنكِ إضافة مسودة جديدة في الطابور من النموذج أعلاه.</div>`}
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
            <button type="button" class="chip ${OFFICE_STATE.deptFilter === d ? 'on' : ''}" aria-pressed="${OFFICE_STATE.deptFilter === d}" onclick="officeSetDeptFilter('${esc(d)}')">
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
                    <button type="button" class="btn primary sm" onclick="officeFilterCasesByRole('${esc(r.id)}')">
                      عرض الحالات المفتوحة (${openCnt}) ›
                    </button>
                  ` : ''}
                  ${roleAllowedKinds.length ? `
                    <button type="button" class="btn sm" onclick="officeStartRoleDraft('${esc(roleAllowedKinds[0])}')">
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
    await fetchOfficeBundle({ sync: !OFFICE_STATE.loadedOnce });
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

    return `
      <div class="topbar">
        <div>
          <h1>${isOwner() ? 'ملخص يومك والموافقات والفريق' : 'ملخص يومك والمتابعة التشغيلية'}</h1>
          <div class="sub">${isOwner()
            ? 'متابعة الحالات الحقيقية بالأولوية، ومراجعة المسودات قبل الاعتماد، وقوالب مسؤوليات الفريق الـ١٧.'
            : 'متابعة الحالات التشغيلية اليومية ومسودات التنفيذ المسموحة بدون أي بيانات مالية.'}</div>
        </div>
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
    if (typeof render === 'function') render();
  };

  window.officeOpenSubject = function (subjectType, subjectId, subjectCode) {
    if (subjectType === 'order' && subjectCode) {
      if (typeof openOrder === 'function') openOrder(subjectCode);
      return;
    }
    if (subjectType === 'custom_request' && isOwner() && typeof window.maviOpenCustomAdmin === 'function') {
      window.maviOpenCustomAdmin(Number(subjectId));
    }
  };

  window.officeFilterCasesByRole = function (roleId) {
    OFFICE_STATE.roleFilter = roleId;
    OFFICE_STATE.tab = 'summary';
    if (typeof render === 'function') render();
  };

  window.officeClearRoleFilter = function () {
    OFFICE_STATE.roleFilter = '';
    if (typeof render === 'function') render();
  };

  window.officeSetDeptFilter = function (dept) {
    OFFICE_STATE.deptFilter = dept || 'all';
    if (typeof render === 'function') render();
  };

  window.officePrefillDraftFromCase = function (orderCode, caseKind) {
    OFFICE_STATE.compose.order_code = orderCode;
    OFFICE_STATE.compose.error = '';
    if (caseKind === 'workshop_unassigned' && OFFICE_STATE.allowedKinds.some(k => k.kind === 'workshop_followup_draft')) {
      OFFICE_STATE.compose.kind = 'workshop_followup_draft';
    } else if (['needs_quote', 'receipt_pending_review', 'deposit_unpaid'].includes(caseKind) && isOwner() && OFFICE_STATE.allowedKinds.some(k => k.kind === 'deposit_followup_draft')) {
      OFFICE_STATE.compose.kind = 'deposit_followup_draft';
    } else {
      OFFICE_STATE.compose.kind = 'order_followup_draft';
      OFFICE_STATE.compose.focus = caseKind === 'missing_measurements' ? 'measurements' : 'schedule';
    }
    OFFICE_STATE.tab = 'drafts';
    if (typeof render === 'function') render();
  };

  window.officeStartRoleDraft = function (kind) {
    if (OFFICE_STATE.allowedKinds.some(k => k.kind === kind)) {
      OFFICE_STATE.compose.kind = kind;
      OFFICE_STATE.compose.error = '';
    }
    OFFICE_STATE.tab = 'drafts';
    if (typeof render === 'function') render();
  };

  window.officeUpdateComposeKind = function (kind) {
    OFFICE_STATE.compose.kind = kind;
    OFFICE_STATE.compose.error = '';
    if (typeof render === 'function') render();
  };

  window.officeSetComposeField = function (field, value) {
    OFFICE_STATE.compose[field] = value;
  };

  window.officeRunSync = async function () {
    if (OFFICE_INFLIGHT.has('sync')) return;
    OFFICE_INFLIGHT.add('sync');
    try {
      await officeApi('/cases/sync', { method: 'POST', body: {} });
      toast('تم تحديث حالات المتابعة');
      await fetchOfficeBundle({ sync: false });
      if (typeof render === 'function') await render();
    } catch (err) {
      if (err && err.status === 401) return;
      toast(err.message || 'تعذر تحديث الحالات');
    } finally {
      OFFICE_INFLIGHT.delete('sync');
    }
  };

  window.officeSubmitCompose = async function () {
    if (OFFICE_INFLIGHT.has('create_job')) return;
    OFFICE_INFLIGHT.add('create_job');
    OFFICE_STATE.compose.error = '';
    const btn = document.getElementById('of-create-job-btn');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    try {
      const kind = OFFICE_STATE.compose.kind;
      let payload;
      if (kind === 'order_followup_draft') {
        payload = {
          order_code: String(OFFICE_STATE.compose.order_code || '').trim().toUpperCase(),
          focus: OFFICE_STATE.compose.focus || 'schedule',
        };
      } else if (kind === 'workshop_followup_draft' || kind === 'deposit_followup_draft') {
        payload = {
          order_code: String(OFFICE_STATE.compose.order_code || '').trim().toUpperCase(),
        };
      } else if (kind === 'campaign_brief') {
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
      });
      toast('تمت إضافة المسودة في الطابور بدون إرسال');
      await fetchOfficeBundle({ sync: false });
      if (typeof render === 'function') await render();
    } catch (err) {
      if (err && err.status === 401) return;
      OFFICE_STATE.compose.error = err.message || 'راجعي بيانات المسودة وحاولي مرة أخرى';
      if (typeof render === 'function') await render();
    } finally {
      OFFICE_INFLIGHT.delete('create_job');
    }
  };

  window.officeRunFixtureStep = async function () {
    if (!isOwner() || OFFICE_INFLIGHT.has('worker_step')) return;
    OFFICE_INFLIGHT.add('worker_step');
    const btn = document.getElementById('of-fixture-step-btn');
    if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
    try {
      const res = await officeApi('/worker/step', {
        method: 'POST',
        body: { provider: 'fixture' },
      });
      if (res.step && res.step.status === 'idle') {
        toast('لا توجد مسودات في الطابور حاليًا');
      } else {
        toast('تم تحضير مسودة اختبار محلية للمراجعة البشرية');
      }
      await fetchOfficeBundle({ sync: false });
      if (typeof render === 'function') await render();
    } catch (err) {
      if (err && err.status === 401) return;
      toast(err.message || 'تعذر تحضير قالب الاختبار');
    } finally {
      OFFICE_INFLIGHT.delete('worker_step');
    }
  };

  /* Owner review decision — strictly locked against double-clicks and NEVER auto-retries on 409! */
  window.officeDecideJob = async function (jobId, decision) {
    if (!isOwner()) return;
    const lockKey = `job:${jobId}`;
    if (OFFICE_INFLIGHT.has(lockKey)) return;

    const job = OFFICE_STATE.jobs.find(j => j.id === jobId);
    if (!job || !job.result_hash) return;

    OFFICE_INFLIGHT.add(lockKey);
    document.querySelectorAll(`[data-approve-job="${jobId}"], [data-reject-job="${jobId}"]`).forEach(b => {
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
    });

    try {
      await officeApi('/jobs/' + encodeURIComponent(jobId) + '/review', {
        method: 'POST',
        body: {
          expected_revision: job.revision,
          expected_result_hash: job.result_hash,
          decision,
        },
      });
      delete OFFICE_STATE.staleAlerts[jobId];
      toast(decision === 'approve'
        ? 'تم اعتماد المسودة كمسودة محفوظة فقط — بدون إرسال أو صرف'
        : 'تم رفض المسودة');
      await fetchOfficeBundle({ sync: false });
      if (typeof render === 'function') await render();
    } catch (err) {
      if (err && err.status === 401) return;
      if (err && err.status === 409) {
        // NEVER auto-reapprove! Surface explicit stale notice and require manual refresh + human re-review.
        OFFICE_STATE.staleAlerts[jobId] = {
          code: err.code || 'stale_conflict',
          message: err.message || 'تغيّرت بيانات الطلب أو نسخة المسودة بعد فتحها؛ حدّثي المسودة وراجعيها من جديد قبل اتخاذ القرار.',
        };
        if (typeof render === 'function') await render();
        return;
      }
      toast(err.message || 'تعذر حفظ القرار');
      if (typeof render === 'function') await render();
    } finally {
      OFFICE_INFLIGHT.delete(lockKey);
    }
  };

  /* Explicit manual refresh when a draft's underlying order/product changed — re-queues & prepares fresh draft for human review ONLY */
  window.officeRefreshStaleJob = async function (jobId) {
    const lockKey = `job:${jobId}`;
    if (OFFICE_INFLIGHT.has(lockKey)) return;
    OFFICE_INFLIGHT.add(lockKey);
    try {
      const latestRes = await officeApi('/jobs/' + encodeURIComponent(jobId));
      const latest = latestRes.job;
      await officeApi('/jobs/' + encodeURIComponent(jobId), {
        method: 'PATCH',
        body: {
          payload: latest.payload,
          expected_revision: latest.revision,
        },
      });
      if (isOwner()) {
        await officeApi('/worker/step', {
          method: 'POST',
          body: { provider: 'fixture' },
        });
      }
      delete OFFICE_STATE.staleAlerts[jobId];
      toast('تم تحديث المسودة على البيانات الحالية — راجعي النص والحقائق الجديدة قبل اتخاذ القرار');
      await fetchOfficeBundle({ sync: false });
      if (typeof render === 'function') await render();
    } catch (err) {
      if (err && err.status === 401) return;
      toast(err.message || 'تعذر تحديث المسودة');
    } finally {
      OFFICE_INFLIGHT.delete(lockKey);
    }
  };

  window.officeShowCaseHistory = async function (subjectType, subjectId, subjectCode) {
    try {
      const h = await officeApi(`/cases/${encodeURIComponent(subjectType)}/${Number(subjectId)}/history`);
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
      if (err && err.status === 401) return;
      toast(err.message || 'تعذر عرض السجل');
    }
  };
})();
