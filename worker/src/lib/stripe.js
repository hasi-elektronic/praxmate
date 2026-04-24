// ============================================================
// Stripe HTTP client — minimal, no SDK
// ============================================================
// Uses form-encoded bodies per Stripe REST conventions.
// Supports dual-mode (LIVE + TEST) routing. Call stripeContextFor(env, practice)
// to pick the right context before issuing any API call.
// ============================================================

const STRIPE_API = 'https://api.stripe.com/v1';

/**
 * Select live vs test Stripe context based on practice.is_test_mode flag.
 * Test tenants hit sk_test_ + test price IDs so you can run unlimited checkout
 * with the 4242 4242 4242 4242 card without real charges.
 */
export function stripeContextFor(env, practice) {
  const isTest = practice?.is_test_mode === 1;
  if (isTest && env.STRIPE_TEST_SECRET_KEY) {
    return {
      mode: 'test',
      secretKey:     env.STRIPE_TEST_SECRET_KEY,
      webhookSecret: env.STRIPE_TEST_WEBHOOK_SECRET,
      publicKey:     env.STRIPE_TEST_PUBLIC_KEY,
      prices: {
        solo:   env.STRIPE_TEST_PRICE_SOLO,
        team:   env.STRIPE_TEST_PRICE_TEAM,
        klinik: env.STRIPE_TEST_PRICE_KLINIK,
      },
    };
  }
  return {
    mode: 'live',
    secretKey:     env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    publicKey:     env.STRIPE_PUBLIC_KEY,
    prices: {
      solo:   env.STRIPE_PRICE_SOLO,
      team:   env.STRIPE_PRICE_TEAM,
      klinik: env.STRIPE_PRICE_KLINIK,
    },
  };
}

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

/**
 * Call the Stripe API.
 * First arg may be either:
 *   - an env object (legacy: uses env.STRIPE_SECRET_KEY, always LIVE)
 *   - a context object from stripeContextFor() (dual-mode, preferred)
 */
export async function stripeRequest(envOrCtx, method, path, body) {
  const secretKey = envOrCtx.secretKey || envOrCtx.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('stripeRequest: missing secret key (call with env or context)');
  }
  const res = await fetch(STRIPE_API + path, {
    method,
    headers: {
      'Authorization': `Bearer ${secretKey}`,
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
// Accepts either env (legacy, LIVE only) or a context from stripeContextFor().
export function priceIdForPlan(envOrCtx, plan) {
  const prices = envOrCtx.prices || {
    solo:   envOrCtx.STRIPE_PRICE_SOLO,
    team:   envOrCtx.STRIPE_PRICE_TEAM,
    klinik: envOrCtx.STRIPE_PRICE_KLINIK,
  };
  return prices[plan] || null;
}

// Reverse lookup — given a Stripe Price ID, return the plan slug.
// Checks BOTH live and test mappings so webhook events (which don't know
// which mode they came from until verified) resolve correctly.
export function planForPriceId(env, priceId) {
  if (priceId === env.STRIPE_PRICE_SOLO)        return 'solo';
  if (priceId === env.STRIPE_PRICE_TEAM)        return 'team';
  if (priceId === env.STRIPE_PRICE_KLINIK)      return 'klinik';
  if (priceId === env.STRIPE_TEST_PRICE_SOLO)   return 'solo';
  if (priceId === env.STRIPE_TEST_PRICE_TEAM)   return 'team';
  if (priceId === env.STRIPE_TEST_PRICE_KLINIK) return 'klinik';
  return null;
}
