/**
 * Generate password hash + salt using PBKDF2 (Web Crypto API)
 * Compatible with Cloudflare Workers runtime
 */

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const salt = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');

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
      iterations: 600000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  const hash = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return { hash, salt };
}

// Generate for seed user
const password = process.argv[2] || 'Praxmate2026!';
hashPassword(password).then(({ hash, salt }) => {
  console.log(`Password: ${password}`);
  console.log(`Hash:     ${hash}`);
  console.log(`Salt:     ${salt}`);
  console.log();
  console.log('SQL:');
  console.log(`INSERT INTO users (
  id, practice_id, email, name, role, doctor_id,
  password_hash, password_salt, password_changed_at,
  email_verified_at, active
) VALUES (
  'usr_juliane', 'prc_hild', 'juliane@zahnarzthild.de', 'Juliane Hild', 'owner', 'doc_juliane',
  '${hash}', '${salt}', datetime('now'),
  datetime('now'), 1
);`);
});
