// ============================================================
// Stripe HTTP client — minimal, no SDK
// ============================================================
// Uses form-encoded bodies per Stripe REST conventions.
// STRIPE_SECRET_KEY is a Worker Secret (never in source).
// ============================================================

const STRIPE_API = 'https://api.stripe.com/v1';

function formEncode(obj, prefix = '') {
  const params = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    const k = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        if (typeof v === 'object' && v !== null) {
          params.push(formEncode(v, `${k}[${i}]`));
        } else {
          params.push(`${encodeURIComponent(k + '[]')}=${encodeURIComponent(v)}`);
        }
      });
    } else if (typeof value === 'object') {
      params.push(formEncode(value, k));
    } else {
      params.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`);
    }
  }
  return params.filter(Boolean).join('&');
}

export async function stripeRequest(env, method, path, body) {
  const res = await fetch(STRIPE_API + path, {
    method,
    headers: {
      'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body ? formEncode(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data?.error?.message || `Stripe ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    e.stripe = data?.error;
    throw e;
  }
  return data;
}

// ============================================================
// Webhook signature verification
// Stripe sends: Stripe-Signature: t=TIMESTAMP,v1=HEX_SIGNATURE
// Payload to HMAC: `${timestamp}.${raw_body}`, key = whsec, alg = HMAC-SHA256
// Reference: https://stripe.com/docs/webhooks/signatures
// ============================================================
export async function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSec = 300) {
  if (!sigHeader || !secret) return false;

  const parts = sigHeader.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    if (!acc[k]) acc[k] = [];
    acc[k].push(v);
    return acc;
  }, {});

  const timestamp = parts.t?.[0];
  const signatures = parts.v1 || [];
  if (!timestamp || signatures.length === 0) return false;

  // Freshness check
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > toleranceSec) return false;

  // Compute expected signature
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    enc.encode(`${timestamp}.${rawBody}`)
  );
  const expected = Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time compare against any provided v1 signature
  return signatures.some(s => timingSafeEq(s, expected));
}

function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// ============================================================
// Plan <-> Price mapping
// ============================================================
export function priceIdForPlan(env, plan) {
  const map = {
    solo:   env.STRIPE_PRICE_SOLO,
    team:   env.STRIPE_PRICE_TEAM,
    klinik: env.STRIPE_PRICE_KLINIK,
  };
  return map[plan] || null;
}

export function planForPriceId(env, priceId) {
  if (priceId === env.STRIPE_PRICE_SOLO)   return 'solo';
  if (priceId === env.STRIPE_PRICE_TEAM)   return 'team';
  if (priceId === env.STRIPE_PRICE_KLINIK) return 'klinik';
  return null;
}
