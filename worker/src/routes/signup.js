// ============================================================
// PUBLIC SIGNUP — Self-service practice creation
// ============================================================
// POST /api/public/signup
// No auth required. Rate-limited by IP to prevent spam.
// Body: {
//   practice_name, slug, owner_name, owner_email, password,
//   locale ('de'|'en'|'tr'), phone?, city?, specialty?,
//   gdpr_consent (must be true)
// }
// Response: { practice_id, slug, login_url, booking_url, token }
// ============================================================

import { jsonResponse, jsonError } from '../lib/http.js';
import { generateId, hashPassword } from '../lib/crypto.js';
import { createSession } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';
import { sendEmail } from '../lib/email.js';

// ===== Reserved slugs =====
// Keep in sync with tenant.js resolver
const RESERVED = new Set([
  'www', 'admin', 'api', 'app', 'mail', 'praxmate',
  'book', 'en', 'tr', 'de', 'praxis', 'demo', 'support',
  'blog', 'help', 'status', 'docs', 'dashboard',
  'new', 'signup', 'login', 'logout', 'test', 'dev',
]);

// ===== Rate limit: 3 signups per IP per 24h =====
async function checkRateLimit(env, ip) {
  const key = `signup_rl:${ip}`;
  // Use a simple D1-based counter; KV would be nicer but let's keep deps low.
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - 86400;

  // Clean old and count recent
  await env.DB.prepare(`
    DELETE FROM signup_rate_limit WHERE created_at < ?
  `).bind(windowStart).run().catch(() => {});

  const { count } = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM signup_rate_limit WHERE ip = ? AND created_at >= ?
  `).bind(ip, windowStart).first() || { count: 0 };

  if (count >= 3) {
    const e = new Error('Too many signups from this IP. Try again tomorrow.');
    e.status = 429;
    throw e;
  }

  await env.DB.prepare(`
    INSERT INTO signup_rate_limit (ip, created_at) VALUES (?, ?)
  `).bind(ip, nowSec).run().catch(() => {});
}

// ===== Welcome email templates =====
const WELCOME = {
  de: {
    subject: 'Willkommen bei Praxmate — Ihre Praxis ist bereit',
    greeting: (name) => `Hallo ${name},`,
    body: (practiceName, slug) =>
      `Ihre Praxis <strong>${practiceName}</strong> ist erfolgreich angelegt.<br><br>` +
      `So geht es weiter:<br>` +
      `1️⃣ Anmelden: <a href="https://${slug}.praxmate.de/praxis/">${slug}.praxmate.de</a><br>` +
      `2️⃣ Einstellungen → Logo + Praxisinfo ausfüllen<br>` +
      `3️⃣ Hastalara Link teilen: <a href="https://${slug}.praxmate.de/book">${slug}.praxmate.de/book</a><br><br>` +
      `<strong>3 Monate kostenlos.</strong> Keine Kündigung nötig — endet automatisch.<br><br>` +
      `Fragen? Antworten Sie einfach auf diese Mail.<br><br>` +
      `Hamdi Güncavdı · Praxmate`,
  },
  en: {
    subject: 'Welcome to Praxmate — your practice is ready',
    greeting: (name) => `Hi ${name},`,
    body: (practiceName, slug) =>
      `Your practice <strong>${practiceName}</strong> has been created.<br><br>` +
      `Next steps:<br>` +
      `1️⃣ Sign in: <a href="https://${slug}.praxmate.de/praxis/">${slug}.praxmate.de</a><br>` +
      `2️⃣ Settings → upload logo + fill in practice info<br>` +
      `3️⃣ Share booking link: <a href="https://${slug}.praxmate.de/book">${slug}.praxmate.de/book</a><br><br>` +
      `<strong>3 months free.</strong> No cancellation needed — ends automatically.<br><br>` +
      `Questions? Just reply to this email.<br><br>` +
      `Hamdi Güncavdı · Praxmate`,
  },
  tr: {
    subject: 'Praxmate\'e hoş geldiniz — kliniğiniz hazır',
    greeting: (name) => `Merhaba ${name},`,
    body: (practiceName, slug) =>
      `Kliniğiniz <strong>${practiceName}</strong> başarıyla oluşturuldu.<br><br>` +
      `Sıradaki adımlar:<br>` +
      `1️⃣ Giriş yapın: <a href="https://${slug}.praxmate.de/praxis/">${slug}.praxmate.de</a><br>` +
      `2️⃣ Ayarlar → Logo + klinik bilgileri doldurun<br>` +
      `3️⃣ Randevu linkini paylaşın: <a href="https://${slug}.praxmate.de/book">${slug}.praxmate.de/book</a><br><br>` +
      `<strong>3 ay ücretsiz.</strong> İptal gerekmez — otomatik biter.<br><br>` +
      `Sorularınız için bu e-postaya yanıt verin.<br><br>` +
      `Hamdi Güncavdı · Praxmate`,
  },
};

async function sendWelcomeEmail(env, { to, ownerName, practiceName, slug, locale }) {
  const tmpl = WELCOME[locale] || WELCOME.de;
  const html = `<!DOCTYPE html><html><body style="font-family:system-ui,-apple-system,sans-serif; color:#0f172a; line-height:1.6; max-width:560px; margin:0 auto; padding:20px;">
    <div style="background:linear-gradient(135deg,#0ea5e9,#14b8a6); color:white; padding:24px; border-radius:12px 12px 0 0;">
      <h1 style="margin:0; font-size:22px;">Praxmate</h1>
    </div>
    <div style="background:white; padding:24px; border-radius:0 0 12px 12px; border:1px solid #e2e8f0; border-top:none;">
      <p style="margin-top:0;">${tmpl.greeting(ownerName)}</p>
      <p>${tmpl.body(practiceName, slug)}</p>
    </div>
    <p style="font-size:12px; color:#64748b; text-align:center; margin-top:16px;">
      Praxmate · Germany-hosted · GDPR/KVKK compliant
    </p>
  </body></html>`;
  try {
    await sendEmail(env, { to, subject: tmpl.subject, html });
  } catch (e) {
    console.error('Welcome email failed:', e.message);
    // Non-fatal — signup still succeeds
  }
}

// ============================================================
// Main handler
// ============================================================
export async function handlePublicSignup(env, request) {
  let body;
  try { body = await request.json(); } catch { return jsonError('Invalid request', request, 400); }

  const {
    practice_name,
    slug,
    owner_name,
    owner_email,
    password,
    locale = 'de',
    phone,
    city,
    specialty = 'gp',
    gdpr_consent,
  } = body;

  // ===== Validation =====
  if (!practice_name || !slug || !owner_name || !owner_email || !password) {
    return jsonError('Missing required fields', request, 400);
  }
  if (!gdpr_consent) {
    return jsonError('GDPR consent required', request, 400);
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{1,29}[a-z0-9])?$/.test(slug)) {
    return jsonError('Slug: 2-30 chars, lowercase letters, numbers, and dashes only', request, 400);
  }
  if (RESERVED.has(slug)) {
    return jsonError('This URL name is reserved', request, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner_email)) {
    return jsonError('Invalid email', request, 400);
  }
  if (password.length < 8) {
    return jsonError('Password must be at least 8 characters', request, 400);
  }
  if (!['de', 'en', 'tr'].includes(locale)) {
    return jsonError('Unsupported locale', request, 400);
  }

  // ===== Rate limit =====
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  try {
    await checkRateLimit(env, ip);
  } catch (e) {
    return jsonError(e.message, request, e.status || 429);
  }

  // ===== Uniqueness check =====
  const existingSlug = await env.DB.prepare(
    `SELECT id FROM practices WHERE slug = ? LIMIT 1`
  ).bind(slug).first();
  if (existingSlug) return jsonError(`URL "${slug}" already taken`, request, 409);

  const existingEmail = await env.DB.prepare(
    `SELECT id FROM users WHERE email = ? LIMIT 1`
  ).bind(owner_email).first();
  if (existingEmail) return jsonError('This email is already registered', request, 409);

  // ===== Create practice + user + defaults atomically via batch =====
  // All IDs pre-generated so the batch needs no cross-statement reads.
  const practiceId = generateId('prc');
  const userId = generateId('usr');
  const docId = generateId('doc');
  const typeId = generateId('apt');
  const domId = generateId('dom');
  const timezone = 'Europe/Berlin';
  const typeNames = { de: 'Beratung', en: 'Consultation', tr: 'Muayene' };
  const typeName = typeNames[locale] || typeNames.de;
  const trialEndsAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { hash, salt } = await hashPassword(password);
  const initials = owner_name.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

  const stmts = [
    env.DB.prepare(`
      INSERT INTO practices (
        id, slug, name, specialty, city, country, phone,
        locale, timezone,
        brand_primary, brand_accent, brand_ink,
        plan, plan_status, trial_ends_at, max_doctors
      ) VALUES (?, ?, ?, ?, ?, 'DE', ?, ?, ?, '#0ea5e9', '#14b8a6', '#0f172a',
                'solo', 'trial', ?, 1)
    `).bind(practiceId, slug, practice_name, specialty, city || null, phone || null, locale, timezone, trialEndsAt),

    env.DB.prepare(`
      INSERT INTO practice_domains (id, practice_id, hostname, type, verified, is_primary)
      VALUES (?, ?, ?, 'subdomain', 1, 1)
    `).bind(domId, practiceId, `${slug}.praxmate.de`),

    env.DB.prepare(`
      INSERT INTO users (
        id, practice_id, email, name, role, avatar_initials,
        password_hash, password_salt, password_updated_at, status
      ) VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, datetime('now'), 'active')
    `).bind(userId, practiceId, owner_email, owner_name, initials, hash, salt),

    env.DB.prepare(`
      INSERT INTO doctors (id, practice_id, name, is_active, created_at)
      VALUES (?, ?, ?, 1, datetime('now'))
    `).bind(docId, practiceId, owner_name),

    env.DB.prepare(`
      INSERT INTO appointment_types (
        id, practice_id, code, name, duration_minutes, icon, color,
        online_bookable, sort_order, is_active, created_at
      ) VALUES (?, ?, 'beratung', ?, 30, '💬', '#0ea5e9', 1, 1, 1, datetime('now'))
    `).bind(typeId, practiceId, typeName),

    env.DB.prepare(`
      INSERT INTO doctor_appointment_types (doctor_id, appointment_type_id, practice_id)
      VALUES (?, ?, ?)
    `).bind(docId, typeId, practiceId),
  ];

  // Default working hours: Mon-Fri 09:00-12:00 + 14:00-18:00 (10 rows)
  for (let dow = 1; dow <= 5; dow++) {
    for (const [start, end] of [['09:00', '12:00'], ['14:00', '18:00']]) {
      stmts.push(env.DB.prepare(`
        INSERT INTO working_hours (id, practice_id, doctor_id, day_of_week, start_time, end_time)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(generateId('whr'), practiceId, docId, dow, start, end));
    }
  }

  // Atomic: all 16 INSERTs succeed or none do.
  await env.DB.batch(stmts);

  // ===== Create session so user is auto-logged-in =====
  // createSession signature: (env, user, request, trustDevice)
  const { token, expires_at } = await createSession(
    env,
    { id: userId, practice_id: practiceId },
    request,
    false // 8h default; user can enable trust on next login
  );

  // ===== Audit + welcome email (non-blocking) =====
  await logAudit(env, {
    practice_id: practiceId,
    actor_type: 'user',
    actor_id: userId,
    action: 'practice.self_signup',
    meta: { slug, owner_email, locale, ip },
    request,
  });

  // Fire welcome email in background; don't block the response
  sendWelcomeEmail(env, {
    to: owner_email,
    ownerName: owner_name,
    practiceName: practice_name,
    slug,
    locale,
  }).catch(() => {});

  return jsonResponse({
    practice_id: practiceId,
    slug,
    user_id: userId,
    token,
    expires_at,
    login_url: `https://${slug}.praxmate.de/praxis/`,
    booking_url: `https://${slug}.praxmate.de/book`,
    admin_url_fallback: `https://praxmate.de/praxis/?practice=${slug}`,
  }, request, 201);
}

// ============================================================
// GET /api/public/signup/check-slug?slug=xxx — availability check
// ============================================================
export async function handleSlugCheck(env, request) {
  const url = new URL(request.url);
  const slug = (url.searchParams.get('slug') || '').toLowerCase().trim();

  if (!slug) return jsonResponse({ available: false, reason: 'empty' }, request);

  if (!/^[a-z0-9](?:[a-z0-9-]{1,29}[a-z0-9])?$/.test(slug)) {
    return jsonResponse({ available: false, reason: 'invalid_format' }, request);
  }
  if (RESERVED.has(slug)) {
    return jsonResponse({ available: false, reason: 'reserved' }, request);
  }
  const existing = await env.DB.prepare(
    `SELECT id FROM practices WHERE slug = ? LIMIT 1`
  ).bind(slug).first();
  if (existing) {
    return jsonResponse({ available: false, reason: 'taken' }, request);
  }
  return jsonResponse({ available: true, preview_url: `${slug}.praxmate.de` }, request);
}
