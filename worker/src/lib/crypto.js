/**
 * Crypto utilities for Praxmate auth
 * Uses Web Crypto API (Cloudflare Workers compatible)
 */

// Hex helpers
export function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

// Constant-time comparison (prevent timing attacks)
export function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Hash a password with PBKDF2 (SHA-256, 600k iterations, 16-byte salt)
 * Returns { hash: hex, salt: hex }
 */
export async function hashPassword(password) {
  const encoder = new TextEncoder();
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = bytesToHex(saltBytes);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  return { hash: bytesToHex(new Uint8Array(hashBuffer)), salt };
}

/**
 * Verify a password against stored hash + salt
 */
export async function verifyPassword(password, storedHash, storedSalt) {
  const encoder = new TextEncoder();
  const saltBytes = hexToBytes(storedSalt);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  const computed = bytesToHex(new Uint8Array(hashBuffer));
  return constantTimeEqual(computed, storedHash);
}

/**
 * Generate a secure random token (32 bytes = 64 hex chars)
 */
export function generateToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

/**
 * Generate a shorter random ID (with prefix)
 */
export function generateId(prefix = '') {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const id = bytesToHex(bytes);
  return prefix ? `${prefix}_${id}` : id;
}

/**
 * Hash a value with SHA-256 (for tokens in DB — never store raw tokens)
 */
export async function sha256(value) {
  const encoder = new TextEncoder();
  const buffer = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToHex(new Uint8Array(buffer));
}

/**
 * Generate a device fingerprint from IP + User-Agent
 */
export async function deviceFingerprint(ip, userAgent) {
  return await sha256(`${ip}|${userAgent}`);
}

/**
 * Password strength validation
 * Returns { valid: bool, reasons: [] }
 */
export function validatePassword(password) {
  const reasons = [];
  if (!password || password.length < 10) reasons.push('Mindestens 10 Zeichen');
  if (!/[a-zA-Z]/.test(password)) reasons.push('Mindestens ein Buchstabe');
  if (!/[0-9]/.test(password)) reasons.push('Mindestens eine Zahl');
  return { valid: reasons.length === 0, reasons };
}
