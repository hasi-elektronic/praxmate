// ============================================================
// SUPER-ADMIN OPERATIONS TOOLS
// ============================================================
// Endpoints designed for daily-ops use:
//
//   GET  /api/super/tenant/:slug/detail
//        Aggregated drill-down for one tenant: billing, Stripe state,
//        users, domains, last activity counts, recent audit log.
//
//   GET  /api/super/health
//        "Is anyone in trouble?" panel — past-due subs, trials
//        expiring in next 7 days, failed payments last 30 days,
//        zero-login engagement risks.
//
//   POST /api/super/tenant/:id/note
//        Stash a free-text internal note (kept in audit_log for now).
// ============================================================

import { jsonResponse, jsonError } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { stripeRequest, stripeContextFor } from '../lib/stripe.js';
import { logAudit } from '../lib/audit.js';

async function requireSuperAdmin(env, request) {
  const user = await requireAuth(env, request);
  const superEmail = env.SUPER_ADMIN_EMAIL || 'h.guencavdi@hasi-elektronic.de';
  if (user.email !== superEmail) {
    const e = new Error('Nur Super-Admin');
    e.status = 403;
    throw e;
  }
  return user;
}

// ============================================================
// GET /api/super/tenant/:slugOrId/detail
// ============================================================
export async function handleTenantDetail(env, request, slugOrId) {
  await requireSuperAdmin(env, request);

  // Accept either slug or practice id
  const isId = /^prc_/.test(slugOrId);
  const practice = await env.DB.prepare(`
    SELECT * FROM practices WHERE ${isId ? 'id' : 'slug'} = ? LIMIT 1
  `).bind(slugOrId).first();
  if (!practice) return jsonError('Praxis nicht gefunden', request, 404);

  // Activity counts
  const counts = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users           WHERE practice_id = ?) AS user_count,
      (SELECT COUNT(*) FROM doctors         WHERE practice_id = ?) AS doctor_count,
      (SELECT COUNT(*) FROM patients        WHERE practice_id = ? AND deleted_at IS NULL) AS patient_count,
      (SELECT COUNT(*) FROM appointments    WHERE practice_id = ?) AS appt_count_total,
      (SELECT COUNT(*) FROM appointments    WHERE practice_id = ? AND start_datetime >= datetime('now','-30 day')) AS appt_count_30d,
      (SELECT COUNT(*) FROM appointments    WHERE practice_id = ? AND start_datetime >= datetime('now','-7 day')) AS appt_count_7d,
      (SELECT COUNT(*) FROM appointment_types WHERE practice_id = ?) AS type_count
  `).bind(
    practice.id, practice.id, practice.id, practice.id, practice.id, practice.id, practice.id
  ).first() || {};

  // Users
  const users = await env.DB.prepare(`
    SELECT id, email, name, role, status, created_at,
           (SELECT MAX(last_seen_at) FROM sessions WHERE user_id = users.id) AS last_login
    FROM users
    WHERE practice_id = ?
    ORDER BY (role = 'owner') DESC, created_at ASC
  `).bind(practice.id).all();

  // Domains
  const domains = await env.DB.prepare(`
    SELECT hostname, type, verified, is_primary, ssl_status, created_at
    FROM practice_domains
    WHERE practice_id = ?
    ORDER BY is_primary DESC, created_at ASC
  `).bind(practice.id).all();

  // Recent audit (last 30)
  const audit = await env.DB.prepare(`
    SELECT created_at, actor_type, actor_id, action, meta
    FROM audit_log
    WHERE practice_id = ?
    ORDER BY created_at DESC
    LIMIT 30
  `).bind(practice.id).all();

  // Stripe live state (if subscribed)
  let stripe_subscription = null;
  let stripe_customer = null;
  const ctx = stripeContextFor(env, practice);
  const customerId = ctx.mode === 'test'
    ? practice.stripe_test_customer_id
    : practice.stripe_customer_id;
  const subId = ctx.mode === 'test'
    ? practice.stripe_test_subscription_id
    : practice.stripe_subscription_id;

  if (subId) {
    try {
      const sub = await stripeRequest(ctx, 'GET', `/subscriptions/${subId}`);
      const item = sub.items?.data?.[0] || {};
      stripe_subscription = {
        id: sub.id,
        status: sub.status,
        cancel_at_period_end: sub.cancel_at_period_end,
        current_period_end: item.current_period_end ?? sub.current_period_end,
        trial_end: sub.trial_end,
        amount_cents: item.price?.unit_amount ?? null,
        price_id: item.price?.id ?? null,
        nickname: item.price?.nickname ?? null,
        latest_invoice: typeof sub.latest_invoice === 'string' ? sub.latest_invoice : sub.latest_invoice?.id,
      };
    } catch (e) {
      stripe_subscription = { error: e?.message || 'Stripe lookup failed' };
    }
  }
  if (customerId) {
    try {
      const cust = await stripeRequest(ctx, 'GET', `/customers/${customerId}`);
      stripe_customer = {
        id: cust.id,
        email: cust.email,
        name: cust.name,
        balance_cents: cust.balance,
        default_payment_method: cust.invoice_settings?.default_payment_method,
        created: cust.created,
      };
    } catch (e) {
      stripe_customer = { error: e?.message || 'Stripe lookup failed' };
    }
  }

  return jsonResponse({
    practice: {
      id: practice.id,
      slug: practice.slug,
      name: practice.name,
      specialty: practice.specialty,
      city: practice.city,
      country: practice.country,
      phone: practice.phone,
      email: practice.email,
      website: practice.website,
      locale: practice.locale,
      timezone: practice.timezone,
      brand_primary: practice.brand_primary,
      brand_accent: practice.brand_accent,
      logo_url: practice.logo_url,
      plan: practice.plan,
      plan_status: practice.plan_status,
      trial_ends_at: practice.trial_ends_at,
      max_doctors: practice.max_doctors,
      is_test_mode: practice.is_test_mode === 1,
      stripe_mode: ctx.mode,
      created_at: practice.created_at,
      activated_at: practice.activated_at,
      suspended_at: practice.suspended_at,
    },
    counts,
    users:   users.results || [],
    domains: domains.results || [],
    audit:   audit.results || [],
    stripe_customer,
    stripe_subscription,
  }, request);
}

// ============================================================
// GET /api/super/health
// "Is anyone in trouble?" — daily ops alert panel.
// ============================================================
export async function handleHealth(env, request) {
  await requireSuperAdmin(env, request);

  // 1. Past-due subscriptions (Stripe webhook flagged them)
  const pastDue = await env.DB.prepare(`
    SELECT slug, name, plan, locale, current_period_end, stripe_subscription_id, is_test_mode
    FROM practices
    WHERE plan_status = 'past_due'
    ORDER BY current_period_end ASC
    LIMIT 50
  `).all();

  // 2. Trials expiring in next 7 days (warm leads to chase manually if needed)
  const trialExpiring = await env.DB.prepare(`
    SELECT slug, name, plan, locale, trial_ends_at, is_test_mode,
           CAST(julianday(trial_ends_at) - julianday('now') AS INTEGER) AS days_left
    FROM practices
    WHERE plan_status = 'trial'
      AND trial_ends_at IS NOT NULL
      AND trial_ends_at >= date('now')
      AND trial_ends_at <= date('now','+7 day')
    ORDER BY trial_ends_at ASC
    LIMIT 50
  `).all();

  // 3. Recent cancellations (last 14 days)
  const recentCancellations = await env.DB.prepare(`
    SELECT pr.slug, pr.name, pr.plan, pr.locale,
           pr.is_test_mode,
           (SELECT created_at FROM audit_log
            WHERE practice_id = pr.id
              AND action = 'billing.subscription_cancelled'
            ORDER BY created_at DESC LIMIT 1) AS cancelled_at
    FROM practices pr
    WHERE pr.plan_status = 'cancelled'
      AND EXISTS (
        SELECT 1 FROM audit_log
        WHERE practice_id = pr.id
          AND action = 'billing.subscription_cancelled'
          AND created_at >= datetime('now','-14 day')
      )
    ORDER BY cancelled_at DESC
    LIMIT 30
  `).all();

  // 4. Failed-payment events last 30 days (for follow-up)
  const failedPayments = await env.DB.prepare(`
    SELECT al.created_at, al.practice_id, al.meta, pr.slug, pr.name, pr.locale
    FROM audit_log al
    JOIN practices pr ON pr.id = al.practice_id
    WHERE al.action = 'billing.payment_failed'
      AND al.created_at >= datetime('now','-30 day')
    ORDER BY al.created_at DESC
    LIMIT 30
  `).all();

  // 5. Engagement risk: active tenants with NO logins in last 7 days
  // (excluding test mode + tenants younger than 7 days who haven't had time)
  const engagementRisk = await env.DB.prepare(`
    SELECT pr.slug, pr.name, pr.plan, pr.locale, pr.created_at,
           (SELECT MAX(s.last_seen_at) FROM sessions s
            JOIN users u ON u.id = s.user_id
            WHERE u.practice_id = pr.id) AS last_login
    FROM practices pr
    WHERE pr.plan_status IN ('trial','active')
      AND pr.is_test_mode != 1
      AND pr.created_at < datetime('now','-7 day')
      AND NOT EXISTS (
        SELECT 1 FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE u.practice_id = pr.id
          AND s.last_seen_at >= datetime('now','-7 day')
      )
    ORDER BY last_login ASC NULLS FIRST
    LIMIT 30
  `).all();

  // 6. Trial reminder funnel — how many at each threshold currently
  const trialFunnel = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN trial_reminder_sent_at = 7 THEN 1 ELSE 0 END) AS at_7d,
      SUM(CASE WHEN trial_reminder_sent_at = 3 THEN 1 ELSE 0 END) AS at_3d,
      SUM(CASE WHEN trial_reminder_sent_at = 1 THEN 1 ELSE 0 END) AS at_1d,
      SUM(CASE WHEN trial_reminder_sent_at = 0 THEN 1 ELSE 0 END) AS at_0d
    FROM practices
    WHERE plan_status = 'trial' AND is_test_mode != 1
  `).first() || {};

  return jsonResponse({
    generated_at: new Date().toISOString(),
    past_due:               pastDue.results || [],
    trial_expiring_7d:      trialExpiring.results || [],
    recent_cancellations:   recentCancellations.results || [],
    failed_payments_30d:    failedPayments.results || [],
    engagement_risk:        engagementRisk.results || [],
    trial_reminder_funnel:  trialFunnel,
  }, request);
}

// ============================================================
// POST /api/super/tenant/:id/note
// ============================================================
export async function handleAddNote(env, request, slugOrId) {
  const user = await requireSuperAdmin(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Bad JSON', request, 400); }
  const note = String(body?.note || '').trim();
  if (!note) return jsonError('note required', request, 400);
  if (note.length > 2000) return jsonError('note too long (max 2000 chars)', request, 400);

  const isId = /^prc_/.test(slugOrId);
  const practice = await env.DB.prepare(
    `SELECT id FROM practices WHERE ${isId ? 'id' : 'slug'} = ? LIMIT 1`
  ).bind(slugOrId).first();
  if (!practice) return jsonError('Praxis nicht gefunden', request, 404);

  await logAudit(env, {
    practice_id: practice.id,
    actor_type:  'user',
    actor_id:    user.user_id,
    action:      'super.note',
    meta:        { note, by: user.email },
    request,
  });

  return jsonResponse({ ok: true }, request);
}
