import { generateId, generateToken } from './crypto.js';
import { getClientIp, getUserAgent } from './http.js';

// Session duration: 8 hours default, 30 days if trust_device
const SESSION_HOURS = 8;
const TRUSTED_DEVICE_DAYS = 30;

// Rate limit: 5 attempts per 15 minutes per email+ip
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX_ATTEMPTS = 5;

export async function createSession(env, user, request, trustDevice = false) {
  const token = generateToken(32);
  const hours = trustDevice ? TRUSTED_DEVICE_DAYS * 24 : SESSION_HOURS;
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(`
    INSERT INTO sessions (token, user_id, practice_id, expires_at, last_seen_at, ip_address, user_agent)
    VALUES (?, ?, ?, ?, datetime('now'), ?, ?)
  `).bind(
    token,
    user.id,
    user.practice_id,
    expiresAt,
    getClientIp(request),
    getUserAgent(request)
  ).run();

  return { token, expires_at: expiresAt };
}

export async function getSession(env, token) {
  if (!token) return null;
  return await env.DB.prepare(`
    SELECT s.token, s.user_id, s.practice_id, s.expires_at, s.revoked_at,
           u.id as user_id_full, u.email, u.name, u.role, u.doctor_id,
           u.avatar_initials, u.status
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
      AND s.expires_at > datetime('now')
      AND s.revoked_at IS NULL
      AND u.status = 'active'
    LIMIT 1
  `).bind(token).first();
}

export async function revokeSession(env, token) {
  await env.DB.prepare(`
    UPDATE sessions SET revoked_at = datetime('now') WHERE token = ?
  `).bind(token).run();
}

export async function revokeAllUserSessions(env, userId) {
  await env.DB.prepare(`
    UPDATE sessions SET revoked_at = datetime('now')
    WHERE user_id = ? AND revoked_at IS NULL
  `).bind(userId).run();
}

/**
 * Require a valid session. Returns the user+session context.
 * Throws 401 if invalid.
 *
 * IMPORTANT: returns practice_id — all subsequent queries MUST filter by this.
 */
export async function requireAuth(env, request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) {
    const e = new Error('Nicht angemeldet');
    e.status = 401;
    throw e;
  }

  const session = await getSession(env, token);
  if (!session) {
    const e = new Error('Sitzung abgelaufen');
    e.status = 401;
    throw e;
  }

  // Update last_seen
  await env.DB.prepare(`
    UPDATE sessions SET last_seen_at = datetime('now') WHERE token = ?
  `).bind(token).run();

  return {
    user_id: session.user_id,
    practice_id: session.practice_id,
    email: session.email,
    name: session.name,
    role: session.role,
    doctor_id: session.doctor_id,
    avatar_initials: session.avatar_initials,
    token,
  };
}

/**
 * Additionally enforce a role. Usage: const user = await requireRole(env, request, ['owner', 'doctor']);
 */
export async function requireRole(env, request, allowedRoles) {
  const user = await requireAuth(env, request);
  if (!allowedRoles.includes(user.role)) {
    const e = new Error('Keine Berechtigung');
    e.status = 403;
    throw e;
  }
  return user;
}

// ============================================================
// RATE LIMITING
// ============================================================
export async function isRateLimited(env, email, ip) {
  const since = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
  const row = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM login_attempts
    WHERE (email = ? OR ip_address = ?)
      AND success = 0
      AND created_at > ?
  `).bind(email, ip, since).first();
  return row.n >= RATE_MAX_ATTEMPTS;
}

export async function recordLoginAttempt(env, email, practiceId, ip, success) {
  await env.DB.prepare(`
    INSERT INTO login_attempts (id, email, practice_id, ip_address, success)
    VALUES (?, ?, ?, ?, ?)
  `).bind(generateId('la'), email, practiceId, ip, success ? 1 : 0).run();
}
