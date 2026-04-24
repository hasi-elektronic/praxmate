// ============================================================
// RESEND email client
// ============================================================
// Thin wrapper around the Resend HTTP API. API key comes from
// env.RESEND_API_KEY (set via `wrangler secret put RESEND_API_KEY`).
// From-address: env.RESEND_FROM_EMAIL or sensible default.
// ============================================================

const RESEND_URL = 'https://api.resend.com/emails';

export async function sendEmail(env, { to, subject, html, text, replyTo, from, tags }) {
  if (!env.RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not configured — skipping send');
    return { skipped: true, reason: 'no_api_key' };
  }
  const fromAddr = from || env.RESEND_FROM_EMAIL || 'Praxmate <noreply@machbar24.com>';

  const payload = {
    from: fromAddr,
    to: Array.isArray(to) ? to : [to],
    subject,
    html,
    ...(text ? { text } : {}),
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(tags ? { tags } : {}),
  };

  const res = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '<unreadable>');
    console.error(`[email] send failed ${res.status}: ${body.slice(0, 300)}`);
    return { ok: false, status: res.status, body };
  }
  const data = await res.json();
  return { ok: true, id: data.id };
}

/**
 * Demo tenants never send real email — helps avoid accidental spam
 * when prospects play with the demo.
 */
export function isDemoTenant(practiceSlug) {
  return /^demo(-|$)/.test(practiceSlug || '');
}

/**
 * Resolve the tenant's user-facing locale. Falls back to 'de-DE' so
 * pilot customers (Hild, Vayhinger) stay on German.
 */
export function tenantLocale(practice) {
  const raw = practice?.locale || 'de-DE';
  if (raw.startsWith('tr')) return 'tr';
  if (raw.startsWith('en')) return 'en';
  return 'de';
}
