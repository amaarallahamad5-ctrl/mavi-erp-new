'use strict';
/* 17 virtual office role templates adapted from Accounting's data/mavi-team.json.
   IMPORTANT: These are responsibility & workflow templates only — NEVER login
   accounts, sessions, or independent security principals. Server authorization
   is strictly enforced via MAVI's authenticated user roles ('owner' vs 'staff'). */

const TEAM_ROLES = Object.freeze([
  {
    id: 'rami', name: 'رامي', role: 'المدير العام', department: 'الإدارة العليا', manager_id: null,
    description: 'اعتماد الأولويات وتنسيق التشغيل والتسويق ورفع القرارات للمالكة',
    deliverable: 'خطة أسبوعية تجمع التسليمات والحملة وقرارات المالكة',
    kpi: 'جاهزية التنفيذ وجودة الطلبات المؤكدة',
    limits: 'لا يعتمد سعرًا أو دفعة أو إنفاقًا نيابة عن المالكة',
    starter_task: 'إعداد خطة أسبوعية مشتركة للتشغيل والتسويق',
    initial: 'R', color: '#8b7455',
  },
  {
    id: 'tarek', name: 'طارق', role: 'مسؤول الأمان والجودة', department: 'الإدارة العليا', manager_id: 'rami',
    description: 'مراجعة الخصوصية والصلاحيات وصحة الادعاءات قبل النشر',
    deliverable: 'قائمة فحص ومخاطر وقرار جاهزية للمراجعة',
    kpi: 'اجتياز اختبارات الصلاحيات وعدم تسريب بيانات',
    limits: 'له رفع توصية إيقاف؛ لا يغيّر الصلاحيات تلقائيًا',
    starter_task: 'تجهيز قائمة فحص خصوصية القياس وصلاحيات الفريق',
    initial: 'T', color: '#73878a',
  },
  {
    id: 'salma', name: 'سلمى', role: 'مديرة التشغيل', department: 'التشغيل', manager_id: 'rami',
    description: 'توزيع المتابعات والتأكد من جاهزية الطلبات ومواعيد التنفيذ',
    deliverable: 'قائمة أولويات يومية مرتبطة بأسباب ومصادر',
    kpi: 'طلبات مفتوحة متأخرة ومتطلبات ناقصة',
    limits: 'أي وعد تسليم جديد يحتاج مراجعة واعتماد',
    starter_task: 'تصميم قائمة الطلبات المحتاجة تدخلًا ومسار تصعيدها',
    initial: 'S', color: '#53796b',
  },
  {
    id: 'omar', name: 'عمر', role: 'محاسب', department: 'التشغيل', manager_id: 'salma',
    description: 'مراجعة العربون والإيصالات والمتبقي باستخدام حسابات النظام',
    deliverable: 'قائمة إيصالات للمراجعة ومسودات متابعة مالية',
    kpi: 'مدة انتظار اعتماد الإيصال ودقة الأرصدة',
    limits: 'لا يعتمد دفعة أو يصححها أو يرد أموالًا تلقائيًا',
    starter_task: 'وضع قواعد فصل إيصال قيد المراجعة عن العربون المعتمد',
    initial: 'O', color: '#6a8d76',
  },
  {
    id: 'nour', name: 'نور', role: 'منسقة الطلبات والمقاسات', department: 'التشغيل', manager_id: 'salma',
    description: 'فحص اكتمال متطلبات التفصيل والتسعير وتاريخ التسليم',
    deliverable: 'قائمة نواقص لكل طلب ومسودة طلب استكمال',
    kpi: 'زمن استكمال متطلبات الطلب',
    limits: 'لا تستنتج قياسات من الصور ولا تعدلها دون مراجعة',
    starter_task: 'تحديد متطلبات جاهزية طلب الجاهز والتفصيل والتصميم الخاص',
    initial: 'N', color: '#ae7e68',
  },
  {
    id: 'hana', name: 'هنا', role: 'منسقة الورش والإنتاج', department: 'التشغيل', manager_id: 'salma',
    description: 'تجميع متابعات القص والخياطة والورش حسب الموعد المسجل',
    deliverable: 'كشف متابعة ورش ومقترح تصعيد التأخير',
    kpi: 'التأخير المسجل والمتابعات المغلقة',
    limits: 'لا تفترض طاقة ورشة غير مسجلة ولا تكشف تكلفتها للموظفين',
    starter_task: 'تجهيز نموذج متابعة الورش للطلبات القريبة والمتأخرة',
    initial: 'H', color: '#79957a',
  },
  {
    id: 'dina', name: 'دينا', role: 'مسؤولة الجودة والتسليم', department: 'التشغيل', manager_id: 'salma',
    description: 'تجهيز فحص القطعة ومتابعة جاهزية التسليم والإصلاح',
    deliverable: 'قائمة فحص وتسليم وحالات إصلاح تحتاج قرارًا',
    kpi: 'اكتمال الفحص ومشاكل ما بعد التسليم',
    limits: 'الفحص الفعلي بشري؛ لا تؤكد جودة قطعة من سجل فقط',
    starter_task: 'إعداد قائمة فحص قبل التسليم ومسار تصعيد الإصلاح',
    initial: 'D', color: '#9b8770',
  },
  {
    id: 'basma', name: 'بسمة', role: 'مسؤولة خدمة العميلات', department: 'التشغيل', manager_id: 'salma',
    description: 'تجهيز ردود حالة الطلب واستكمال المعلومات وتصعيد الشكاوى',
    deliverable: 'مسودات ردود من بيانات الطلب المسموح بها',
    kpi: 'زمن الرد وحل الاستفسار',
    limits: 'تتحقق من ملكية الطلب؛ لا ترسل تلقائيًا أو تعد بسعر أو موعد',
    starter_task: 'إعداد قوالب متابعة الطلب دون كشف بيانات عميلة أخرى',
    initial: 'B', color: '#a27e9b',
  },
  {
    id: 'youssef', name: 'يوسف', role: 'مسؤول بيانات وربط ERP', department: 'التشغيل', manager_id: 'salma',
    description: 'تعريف مصادر البيانات والربط والأحداث الموثوقة ومنع التكرار',
    deliverable: 'خريطة مصادر وحقول واختبارات قياس وتكامل',
    kpi: 'دقة البيانات ونجاح الاختبارات',
    limits: 'لا وصول حر لقاعدة الإنتاج ولا نشر دون مراجعة',
    starter_task: 'رسم مصادر بيانات الطلبات والتحصيل وأحداث نجاح الطلب',
    initial: 'Y', color: '#7c83a7',
  },
  {
    id: 'karim', name: 'كريم', role: 'مدير التسويق والنمو', department: 'التسويق', manager_id: 'rami',
    description: 'اختيار عرض واحد وتنسيق المحتوى والتوزيع والقياس مع التشغيل',
    deliverable: 'موجز حملة أسبوعي قابل للاعتماد بحد صرف واضح',
    kpi: 'عميلات جديدات مؤكدات وتكلفة اكتساب قابلة للإثبات',
    limits: 'لا ضمان مبيعات ولا إطلاق حملة أو زيادة ميزانية تلقائيًا',
    starter_task: 'تجهيز تجربة ١٠٠ جنيه ليوم الإعلان في الإجازة دون افتراض عدد الأيام',
    initial: 'K', color: '#6b82a2',
  },
  {
    id: 'laila', name: 'ليلى', role: 'كاتبة المحتوى', department: 'التسويق', manager_id: 'karim',
    description: 'صياغة وصف المنتجات والريلز والإعلانات من حقائق الكتالوج',
    deliverable: 'نصوص ومنشورات وسيناريوهات للمراجعة',
    kpi: 'محتوى معتمد وزيارات مؤهلة بحسب البيانات المتاحة',
    limits: 'لا تختلق خامات أو خصومات أو تقييمات',
    starter_task: 'تجهيز ٣ أفكار محتوى عضوي لعرض واحد من منتجات حقيقية',
    initial: 'L', color: '#8b7455',
  },
  {
    id: 'maya', name: 'مايا', role: 'مصممة المحتوى المرئي', department: 'التسويق', manager_id: 'karim',
    description: 'تحويل صور البراند المصرح بها إلى موجزات تصميم ولقطات عرض',
    deliverable: 'موجز ريل وتصميم إعلان بمواد معتمدة',
    kpi: 'وضوح المنتج وجودة المواد المعتمدة',
    limits: 'لا تستخدم صور عميلات دون إذن ولا تعرض صورًا مولدة كعمل سابق',
    starter_task: 'إعداد موجز تصوير ريل لقطعة حقيقية دون ادعاءات مضللة',
    initial: 'M', color: '#73878a',
  },
  {
    id: 'ziad', name: 'زياد', role: 'مسؤول الإعلانات المدفوعة', department: 'التسويق', manager_id: 'karim',
    description: 'اقتراح إعداد حملة صغيرة ومراجعة الجدول والصرف والوجهة',
    deliverable: 'مسودة إعداد حملة وسقف فترة للموافقة',
    kpi: 'الصرف الفعلي ونتائج مؤهلة لا الضغطات وحدها',
    limits: 'لا ربط حساب أو نشر أو إنفاق دون اعتماد المالكة',
    starter_task: 'تجهيز مسودة حملة واحدة لمصر بسقف يراجَع قبل الإطلاق',
    initial: 'Z', color: '#53796b',
  },
  {
    id: 'farah', name: 'فرح', role: 'محللة التسويق والتحويل', department: 'التسويق', manager_id: 'karim',
    description: 'فصل الزيارة وضغط واتساب ونجاح الطلب والعربون المؤكد',
    deliverable: 'تقرير قمع يبيّن المصدر ونقص البيانات',
    kpi: 'تحويل موثوق وتكلفة اكتساب عند كفاية البيانات',
    limits: 'لا تعتبر النقرة بيعًا ولا تنسب إيرادًا دون دليل',
    starter_task: 'تحديد فجوات القياس الحالية وخطة attribution تحترم الموافقة',
    initial: 'F', color: '#6a8d76',
  },
  {
    id: 'adam', name: 'آدم', role: 'مسؤول البحث وصفحات الوصول', department: 'التسويق', manager_id: 'karim',
    description: 'تحسين صفحة العرض والبحث ووضوح السعر والتنفيذ والتوصيل',
    deliverable: 'قائمة تحسينات صفحة وفحص فهرسة وطلب موبايل',
    kpi: 'زيارات بحث مؤهلة واكتمال مسار الطلب',
    limits: 'لا يعد بترتيب بحث ولا يغير سياسات أو أسعار دون اعتماد',
    starter_task: 'فحص متطلبات صفحة وصول العرض والفهرسة قبل الإعلان',
    initial: 'A', color: '#ae7e68',
  },
  {
    id: 'jana', name: 'جنى', role: 'مسؤولة المجتمع والمتابعة التسويقية', department: 'التسويق', manager_id: 'karim',
    description: 'تنظيم الرد على الاهتمام وجمع الأسئلة والتقييمات بإذن',
    deliverable: 'قائمة استفسارات مؤهلة ومسودات متابعة اختيارية',
    kpi: 'استفسارات مؤهلة ومتابعات بموافقة',
    limits: 'لا جمع أرقام أو رسائل جماعية غير مطلوبة؛ رسالة طلب ليست موافقة تسويق',
    starter_task: 'إعداد مسار تحويل الاستفسار للموقع وموافقة المتابعة التسويقية',
    initial: 'J', color: '#79957a',
  },
  {
    id: 'nadine', name: 'نادين', role: 'مسؤولة Google والظهور والامتثال', department: 'التسويق', manager_id: 'karim',
    description: 'تنسيق إثبات ملكية الموقع والفهرسة والقياس ومراجعات خدمات Google المطلوبة بحسب نوع الربط',
    deliverable: 'ملف جاهزية Google يفرّق بين التحقق والفهرسة وموافقات التتبّع والتحقق من تطبيق OAuth عند انطباقه',
    kpi: 'فحوصات موثقة وصفحات قابلة للفهرسة وقياس بموافقة؛ لا ضمان ترتيب أو قبول',
    limits: 'لا ربط مباشر بخوارزمية Google ولا ضمان موافقة؛ لا مفاتيح أو توكنات في HTML ولا طلب صلاحيات غير ضرورية',
    starter_task: 'حصر متطلبات Search Console وGA4 وOAuth والإعلانات وفصل المطلوب من غير المنطبق',
    initial: 'N', color: '#a9865d',
  },
].map(r => Object.freeze({
  ...r,
  template_only: true,
  is_auth_principal: false,
})));

const JOB_KINDS = Object.freeze({
  order_followup_draft: Object.freeze({
    kind: 'order_followup_draft',
    label: 'مسودة متابعة طلب تشغيلية',
    employee_id: 'nour',
    subject_type: 'order',
    financial: false,
    allowed_create_roles: Object.freeze(['owner', 'staff']),
    visibility_roles: Object.freeze(['owner', 'staff']),
    approval_roles: Object.freeze(['owner']),
  }),
  workshop_followup_draft: Object.freeze({
    kind: 'workshop_followup_draft',
    label: 'مسودة متابعة ورشة وإنتاج',
    employee_id: 'hana',
    subject_type: 'order',
    financial: false,
    allowed_create_roles: Object.freeze(['owner', 'staff']),
    visibility_roles: Object.freeze(['owner', 'staff']),
    approval_roles: Object.freeze(['owner']),
  }),
  content_draft: Object.freeze({
    kind: 'content_draft',
    label: 'مسودة محتوى لقطعة',
    employee_id: 'laila',
    subject_type: 'catalogue',
    financial: false,
    allowed_create_roles: Object.freeze(['owner', 'staff']),
    visibility_roles: Object.freeze(['owner', 'staff']),
    approval_roles: Object.freeze(['owner']),
  }),
  campaign_brief: Object.freeze({
    kind: 'campaign_brief',
    label: 'موجز حملة وسقف تخطيطي',
    employee_id: 'karim',
    subject_type: 'catalogue',
    financial: true,
    allowed_create_roles: Object.freeze(['owner']),
    visibility_roles: Object.freeze(['owner']),
    approval_roles: Object.freeze(['owner']),
  }),
  deposit_followup_draft: Object.freeze({
    kind: 'deposit_followup_draft',
    label: 'مسودة متابعة عربون وتحصيل',
    employee_id: 'omar',
    subject_type: 'order',
    financial: true,
    allowed_create_roles: Object.freeze(['owner']),
    visibility_roles: Object.freeze(['owner']),
    approval_roles: Object.freeze(['owner']),
  }),
  custom_design_followup_draft: Object.freeze({
    kind: 'custom_design_followup_draft',
    label: 'مسودة مراجعة وتسعير تصميم خاص',
    employee_id: 'omar',
    subject_type: 'custom_request',
    financial: true,
    allowed_create_roles: Object.freeze(['owner']),
    visibility_roles: Object.freeze(['owner']),
    approval_roles: Object.freeze(['owner']),
  }),
  seo_readiness_check: Object.freeze({
    kind: 'seo_readiness_check',
    label: 'فحص جاهزية الظهور وصفحة الموديل',
    employee_id: 'nadine',
    subject_type: 'catalogue',
    financial: false,
    allowed_create_roles: Object.freeze(['owner', 'staff']),
    visibility_roles: Object.freeze(['owner', 'staff']),
    approval_roles: Object.freeze(['owner']),
  }),
  executive_weekly_plan: Object.freeze({
    kind: 'executive_weekly_plan',
    label: 'خطة أولويات الأسبوع المشتركة',
    employee_id: 'rami',
    subject_type: 'ops_summary',
    financial: true,
    allowed_create_roles: Object.freeze(['owner']),
    visibility_roles: Object.freeze(['owner']),
    approval_roles: Object.freeze(['owner']),
  }),
});

const ROLE_BY_ID = new Map(TEAM_ROLES.map(r => [r.id, r]));

function teamForRole(userRole) {
  const isOwner = userRole === 'owner';
  return TEAM_ROLES.map(r => {
    const jobKinds = Object.values(JOB_KINDS)
      .filter(spec => spec.employee_id === r.id && spec.visibility_roles.includes(userRole))
      .map(spec => spec.kind);
    if (isOwner) return { ...r, job_kinds: jobKinds };
    return {
      ...r,
      job_kinds: jobKinds,
      starter_task: r.id === 'karim'
        ? 'تجهيز خطة محتوى الإجازة الأسبوعية للمراجعة من المالكة'
        : r.starter_task,
    };
  });
}

function visibleJobKindsForRole(userRole) {
  return Object.values(JOB_KINDS)
    .filter(spec => spec.visibility_roles.includes(userRole))
    .map(spec => ({
      kind: spec.kind,
      label: spec.label,
      employee_id: spec.employee_id,
      subject_type: spec.subject_type,
      requires_owner_approval: true,
    }));
}

module.exports = {
  TEAM_ROLES,
  ROLE_BY_ID,
  JOB_KINDS,
  teamForRole,
  visibleJobKindsForRole,
};
