/**
 * Auth middleware for admin routes
 * Validates session tokens and enforces role-based access
 */

import { generateId, generateToken, sha256, deviceFingerprint } from './crypto.js';

/**
 * Extract session token from request.
 * Priority: Authorization header > Cookie
 */
export function getSessionToken(request) {
  const auth = request.headers.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  const cookie = request.headers.get('Cookie');
  if (cookie) {
    const match = cookie.match(/praxmate_session=([a-f0-9]{64})/);
    if (match) return match[1];
  }
  return null;
}

/**
 * Validate session and return user.
 * Returns null if invalid/expired/revoked.
 */
export async function validateSession(env, token) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;

  const session = await env.DB.prepare(`
    SELECT s.id, s.user_id, s.expires_at, s.revoked,
           u.id as u_id, u.practice_id, u.email, u.name, u.role, u.doctor_id, u.active
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ?
  `).bind(token).first();

  if (!session) return null;
  if (session.revoked) return null;
  if (!session.active) return null;
  if (new Date(session.expires_at) < new Date()) return null;

  // Refresh last_active_at (best-effort, don't block on failure)
  env.DB.prepare(`
    UPDATE sessions SET last_active_at = datetime('now') WHERE id = ?
  `).bind(token).run().catch(() => {});

  return {
    session_id: session.id,
    user_id: session.u_id,
    practice_id: session.practice_id,
    email: session.email,
    name: session.name,
    role: session.role,
    doctor_id: session.doctor_id,
  };
}

/**
 * Require authentication for a handler.
 * Returns the authenticated user, or throws a Response with 401.
 */
export async function requireAuth(env, request) {
  const token = getSessionToken(request);
  if (!token) {
    throw new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  const user = await validateSession(env, token);
  if (!user) {
    throw new Response(JSON.stringify({ error: 'Invalid or expired session' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }
  return user;
}

/**
 * Require specific role(s) for a handler.
 * Usage: requireRole(user, 'owner') or requireRole(user, ['owner', 'doctor'])
 */
export function requireRole(user, allowedRoles) {
  const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
  if (!roles.includes(user.role)) {
    throw new Response(JSON.stringify({ error: `Requires role: ${roles.join(' or ')}` }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Create a new session for a user.
 * Returns { token, expires_at }
 */
export async function createSession(env, userId, practiceId, request, deviceId = null) {
  const token = generateToken(); // 64-char hex
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';
  const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 hours

  await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, practice_id, device_id, ip_address, user_agent, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    token, userId, practiceId, deviceId,
    ip, ua, expiresAt.toISOString()
  ).run();

  return { token, expires_at: expiresAt.toISOString() };
}

/**
 * Revoke a session
 */
export async function revokeSession(env, token) {
  await env.DB.prepare(`
    UPDATE sessions SET revoked = 1 WHERE id = ?
  `).bind(token).run();
}

/**
 * Revoke all sessions for a user (e.g., "logout everywhere")
 */
export async function revokeAllSessions(env, userId) {
  await env.DB.prepare(`
    UPDATE sessions SET revoked = 1 WHERE user_id = ? AND revoked = 0
  `).bind(userId).run();
}

/**
 * Check trusted device (for skip-2FA, etc.)
 */
export async function isDeviceTrusted(env, userId, request) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';
  const fingerprint = await deviceFingerprint(ip, ua);

  const device = await env.DB.prepare(`
    SELECT id FROM trusted_devices
    WHERE user_id = ? AND device_fingerprint = ? AND expires_at > datetime('now')
  `).bind(userId, fingerprint).first();

  return device !== null;
}

/**
 * Add a trusted device (30 days)
 */
export async function addTrustedDevice(env, userId, request) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';
  const fingerprint = await deviceFingerprint(ip, ua);
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  // Parse device name from UA (simple)
  let deviceName = 'Unknown Device';
  if (/Chrome/.test(ua)) deviceName = 'Chrome';
  else if (/Firefox/.test(ua)) deviceName = 'Firefox';
  else if (/Safari/.test(ua)) deviceName = 'Safari';
  else if (/Edge/.test(ua)) deviceName = 'Edge';
  if (/Mobile/.test(ua)) deviceName += ' (Mobile)';
  else if (/iPad/.test(ua)) deviceName += ' (iPad)';
  else if (/Macintosh/.test(ua)) deviceName += ' (Mac)';
  else if (/Windows/.test(ua)) deviceName += ' (Windows)';

  await env.DB.prepare(`
    INSERT INTO trusted_devices (id, user_id, device_fingerprint, device_name, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    generateId('dev'), userId, fingerprint, deviceName, expiresAt.toISOString()
  ).run();
}

/**
 * Rate-limit check for login attempts.
 * Returns null if OK, or an error object if rate-limited.
 */
export async function checkLoginRateLimit(env, email, ip) {
  // Check failed attempts in last 15 minutes for this email
  const emailCheck = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM login_attempts
    WHERE email = ? AND success = 0
      AND attempted_at > datetime('now', '-15 minutes')
  `).bind(email.toLowerCase()).first();

  if (emailCheck && emailCheck.n >= 5) {
    return { limited: true, reason: 'Too many failed attempts for this account. Try again in 15 minutes.' };
  }

  // Check failed attempts from this IP in last hour
  const ipCheck = await env.DB.prepare(`
    SELECT COUNT(*) as n FROM login_attempts
    WHERE ip_address = ? AND success = 0
      AND attempted_at > datetime('now', '-1 hour')
  `).bind(ip).first();

  if (ipCheck && ipCheck.n >= 20) {
    return { limited: true, reason: 'Too many failed attempts from this network. Try again later.' };
  }

  return null;
}

/**
 * Log a login attempt (success or failure)
 */
export async function logLoginAttempt(env, email, ip, success) {
  await env.DB.prepare(`
    INSERT INTO login_attempts (id, email, ip_address, success)
    VALUES (?, ?, ?, ?)
  `).bind(
    generateId('att'),
    email ? email.toLowerCase() : null,
    ip,
    success ? 1 : 0
  ).run();
}
