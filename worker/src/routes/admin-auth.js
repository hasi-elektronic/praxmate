/**
 * Admin auth routes
 * /api/admin/auth/*
 */

import {
  verifyPassword,
  hashPassword,
  validatePassword,
  generateId,
  sha256,
} from '../lib/crypto.js';
import {
  createSession,
  revokeSession,
  revokeAllSessions,
  requireAuth,
  getSessionToken,
  checkLoginRateLimit,
  logLoginAttempt,
  addTrustedDevice,
  isDeviceTrusted,
} from '../lib/auth.js';
import { logAudit, logAuditFromRequest } from '../lib/audit.js';

// ============================================================
// POST /api/admin/auth/login
// ============================================================
export async function handleLogin(env, request) {
  let body;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON', 400); }

  const { email, password, trust_device } = body;
  if (!email || !password) {
    return jsonError('E-Mail und Passwort erforderlich', 400);
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const normalizedEmail = email.toLowerCase().trim();

  // Rate limit check
  const rateLimit = await checkLoginRateLimit(env, normalizedEmail, ip);
  if (rateLimit) {
    return jsonError(rateLimit.reason, 429);
  }

  // Fetch user
  const user = await env.DB.prepare(`
    SELECT id, practice_id, email, name, role, doctor_id,
           password_hash, password_salt, active, twofa_enabled
    FROM users
    WHERE email = ?
  `).bind(normalizedEmail).first();

  if (!user || !user.active) {
    await logLoginAttempt(env, normalizedEmail, ip, false);
    // Consistent timing: still hash a dummy password to prevent user enumeration
    await verifyPassword('dummy', 'a'.repeat(64), 'b'.repeat(32));
    return jsonError('E-Mail oder Passwort ungültig', 401);
  }

  // Verify password
  const ok = await verifyPassword(password, user.password_hash, user.password_salt);
  if (!ok) {
    await logLoginAttempt(env, normalizedEmail, ip, false);
    return jsonError('E-Mail oder Passwort ungültig', 401);
  }

  // 2FA check (skip if trusted device)
  if (user.twofa_enabled) {
    const trusted = await isDeviceTrusted(env, user.id, request);
    if (!trusted) {
      // Return challenge token (valid for 5 min) — user submits code next
      const challengeToken = generateId('ch');
      await env.DB.prepare(`
        INSERT INTO sessions (id, user_id, practice_id, expires_at, revoked, user_agent)
        VALUES (?, ?, ?, datetime('now', '+5 minutes'), 1, '2fa-challenge')
      `).bind(challengeToken, user.id, user.practice_id).run();

      return jsonResponse({ requires_2fa: true, challenge_token: challengeToken }, 200);
    }
  }

  // Successful login
  const session = await createSession(env, user.id, user.practice_id, request);

  // Optionally mark as trusted device (30 days)
  if (trust_device) {
    await addTrustedDevice(env, user.id, request);
  }

  // Update last_login
  await env.DB.prepare(`
    UPDATE users SET last_login_at = datetime('now'), last_login_ip = ?
    WHERE id = ?
  `).bind(ip, user.id).run();

  await logLoginAttempt(env, normalizedEmail, ip, true);
  await logAudit(env, user.practice_id, 'user', user.id, 'user.login', {
    ip, ua: request.headers.get('User-Agent') || ''
  });

  const responseBody = {
    token: session.token,
    expires_at: session.expires_at,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      doctor_id: user.doctor_id,
    },
    practice_id: user.practice_id,
  };

  return new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `praxmate_session=${session.token}; Path=/; Max-Age=${8*3600}; HttpOnly; Secure; SameSite=Strict`,
      'Access-Control-Allow-Credentials': 'true',
    }
  });
}

// ============================================================
// POST /api/admin/auth/logout
// ============================================================
export async function handleLogout(env, request) {
  const token = getSessionToken(request);
  if (token) {
    await revokeSession(env, token);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': `praxmate_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
    }
  });
}

// ============================================================
// POST /api/admin/auth/logout-all
// ============================================================
export async function handleLogoutAll(env, request) {
  const user = await requireAuth(env, request);
  await revokeAllSessions(env, user.user_id);
  return jsonResponse({ ok: true, message: 'Alle Geräte abgemeldet' });
}

// ============================================================
// GET /api/admin/auth/me
// ============================================================
export async function handleMe(env, request) {
  const user = await requireAuth(env, request);

  // Enrich with doctor info if applicable
  let doctor = null;
  if (user.doctor_id) {
    doctor = await env.DB.prepare(`
      SELECT id, name, title, role, avatar_initials FROM doctors WHERE id = ?
    `).bind(user.doctor_id).first();
  }

  // Practice info
  const practice = await env.DB.prepare(`
    SELECT id, name, slug, brand_primary, brand_accent FROM practices WHERE id = ?
  `).bind(user.practice_id).first();

  return jsonResponse({
    user: {
      id: user.user_id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
    doctor,
    practice,
  });
}

// ============================================================
// POST /api/admin/auth/password/change
// ============================================================
export async function handlePasswordChange(env, request) {
  const user = await requireAuth(env, request);
  let body;
  try { body = await request.json(); }
  catch { return jsonError('Invalid JSON', 400); }

  const { current_password, new_password } = body;
  if (!current_password || !new_password) {
    return jsonError('Aktuelles und neues Passwort erforderlich', 400);
  }

  // Validate new password
  const validation = validatePassword(new_password);
  if (!validation.valid) {
    return jsonError('Passwort ungültig: ' + validation.reasons.join(', '), 400);
  }

  // Verify current password
  const row = await env.DB.prepare(`
    SELECT password_hash, password_salt FROM users WHERE id = ?
  `).bind(user.user_id).first();
  const ok = await verifyPassword(current_password, row.password_hash, row.password_salt);
  if (!ok) {
    return jsonError('Aktuelles Passwort falsch', 401);
  }

  // Hash new password and update
  const { hash, salt } = await hashPassword(new_password);
  await env.DB.prepare(`
    UPDATE users SET password_hash = ?, password_salt = ?, password_changed_at = datetime('now')
    WHERE id = ?
  `).bind(hash, salt, user.user_id).run();

  // Revoke all other sessions (force re-login elsewhere, keep current)
  const currentToken = getSessionToken(request);
  await env.DB.prepare(`
    UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id != ? AND revoked = 0
  `).bind(user.user_id, currentToken).run();

  await logAuditFromRequest(env, request, user, 'user.password_changed');

  return jsonResponse({ ok: true, message: 'Passwort geändert' });
}

// ============================================================
// GET /api/admin/auth/sessions
// ============================================================
export async function handleListSessions(env, request) {
  const user = await requireAuth(env, request);

  const currentToken = getSessionToken(request);
  const { results } = await env.DB.prepare(`
    SELECT id, ip_address, user_agent, created_at, last_active_at, expires_at
    FROM sessions
    WHERE user_id = ? AND revoked = 0 AND expires_at > datetime('now')
    ORDER BY last_active_at DESC
  `).bind(user.user_id).all();

  const sessions = results.map(s => ({
    ...s,
    is_current: s.id === currentToken,
    // Don't expose the full session ID (partial for UI reference only)
    id_preview: s.id.substring(0, 8),
  }));

  return jsonResponse({ sessions });
}

// ============================================================
// Helpers
// ============================================================
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders,
    },
  });
}

function jsonError(message, status = 400) {
  return jsonResponse({ error: message }, status);
}
