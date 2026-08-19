// ============================================================
// TOTP (Time-based One-Time Password) — RFC 6238
// ============================================================
// 6-digit code, SHA-1, 30-second window. Compatible with
// Google Authenticator, Authy, 1Password, Bitwarden, etc.
// Plus 8 single-use backup codes (hashed at rest).
// ============================================================

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).replace(/[\s=]/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character: ' + ch);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function generateTotpSecret() {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

export function buildOtpauthUrl({ issuer, account, secret }) {
  const enc = (s) => encodeURIComponent(String(s));
  const label = `${enc(issuer)}:${enc(account)}`;
  const params = new URLSearchParams({
    secret, issuer, algorithm: 'SHA1', digits: '6', period: '30',
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

async function hotp(secretBytes, counter) {
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  view.setUint32(0, Math.floor(counter / 0x100000000), false);
  view.setUint32(4, counter >>> 0, false);
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const offset = sig[sig.length - 1] & 0x0f;
  const code =
    ((sig[offset]     & 0x7f) << 24) |
    ((sig[offset + 1] & 0xff) << 16) |
    ((sig[offset + 2] & 0xff) <<  8) |
     (sig[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, '0');
}

export async function generateTotpCode(base32Secret, at = Math.floor(Date.now() / 1000)) {
  return hotp(base32Decode(base32Secret), Math.floor(at / 30));
}

export async function verifyTotpCode(base32Secret, userCode, { window = 1, at = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof userCode !== 'string' && typeof userCode !== 'number') return false;
  const code = String(userCode).trim().replace(/\s/g, '');
  if (!/^\d{6}$/.test(code)) return false;
  const secretBytes = base32Decode(base32Secret);
  const baseCounter = Math.floor(at / 30);
  for (let w = -window; w <= window; w++) {
    const counter = baseCounter + w;
    if (counter < 0) continue;
    if (timingSafeEq(await hotp(secretBytes, counter), code)) return true;
  }
  return false;
}

function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let m = 0;
  for (let i = 0; i < a.length; i++) m |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return m === 0;
}

// Backup codes — XXXX-XXXX, no ambiguous chars
const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const rand = crypto.getRandomValues(new Uint8Array(8));
    const part = (start) => Array.from(rand.slice(start, start + 4))
      .map(b => BACKUP_ALPHABET[b % BACKUP_ALPHABET.length]).join('');
    codes.push(part(0) + '-' + part(4));
  }
  return codes;
}

export async function hashBackupCodes(codes) {
  const out = [];
  for (const c of codes) out.push(await sha256Hex(c.toUpperCase().replace(/-/g, '')));
  return out;
}

export async function findAndConsumeBackupCode(env, userId, providedCode) {
  const row = await env.DB.prepare(`SELECT totp_backup_codes FROM users WHERE id = ?`).bind(userId).first();
  if (!row || !row.totp_backup_codes) return false;
  let stored;
  try { stored = JSON.parse(row.totp_backup_codes); } catch { return false; }
  if (!Array.isArray(stored) || stored.length === 0) return false;
  const normalized = String(providedCode || '').toUpperCase().replace(/[-\s]/g, '');
  if (!/^[A-Z0-9]{8}$/.test(normalized)) return false;
  const provHash = await sha256Hex(normalized);
  const idx = stored.findIndex(h => h === provHash);
  if (idx < 0) return false;
  stored.splice(idx, 1);
  await env.DB.prepare(`UPDATE users SET totp_backup_codes = ? WHERE id = ?`).bind(JSON.stringify(stored), userId).run();
  return true;
}

async function sha256Hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
