import { jsonResponse, jsonError } from '../lib/http.js';
import { requireAuth, requireRole, createSession } from '../lib/auth.js';
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
// The super admin is a special user whose email matches env.SUPER_ADMIN_EMAIL.
// Configured in wrangler.toml [vars] — overridable per environment.
// Fallback kept for local/dev, but production MUST set the env var explicitly.
// ============================================================
const SUPER_ADMIN_EMAIL_FALLBACK = 'h.guencavdi@hasi-elektronic.de';

async function requireSuperAdmin(env, request) {
  const user = await requireAuth(env, request);
  const superEmail = env.SUPER_ADMIN_EMAIL || SUPER_ADMIN_EMAIL_FALLBACK;
  if (user.email !== superEmail) {
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

  // Optional: create default doctor (chef = owner) + default appointment type + default working hours
  if (body.create_defaults !== false) {
    const docId = generateId('doc');
    await env.DB.prepare(`
      INSERT INTO doctors (id, practice_id, name, title, is_active, created_at)
      VALUES (?, ?, ?, ?, 1, datetime('now'))
    `).bind(docId, practiceId, owner_name, body.owner_title || null).run();

    // Default appointment type
    const typeId = generateId('apt');
    await env.DB.prepare(`
      INSERT INTO appointment_types (
        id, practice_id, name, duration_minutes, color, sort_order, is_active, created_at
      ) VALUES (?, ?, 'Beratung', 30, '#2d6a8e', 1, 1, datetime('now'))
    `).bind(typeId, practiceId).run();

    // Link doctor to type
    await env.DB.prepare(`
      INSERT INTO doctor_appointment_types (doctor_id, appointment_type_id)
      VALUES (?, ?)
    `).bind(docId, typeId).run();

    // Default working hours: Mo-Fr 08:00-12:00 + 14:00-18:00
    const hoursTemplate = body.hours_template || 'standard';
    const hourBlocks = (hoursTemplate === 'extended')
      ? [['08:00','13:00'], ['14:00','19:00']]   // 5h morning + 5h afternoon
      : (hoursTemplate === 'mornings')
      ? [['08:00','13:00']]                       // mornings only
      : [['08:00','12:00'], ['14:00','18:00']];   // standard
    for (let dow = 1; dow <= 5; dow++) {
      for (const [start, end] of hourBlocks) {
        await env.DB.prepare(`
          INSERT INTO working_hours (id, practice_id, doctor_id, day_of_week, start_time, end_time)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(generateId('whr'), practiceId, docId, dow, start, end).run();
      }
    }
  }

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

// ============================================================
// DELETE /api/super/practices/:id — delete practice + all data
// ============================================================
// Cascade delete: appointments, patients, doctors, types, hours,
// users, sessions, closures, domains, audit_log entries.
// Requires confirm=PRAXISNAME query param to prevent accidents.
export async function handleSuperPracticeDelete(env, request, practiceId) {
  const superUser = await requireSuperAdmin(env, request);

  const practice = await env.DB.prepare(
    `SELECT id, slug, name FROM practices WHERE id = ?`
  ).bind(practiceId).first();
  if (!practice) return jsonError('Praxis nicht gefunden', request, 404);

  // Safety: require confirm=<slug> in query
  const url = new URL(request.url);
  const confirm = url.searchParams.get('confirm');
  if (confirm !== practice.slug) {
    return jsonError(
      `Bestätigung erforderlich. Sende ?confirm=${practice.slug} um endgültig zu löschen.`,
      request, 400
    );
  }

  // Refuse to delete system practice
  const sys = await env.DB.prepare(
    `SELECT id FROM practices WHERE id = ? AND specialty = 'system'`
  ).bind(practiceId).first();
  if (sys) return jsonError('System-Praxis kann nicht gelöscht werden', request, 403);

  // Cascade delete (no FK cascade in SQLite by default)
  const tables = [
    'appointments', 'patients', 'closures', 'working_hours',
    'doctor_appointment_types', 'appointment_types', 'doctors',
    'sessions', 'practice_domains',
  ];
  let stats = {};
  for (const tbl of tables) {
    try {
      const r = await env.DB.prepare(
        `DELETE FROM ${tbl} WHERE practice_id = ?`
      ).bind(practiceId).run();
      stats[tbl] = r.meta.changes || 0;
    } catch (e) {
      // Table might not have practice_id column — skip
      stats[tbl] = `skipped: ${e.message}`;
    }
  }
  // Sessions for users belonging to this practice (in case)
  try {
    await env.DB.prepare(
      `DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE practice_id = ?)`
    ).bind(practiceId).run();
  } catch {}
  // Users
  const userResult = await env.DB.prepare(
    `DELETE FROM users WHERE practice_id = ?`
  ).bind(practiceId).run();
  stats.users = userResult.meta.changes || 0;

  // Audit log entries (keep history elsewhere — but practice-scoped ones can go)
  try {
    await env.DB.prepare(
      `DELETE FROM audit_log WHERE practice_id = ?`
    ).bind(practiceId).run();
  } catch {}

  // Finally the practice itself
  await env.DB.prepare(`DELETE FROM practices WHERE id = ?`).bind(practiceId).run();

  // R2 logo cleanup (best-effort)
  if (env.R2) {
    try {
      const list = await env.R2.list({ prefix: `praxmate/logos/${practice.slug}/` });
      for (const obj of (list.objects || [])) {
        await env.R2.delete(obj.key);
      }
    } catch {}
  }

  return jsonResponse({
    ok: true,
    deleted: practice.slug,
    stats,
  }, request);
}

// ============================================================
// POST /api/super/practices/:id/impersonate — log in as practice owner
// ============================================================
// Returns a praxis-scoped session token that the super-admin can use
// to log in as the owner of the target practice for support purposes.
export async function handleSuperImpersonate(env, request, practiceId) {
  const superUser = await requireSuperAdmin(env, request);

  const practice = await env.DB.prepare(
    `SELECT id, slug, name FROM practices WHERE id = ?`
  ).bind(practiceId).first();
  if (!practice) return jsonError('Praxis nicht gefunden', request, 404);

  // Find the owner (or any active admin)
  const owner = await env.DB.prepare(`
    SELECT id, email, name, role, doctor_id, avatar_initials, practice_id
    FROM users
    WHERE practice_id = ? AND status = 'active'
    ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'doctor' THEN 2 ELSE 3 END
    LIMIT 1
  `).bind(practiceId).first();

  if (!owner) return jsonError('Kein aktiver Nutzer in dieser Praxis gefunden', request, 404);

  // Create session for this user
  const session = await createSession(env, owner, request, false);

  await logAudit(env, {
    practice_id: practiceId,
    actor_type: 'user',
    actor_id: superUser.user_id,
    action: 'practice.impersonated',
    meta: {
      slug: practice.slug,
      by: superUser.email,
      as_user: owner.email,
    },
    request,
  });

  return jsonResponse({
    token: session.token,
    expires_at: session.expires_at,
    user: {
      id: owner.id,
      email: owner.email,
      name: owner.name,
      role: owner.role,
      doctor_id: owner.doctor_id,
      avatar_initials: owner.avatar_initials,
    },
    practice: {
      id: practice.id,
      slug: practice.slug,
      name: practice.name,
    },
    redirect_url: `/praxis/dashboard.html?practice=${practice.slug}`,
  }, request);
}
