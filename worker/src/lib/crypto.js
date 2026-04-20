// PBKDF2 100k (Cloudflare Workers max)
// NIST min is 10k, we use 100k which is CF-supported ceiling.

const ITERATIONS = 100_000;

export async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hashHex = buf2hex(hashBuffer);
  const saltHex = buf2hex(salt);
  return { hash: hashHex, salt: saltHex };
}

export async function verifyPassword(password, storedHash, storedSalt) {
  const encoder = new TextEncoder();
  const saltBytes = new Uint8Array(storedSalt.length / 2);
  for (let i = 0; i < storedSalt.length; i += 2) {
    saltBytes[i / 2] = parseInt(storedSalt.substr(i, 2), 16);
  }
  const keyMaterial = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const hashBuffer = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const computed = buf2hex(hashBuffer);
  return computed === storedHash;
}

export function generateId(prefix = '') {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const hex = buf2hex(bytes);
  return prefix + (prefix ? '_' : '') + hex;
}

export function generateToken(bytes = 32) {
  return buf2hex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function generateBookingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rand = crypto.getRandomValues(new Uint8Array(6));
  return 'PRX-' + Array.from(rand).map(b => alphabet[b % alphabet.length]).join('');
}

function buf2hex(buf) {
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
