import { jsonResponse, jsonError, getClientIp } from '../lib/http.js';
import { verifyPassword, hashPassword, generateId } from '../lib/crypto.js';
import {
  createSession, revokeSession, revokeAllUserSessions, requireAuth,
  isRateLimited, recordLoginAttempt,
} from '../lib/auth.js';
import { getPracticeById } from '../lib/tenant.js';
import { logAudit } from '../lib/audit.js';

// ============================================================
// POST /api/admin/auth/login
// Body: { email, password, trust_device? }
// Returns: { token, expires_at, user, practice }
// ============================================================
export async function handleLogin(env, request) {
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }
  const { email, password, trust_device } = body;
  const ip = getClientIp(request);

  if (!email || !password) return jsonError('E-Mail und Passwort erforderlich', request, 400);

  // Rate limit — separate email / ip counters (see lib/auth.js)
  const rl = await isRateLimited(env, email, ip);
  if (rl.limited) {
    const msg = rl.reason === 'email'
      ? 'Zu viele Anmeldeversuche für dieses Konto. Bitte in 15 Minuten erneut.'
      : 'Zu viele Anmeldeversuche von diesem Netzwerk. Bitte in 15 Minuten erneut.';
    return jsonError(msg, request, 429);
  }

  // Lookup user (globally by email — one login can belong to multiple practices?
  // For now: unique per practice. If user has same email in 2 practices → error)
  const users = await env.DB.prepare(`
    SELECT id, practice_id, email, name, role, doctor_id, avatar_initials,
           password_hash, password_salt, status, locked_until
    FROM users WHERE email = ? AND status = 'active'
  `).bind(email).all();

  if (users.results.length === 0) {
    await recordLoginAttempt(env, email, null, ip, false);
    return jsonError('E-Mail oder Passwort falsch', request, 401);
  }

  // If multiple practices with same email → require practice slug
  let user;
  if (users.results.length > 1) {
    const practiceSlug = request.headers.get('X-Praxmate-Practice') || new URL(request.url).searchParams.get('practice');
    if (!practiceSlug) {
      return jsonError('Praxis-Auswahl erforderlich', request, 400);
    }
    // Find user whose practice matches
    for (const u of users.results) {
      const p = await env.DB.prepare('SELECT slug FROM practices WHERE id=?').bind(u.practice_id).first();
      if (p && p.slug === practiceSlug) { user = u; break; }
    }
    if (!user) {
      await recordLoginAttempt(env, email, null, ip, false);
      return jsonError('E-Mail oder Passwort falsch', request, 401);
    }
  } else {
    user = users.results[0];
  }

  // Verify password
  const ok = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!ok) {
    await recordLoginAttempt(env, email, user.practice_id, ip, false);
    return jsonError('E-Mail oder Passwort falsch', request, 401);
  }

  await recordLoginAttempt(env, email, user.practice_id, ip, true);

  // Create session
  const session = await createSession(env, user, request, !!trust_device);

  // Update last_login
  await env.DB.prepare('UPDATE users SET last_login_at = datetime(\'now\') WHERE id=?').bind(user.id).run();

  // Load practice info
  const practice = await getPracticeById(env, user.practice_id);

  await logAudit(env, {
    practice_id: user.practice_id,
    actor_type: 'user',
    actor_id: user.id,
    action: 'user.login',
    request,
  });

  return jsonResponse({
    token: session.token,
    expires_at: session.expires_at,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      doctor_id: user.doctor_id,
      avatar_initials: user.avatar_initials,
    },
    practice,
  }, request);
}

// ============================================================
// POST /api/admin/auth/logout
// ============================================================
export async function handleLogout(env, request) {
  const user = await requireAuth(env, request);
  await revokeSession(env, user.token);
  await logAudit(env, {
    practice_id: user.practice_id,
    actor_type: 'user',
    actor_id: user.user_id,
    action: 'user.logout',
    request,
  });
  return jsonResponse({ ok: true }, request);
}

// ============================================================
// GET /api/admin/auth/me
// ============================================================
export async function handleMe(env, request) {
  const user = await requireAuth(env, request);
  const practice = await getPracticeById(env, user.practice_id);

  let doctor = null;
  if (user.doctor_id) {
    doctor = await env.DB.prepare(`
      SELECT id, name, title, role, avatar_initials
      FROM doctors WHERE id=? AND practice_id=?
    `).bind(user.doctor_id, user.practice_id).first();
  }

  return jsonResponse({
    user: {
      id: user.user_id, email: user.email, name: user.name, role: user.role,
    },
    doctor,
    practice: practice ? {
      id: practice.id, name: practice.name, slug: practice.slug,
      brand_primary: practice.brand_primary, brand_accent: practice.brand_accent,
    } : null,
  }, request);
}

// ============================================================
// POST /api/admin/auth/password/change
// Body: { old_password, new_password }
// ============================================================
export async function handlePasswordChange(env, request) {
  const user = await requireAuth(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }
  const { old_password, new_password } = body;

  if (!old_password || !new_password) return jsonError('Passwörter erforderlich', request, 400);
  if (new_password.length < 8) return jsonError('Passwort zu kurz (min. 8 Zeichen)', request, 400);

  const u = await env.DB.prepare(`SELECT password_hash, password_salt FROM users WHERE id=?`).bind(user.user_id).first();
  const ok = await verifyPassword(old_password, u.password_hash, u.password_salt);
  if (!ok) return jsonError('Aktuelles Passwort falsch', request, 401);

  const { hash, salt } = await hashPassword(new_password);
  await env.DB.prepare(`
    UPDATE users SET password_hash=?, password_salt=?, password_updated_at=datetime('now')
    WHERE id=?
  `).bind(hash, salt, user.user_id).run();

  // Revoke all other sessions for safety
  await revokeAllUserSessions(env, user.user_id);

  await logAudit(env, {
    practice_id: user.practice_id,
    actor_type: 'user',
    actor_id: user.user_id,
    action: 'user.password_changed',
    request,
  });

  return jsonResponse({ ok: true, message: 'Bitte erneut anmelden' }, request);
}
