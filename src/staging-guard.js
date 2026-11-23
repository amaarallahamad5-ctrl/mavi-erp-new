'use strict';
/* Explicit staging protection:
   1) X-Robots-Tag: noindex, nofollow, noarchive + Disallow-all /robots.txt
   2) Server-enforced admin session gate on storefront/catalogue/SEO routes
      (noindex alone is NOT access control)
   3) Explicit code-level disablement of the app's outbound channels:
      Twilio WhatsApp (src/notify.js), Web Push delivery/subscriptions
      (src/web-alerts.js), Google Analytics script/CSP, and OpenRouter AI. */
const A = require('./auth');
const { get } = require('./db');

const STAGING_CSP = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data: blob:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'self'; manifest-src 'self'";

const OUTBOUND_TELEMETRY = {
  total_network_attempts: 0,
  blocked_in_staging: {
    twilio_whatsapp: 0,
    web_push: 0,
    google_analytics: 0,
    openrouter_ai: 0,
  },
  network_attempts_by_channel: {
    twilio_whatsapp: 0,
    web_push: 0,
    openrouter_ai: 0,
  },
};

function recordOutboundTelemetry(channel, outcome) {
  if (outcome === 'blocked_staging' && Object.prototype.hasOwnProperty.call(OUTBOUND_TELEMETRY.blocked_in_staging, channel)) {
    OUTBOUND_TELEMETRY.blocked_in_staging[channel] += 1;
  } else if (outcome === 'network_attempt' && Object.prototype.hasOwnProperty.call(OUTBOUND_TELEMETRY.network_attempts_by_channel, channel)) {
    OUTBOUND_TELEMETRY.network_attempts_by_channel[channel] += 1;
    OUTBOUND_TELEMETRY.total_network_attempts += 1;
  }
}

function getOutboundTelemetry() {
  return {
    total_network_attempts: OUTBOUND_TELEMETRY.total_network_attempts,
    blocked_in_staging: { ...OUTBOUND_TELEMETRY.blocked_in_staging },
    network_attempts_by_channel: { ...OUTBOUND_TELEMETRY.network_attempts_by_channel },
  };
}

function isStagingMode() {
  return process.env.MAVI_STAGING_MODE === '1';
}

function readAdminCookieToken(req) {
  const authHeader = String(req.headers.authorization || '');
  if (authHeader.startsWith('Bearer ')) return authHeader.slice(7).trim();
  const cookie = String(req.headers.cookie || '');
  const match = cookie.match(/(?:^|;\s*)mavi_admin_session=([^;]+)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch (_) { return null; }
}

function resolveAdminPrincipal(req) {
  const token = readAdminCookieToken(req);
  if (!token) return null;
  const session = A.resolve(token);
  if (!session || session.realm !== 'admin') return null;
  const user = get('SELECT id, email, name, role FROM users WHERE id = ? AND active = 1', session.subject_id);
  if (!user || !['owner', 'staff'].includes(user.role)) return null;
  return { session, user };
}

function isAllowedPreLoginRoute(req) {
  const method = req.method;
  const p = req.path || '/';
  if ((method === 'GET' || method === 'HEAD') && (p === '/healthz' || p === '/robots.txt')) return true;
  if (method === 'POST' && p === '/api/admin/auth/login') return true;
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (p === '/admin' || p === '/admin/') return true;
  if (p.startsWith('/admin/') && /\.(?:js|css|html)$/i.test(p)) return true;
  if (p === '/mavi-i18n.js' || p === '/web-alerts.js') return true;
  if (p.startsWith('/brand/') && /\.(?:png|webp|jpg|jpeg|ico)$/i.test(p)) return true;
  return false;
}

function outboundPolicySummary() {
  const staging = isStagingMode();
  return {
    staging_mode: staging,
    channels: {
      twilio_whatsapp: {
        disabled_in_staging: true,
        active: !staging && !!(process.env.TWILIO_SID && process.env.TWILIO_TOKEN && process.env.TWILIO_WHATSAPP_FROM),
      },
      web_push: {
        disabled_in_staging: true,
        active: !staging,
      },
      google_analytics: {
        disabled_in_staging: true,
        active: !staging,
      },
      openrouter_ai: {
        disabled_in_staging: true,
        active: false,
      },
    },
  };
}

function stagingMiddleware(req, res, next) {
  if (!isStagingMode()) return next();

  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', STAGING_CSP);

  if ((req.method === 'GET' || req.method === 'HEAD') && req.path === '/robots.txt') {
    return res.type('text/plain; charset=utf-8').send('User-agent: *\nDisallow: /\n');
  }

  if (isAllowedPreLoginRoute(req)) return next();

  const adminPrincipal = resolveAdminPrincipal(req);
  if (!adminPrincipal) {
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({
        error: 'staging_auth_required',
        message: 'بيئة اختبار محمية — يلزم تسجيل دخول الإدارة أولًا',
      });
    }
    return res.status(401).type('text/html; charset=utf-8').send(
      '<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">' +
      '<meta name="robots" content="noindex,nofollow,noarchive">' +
      '<title>MAVI Staging — تسجيل دخول مطلوب</title></head>' +
      '<body style="font-family:Tahoma,Arial,sans-serif;background:#f7f3ed;color:#121E48;padding:40px;text-align:center">' +
      '<h1>بيئة اختبار MAVI محمية</h1><p>الوصول متاح لفريق الإدارة المسجّل فقط.</p>' +
      '<p><a href="/admin/" style="color:#121E48;font-weight:bold">الانتقال لتسجيل دخول الإدارة</a></p>' +
      '</body></html>'
    );
  }

  if ((req.method === 'GET' || req.method === 'HEAD') && req.path === '/store/analytics-consent.js') {
    recordOutboundTelemetry('google_analytics', 'blocked_staging');
    return res.type('application/javascript; charset=utf-8').send(
      "/* MAVI staging: external analytics explicitly disabled */\nwindow['ga-disable-G-JYBHFBY025']=true;\n"
    );
  }

  return next();
}

module.exports = {
  STAGING_CSP,
  isStagingMode,
  resolveAdminPrincipal,
  outboundPolicySummary,
  recordOutboundTelemetry,
  getOutboundTelemetry,
  stagingMiddleware,
};
