// ============================================================
// SUPER-ADMIN ANALYTICS — MRR, signups, churn, conversion
// ============================================================
// GET /api/super/analytics
// Returns the numbers Hamdi cares about every morning:
//   - Active subscriptions (live mode only)
//   - MRR (sum of active subscription monthly amounts, EUR cents)
//   - New signups today / this week / this month
//   - Trial → paid conversion (last 30 days)
//   - Churn (cancellations last 30 days)
//   - Recent signups (last 10 with timestamps)
//   - Recent payments (last 10 successful invoices via Stripe)
// ============================================================

import { jsonResponse, jsonError } from '../lib/http.js';
import { requireAuth } from '../lib/auth.js';
import { stripeRequest, planForPriceId } from '../lib/stripe.js';

// EUR-cent prices for plans, used to compute MRR from price_id
const PLAN_AMOUNT = {
  solo:   3900,
  team:   6900,
  klinik: 11900,
};

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

export async function handleSuperAnalytics(env, request) {
  await requireSuperAdmin(env, request);

  // ===== D1 stats: tenant counts + signup velocity =====
  const tenants = await env.DB.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN plan_status = 'trial'    THEN 1 ELSE 0 END) AS trial,
      SUM(CASE WHEN plan_status = 'active'   THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN plan_status = 'past_due' THEN 1 ELSE 0 END) AS past_due,
      SUM(CASE WHEN plan_status = 'cancelled'THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN is_test_mode = 1         THEN 1 ELSE 0 END) AS test_tenants,
      SUM(CASE WHEN created_at >= date('now') THEN 1 ELSE 0 END) AS signups_today,
      SUM(CASE WHEN created_at >= date('now','-7 day') THEN 1 ELSE 0 END) AS signups_7d,
      SUM(CASE WHEN created_at >= date('now','-30 day') THEN 1 ELSE 0 END) AS signups_30d,
      SUM(CASE WHEN created_at >= date('now','start of month') THEN 1 ELSE 0 END) AS signups_this_month
    FROM practices
  `).first() || {};

  // ===== Recent signups (last 10) =====
  const recentSignups = await env.DB.prepare(`
    SELECT slug, name, locale, plan, plan_status, created_at, is_test_mode
    FROM practices
    ORDER BY created_at DESC
    LIMIT 10
  `).all();

  // ===== MRR — only LIVE active subscriptions =====
  const mrrRow = await env.DB.prepare(`
    SELECT
      SUM(CASE WHEN plan = 'solo'   AND plan_status = 'active' AND is_test_mode != 1 THEN 1 ELSE 0 END) AS solo_active,
      SUM(CASE WHEN plan = 'team'   AND plan_status = 'active' AND is_test_mode != 1 THEN 1 ELSE 0 END) AS team_active,
      SUM(CASE WHEN plan = 'klinik' AND plan_status = 'active' AND is_test_mode != 1 THEN 1 ELSE 0 END) AS klinik_active
    FROM practices
  `).first() || {};

  const mrr_cents =
    (mrrRow.solo_active   || 0) * PLAN_AMOUNT.solo   +
    (mrrRow.team_active   || 0) * PLAN_AMOUNT.team   +
    (mrrRow.klinik_active || 0) * PLAN_AMOUNT.klinik;

  // ===== Daily signup time series for last 30 days (for sparkline) =====
  const dailySignups = await env.DB.prepare(`
    SELECT
      date(created_at) AS day,
      COUNT(*) AS count
    FROM practices
    WHERE created_at >= date('now','-30 day')
    GROUP BY date(created_at)
    ORDER BY day
  `).all();

  // ===== Conversion: how many trials in last 30d turned into active? =====
  // Note: this compares ACTIVE practices that signed up in the window.
  const conversion = await env.DB.prepare(`
    SELECT
      COUNT(*) AS signups,
      SUM(CASE WHEN plan_status = 'active' AND is_test_mode != 1 THEN 1 ELSE 0 END) AS converted
    FROM practices
    WHERE created_at >= date('now','-30 day')
      AND is_test_mode != 1
  `).first() || {};

  const conversionRate = conversion.signups > 0
    ? Math.round((conversion.converted / conversion.signups) * 1000) / 10
    : 0;

  // ===== Recent live invoices (last 10) — pulled from Stripe =====
  let recentInvoices = [];
  try {
    const inv = await stripeRequest(
      { secretKey: env.STRIPE_SECRET_KEY },
      'GET',
      '/invoices?status=paid&limit=10'
    );
    recentInvoices = (inv.data || []).map(i => ({
      id: i.id,
      number: i.number,
      amount_cents: i.amount_paid,
      currency: (i.currency || 'eur').toUpperCase(),
      paid_at: i.status_transitions?.paid_at,
      customer_email: i.customer_email,
      hosted_url: i.hosted_invoice_url,
    }));
  } catch (e) {
    console.warn('[analytics] Stripe invoices fetch failed:', e.message);
  }

  return jsonResponse({
    generated_at: new Date().toISOString(),
    tenants: {
      total:          tenants.total      || 0,
      trial:          tenants.trial      || 0,
      active:         tenants.active     || 0,
      past_due:       tenants.past_due   || 0,
      cancelled:      tenants.cancelled  || 0,
      test_tenants:   tenants.test_tenants || 0,
    },
    plans: {
      solo:   { count: mrrRow.solo_active   || 0 },
      team:   { count: mrrRow.team_active   || 0 },
      klinik: { count: mrrRow.klinik_active || 0 },
    },
    signups: {
      today:       tenants.signups_today      || 0,
      week:        tenants.signups_7d         || 0,
      month:       tenants.signups_this_month || 0,
      last_30d:    tenants.signups_30d        || 0,
      daily_30d:   dailySignups.results || [],
    },
    mrr: {
      cents:  mrr_cents,
      euro:   mrr_cents / 100,
      breakdown: {
        solo:   { count: mrrRow.solo_active   || 0, mrr_cents: (mrrRow.solo_active   || 0) * PLAN_AMOUNT.solo },
        team:   { count: mrrRow.team_active   || 0, mrr_cents: (mrrRow.team_active   || 0) * PLAN_AMOUNT.team },
        klinik: { count: mrrRow.klinik_active || 0, mrr_cents: (mrrRow.klinik_active || 0) * PLAN_AMOUNT.klinik },
      },
    },
    conversion: {
      signups_30d: conversion.signups || 0,
      converted:   conversion.converted || 0,
      rate_pct:    conversionRate,
    },
    recent_signups: recentSignups.results || [],
    recent_invoices: recentInvoices,
  }, request);
}
