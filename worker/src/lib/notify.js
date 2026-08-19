// ============================================================
// SUPER-ADMIN EVENT NOTIFICATIONS
// ============================================================
// Fan-out internal alerts to Slack + email. Best-effort, never throws.
//
// Channels (configured via secrets):
//   ADMIN_SLACK_WEBHOOK_URL  — incoming-webhook URL
//   ADMIN_NOTIFY_EMAIL       — comma-separated admin emails
//   ADMIN_NOTIFY_BASE_URL    — base for admin links (default praxmate.de)
//
// Usage: env.waitUntil(notify(env, 'tenant.signup', { practice, ... }))
// ============================================================

import { sendEmail } from './email.js';

const EVENTS = {
  'tenant.signup':                { emoji: '🆕', color: '#0ea5e9', severity: 'info',    title: 'Yeni signup',          summary: (p) => `${p.practice?.name || p.practice?.slug} kaydoldu (${p.plan || '?'})` },
  'tenant.subscription_created':  { emoji: '💸', color: '#059669', severity: 'good',    title: 'Abonelik başladı',     summary: (p) => `${p.practice?.name || p.practice?.slug} → ${p.plan || '?'}` },
  'tenant.cancelled':             { emoji: '👋', color: '#dc2626', severity: 'danger',  title: 'Abonelik iptal',       summary: (p) => `${p.practice?.name || p.practice?.slug} aboneliğini sonlandırdı` },
  'tenant.past_due':              { emoji: '⚠️', color: '#d97706', severity: 'warning', title: 'Ödeme başarısız',      summary: (p) => `${p.practice?.name || p.practice?.slug} (${p.amount_eur ? '€' + p.amount_eur : ''})` },
  'tenant.suspended':             { emoji: '⛔', color: '#dc2626', severity: 'danger',  title: 'Tenant askıya alındı', summary: (p) => `${p.practice?.name || p.practice?.slug} (super-admin)` },
  'tenant.2fa_disabled':          { emoji: '🔓', color: '#d97706', severity: 'warning', title: '2FA devre dışı',       summary: (p) => `${p.user?.email || '?'} @ ${p.practice?.name || p.practice?.slug}` },
};

export async function notify(env, event, payload = {}) {
  const def = EVENTS[event];
  if (!def) { console.warn(`[notify] unknown event: ${event}`); return; }

  const promises = [];
  if (env.ADMIN_SLACK_WEBHOOK_URL) {
    promises.push(deliverSlack(env, event, def, payload).catch(e => console.error('[notify] slack:', e?.message)));
  }
  if (env.ADMIN_NOTIFY_EMAIL) {
    promises.push(deliverEmail(env, event, def, payload).catch(e => console.error('[notify] email:', e?.message)));
  }
  if (promises.length === 0) {
    console.log(`[notify] no channels — would send: ${event}`);
    return;
  }
  await Promise.allSettled(promises);
}

async function deliverSlack(env, event, def, payload) {
  const baseUrl = env.ADMIN_NOTIFY_BASE_URL || 'https://praxmate.de';
  const fields = buildFields(payload);
  const tenantSlug = payload.practice?.slug;
  const detailUrl = tenantSlug ? `${baseUrl}/admin/tenant.html?slug=${encodeURIComponent(tenantSlug)}` : null;

  const body = {
    text: `${def.emoji} *${def.title}* — ${def.summary(payload)}`,
    attachments: [{
      color: def.color,
      fields: fields.map(f => ({ title: f.label, value: f.value, short: f.short !== false })),
      footer: 'Praxmate',
      ts: Math.floor(Date.now() / 1000),
      ...(detailUrl ? { actions: [{ type: 'button', text: 'Tenant öffnen', url: detailUrl }] } : {}),
    }],
  };

  const res = await fetch(env.ADMIN_SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`slack ${res.status}`);
}

async function deliverEmail(env, event, def, payload) {
  const baseUrl = env.ADMIN_NOTIFY_BASE_URL || 'https://praxmate.de';
  const recipients = String(env.ADMIN_NOTIFY_EMAIL).split(',').map(s => s.trim()).filter(Boolean);
  if (!recipients.length) return;

  const fields = buildFields(payload);
  const tenantSlug = payload.practice?.slug;
  const detailUrl = tenantSlug ? `${baseUrl}/admin/tenant.html?slug=${encodeURIComponent(tenantSlug)}` : `${baseUrl}/admin/dashboard.html`;
  const subject = `[Praxmate] ${def.emoji} ${def.title}: ${def.summary(payload)}`;

  const fieldRows = fields.map(f => `
    <tr>
      <td style="padding:6px 12px 6px 0;color:#64748b;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;vertical-align:top">${escapeHtml(f.label)}</td>
      <td style="padding:6px 0;font-size:14px;color:#0f172a;word-break:break-word">${escapeHtml(f.value)}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;padding:20px;margin:0">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:white;border-radius:14px;overflow:hidden;border:1px solid #e2e8f0">
    <tr><td style="background:${def.color};padding:18px 22px">
      <div style="font-size:11px;color:rgba(255,255,255,0.85);text-transform:uppercase;letter-spacing:0.08em;font-weight:700">Praxmate / ${escapeHtml(def.severity)}</div>
      <div style="font-size:18px;color:white;font-weight:800;margin-top:4px">${def.emoji} ${escapeHtml(def.title)}</div>
    </td></tr>
    <tr><td style="padding:22px">
      <div style="font-size:15px;color:#0f172a;margin-bottom:18px">${escapeHtml(def.summary(payload))}</div>
      <table cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #e2e8f0">${fieldRows}</table>
      <div style="margin-top:22px;text-align:center">
        <a href="${escapeHtml(detailUrl)}" style="display:inline-block;padding:10px 22px;background:#0ea5e9;color:white;text-decoration:none;border-radius:8px;font-weight:600;font-size:14px">Im Admin-Panel ansehen</a>
      </div>
    </td></tr>
    <tr><td style="padding:14px 22px;background:#f8fafc;font-size:11px;color:#64748b;text-align:center;border-top:1px solid #e2e8f0">Event: <code>${escapeHtml(event)}</code> · ${new Date().toISOString()}</td></tr>
  </table>
</body></html>`;

  await sendEmail(env, {
    to: recipients,
    subject,
    html,
    tags: [{ name: 'category', value: 'admin-alert' }, { name: 'event', value: event.replace(/\./g, '-') }],
  });
}

function buildFields(p) {
  const out = [];
  if (p.practice?.slug)   out.push({ label: 'Praxis',  value: `${p.practice.name || ''} (${p.practice.slug})`, short: true });
  if (p.practice?.id)     out.push({ label: 'ID',      value: p.practice.id, short: true });
  if (p.practice?.locale) out.push({ label: 'Sprache', value: p.practice.locale, short: true });
  if (p.user?.email)      out.push({ label: 'User',    value: p.user.email, short: true });
  if (p.plan)             out.push({ label: 'Plan',    value: p.plan, short: true });
  if (p.amount_eur)       out.push({ label: 'Betrag',  value: `€${p.amount_eur}`, short: true });
  if (p.mode)             out.push({ label: 'Stripe',  value: p.mode, short: true });
  if (p.reason)           out.push({ label: 'Grund',   value: p.reason, short: false });
  return out;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
