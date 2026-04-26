// ============================================================
// PASSWORD RESET — forgot + reset endpoints
// ============================================================
// POST /api/public/auth/password/forgot
//   body: { email, locale? }
//   - Always returns 200 with same message (don't leak email existence)
//   - Internal: find users with that email, generate secure token,
//     store in password_reset_tokens, send reset email via Resend
//
// POST /api/public/auth/password/reset
//   body: { token, new_password }
//   - Validates token (exists, not used, not expired)
//   - Hashes new password, updates ALL users with the email tied to token
//   - Marks token as used; revokes existing sessions for those users
//
// Token: 48-byte hex (96 chars), 1 hour TTL, single-use.
// Rate limit: 5 requests per email per hour (D1 INSERT counts blocked).
// ============================================================

import { jsonResponse, jsonError } from '../lib/http.js';
import { generateId, generateToken, hashPassword } from '../lib/crypto.js';
import { sendEmail, tenantLocale } from '../lib/email.js';
import { logAudit } from '../lib/audit.js';

const TOKEN_TTL_MS = 60 * 60 * 1000;        // 1 hour
const MAX_REQUESTS_PER_EMAIL_PER_HOUR = 5;  // anti-abuse

// ===== Email templates (DE / EN / TR) =====
const TEMPLATES = {
  de: {
    subject: 'Praxmate — Passwort zurücksetzen',
    body: (link, displayName) => `
      <p>Hallo ${escapeHtml(displayName)},</p>
      <p>Sie haben angefordert, Ihr Passwort zurückzusetzen. Klicken Sie auf den folgenden Link:</p>
      <p style="margin:20px 0">
        <a href="${link}" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#0ea5e9,#14b8a6);color:white;text-decoration:none;border-radius:10px;font-weight:600">
          Neues Passwort festlegen
        </a>
      </p>
      <p style="color:#64748b;font-size:13px">
        Der Link ist <strong>1 Stunde</strong> gültig. Wenn Sie diese Anfrage nicht gestellt haben,
        können Sie diese Mail einfach ignorieren — Ihr Passwort bleibt unverändert.
      </p>
      <p style="color:#64748b;font-size:12px;margin-top:20px">
        Link funktioniert nicht? Kopieren Sie diese Adresse in Ihren Browser:<br>
        <code style="word-break:break-all">${link}</code>
      </p>
      <p>Hamdi · Praxmate</p>`,
  },
  en: {
    subject: 'Praxmate — reset your password',
    body: (link, displayName) => `
      <p>Hi ${escapeHtml(displayName)},</p>
      <p>You requested a password reset. Click the link below:</p>
      <p style="margin:20px 0">
        <a href="${link}" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#0ea5e9,#14b8a6);color:white;text-decoration:none;border-radius:10px;font-weight:600">
          Set new password
        </a>
      </p>
      <p style="color:#64748b;font-size:13px">
        The link is valid for <strong>1 hour</strong>. If you did not request this,
        you can safely ignore this email — your password stays unchanged.
      </p>
      <p style="color:#64748b;font-size:12px;margin-top:20px">
        Link not working? Copy this address into your browser:<br>
        <code style="word-break:break-all">${link}</code>
      </p>
      <p>Hamdi · Praxmate</p>`,
  },
  tr: {
    subject: 'Praxmate — şifre sıfırlama',
    body: (link, displayName) => `
      <p>Merhaba ${escapeHtml(displayName)},</p>
      <p>Şifrenizi sıfırlamak istediniz. Aşağıdaki bağlantıya tıklayın:</p>
      <p style="margin:20px 0">
        <a href="${link}" style="display:inline-block;padding:12px 24px;background:linear-gradient(135deg,#0ea5e9,#14b8a6);color:white;text-decoration:none;border-radius:10px;font-weight:600">
          Yeni şifre belirle
        </a>
      </p>
      <p style="color:#64748b;font-size:13px">
        Bağlantı <strong>1 saat</strong> geçerlidir. Bu isteği siz yapmadıysanız,
        bu e-postayı görmezden gelebilirsiniz — şifreniz değişmez.
      </p>
      <p style="color:#64748b;font-size:12px;margin-top:20px">
        Bağlantı çalışmıyor mu? Bu adresi tarayıcınıza kopyalayın:<br>
        <code style="word-break:break-all">${link}</code>
      </p>
      <p>Hamdi · Praxmate</p>`,
  },
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function renderResetEmail(locale, link, displayName) {
  const tmpl = TEMPLATES[locale] || TEMPLATES.de;
  const html = `<!DOCTYPE html><html><body style="font-family:system-ui,-apple-system,sans-serif;color:#0f172a;line-height:1.6;max-width:560px;margin:0 auto;padding:20px;">
    <div style="background:linear-gradient(135deg,#0ea5e9,#14b8a6);color:white;padding:18px 22px;border-radius:12px 12px 0 0;">
      <h1 style="margin:0;font-size:20px;font-weight:700">Praxmate</h1>
    </div>
    <div style="background:white;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 12px 12px;">
      ${tmpl.body(link, displayName)}
    </div>
  </body></html>`;
  return { subject: tmpl.subject, html };
}

// ============================================================
// POST /api/public/auth/password/forgot
// ============================================================
export async function handleForgotPassword(env, request) {
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const email = String(body?.email || '').toLowerCase().trim();
  const langHint = String(body?.locale || '').slice(0, 2).toLowerCase();

  // Always pretend success — never leak whether email exists
  const okResponse = { ok: true, message: 'Wenn ein Konto mit dieser E-Mail existiert, haben wir eine Reset-Mail geschickt.' };

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse(okResponse, request);
  }

  // ===== Rate limit per email — using existing login_attempts table =====
  // We log forgot requests as "login attempts" with a special action marker.
  // Reuse existing table to avoid yet another schema migration.
  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recentRow = await env.DB.prepare(`
    SELECT COUNT(*) AS n FROM login_attempts
    WHERE email = ? AND created_at > ? AND ip_address LIKE 'pw-reset:%'
  `).bind(email, since).first();
  if ((recentRow?.n || 0) >= MAX_REQUESTS_PER_EMAIL_PER_HOUR) {
    // Quietly skip without leaking
    return jsonResponse(okResponse, request);
  }

  // Find users with this email (could be on multiple practices)
  const users = await env.DB.prepare(`
    SELECT u.id, u.email, u.name, u.practice_id, pr.locale, pr.slug
    FROM users u
    LEFT JOIN practices pr ON pr.id = u.practice_id
    WHERE u.email = ? AND u.status = 'active'
    LIMIT 5
  `).bind(email).all();

  const rows = users.results || [];
  if (rows.length === 0) {
    // Still log the attempt (anti-enumeration: same response time)
    await env.DB.prepare(`
      INSERT INTO login_attempts (id, email, practice_id, ip_address, success)
      VALUES (?, ?, NULL, ?, 0)
    `).bind(
      generateId('la'),
      email,
      'pw-reset:not-found:' + (request.headers.get('CF-Connecting-IP') || '?')
    ).run();
    return jsonResponse(okResponse, request);
  }

  // Pick the first user as the canonical one for the email + name in the email body.
  // We tie the token to email (not user_id) so it resets all matching users.
  const u = rows[0];
  const locale = ['de','en','tr'].includes(langHint) ? langHint : tenantLocale({ locale: u.locale });

  const token = generateToken(48); // 96 hex chars
  const tokenId = generateId('prt');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const ip = request.headers.get('CF-Connecting-IP') || '-';

  // Persist token. Schema added separately.
  await env.DB.prepare(`
    INSERT INTO password_reset_tokens (id, token, email, expires_at, ip_address)
    VALUES (?, ?, ?, ?, ?)
  `).bind(tokenId, token, email, expiresAt, ip).run();

  // Audit / rate limit log
  await env.DB.prepare(`
    INSERT INTO login_attempts (id, email, practice_id, ip_address, success)
    VALUES (?, ?, ?, ?, 0)
  `).bind(generateId('la'), email, null, 'pw-reset:sent:' + ip).run();

  // Build reset link (path-based — works regardless of subdomain origin)
  const link = `https://praxmate.de/praxis/reset.html?t=${encodeURIComponent(token)}`;

  // Send email
  try {
    const { subject, html } = renderResetEmail(locale, link, u.name || email);
    await sendEmail(env, { to: email, subject, html });
  } catch (e) {
    // Non-fatal — token is still valid; user could request again
    console.error('[forgot-password] send failed:', e?.message);
  }

  return jsonResponse(okResponse, request);
}

// ============================================================
// POST /api/public/auth/password/reset
// ============================================================
export async function handleResetPassword(env, request) {
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const token = String(body?.token || '').trim();
  const newPw = String(body?.new_password || '');

  if (!token || token.length < 32) {
    return jsonError('Token fehlt oder ungültig', request, 400);
  }
  if (newPw.length < 8) {
    return jsonError('Passwort muss mindestens 8 Zeichen haben', request, 400);
  }

  // Look up token
  const t = await env.DB.prepare(`
    SELECT id, token, email, expires_at, used_at
    FROM password_reset_tokens
    WHERE token = ?
    LIMIT 1
  `).bind(token).first();

  if (!t) {
    return jsonError('Ungültiger Reset-Link', request, 400);
  }
  if (t.used_at) {
    return jsonError('Dieser Reset-Link wurde bereits verwendet', request, 400);
  }
  if (new Date(t.expires_at).getTime() < Date.now()) {
    return jsonError('Reset-Link abgelaufen — bitte erneut anfordern', request, 400);
  }

  // Hash new password, update all users with this email
  const { hash, salt } = await hashPassword(newPw);
  const upd = await env.DB.prepare(`
    UPDATE users
    SET password_hash = ?, password_salt = ?, password_updated_at = datetime('now')
    WHERE email = ? AND status = 'active'
  `).bind(hash, salt, t.email).run();

  // Mark token as used
  await env.DB.prepare(`
    UPDATE password_reset_tokens SET used_at = datetime('now') WHERE id = ?
  `).bind(t.id).run();

  // Revoke existing sessions for these users so the old token can't be reused
  await env.DB.prepare(`
    UPDATE sessions SET revoked_at = datetime('now')
    WHERE user_id IN (SELECT id FROM users WHERE email = ?) AND revoked_at IS NULL
  `).bind(t.email).run();

  // Audit log — find a practice id for context (any will do, just for traceability)
  const userRow = await env.DB.prepare(
    `SELECT id, practice_id FROM users WHERE email = ? LIMIT 1`
  ).bind(t.email).first();
  if (userRow) {
    await logAudit(env, {
      practice_id: userRow.practice_id,
      actor_type:  'user',
      actor_id:    userRow.id,
      action:      'auth.password_reset',
      meta:        { email: t.email, users_updated: upd.meta?.changes ?? 0 },
      request,
    });
  }

  return jsonResponse({
    ok: true,
    users_updated: upd.meta?.changes ?? 0,
    message: 'Passwort erfolgreich gesetzt. Sie können sich jetzt anmelden.',
  }, request);
}
