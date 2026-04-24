// ============================================================
// BILLING — Stripe Checkout + Customer Portal + Webhook
// ============================================================
// POST /api/admin/billing/checkout  — owner starts upgrade flow
// POST /api/admin/billing/portal    — owner manages existing sub (cancel/update)
// GET  /api/admin/billing/status    — current plan + period end
// POST /api/public/stripe-webhook   — Stripe → us (signed payload)
// ============================================================

import { jsonResponse, jsonError } from '../lib/http.js';
import { requireRole } from '../lib/auth.js';
import { getPracticeById } from '../lib/tenant.js';
import { logAudit } from '../lib/audit.js';
import {
  stripeRequest,
  verifyStripeSignature,
  priceIdForPlan,
  planForPriceId,
  stripeContextFor,
} from '../lib/stripe.js';

// ============================================================
// POST /api/admin/billing/checkout
// Body: { plan: 'solo'|'team'|'klinik', return_base: 'https://<host>' }
// Creates (or reuses) a Stripe Customer, then a Checkout Session,
// and returns { url } for the client to redirect to.
// ============================================================
export async function handleCheckoutStart(env, request) {
  const user = await requireRole(env, request, ['owner']);
  let body;
  try { body = await request.json(); } catch { return jsonError('Ungültige Anfrage', request, 400); }

  const plan = body?.plan;
  const returnBase = String(body?.return_base || 'https://praxmate.de').replace(/\/+$/, '');

  // mode: 'trial7' (7-day trial), 'direct' (no trial, charge now), or omitted (preserve tenant's remaining trial).
  // Explicit integer `trial_days` also accepted (0-90). Takes precedence over mode.
  const mode = body?.mode;
  const explicitDays = typeof body?.trial_days === 'number' ? body.trial_days : null;

  const practice = await getPracticeById(env, user.practice_id);
  if (!practice) return jsonError('Praxis nicht gefunden', request, 404);

  // Route to live or test Stripe backend based on practice.is_test_mode
  const ctx = stripeContextFor(env, practice);
  const priceId = priceIdForPlan(ctx, plan);
  if (!priceId) return jsonError('Unbekannter Plan', request, 400);

  // ===== Ensure a Stripe Customer exists for this practice (per-mode) =====
  // Test customers live in a different column so they survive mode flips.
  const customerCol = ctx.mode === 'test' ? 'stripe_test_customer_id' : 'stripe_customer_id';
  let customerId = practice[customerCol];
  if (!customerId) {
    const customer = await stripeRequest(ctx, 'POST', '/customers', {
      email: user.email,
      name:  practice.name,
      metadata: {
        practice_id: practice.id,
        practice_slug: practice.slug,
        is_test: ctx.mode === 'test' ? '1' : '0',
      },
    });
    customerId = customer.id;
    await env.DB.prepare(
      `UPDATE practices SET ${customerCol} = ? WHERE id = ?`
    ).bind(customerId, practice.id).run();
  }

  // ===== Resolve trial days =====
  // Precedence: explicit trial_days > mode > tenant's remaining trial (default).
  let trialDays;
  if (explicitDays !== null) {
    trialDays = Math.max(0, Math.min(90, Math.floor(explicitDays)));
  } else if (mode === 'trial7') {
    trialDays = 7;
  } else if (mode === 'direct') {
    trialDays = 0;
  } else {
    // Fallback: preserve tenant's remaining trial if still in trial
    const stillInTrial = practice.plan_status === 'trial' && practice.trial_ends_at
      && new Date(practice.trial_ends_at).getTime() > Date.now();
    trialDays = stillInTrial
      ? Math.max(0, Math.ceil((new Date(practice.trial_ends_at).getTime() - Date.now()) / 86400000))
      : 0;
  }

  // ===== Create Checkout Session =====
  // Intentionally omit `payment_method_types` — Stripe then falls back to the
  // merchant's Dashboard-configured methods (card, SEPA, PayPal, Klarna,
  // Google Pay, Apple Pay, Link, Bancontact, Amazon Pay) and filters to the
  // ones compatible with subscription mode.
  // Note: `automatic_payment_methods` is a PaymentIntent param, NOT valid here.
  const session = await stripeRequest(ctx, 'POST', '/checkout/sessions', {
    customer: customerId,
    mode: 'subscription',
    'line_items[0][price]': priceId,
    'line_items[0][quantity]': 1,
    success_url: `${returnBase}/praxis/billing.html?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${returnBase}/praxis/billing.html?status=cancelled`,
    locale: practice.locale?.slice(0, 2) || 'de',
    // Only pass trial_period_days if > 0 (Stripe rejects 0 as invalid)
    ...(trialDays > 0 ? { 'subscription_data[trial_period_days]': trialDays } : {}),
    'subscription_data[metadata][practice_id]': practice.id,
    'subscription_data[metadata][practice_slug]': practice.slug,
    'subscription_data[metadata][trial_mode]': mode || (explicitDays !== null ? `explicit:${trialDays}` : 'default'),
    allow_promotion_codes: 'true',
    billing_address_collection: 'auto',
    'metadata[practice_id]': practice.id,
    'metadata[plan]': plan,
  });

  await logAudit(env, {
    practice_id: practice.id,
    actor_type: 'user',
    actor_id: user.user_id,
    action: 'billing.checkout_started',
    meta: { plan, price_id: priceId, session_id: session.id, trial_days: trialDays, mode: mode || null },
    request,
  });

  return jsonResponse({ url: session.url, session_id: session.id }, request);
}

// ============================================================
// POST /api/admin/billing/portal
// Redirect to the Stripe-hosted Customer Portal for plan management.
// ============================================================
export async function handleCustomerPortal(env, request) {
  const user = await requireRole(env, request, ['owner']);
  let body;
  try { body = await request.json(); } catch { body = {}; }

  const returnUrl = String(body?.return_base || 'https://praxmate.de').replace(/\/+$/, '') + '/praxis/billing.html';
  const practice = await getPracticeById(env, user.practice_id);
  if (!practice) return jsonError('Praxis nicht gefunden', request, 404);

  const ctx = stripeContextFor(env, practice);
  const customerId = ctx.mode === 'test'
    ? practice.stripe_test_customer_id
    : practice.stripe_customer_id;
  if (!customerId) {
    return jsonError('Kein aktives Abonnement', request, 400);
  }

  const session = await stripeRequest(ctx, 'POST', '/billing_portal/sessions', {
    customer: customerId,
    return_url: returnUrl,
  });

  return jsonResponse({ url: session.url }, request);
}

// ============================================================
// GET /api/admin/billing/status
// Returns plan, status, trial/period end, public key for client-side Stripe.js.
// ============================================================
export async function handleBillingStatus(env, request) {
  const user = await requireRole(env, request, ['owner', 'doctor', 'staff']);
  const practice = await getPracticeById(env, user.practice_id);
  if (!practice) return jsonError('Praxis nicht gefunden', request, 404);

  // Read Stripe-specific columns directly so both live + test fields are visible
  const stripeRow = await env.DB.prepare(`
    SELECT stripe_customer_id, stripe_subscription_id, stripe_price_id, current_period_end,
           stripe_test_customer_id, stripe_test_subscription_id, is_test_mode
    FROM practices WHERE id = ?
  `).bind(practice.id).first() || {};

  const ctx = stripeContextFor(env, { ...practice, is_test_mode: stripeRow.is_test_mode });

  return jsonResponse({
    plan: practice.plan,
    plan_status: practice.plan_status,
    trial_ends_at: practice.trial_ends_at,
    current_period_end: stripeRow.current_period_end || null,
    has_subscription: !!(
      ctx.mode === 'test' ? stripeRow.stripe_test_subscription_id : stripeRow.stripe_subscription_id
    ),
    is_test_mode: stripeRow.is_test_mode === 1,
    stripe_mode: ctx.mode,
    stripe_public_key: ctx.publicKey || null,
    prices: {
      solo:   { id: ctx.prices.solo,   amount_cents: 3900,  currency: 'EUR' },
      team:   { id: ctx.prices.team,   amount_cents: 6900,  currency: 'EUR' },
      klinik: { id: ctx.prices.klinik, amount_cents: 11900, currency: 'EUR' },
    },
  }, request);
}

// ============================================================
// POST /api/public/stripe-webhook
// Verify Stripe signature, update practice state, return 200 fast.
// ============================================================
export async function handleStripeWebhook(env, request) {
  const sig = request.headers.get('Stripe-Signature');
  const rawBody = await request.text();

  // Try LIVE signature first, then TEST — whichever verifies wins.
  let webhookMode = null;
  if (await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET)) {
    webhookMode = 'live';
  } else if (env.STRIPE_TEST_WEBHOOK_SECRET
             && await verifyStripeSignature(rawBody, sig, env.STRIPE_TEST_WEBHOOK_SECRET)) {
    webhookMode = 'test';
  }
  if (!webhookMode) {
    console.warn('Stripe webhook: signature mismatch (tried both live + test)');
    return jsonError('Invalid signature', request, 400);
  }

  let event;
  try { event = JSON.parse(rawBody); } catch { return jsonError('Bad JSON', request, 400); }

  // Column selector: test events update test-specific columns, live events update live columns.
  const isTest = webhookMode === 'test';
  const col = {
    customer:     isTest ? 'stripe_test_customer_id'     : 'stripe_customer_id',
    subscription: isTest ? 'stripe_test_subscription_id' : 'stripe_subscription_id',
    priceId:      isTest ? 'stripe_test_price_id'        : 'stripe_price_id',
  };

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const s = event.data.object;
        const practiceId = s.metadata?.practice_id;
        if (practiceId && s.subscription) {
          await env.DB.prepare(`
            UPDATE practices
            SET ${col.customer} = COALESCE(${col.customer}, ?),
                ${col.subscription} = ?,
                plan_status = 'active'
            WHERE id = ?
          `).bind(s.customer, s.subscription, practiceId).run();
          await logAudit(env, {
            practice_id: practiceId,
            actor_type: 'system',
            actor_id: `stripe:${webhookMode}`,
            action: 'billing.checkout_completed',
            meta: { session_id: s.id, subscription: s.subscription, mode: webhookMode },
            request,
          });
        }
        break;
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = event.data.object;
        const practiceId = sub.metadata?.practice_id;
        if (!practiceId) break;

        const item = sub.items?.data?.[0] || {};
        const priceId = item.price?.id || null;
        const derivedPlan = planForPriceId(env, priceId);
        const periodEnd = sub.current_period_end ?? item.current_period_end ?? null;
        const statusMap = {
          active:            'active',
          trialing:          'trial',
          past_due:          'past_due',
          unpaid:            'past_due',
          canceled:          'cancelled',
          incomplete:        'trial',
          incomplete_expired:'cancelled',
          paused:            'suspended',
        };
        const planStatus = statusMap[sub.status] || 'active';

        await env.DB.prepare(`
          UPDATE practices
          SET ${col.subscription} = ?,
              ${col.priceId} = ?,
              plan = COALESCE(?, plan),
              plan_status = ?,
              current_period_end = CASE WHEN ? IS NULL THEN NULL ELSE datetime(?, 'unixepoch') END
          WHERE id = ?
        `).bind(
          sub.id, priceId, derivedPlan, planStatus,
          periodEnd, periodEnd, practiceId
        ).run();
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const practiceId = sub.metadata?.practice_id;
        if (!practiceId) break;
        await env.DB.prepare(`
          UPDATE practices
          SET plan_status = 'cancelled',
              ${col.subscription} = NULL
          WHERE id = ?
        `).bind(practiceId).run();
        await logAudit(env, {
          practice_id: practiceId,
          actor_type: 'system',
          actor_id: `stripe:${webhookMode}`,
          action: 'billing.subscription_cancelled',
          meta: { subscription: sub.id, mode: webhookMode },
          request,
        });
        break;
      }

      case 'invoice.payment_succeeded': {
        const inv = event.data.object;
        const subId = inv.subscription
          ?? inv.parent?.subscription_details?.subscription
          ?? inv.lines?.data?.[0]?.parent?.subscription_item_details?.subscription
          ?? null;
        if (!subId) break;
        const periodEnd = inv.lines?.data?.[0]?.period?.end;
        if (periodEnd) {
          await env.DB.prepare(`
            UPDATE practices
            SET current_period_end = datetime(?, 'unixepoch'),
                plan_status = 'active'
            WHERE ${col.subscription} = ?
          `).bind(periodEnd, subId).run();
        }
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const subId = inv.subscription;
        if (!subId) break;
        await env.DB.prepare(`
          UPDATE practices SET plan_status = 'past_due'
          WHERE ${col.subscription} = ?
        `).bind(subId).run();
        const row = await env.DB.prepare(
          `SELECT id FROM practices WHERE ${col.subscription} = ?`
        ).bind(subId).first();
        if (row) {
          await logAudit(env, {
            practice_id: row.id,
            actor_type: 'system',
            actor_id: `stripe:${webhookMode}`,
            action: 'billing.payment_failed',
            meta: { invoice: inv.id, amount_due: inv.amount_due, mode: webhookMode },
            request,
          });
        }
        break;
      }

      default:
        // Ignore unhandled event types silently.
        break;
    }

    return jsonResponse({ received: true }, request);
  } catch (e) {
    console.error('Stripe webhook handler error:', e);
    // Return 500 so Stripe retries
    return jsonError(e.message || 'webhook handler failed', request, 500);
  }
}
