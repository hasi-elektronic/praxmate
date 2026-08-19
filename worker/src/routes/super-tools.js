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
import { stripeRequest, stripeContextFor, priceIdForPlan } from '../lib/stripe.js';
import { logAudit } from '../lib/audit.js';
import { notify } from '../lib/notify.js';

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
// GET /api/super/kpi
// Top-line numbers for the admin dashboard.
// ============================================================
export async function handleKpiSummary(env, request) {
  await requireSuperAdmin(env, request);

  const planAmount = {
    warteliste: 29,
    solo: 39,
    team: 69,
    klinik: 119,
  };

  // Active subs (plan_status = 'active') grouped by plan — for MRR
  const activeByPlan = await env.DB.prepare(`
    SELECT plan, COUNT(*) AS n
    FROM practices
    WHERE plan_status = 'active' AND (is_test_mode IS NULL OR is_test_mode = 0)
    GROUP BY plan
  `).all();

  let mrr_eur = 0;
  let active_count = 0;
  const by_plan = {};
  for (const row of (activeByPlan.results || [])) {
    const amt = planAmount[row.plan] || 0;
    mrr_eur += amt * row.n;
    active_count += row.n;
    by_plan[row.plan] = row.n;
  }

  // Trials ending in next 7 days
  const trialEnding = await env.DB.prepare(`
    SELECT COUNT(*) AS n
    FROM practices
    WHERE plan_status = 'trial'
      AND trial_ends_at IS NOT NULL
      AND trial_ends_at >= date('now')
      AND trial_ends_at <= date('now','+7 day')
      AND (is_test_mode IS NULL OR is_test_mode = 0)
  `).first();

  // Past-due
  const pastDue = await env.DB.prepare(`
    SELECT COUNT(*) AS n
    FROM practices
    WHERE plan_status = 'past_due'
      AND (is_test_mode IS NULL OR is_test_mode = 0)
  `).first();

  // Suspended
  const suspended = await env.DB.prepare(`
    SELECT COUNT(*) AS n
    FROM practices
    WHERE plan_status = 'suspended'
  `).first();

  // Signups in last 30 / 7 days
  const signups = await env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM practices WHERE created_at >= datetime('now','-30 day')) AS d30,
      (SELECT COUNT(*) FROM practices WHERE created_at >= datetime('now','-7 day'))  AS d7,
      (SELECT COUNT(*) FROM practices WHERE created_at >= datetime('now','-1 day'))  AS d1
  `).first();

  // Total tenants
  const total = await env.DB.prepare(`SELECT COUNT(*) AS n FROM practices`).first();

  return jsonResponse({
    mrr_eur,
    active_count,
    by_plan,
    trial_ending_7d: trialEnding?.n || 0,
    past_due_count:  pastDue?.n || 0,
    suspended_count: suspended?.n || 0,
    total_tenants:   total?.n || 0,
    signups: {
      last_30d: signups?.d30 || 0,
      last_7d:  signups?.d7  || 0,
      last_24h: signups?.d1  || 0,
    },
    generated_at: new Date().toISOString(),
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

// ============================================================
// GET /api/super/audit
// ============================================================
// Cross-tenant audit log viewer with filters.
//   ?practice=<slug|id>   narrow to one tenant
//   ?action=<exact>       exact action match, or 'billing.*' prefix
//   ?since=<iso>          created_at >= since
//   ?until=<iso>          created_at <= until
//   ?limit=<1..200>       default 50
//   ?cursor=<id>          keyset pagination (audit_log.id of last row)
// Returns: { items, count, next_cursor, filters }
// ============================================================
export async function handleAuditLogList(env, request) {
  await requireSuperAdmin(env, request);
  const url = new URL(request.url);
  const filterPractice = (url.searchParams.get('practice') || '').trim();
  const filterAction   = (url.searchParams.get('action')   || '').trim();
  const filterSince    = (url.searchParams.get('since')    || '').trim();
  const filterUntil    = (url.searchParams.get('until')    || '').trim();
  const cursor         = (url.searchParams.get('cursor')   || '').trim();
  let limit = parseInt(url.searchParams.get('limit') || '50', 10);
  if (!Number.isFinite(limit) || limit < 1) limit = 50;
  if (limit > 200) limit = 200;

  const where = [];
  const binds = [];

  if (filterPractice) {
    if (/^prc_/.test(filterPractice)) {
      where.push('al.practice_id = ?');
      binds.push(filterPractice);
    } else {
      where.push('al.practice_id = (SELECT id FROM practices WHERE slug = ? LIMIT 1)');
      binds.push(filterPractice);
    }
  }
  if (filterAction) {
    if (filterAction.endsWith('*')) {
      const prefix = filterAction.slice(0, -1).replace(/[%_\\]/g, c => '\\' + c);
      where.push("al.action LIKE ? ESCAPE '\\'");
      binds.push(prefix + '%');
    } else {
      where.push('al.action = ?');
      binds.push(filterAction);
    }
  }
  if (filterSince) { where.push('al.created_at >= ?'); binds.push(filterSince); }
  if (filterUntil) { where.push('al.created_at <= ?'); binds.push(filterUntil); }

  if (cursor) {
    const anchor = await env.DB.prepare(
      `SELECT created_at FROM audit_log WHERE id = ? LIMIT 1`
    ).bind(cursor).first();
    if (anchor) {
      where.push('(al.created_at < ? OR (al.created_at = ? AND al.id < ?))');
      binds.push(anchor.created_at, anchor.created_at, cursor);
    }
  }

  const sql = `
    SELECT al.id, al.created_at, al.practice_id,
           al.actor_type, al.actor_id, al.action,
           al.target_type, al.target_id, al.meta,
           al.ip_address, al.user_agent,
           pr.slug      AS practice_slug,
           pr.name      AS practice_name,
           u.email      AS actor_email,
           u.name       AS actor_name
    FROM audit_log al
    LEFT JOIN practices pr ON pr.id = al.practice_id
    LEFT JOIN users     u  ON u.id  = al.actor_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY al.created_at DESC, al.id DESC
    LIMIT ?
  `;
  binds.push(limit + 1);

  const res = await env.DB.prepare(sql).bind(...binds).all();
  const rows = res.results || [];
  const hasMore = rows.length > limit;
  const items = (hasMore ? rows.slice(0, limit) : rows);

  return jsonResponse({
    items,
    count: items.length,
    next_cursor: hasMore ? items[items.length - 1].id : null,
    filters: {
      practice: filterPractice || null,
      action:   filterAction   || null,
      since:    filterSince    || null,
      until:    filterUntil    || null,
      limit,
    },
  }, request);
}

// ============================================================
// Shared admin-action executor — used by both single-tenant
// billing endpoint and the bulk endpoint. Catches errors so
// bulk iterations don't bail on one bad tenant.
//
// Supported actions:
//   change_plan           { plan: 'warteliste'|'solo'|'team'|'klinik', proration?: bool }
//   extend_trial          { days: 1..90 }
//   cancel_at_period_end  { cancel?: bool }   default true
//   apply_coupon          { coupon: <stripe_coupon_id> }
//   comp_month            { months?: 1..3 }
//   suspend               { reason?: string }
//   unsuspend             {}
// Returns { ok, status, error, action, mode, ...result }
// ============================================================
async function executeAdminAction(env, request, practice, body, user) {
  const action = String(body?.action || '').trim();
  if (!action) return { ok: false, status: 400, error: 'action required' };

  const ctx = stripeContextFor(env, practice);
  const subId = ctx.mode === 'test'
    ? practice.stripe_test_subscription_id
    : practice.stripe_subscription_id;
  const customerId = ctx.mode === 'test'
    ? practice.stripe_test_customer_id
    : practice.stripe_customer_id;

  let result = {};
  try {
    if (action === 'change_plan') {
      const targetPlan = String(body.plan || '').toLowerCase();
      if (!['warteliste', 'solo', 'team', 'klinik'].includes(targetPlan)) {
        return { ok: false, status: 400, error: 'plan must be warteliste|solo|team|klinik' };
      }
      const newPriceId = priceIdForPlan(ctx, targetPlan);
      if (!newPriceId) return { ok: false, status: 500, error: `No price configured for ${targetPlan} (${ctx.mode})` };
      if (subId) {
        const sub = await stripeRequest(ctx, 'GET', `/subscriptions/${subId}`);
        const itemId = sub.items?.data?.[0]?.id;
        if (!itemId) return { ok: false, status: 502, error: 'Subscription has no items' };
        const proration = body.proration === false ? 'none' : 'create_prorations';
        const updated = await stripeRequest(ctx, 'POST', `/subscriptions/${subId}`, {
          'items[0][id]': itemId,
          'items[0][price]': newPriceId,
          proration_behavior: proration,
        });
        result.subscription = { id: updated.id, status: updated.status };
      }
      const maxDoctors = targetPlan === 'warteliste' ? 1 : targetPlan === 'solo' ? 1 : targetPlan === 'team' ? 5 : 50;
      await env.DB.prepare(
        `UPDATE practices SET plan = ?, max_doctors = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(targetPlan, maxDoctors, practice.id).run();
      result.plan = targetPlan;
    }
    else if (action === 'extend_trial') {
      const days = parseInt(body.days, 10);
      if (!Number.isFinite(days) || days < 1 || days > 90) {
        return { ok: false, status: 400, error: 'days must be 1..90' };
      }
      const now = new Date();
      const cur = practice.trial_ends_at ? new Date(practice.trial_ends_at) : now;
      const base = cur > now ? cur : now;
      const newTrialEnd = new Date(base.getTime() + days * 86400 * 1000);
      const newTrialEndIso = newTrialEnd.toISOString().replace('T', ' ').slice(0, 19);
      await env.DB.prepare(
        `UPDATE practices
           SET trial_ends_at = ?,
               plan_status = CASE WHEN plan_status = 'past_due' THEN plan_status ELSE 'trial' END,
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).bind(newTrialEndIso, practice.id).run();
      if (subId) {
        try {
          await stripeRequest(ctx, 'POST', `/subscriptions/${subId}`, {
            trial_end: Math.floor(newTrialEnd.getTime() / 1000),
            proration_behavior: 'none',
          });
        } catch (e) { result.stripe_warning = e?.message; }
      }
      result.trial_ends_at = newTrialEndIso;
      result.added_days = days;
    }
    else if (action === 'cancel_at_period_end') {
      if (!subId) return { ok: false, status: 400, error: 'No active subscription' };
      const cancel = body.cancel !== false;
      const updated = await stripeRequest(ctx, 'POST', `/subscriptions/${subId}`, {
        cancel_at_period_end: cancel ? 'true' : 'false',
      });
      result.subscription = {
        id: updated.id,
        cancel_at_period_end: updated.cancel_at_period_end,
      };
      result.cancel = cancel;
    }
    else if (action === 'apply_coupon') {
      const coupon = String(body.coupon || '').trim();
      if (!coupon) return { ok: false, status: 400, error: 'coupon required' };
      if (!subId) return { ok: false, status: 400, error: 'No active subscription' };
      const updated = await stripeRequest(ctx, 'POST', `/subscriptions/${subId}`, { coupon });
      result.subscription = { id: updated.id };
      result.coupon = coupon;
    }
    else if (action === 'comp_month') {
      if (!customerId) return { ok: false, status: 400, error: 'No Stripe customer' };
      const months = parseInt(body.months || 1, 10);
      if (!Number.isFinite(months) || months < 1 || months > 3) {
        return { ok: false, status: 400, error: 'months must be 1..3' };
      }
      const planMap = { warteliste: 900, solo: 3900, team: 6900, klinik: 11900 };
      const cents = planMap[practice.plan] ?? 0;
      if (!cents) return { ok: false, status: 400, error: `Plan "${practice.plan}" has no comp price` };
      const totalCents = cents * months;
      const created = await stripeRequest(ctx, 'POST', '/invoiceitems', {
        customer: customerId,
        amount: -totalCents,
        currency: 'eur',
        description: `Goodwill credit (${months} month${months > 1 ? 's' : ''}) — Praxmate Support`,
      });
      result.invoice_item = { id: created.id, amount_cents: totalCents, months };
    }
    else if (action === 'suspend') {
      if (practice.plan_status === 'suspended') {
        return { ok: false, status: 400, error: 'Already suspended' };
      }
      const reason = String(body.reason || '').trim().slice(0, 500);
      await env.DB.prepare(
        `UPDATE practices SET plan_status='suspended', suspended_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(practice.id).run();
      result.suspended = true;
      if (reason) result.reason = reason;
      if (env.waitUntil) {
        env.waitUntil(notify(env, 'tenant.suspended', {
          practice: { id: practice.id, slug: practice.slug, name: practice.name, locale: practice.locale },
          user: { email: user.email },
          reason,
        }));
      }
    }
    else if (action === 'unsuspend') {
      if (practice.plan_status !== 'suspended') {
        return { ok: false, status: 400, error: 'Not suspended' };
      }
      const newStatus = subId ? 'active' : 'trial';
      await env.DB.prepare(
        `UPDATE practices SET plan_status=?, suspended_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id = ?`
      ).bind(newStatus, practice.id).run();
      result.plan_status = newStatus;
    }
    else {
      return { ok: false, status: 400, error: `Unknown action: ${action}` };
    }
  } catch (e) {
    return { ok: false, status: e?.status || 500, error: e?.message || 'Action failed' };
  }

  await logAudit(env, {
    practice_id: practice.id,
    actor_type:  'user',
    actor_id:    user.user_id,
    action:      `super.billing.${action}`,
    meta:        { by: user.email, mode: ctx.mode, request: body, result },
    request,
  });

  return { ok: true, action, mode: ctx.mode, ...result };
}

// ============================================================
// POST /api/super/tenant/:id/billing — single-tenant billing action
// ============================================================
export async function handleTenantBilling(env, request, slugOrId) {
  const user = await requireSuperAdmin(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Bad JSON', request, 400); }

  const isId = /^prc_/.test(slugOrId);
  const practice = await env.DB.prepare(
    `SELECT * FROM practices WHERE ${isId ? 'id' : 'slug'} = ? LIMIT 1`
  ).bind(slugOrId).first();
  if (!practice) return jsonError('Praxis nicht gefunden', request, 404);

  const out = await executeAdminAction(env, request, practice, body, user);
  if (!out.ok) return jsonError(out.error, request, out.status || 400);
  return jsonResponse(out, request);
}

// ============================================================
// POST /api/super/bulk — apply ONE action to N tenants
// Body: { practice_ids: [...], action, ...args }
// Max 50 tenants/call. Per-tenant { ok, error } in results[].
// ============================================================
export async function handleBulkAction(env, request) {
  const user = await requireSuperAdmin(env, request);
  let body;
  try { body = await request.json(); } catch { return jsonError('Bad JSON', request, 400); }

  const ids = Array.isArray(body?.practice_ids) ? body.practice_ids : null;
  if (!ids || ids.length === 0) return jsonError('practice_ids array required', request, 400);
  if (ids.length > 50) return jsonError('max 50 practices per bulk call', request, 400);

  const action = String(body?.action || '').trim();
  if (!action) return jsonError('action required', request, 400);

  const resolved = [];
  for (const ref of ids) {
    const r = String(ref || '').trim();
    if (!r) continue;
    const isId = /^prc_/.test(r);
    const practice = await env.DB.prepare(
      `SELECT * FROM practices WHERE ${isId ? 'id' : 'slug'} = ? LIMIT 1`
    ).bind(r).first();
    resolved.push({ ref: r, practice });
  }

  const results = [];
  let succeeded = 0;
  let failed = 0;
  for (const { ref, practice } of resolved) {
    if (!practice) {
      results.push({ ref, ok: false, status: 404, error: 'Praxis nicht gefunden' });
      failed++;
      continue;
    }
    const out = await executeAdminAction(env, request, practice, body, user);
    const row = { practice_id: practice.id, slug: practice.slug, name: practice.name, ...out };
    results.push(row);
    if (out.ok) succeeded++; else failed++;
  }

  await logAudit(env, {
    practice_id: null,
    actor_type:  'user',
    actor_id:    user.user_id,
    action:      `super.bulk.${action}`,
    meta: {
      by:          user.email,
      total:       resolved.length,
      succeeded,
      failed,
      practice_ids: resolved.map(r => r.practice?.id || r.ref),
      args:        { ...body, practice_ids: undefined },
    },
    request,
  });

  return jsonResponse({
    ok: failed === 0,
    total: resolved.length,
    succeeded,
    failed,
    results,
  }, request);
}
