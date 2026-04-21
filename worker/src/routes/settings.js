import { jsonResponse, jsonError } from '../lib/http.js';
import { requireAuth, requireRole } from '../lib/auth.js';
import { getPracticeById } from '../lib/tenant.js';
import { logAudit } from '../lib/audit.js';
import { generateId, hashPassword } from '../lib/crypto.js';

// ============================================================
// GET /api/admin/practice/settings — current practice info
// Any authenticated user can view
// ============================================================
export async function handlePracticeSettingsGet(env, request) {
  const user = await requireAuth(env, request);
  const practice = await getPracticeById(env, user.practice_id);
  if (!practice) return jsonError('Praxis nicht gefunden', request, 404);
  return jsonResponse(practice, request);
}

// ============================================================
// PUT /api/admin/practice/settings — update (owner only)
// Body: { name, phone, email, website, street, postal_code, city,
//         brand_primary, brand_accent, brand_ink, logo_url,
//         legal_name, tax_id, responsible_person, professional_chamber }
// ============================================================
export async function handlePracticeSettingsUpdate(env, request) {
  const user = await requireRole(env, request, ['owner']);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  // Whitelist of editable fields (by owner only)
  const allowed = [
    'name', 'phone', 'email', 'website',
    'street', 'postal_code', 'city',
    'brand_primary', 'brand_accent', 'brand_ink', 'logo_url',
    'legal_name', 'tax_id', 'responsible_person', 'professional_chamber',
  ];
  const updates = {};
  for (const k of allowed) {
    if (k in body) {
      updates[k] = body[k] === '' ? null : body[k];
    }
  }
  if (Object.keys(updates).length === 0) {
    return jsonError('Keine Änderungen', request, 400);
  }

  // Validate brand colors (hex)
  const hexRe = /^#[0-9a-fA-F]{6}$/;
  for (const colorKey of ['brand_primary', 'brand_accent', 'brand_ink']) {
    if (colorKey in updates && updates[colorKey] && !hexRe.test(updates[colorKey])) {
      return jsonError(`${colorKey} muss ein Hex-Wert sein (z.B. #2d6a8e)`, request, 400);
    }
  }

  // Build SQL
  const fields = Object.keys(updates);
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => updates[f]);

  await env.DB.prepare(`
    UPDATE practices SET ${setClause} WHERE id = ?
  `).bind(...values, user.practice_id).run();

  await logAudit(env, {
    practice_id: user.practice_id,
    actor_type: 'user',
    actor_id: user.user_id,
    action: 'practice.settings_updated',
    meta: { fields },
    request,
  });

  const updated = await getPracticeById(env, user.practice_id);
  return jsonResponse(updated, request);
}

// ============================================================
// SUPER-ADMIN ROUTES
// ============================================================
// The super admin is a special user: email === SUPER_ADMIN_EMAIL
// This user can access cross-tenant management endpoints.
// ============================================================
const SUPER_ADMIN_EMAIL = 'h.guencavdi@hasi-elektronic.de';

async function requireSuperAdmin(env, request) {
  const user = await requireAuth(env, request);
  if (user.email !== SUPER_ADMIN_EMAIL) {
    const e = new Error('Nur Super-Admin');
    e.status = 403;
    throw e;
  }
  return user;
}

// ============================================================
// GET /api/super/practices — list all practices
// ============================================================
export async function handleSuperPracticesList(env, request) {
  await requireSuperAdmin(env, request);
  const res = await env.DB.prepare(`
    SELECT p.id, p.slug, p.name, p.specialty, p.city, p.phone, p.email,
           p.brand_primary, p.logo_url, p.plan, p.plan_status,
           p.created_at, p.trial_ends_at,
           (SELECT COUNT(*) FROM users WHERE practice_id = p.id) as user_count,
           (SELECT COUNT(*) FROM doctors WHERE practice_id = p.id AND is_active = 1) as doctor_count,
           (SELECT COUNT(*) FROM appointments WHERE practice_id = p.id) as appointment_count
    FROM practices p
    ORDER BY p.created_at DESC
  `).all();
  return jsonResponse({ practices: res.results }, request);
}

// ============================================================
// GET /api/super/practices/:id — detail
// ============================================================
export async function handleSuperPracticeDetail(env, request, practiceId) {
  await requireSuperAdmin(env, request);
  const practice = await getPracticeById(env, practiceId);
  if (!practice) return jsonError('Nicht gefunden', request, 404);

  const users = await env.DB.prepare(`
    SELECT id, email, name, role, last_login_at FROM users WHERE practice_id = ?
  `).bind(practiceId).all();

  const doctors = await env.DB.prepare(`
    SELECT id, name, title, role, avatar_initials, is_active FROM doctors WHERE practice_id = ?
    ORDER BY sort_order
  `).bind(practiceId).all();

  const stats = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM appointments WHERE practice_id = ?) as total_appointments,
      (SELECT COUNT(*) FROM appointments WHERE practice_id = ? AND status = 'confirmed') as confirmed,
      (SELECT COUNT(*) FROM patients WHERE practice_id = ?) as patient_count
  `).bind(practiceId, practiceId, practiceId).first();

  return jsonResponse({
    practice,
    users: users.results,
    doctors: doctors.results,
    stats,
  }, request);
}

// ============================================================
// PUT /api/super/practices/:id — super admin edits any practice
// Body: full settings (same as handlePracticeSettingsUpdate) + plan, plan_status
// ============================================================
export async function handleSuperPracticeUpdate(env, request, practiceId) {
  const user = await requireSuperAdmin(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  // Super-admin can also change plan + status
  const allowed = [
    'name', 'slug', 'specialty', 'phone', 'email', 'website',
    'street', 'postal_code', 'city',
    'brand_primary', 'brand_accent', 'brand_ink', 'logo_url',
    'legal_name', 'tax_id', 'responsible_person', 'professional_chamber',
    'plan', 'plan_status', 'max_doctors', 'trial_ends_at',
  ];
  const updates = {};
  for (const k of allowed) {
    if (k in body) updates[k] = body[k] === '' ? null : body[k];
  }
  if (Object.keys(updates).length === 0) return jsonError('Keine Änderungen', request, 400);

  const fields = Object.keys(updates);
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  const values = fields.map(f => updates[f]);

  await env.DB.prepare(`UPDATE practices SET ${setClause} WHERE id = ?`).bind(...values, practiceId).run();

  await logAudit(env, {
    practice_id: practiceId,
    actor_type: 'user',
    actor_id: user.user_id,
    action: 'practice.super_updated',
    meta: { fields, by: user.email },
    request,
  });

  return jsonResponse(await getPracticeById(env, practiceId), request);
}

// ============================================================
// POST /api/super/practices — create new practice
// Body: { name, slug, specialty, city, owner_email, owner_name, owner_password, ... }
// ============================================================
export async function handleSuperPracticeCreate(env, request) {
  const superUser = await requireSuperAdmin(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const { name, slug, specialty, owner_email, owner_name, owner_password } = body;
  if (!name || !slug || !owner_email || !owner_name || !owner_password) {
    return jsonError('Pflichtfelder fehlen (name, slug, owner_email, owner_name, owner_password)', request, 400);
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    return jsonError('Slug darf nur Kleinbuchstaben, Zahlen und - enthalten', request, 400);
  }
  if (owner_password.length < 8) return jsonError('Passwort min. 8 Zeichen', request, 400);

  // Check uniqueness
  const existing = await env.DB.prepare(`SELECT id FROM practices WHERE slug = ?`).bind(slug).first();
  if (existing) return jsonError(`Slug "${slug}" bereits vergeben`, request, 409);

  const practiceId = generateId('prc');
  await env.DB.prepare(`
    INSERT INTO practices (
      id, slug, name, specialty, street, postal_code, city, country,
      phone, email, website, brand_primary, brand_accent, brand_ink, logo_url,
      legal_name, responsible_person, professional_chamber,
      plan, plan_status, trial_ends_at, max_doctors
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'DE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'trial', ?, ?)
  `).bind(
    practiceId, slug, name, specialty || 'gp',
    body.street || null, body.postal_code || null, body.city || null,
    body.phone || null, body.email || null, body.website || null,
    body.brand_primary || '#2d6a8e',
    body.brand_accent || '#e9b949',
    body.brand_ink || '#1a2a3a',
    body.logo_url || null,
    body.legal_name || null, body.responsible_person || null,
    body.professional_chamber || null,
    body.plan || 'team',
    body.trial_ends_at || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    body.max_doctors || 3,
  ).run();

  // Register subdomain
  await env.DB.prepare(`
    INSERT INTO practice_domains (id, practice_id, hostname, type, verified, is_primary)
    VALUES (?, ?, ?, 'subdomain', 1, 1)
  `).bind(generateId('dom'), practiceId, `${slug}.praxmate.de`).run();

  // Create owner user
  const { hash, salt } = await hashPassword(owner_password);
  const userId = generateId('usr');
  const initials = owner_name.split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
  await env.DB.prepare(`
    INSERT INTO users (
      id, practice_id, email, name, role, avatar_initials,
      password_hash, password_salt, password_updated_at, status
    ) VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, datetime('now'), 'active')
  `).bind(userId, practiceId, owner_email, owner_name, initials, hash, salt).run();

  await logAudit(env, {
    practice_id: practiceId,
    actor_type: 'user',
    actor_id: superUser.user_id,
    action: 'practice.created',
    meta: { slug, by: superUser.email, owner_email },
    request,
  });

  return jsonResponse({
    practice_id: practiceId,
    slug,
    user_id: userId,
    owner_email,
    login_url: `https://praxmate.pages.dev/praxis/?practice=${slug}`,
    booking_url: `https://praxmate.pages.dev/book.html?practice=${slug}`,
  }, request, 201);
}

// ============================================================
// GET /api/super/stats — global stats for super dashboard
// ============================================================
export async function handleSuperStats(env, request) {
  await requireSuperAdmin(env, request);

  const stats = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM practices) as practice_count,
      (SELECT COUNT(*) FROM practices WHERE plan_status = 'active') as active_count,
      (SELECT COUNT(*) FROM practices WHERE plan_status = 'trial') as trial_count,
      (SELECT COUNT(*) FROM users) as total_users,
      (SELECT COUNT(*) FROM doctors WHERE is_active = 1) as total_doctors,
      (SELECT COUNT(*) FROM appointments) as total_appointments,
      (SELECT COUNT(*) FROM appointments WHERE date(start_datetime) = date('now')) as today_appointments,
      (SELECT COUNT(*) FROM patients) as total_patients
  `).first();

  // Recent activity
  const activity = await env.DB.prepare(`
    SELECT al.action, al.created_at, al.meta, p.name as practice_name, p.slug as practice_slug
    FROM audit_log al
    LEFT JOIN practices p ON p.id = al.practice_id
    ORDER BY al.created_at DESC
    LIMIT 30
  `).all();

  return jsonResponse({ stats, activity: activity.results }, request);
}
