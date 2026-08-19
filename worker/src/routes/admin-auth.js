import { jsonResponse, jsonError, getClientIp } from '../lib/http.js';
import { verifyPassword, hashPassword, generateId } from '../lib/crypto.js';
import {
  generateTotpSecret, verifyTotpCode, buildOtpauthUrl,
  generateBackupCodes, hashBackupCodes, findAndConsumeBackupCode,
} from '../lib/totp.js';
import {
  createSession, revokeSession, revokeAllUserSessions, requireAuth,
  isRateLimited, recordLoginAttempt,
} from '../lib/auth.js';
import { getPracticeById } from '../lib/tenant.js';
import { logAudit } from '../lib/audit.js';
import { notify } from '../lib/notify.js';

// ============================================================
// POST /api/admin/auth/login
// Body: { email, password, trust_device? }
// Returns: { token, expires_at, user, practice }
// ============================================================
export async function handleLogin(env, request) {
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }
  const { email, password, trust_device, totp_code, backup_code } = body;
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
           password_hash, password_salt, status, locked_until,
           totp_enabled, totp_secret, totp_backup_codes
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

  // 2FA gate — password OK, but if TOTP is enabled, demand a second factor.
  if (user.totp_enabled === 1) {
    if (!totp_code && !backup_code) {
      let hasBackup = false;
      try { hasBackup = (JSON.parse(user.totp_backup_codes || '[]') || []).length > 0; } catch {}
      return jsonResponse({ requires_2fa: true, has_backup_codes: hasBackup }, request);
    }
    let ok2fa = false;
    if (totp_code) ok2fa = await verifyTotpCode(user.totp_secret, totp_code);
    if (!ok2fa && backup_code) {
      ok2fa = await findAndConsumeBackupCode(env, user.id, backup_code);
      if (ok2fa) {
        await logAudit(env, {
          practice_id: user.practice_id, actor_type: 'user', actor_id: user.id,
          action: 'user.2fa.backup_code_used', request,
        });
      }
    }
    if (!ok2fa) {
      await recordLoginAttempt(env, email, user.practice_id, ip, false);
      return jsonError('2FA-Code falsch', request, 401);
    }
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
      locale: practice.locale, timezone: practice.timezone,
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

// ============================================================
// 2FA (TOTP) — setup / verify / disable / regenerate / status
// ============================================================

export async function handle2faStatus(env, request) {
  const user = await requireAuth(env, request);
  const u = await env.DB.prepare(
    `SELECT totp_enabled, totp_verified_at, totp_backup_codes FROM users WHERE id = ?`
  ).bind(user.user_id).first();
  let remaining = 0;
  try { remaining = (JSON.parse(u?.totp_backup_codes || '[]') || []).length; } catch {}
  return jsonResponse({
    enabled: u?.totp_enabled === 1,
    verified_at: u?.totp_verified_at || null,
    backup_codes_remaining: remaining,
  }, request);
}

export async function handle2faSetup(env, request) {
  const user = await requireAuth(env, request);
  const u = await env.DB.prepare(`SELECT email, totp_enabled FROM users WHERE id = ?`).bind(user.user_id).first();
  if (u?.totp_enabled === 1) return jsonError('2FA ist bereits aktiviert. Vorher deaktivieren.', request, 400);

  const practice = await env.DB.prepare(`SELECT name FROM practices WHERE id = ?`).bind(user.practice_id).first();
  const secret = generateTotpSecret();
  const issuer = `Praxmate (${practice?.name || 'Praxis'})`;
  const otpauth = buildOtpauthUrl({ issuer, account: u.email, secret });

  await env.DB.prepare(`UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?`).bind(secret, user.user_id).run();
  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'user.2fa.setup_started', request,
  });
  return jsonResponse({ secret, otpauth_url: otpauth, issuer, account: u.email }, request);
}

export async function handle2faVerify(env, request) {
  const user = await requireAuth(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }
  const code = String(body?.code || '').trim();
  if (!/^\d{6}$/.test(code)) return jsonError('6-stelliger Code erforderlich', request, 400);

  const u = await env.DB.prepare(`SELECT totp_secret, totp_enabled FROM users WHERE id = ?`).bind(user.user_id).first();
  if (!u?.totp_secret) return jsonError('Kein Setup gestartet — zuerst /setup aufrufen', request, 400);
  if (u.totp_enabled === 1) return jsonError('Bereits aktiviert', request, 400);

  if (!await verifyTotpCode(u.totp_secret, code)) {
    return jsonError('Code falsch — bitte aktuellen Code aus der Authenticator-App eingeben', request, 401);
  }

  const plaintextCodes = generateBackupCodes(8);
  const hashedCodes    = await hashBackupCodes(plaintextCodes);
  await env.DB.prepare(
    `UPDATE users SET totp_enabled=1, totp_verified_at=CURRENT_TIMESTAMP, totp_backup_codes=? WHERE id = ?`
  ).bind(JSON.stringify(hashedCodes), user.user_id).run();

  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'user.2fa.enabled', request,
  });
  return jsonResponse({ ok: true, enabled: true, backup_codes: plaintextCodes }, request);
}

export async function handle2faDisable(env, request) {
  const user = await requireAuth(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }
  const { password, code } = body;
  if (!password) return jsonError('Passwort erforderlich', request, 400);

  const u = await env.DB.prepare(
    `SELECT password_hash, password_salt, totp_secret, totp_enabled FROM users WHERE id = ?`
  ).bind(user.user_id).first();
  if (u?.totp_enabled !== 1) return jsonError('2FA ist nicht aktiv', request, 400);

  if (!await verifyPassword(password, u.password_hash, u.password_salt)) {
    return jsonError('Passwort falsch', request, 401);
  }
  if (code && !await verifyTotpCode(u.totp_secret, code)) {
    return jsonError('Code falsch', request, 401);
  }

  await env.DB.prepare(
    `UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_verified_at=NULL, totp_backup_codes=NULL WHERE id = ?`
  ).bind(user.user_id).run();
  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'user.2fa.disabled', meta: { with_code: !!code }, request,
  });
  if (env.waitUntil) {
    const pr = await env.DB.prepare(`SELECT id, slug, name, locale FROM practices WHERE id = ?`).bind(user.practice_id).first();
    env.waitUntil(notify(env, 'tenant.2fa_disabled', {
      practice: pr || { id: user.practice_id },
      user: { email: user.email },
    }));
  }

  return jsonResponse({ ok: true, enabled: false }, request);
}

export async function handle2faRegenerateBackup(env, request) {
  const user = await requireAuth(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }
  const { password } = body;
  if (!password) return jsonError('Passwort erforderlich', request, 400);

  const u = await env.DB.prepare(
    `SELECT password_hash, password_salt, totp_enabled FROM users WHERE id = ?`
  ).bind(user.user_id).first();
  if (u?.totp_enabled !== 1) return jsonError('2FA ist nicht aktiv', request, 400);
  if (!await verifyPassword(password, u.password_hash, u.password_salt)) {
    return jsonError('Passwort falsch', request, 401);
  }

  const plaintextCodes = generateBackupCodes(8);
  const hashedCodes    = await hashBackupCodes(plaintextCodes);
  await env.DB.prepare(`UPDATE users SET totp_backup_codes = ? WHERE id = ?`).bind(JSON.stringify(hashedCodes), user.user_id).run();
  await logAudit(env, {
    practice_id: user.practice_id, actor_type: 'user', actor_id: user.user_id,
    action: 'user.2fa.backup_codes_regenerated', request,
  });
  return jsonResponse({ ok: true, backup_codes: plaintextCodes }, request);
}
